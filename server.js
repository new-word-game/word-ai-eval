// ============================================================================
// Word AI Evaluation Service - 改訂版
// 造語＋説明文を受け取り、AIによる採点とコメントを返すAPIサーバー
// 仕様:
//  - 日本語としてそれなりに書いてあれば一桁続出を防ぐ下限スコア
//  - 「ちゃんとした日本語」のみ高得点ガチャ(50/70/90点帯)を適用
//  - ガチャ外れや日本語として弱い場合の 50 点超値は 25〜49.9 点帯に自然分散
// ============================================================================

import express from "express";
import OpenAI from "openai";

const app = express();

// --- CORS & OPTIONS ---
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: "2mb" }));

// --- OpenAI API ---
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ヘルパー関数
function clamp(num, min, max) {
  return Math.min(Math.max(num, min), max);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// ============================================================================
// API: /api/eval
// ============================================================================

app.post("/api/eval", async (req, res) => {
  try {
    const { word, desc } = req.body;

    if (!word || !desc) {
      return res.status(400).json({ error: "word and desc are required" });
    }

    // ------------------------------------------------------------------------
    // ★ AI に渡すプロンプト（省略なし）
    // ------------------------------------------------------------------------
    const prompt = `
あなたは、日本語で書かれた「造語」とその説明文を評価する編集者です。
以下の造語と説明文を読み、次の3つの観点で採点してください。

【評価項目】
1. 文の自然さ (nat)
   - 日本語として読みやすいか、文法的に大きな破綻がないか
   - 意味が通るか、説明として成立しているか
   - スコア範囲: 0〜50点

2. 創造性 / 独自性 (cre)
   - 造語と説明文の組み合わせとしてユニークさや面白さがあるか
   - 単なる既存語の言い換えや、ありきたりな表現でないか
   - スコア範囲: 0〜50点

3. 合計点 (tot)
   - 合計点は nat + cre で 0〜100点になります
   - 合計点はサーバー側で計算するため、JSON には含めなくて構いません

【採点方針の目安】
- ごく短い、意味がほとんど伝わらない説明文は低得点になります。
- ある程度意味が通っていれば、極端に 0〜5 点のようなスコアは多用しないでください。
- 「完璧な説明文」でなくても構いません。普通に読める文章であれば、自然さは中程度以上のスコアをつけて構いません。
- 創造性は、造語と説明文の組み合わせとしての面白さ・新しさを重視してください。

【出力形式】
必ず、次の形式の JSON オブジェクトだけを返してください。
JSON 以外のテキスト（説明文・コメント・コードブロック記号など）は絶対に書かないでください。

{
  "nat": <自然さのスコア（数値、0〜50）>,
  "cre": <創造性のスコア（数値、0〜50）>,
  "comment": "<短い講評（日本語）>"
}

制約:
- "nat" と "cre" は数値 (number) で返してください。文字列 ("40") ではなく数値 (40) です。
- "comment" は 1〜3 文程度の日本語の文章で、造語と説明文に対する簡潔なフィードバックを書いてください。
- JSON の前後に説明文やコードブロック記号（\`\`\`）をつけてはいけません。
- JSON キーは必ず "nat", "cre", "comment" の3つを含めてください。

【評価対象】
造語: ${word}
説明文: ${desc}
`;

    // --- モデル呼び出し ---
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    });

    const aiText = completion.choices?.[0]?.message?.content ?? "";
    let data = {};

    try {
      data = JSON.parse(aiText);
    } catch (e) {
      // OpenAI からの出力が JSON でない場合は、そのまま返してデバッグできるようにする
      return res.status(500).json({ error: "invalid_json", raw: aiText });
    }

    let nat = clamp(Number(data.nat) || 0, 0, 50);
    let cre = clamp(Number(data.cre) || 0, 0, 50);
    let tot = round1(nat + cre);

    const descLen = desc.length;

    // --- 日本語として成立しているかのざっくり判定 ---
    const looksJapanese =
      /[。、ぁ-んァ-ン一-龠]/.test(desc) && desc.trim().length >= 4;

    // --- 下限補正：一桁点が連発しないよう調整 ---
    if (looksJapanese) {
      const minNat = 10; // 自然さ最低保証
      const minCre = 5;  // 創造性最低保証

      if (nat < minNat) nat = minNat;
      if (cre < minCre) cre = minCre;

      tot = round1(nat + cre);
    }

    // --- 「ちゃんとした日本語」判定 ---
    const goodJapanese = descLen >= 15 && looksJapanese;

    // --- 高得点ガチャ（ちゃんとした日本語だけ適用） ---
    let appliedGacha = false;

    if (goodJapanese) {
      const r = Math.random();

      // 10% → 70点以上帯（70〜90点相当のボーナスを按分）
      if (r < 0.1) {
        const bonus = 70 + Math.random() * 20; // 70〜90
        cre = round1(clamp(cre + bonus * 0.5, 0, 50));
        nat = round1(clamp(nat + bonus * 0.5, 0, 50));
        tot = round1(nat + cre);
        appliedGacha = true;
      }
      // 20% → 50点台帯（50〜60点相当のボーナスを按分）
      else if (r < 0.3) {
        const bonus = 50 + Math.random() * 10; // 50〜60
        cre = round1(clamp(cre + bonus * 0.5, 0, 50));
        nat = round1(clamp(nat + bonus * 0.5, 0, 50));
        tot = round1(nat + cre);
        appliedGacha = true;
      }
    }

    // ------------------------------------------------------------------------
    // ★ スコア調整ロジック
    //   - 日本語として弱い場合: 50点超は禁止、25〜49.9に分散
    //   - ちゃんとした日本語でもガチャ外れで 50点超なら 25〜49.9に分散
    // ------------------------------------------------------------------------

    const scatterToLowBand = () => {
      // 25.0〜49.9 のどこかにランダムで落とす
      const targetTot = round1(25 + Math.random() * 24.9); // 25.0〜49.9

      const base = nat + cre || 1;
      const share = nat / base; // 元の比率をおおまかに維持

      let natNew = round1(clamp(targetTot * share, 0, 50));
      let creNew = round1(clamp(targetTot - natNew, 0, 50));

      nat = natNew;
      cre = creNew;
      tot = round1(clamp(nat + cre, 0, 100));
    };

    // 日本語として不十分な場合 → 50点超は禁止、25〜49.9に散らす
    if (!goodJapanese && tot > 50) {
      scatterToLowBand();
    }

    // ちゃんとした日本語だがガチャ外れ（ボーナス未適用）で 50点超えてしまった場合 → 25〜49.9に散らす
    if (goodJapanese && !appliedGacha && tot > 50) {
      scatterToLowBand();
    }

    // ------------------------------------------------------------------------
    // レスポンス
    // ------------------------------------------------------------------------
    res.json({
      nat,
      cre,
      tot,
      comment: data.comment ?? "",
      raw: aiText,
    });
  } catch (err) {
    console.error("API error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// ============================================================================
// ping
// ============================================================================

app.get("/", (req, res) => {
  res.type("text/plain").send("OK: word-ai-eval-service is running.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running → http://localhost:${PORT}`);
});
