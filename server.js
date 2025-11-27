// server.js
import express from "express";
import OpenAI from "openai";

const app = express();

// --- 強制CORS & OPTIONS即返し（最強モード） ---
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});


// APIキーは環境変数から読み取る（フロントには絶対渡さない）
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(express.json());
app.use(express.static(".")); // 同じフォルダの new-word.html を配信

// ----------------------
//      /api/eval
// ----------------------
app.post("/api/eval", async (req, res) => {
  try {
    const { text, word } = req.body || {};

    if (!text || !word) {
      return res.status(400).json({ error: "text と word が必要です。" });
    }

    // 空白を除いた文字数（短文判定などに使う）
    const rawLen = text.replace(/\s/g, "").length;

    // ★ AI に厳しめで評価させるプロンプト
    //   → 「json」という単語を明示的に含める（response_format=json_object用）
    const prompt = `
あなたは文章評価を行う採点AIです。
今回は **平均点 35 点前後** になるよう「非常に辛口」で評価してください。
満点は **100 点** とし、小数点 1 桁で出してください。

このやり取りでは、あなたは必ず有効な JSON を返してください。
JSON 以外の文字・説明文・前置きは一切書かないでください。
出力は JSON オブジェクト 1 個だけにしてください。

以下の基準で「自然さ」「独創性」を 0〜100 の範囲で採点します。

【自然さ（0〜100）】
- 読みやすさ、文法、論理性
- 句読点や文の切れ方、語彙の選び方
- 40 文字未満の短文は大幅減点
- 誤字・不自然な文は大きく減点
- 長いだけの文章には高得点を与えない。内容が薄い長文は自然さも低くする。
一般的な文章は **20〜50** に収まることが多い

【独創性（0〜100）】
- ひねり・意外性・比喩表現の質
- 造語と説明の結びつき
- ありきたり・凡庸なら大幅減点
- 長文で情報量が多くても、発想が平凡なら独創性は低めにする。
一般的な文章は **20〜40** 程度

【合計点（0〜100）】
合計点は返さず、サーバー側で (自然さ + 独創性) / 2 を計算します。
※ あなたは自然さと独創性のみ返してください。

【コメント（120〜200文字）】
- 文章の要約（何を伝えようとしているか）
- 良い点を 1 個以上（具体的に）
- 改善点を 1 個以上（具体的に）
- プレイヤーの文章に含まれる単語を 1〜2 個引用する

出力形式は **厳守** してください。
必ず次の JSON オブジェクト「だけ」を返します。

{
  "nat": 数値（自然さ）,
  "cre": 数値（独創性）,
  "comment": "日本語コメント"
}

造語: ${word}
説明文: ${text}
`.trim();

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0, // 同じ入力 → 同じ結果（短文ジャックポット以外は決定的）
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "あなたは辛口だが公平な日本語文章の採点者です。平均点を高くしすぎず、json形式の応答のみを返します。",
        },
        { role: "user", content: prompt },
      ],
    });

    const content = response.choices[0]?.message?.content ?? "{}";
    let parsed = {};

    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = {
        nat: 0,
        cre: 0,
        comment: "AIの解析に失敗しました。",
      };
    }

    // ----------------------
    //  スコア後処理（ここを要件どおり変更）
    // ----------------------
    let natRaw = Number(parsed.nat ?? 0); // 0〜100 を想定
    let creRaw = Number(parsed.cre ?? 0);

    // 0〜100にクリップ（この時点ではまだ「生スコア」）
    natRaw = Math.max(0, Math.min(100, natRaw));
    creRaw = Math.max(0, Math.min(100, creRaw));

    // (３) 短い文章でも、1/1000 くらいの確率で高得点（ジャックポット）
    // 生文字数が 40 未満のとき、ごくまれに 70〜95 点程度まで底上げ
    if (rawLen > 0 && rawLen < 40) {
      const jackpotProb = 0.001; // 1000 分の 1
      if (Math.random() < jackpotProb) {
        const boost = 70 + Math.random() * 25; // 70〜95
        if (natRaw < boost) natRaw = boost;
        if (creRaw < boost) creRaw = boost;
      }
    }

    // (１) 自然さも 2 で割り、独創性も 2 で割って表示し、その合計を点数にする。
    // natRaw/2, creRaw/2 が 0〜50 点になる。
    let natHalf = natRaw / 2; // 0〜50
    let creHalf = creRaw / 2; // 0〜50

    // (２) 0.1 点刻みにするため、
    // 長さに応じた微妙な「決定的な」ずらしを加える（乱数ではなく長さベースなので再現性あり）。
    // 例：文字数の下1桁を 0.0〜0.9 点の微調整として足す（最大でも +0.9 点）。
    const tweakNat = (rawLen % 10) / 10;          // 0.0〜0.9
    const tweakCre = ((rawLen * 7) % 10) / 10;    // 0.0〜0.9（別パターン）

    let nat = natHalf + tweakNat;
    let cre = creHalf + tweakCre;

    // 念のため 0〜50 にクリップ
    nat = Math.max(0, Math.min(50, nat));
    cre = Math.max(0, Math.min(50, cre));

    // 合計は 0〜100 点（自然さ 0〜50＋独創性 0〜50）
    let tot = nat + cre;
    tot = Math.max(0, Math.min(100, tot));

    // 小数点 1 桁に整形
    nat = Number(nat.toFixed(1));
    cre = Number(cre.toFixed(1));
    tot = Number(tot.toFixed(1));

    res.json({
      nat,
      cre,
      tot,
      comment:
        typeof parsed.comment === "string"
          ? parsed.comment
          : "コメント生成に失敗しました。",
    });
  } catch (err) {
    console.error("API error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running → http://localhost:${PORT}`);
});
