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

// 丸め & 範囲ユーティリティ
const round1 = (v) => Math.round((Number(v) || 0) * 10) / 10;
const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));
const fracDigit = (v) => Math.round((Math.abs(v) * 10) % 10); // 小数第1位（0..9）

// nat/cre の端数が両方とも .0/.5 のとき、合計を保ったまま“0.1刻みの端数”に散らす
function dequantizeNatCre(natIn, creIn) {
  let nat = round1(natIn);
  let cre = round1(creIn);

  const fdN = fracDigit(nat);
  const fdC = fracDigit(cre);
  const is05 = (d) => d === 0 || d === 5;

  if (is05(fdN) && is05(fdC)) {
    // ずらし量（0.1〜0.4 のどれか）を選ぶ
    const deltas = [0.1, 0.2, 0.3, 0.4];
    // なるべく端に寄らないようランダム
    const delta = deltas[Math.floor(Math.random() * deltas.length)];

    // nat に +δ, cre に -δ（またはその逆）で合計維持
    // 境界を踏まない方を選ぶ
    const tryShift = (dx) => {
      const n2 = round1(nat + dx);
      const c2 = round1(cre - dx);
      if (n2 >= 0 && n2 <= 50 && c2 >= 0 && c2 <= 50) {
        const fN2 = fracDigit(n2), fC2 = fracDigit(c2);
        const ok = !(is05(fN2) && is05(fC2)); // 両方.0/.5でなければOK
        if (ok) { nat = n2; cre = c2; return true; }
      }
      return false;
    };

    // +δ と -δ の両方トライ
    if (!tryShift(delta)) tryShift(-delta);
  }
  return { nat, cre };
}

// -------------------------
// /api/eval
// -------------------------
app.post("/api/eval", async (req, res) => {
  try {
    const { text, word } = req.body || {};
    if (!text || !word) {
      return res.status(400).json({ error: "text と word が必要です。" });
    }

    // ChatGPT に “採点 + 点数にふさわしい感想（助言なし）”
    const prompt = `
あなたは辛口かつユーモアのある審査員です。以下の作品を読み、
1) 自然さ nat（0〜50）
2) 独創性 cre（0〜50）
を採点し、合計 tot = nat + cre（0〜100）を算出してください。

厳守事項：
- コメントは「感想」だけ。助言・提案・指示・改善案は禁止。
- コメントは2文以内。表現のバリエーションを広く（似た言い回しを避ける）。絵文字は任意。
- 各スコアは**必ず小数第1位**（例: 37.4）。**整数のみ禁止**。
- **.0 と .5 に偏らせない。nat と cre の少なくともどちらかは .0/.5 以外の端数**（例: .1/.2/.3/.4/.6/.7/.8/.9）にする。
- **tot は nat + cre を小数第1位で丸めた値**（独自計算禁止）。
- 出力は JSON のみ。プロパティはこの4つだけ：
  {"nat": number, "cre": number, "tot": number, "comment": string}

【造語】${word}
【文章】${text}
`.trim();

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 1.25, // バリエーション重視
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

    // 値を 0.1 刻み & 範囲に整形
    let nat = round1(clamp(parsed.nat, 0, 50));
    let cre = round1(clamp(parsed.cre, 0, 50));

    // フェイルセーフ：両方 .0/.5 なら微調整して端数を散らす（合計は維持）
    ({ nat, cre } = dequantizeNatCre(nat, cre));

    // 合計は nat+cre を 0.1 丸めで
    let tot = round1(clamp(nat + cre, 0, 100));
    const comment = (parsed.comment || "").toString().trim();

    return res.json({
      nat,  // 0〜50（必ず0.1刻み、端数散らし）
      cre,  // 0〜50（必ず0.1刻み、端数散らし）
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
