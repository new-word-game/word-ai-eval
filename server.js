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

重要：
- 「感想」だけを書きます。助言・提案・指示・改善案（〜した方が良い／〜すると良い等）は一切禁止。
- 「点数にふさわしい」情緒のコメントにしてください。
  - 低得点: 容赦ない辛口の感想（罵倒ではなく、あくまで“感じたこと”）
  - 中間: 率直で淡々とした感想
  - 高得点: 高揚感のある賞賛（比喩・断言・詩的表現OK）
- コメントは2文以内。表現のバリエーションを広く（似通った言い回しを避ける）。絵文字は使っても使わなくても良い。
- 平均はだいたい35点前後になりがちだが、作品に応じて自由に採点して良い（たまに高得点/低得点が出ても良い）。

出力は JSON のみ。プロパティはこの4つだけ：
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

    // 値の整形と安全化
    const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));
    let nat = clamp(parsed.nat, 0, 50);
    let cre = clamp(parsed.cre, 0, 50);
    let tot = clamp(parsed.tot, 0, 100);
    const comment = (parsed.comment || "").toString().trim();

    // tot を nat+cre に合わせる（LLMの丸め誤差対策）
    const sum = +(nat + cre).toFixed(1);
    if (Math.abs(sum - tot) > 0.6) {
      tot = sum; // 合計は nat+cre を正とする
    }

    return res.json({
      nat: +nat.toFixed(1),
      cre: +cre.toFixed(1),
      tot: +tot.toFixed(1),
      comment // ← これだけをフロントで表示すればOK
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
