// server.js
import express from "express";
import OpenAI from "openai";

const app = express();

// --- CORS & OPTIONS ---
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());
app.use(express.static(".")); // new-word.html などを同フォルダから配信

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 丸めユーティリティ（小数第1位）
const round1 = (v) => Math.round((Number(v) || 0) * 10) / 10;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

// -------------------------
// /api/eval
// -------------------------
app.post("/api/eval", async (req, res) => {
  try {
    const { text, word } = req.body || {};
    if (!text || !word) {
      return res.status(400).json({ error: "text と word が必要です。" });
    }

    // ChatGPT に “採点 + 点数にふさわしい感想（助言なし）” を丸投げ
    const prompt = `
あなたは辛口かつユーモアのある審査員です。以下の作品を読み、
1) 自然さ nat（0〜50）
2) 独創性 cre（0〜50）
を採点し、合計 tot = nat + cre（0〜100）を算出してください。

重要な厳守事項：
- 「感想」だけを書く。助言・提案・指示・改善案は禁止（〜した方が良い 等は書かない）。
- コメントは2文以内。表現のバリエーションを広く（似た言い回しを避ける）。絵文字は任意。
- 各スコアは**必ず小数第1位まで**（例: 37.4）。**整数のみの出力は禁止**。
- **tot は nat + cre を小数第1位で丸めた値**にすること（独自計算禁止）。
- 出力は JSON のみ。プロパティはこの4つだけ：
  {"nat": number, "cre": number, "tot": number, "comment": string}

【造語】${word}
【文章】${text}
`.trim();

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 1.2, // バリエーション重視
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "日本語で応答。必ずJSONオブジェクトのみを返す。" },
        { role: "user", content: prompt }
      ],
    });

    const content = response.choices[0]?.message?.content ?? "{}";
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return res.status(502).json({ error: "llm_parse_error", raw: content });
    }

    // 値の整形（必ず0.1刻み＆範囲内に）
    let nat = round1(clamp(parsed.nat, 0, 50));
    let cre = round1(clamp(parsed.cre, 0, 50));
    // 合計は nat+cre を正として再計算（0.1刻み）
    let tot = round1(clamp(nat + cre, 0, 100));
    const comment = (parsed.comment || "").toString().trim();

    return res.json({
      nat,  // 0〜50（0.1刻み）
      cre,  // 0〜50（0.1刻み）
      tot,  // 0〜100（0.1刻み, nat+cre）
      comment
    });

  } catch (err) {
    console.error("API error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// ping
app.get("/", (req, res) => {
  res.type("text/plain").send("OK: word-ai-eval-service is running.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running → http://localhost:${PORT}`);
});
