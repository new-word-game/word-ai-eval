// ============================================================================
// Word AI Evaluation Service - 安定版
// 造語＋説明文を受け取り、AIによる採点とコメントを返すAPIサーバー
// 仕様:
//  - 日本語としてそれなりに書いてあれば一桁続出を防ぐ下限スコア
//  - 「ちゃんとした日本語」のみ高得点ガチャ(50/70/90点帯)を適用
//  - ガチャ外れや日本語として弱い場合の 50 点超値は 25〜49 点帯に自然分散
//  - 49.9 の強制スケールは完全廃止
// ============================================================================

import express from "express";
import OpenAI from "openai";

const app = express();

// --- CORS ---
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: "2mb" }));

// --- OpenAI API ---
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ------------------------------
// ヘルパー
// ------------------------------
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
    // ★ AI に渡すプロンプト（完全ノーカット版）
    // ------------------------------------------------------------------------
    const prompt = `
あなたは、日本語で書かれた「造語」とその説明文を評価する専門編集者です。
以下の造語と説明文を読み、次の基準に基づいて採点してください。

【評価項目】
1. 文の自然さ (nat)
   - 日本語として読みやすいか
   - 文法的な破綻がないか
   - 説明文として意味が通るか
   - 0〜50 点で採点

2. 創造性 / 独自性 (cre)
   - 造語と説明文の組み合わせが独創的か
   - アイデアとして面白さや新しさがあるか
   - 0〜50 点で採点

3. 講評 (comment)
   - 1〜3 文の短い日本語による講評を書く

【重要】
返答は必ず次の **JSON のみ** で返してください。  
余計なテキスト、説明文、コードブロック記号（\`\`\`）などは絶対に書かないでください。

{
  "nat": 数値（0〜50）,
  "cre": 数値（0〜50）,
  "comment": "短い日本語のコメント"
}

制約:
- "nat" と "cre" は数値で返してください（文字列は禁止）。
- "comment" は必ず日本語で書いてください。
- JSON の前後に説明文やコードブロックを付けてはいけません。
- キーは "nat", "cre", "comment" の3つを必ず含めてください。

【評価対象】
造語: ${word}
説明文: ${desc}
`;

    // ------------------------------------------------------------------------
    // OpenAI 呼び出し
    // ここで response_format: json_object を指定して「必ず JSON」にする
    // ------------------------------------------------------------------------
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      response_format: { type: "json_object" },
    });

    const aiText = completion.choices?.[0]?.message?.content ?? "";

    let data;
    try {
      data = JSON.parse(aiText);
    } catch (e) {
      console.error("JSON parse error:", e);
      console.error("AI raw response:", aiText);
      return res.status(500).json({ error: "invalid_json", raw: aiText });
    }

    let nat = clamp(Number(data.nat) || 0, 0, 50);
    let cre = clamp(Number(data.cre) || 0, 0, 50);
    let tot = round1(nat + cre);

    // ------------------------------
    // 日本語チェック
    // ------------------------------
    const descLen = desc.length;
    const looksJapanese =
      /[。、ぁ-んァ-ン一-龠]/.test(desc) && desc.trim().length >= 4;

    // ------------------------------
    // 下限補正（日本語なら極端な低得点を避ける）
    // ------------------------------
    if (looksJapanese) {
      if (nat < 10) nat = 10;
      if (cre < 5) cre = 5;
      tot = round1(nat + cre);
    }

    const goodJapanese = looksJapanese && descLen >= 15;

    // ------------------------------
    // 高得点ガチャ（良い日本語のみ）
    // ------------------------------
    let appliedGacha = false;

    if (goodJapanese) {
      const r = Math.random();

      if (r < 0.1) {
        // 70〜90点帯
        const bonus = 70 + Math.random() * 20;
        nat = round1(clamp(nat + bonus * 0.5, 0, 50));
        cre = round1(clamp(cre + bonus * 0.5, 0, 50));
        appliedGacha = true;
      } else if (r < 0.3) {
        // 50〜60点帯
        const bonus = 50 + Math.random() * 10;
        nat = round1(clamp(nat + bonus * 0.5, 0, 50));
        cre = round1(clamp(cre + bonus * 0.5, 0, 50));
        appliedGacha = true;
      }

      tot = round1(nat + cre);
    }

    // ======================================================================
    // ★ ガチャ外れ・日本語弱い → 50超は禁止、25〜49 にランダム分散
    // ======================================================================
    const scatterToLowBand = () => {
      // 25.0〜49.0 のどこかにランダムで落とす（49.9 はそもそも出ない）
      const targetTot = round1(25 + Math.random() * 24); // 25〜49

      const base = nat + cre || 1;
      const share = nat / base;

      const newNat = round1(clamp(targetTot * share, 0, 50));
      const newCre = round1(clamp(targetTot - newNat, 0, 50));

      nat = newNat;
      cre = newCre;
      tot = round1(nat + cre);
    };

    // 日本語として弱いのに 50 超 → 強制的に 25〜49 に落とす
    if (!goodJapanese && tot > 50) {
      scatterToLowBand();
    }

    // ちゃんとした日本語だがガチャ外れなのに 50 超 → 同じく 25〜49 に落とす
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
// Ping
// ============================================================================
app.get("/", (req, res) => {
  res.type("text/plain").send("OK: word-ai-eval-service is running.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running → http://localhost:${PORT}`);
});
