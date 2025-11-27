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

// ---------- ユーティリティ ----------
const round1 = (v) => Math.round((Number(v) || 0) * 10) / 10;
const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));
const frac1 = (v) => Math.round((Math.abs(v) * 10) % 10); // 小数第1位(0..9)
const is05 = (d) => d === 0 || d === 5;
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// 両方 .0/.5 → 端数散らす（合計は維持）
function dequantizeNatCre(natIn, creIn) {
  let nat = round1(natIn);
  let cre = round1(creIn);
  if (is05(frac1(nat)) && is05(frac1(cre))) {
    const deltas = [0.1, 0.2, 0.3, 0.4];
    const tryShift = (dx) => {
      const n2 = round1(nat + dx);
      const c2 = round1(cre - dx);
      if (n2 >= 0 && n2 <= 50 && c2 >= 0 && c2 <= 50) {
        if (!(is05(frac1(n2)) && is05(frac1(c2)))) { nat = n2; cre = c2; return true; }
      }
      return false;
    };
    if (!tryShift(pick(deltas))) tryShift(-pick(deltas));
  }
  return { nat, cre };
}

// tot が 5点刻みに吸着していたら、合計自体を±0.1〜0.4ずらす
function breakFiveStepTotal(natIn, creIn) {
  let nat = round1(natIn);
  const cre = round1(creIn);

  let tot = round1(nat + cre);
  // 5の倍数（小数第一位まで見て 25.0, 30.0 など）ならズラす
  const isFiveStep = (t) => (Math.round(t * 10) % 50) === 0; // 50=5.0*10
  if (!isFiveStep(tot)) return { nat, cre, tot };

  // ずらし候補（0.1〜0.4）
  const deltas = [0.1, 0.2, 0.3, 0.4];
  // nat へ加算 or 減算を試す（範囲内＆.0/.5に戻さない）
  const tryNat = (dx) => {
    const n2 = round1(nat + dx);
    if (n2 < 0 || n2 > 50) return null;
    if (is05(frac1(n2)) && is05(frac1(cre))) return null; // 再び両方.0/.5は避ける
    const t2 = round1(n2 + cre);
    if ((Math.round(t2 * 10) % 50) !== 0) return { nat: n2, cre, tot: t2 };
    return null;
  };

  // ランダムな順でトライ
  for (const d of deltas.sort(() => Math.random() - 0.5)) {
    const r1 = tryNat(+d); if (r1) return r1;
    const r2 = tryNat(-d); if (r2) return r2;
  }
  // どうしても外れなければ最初の状態を返す（実運用ではほぼ起きない）
  return { nat, cre, tot };
}

// ------------------------- /api/eval -------------------------
app.post("/api/eval", async (req, res) => {
  try {
    const { text, word } = req.body || {};
    if (!text || !word) {
      return res.status(400).json({ error: "text と word が必要です。" });
    }

    const prompt = `
あなたは辛口かつユーモアのある審査員です。以下の作品を読み、
1) 自然さ nat（0〜50）
2) 独創性 cre（0〜50）
を採点し、合計 tot = nat + cre（0〜100）を算出してください。

厳守：
- コメントは「感想」だけ。助言・提案・指示・改善案は禁止。
- コメントは2文以内。表現は毎回変化させる。絵文字は任意。
- 各スコアは**必ず小数第1位**（例: 37.4）。**整数のみ禁止**。
- **.0 と .5 に偏らせない**（nat と cre のどちらかは .0/.5 以外の端数）。
- **tot は nat + cre を小数第1位で丸めた値**。
- 出力は JSON のみ：{"nat": number, "cre": number, "tot": number, "comment": string}

【造語】${word}
【文章】${text}
`.trim();

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 1.25,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "日本語で応答。必ずJSONオブジェクトのみを返す。" },
        { role: "user", content: prompt }
      ],
    });

    const content = response.choices[0]?.message?.content ?? "{}";
    let parsed;
    try { parsed = JSON.parse(content); }
    catch { return res.status(502).json({ error: "llm_parse_error", raw: content }); }

    // 0.1刻み＆範囲
    let nat = round1(clamp(parsed.nat, 0, 50));
    let cre = round1(clamp(parsed.cre, 0, 50));

    // 端数散らし（両方 .0/.5 の場合）
    ({ nat, cre } = dequantizeNatCre(nat, cre));

    // 合計（まずはストレート）
    let tot = round1(clamp(nat + cre, 0, 100));

    // 5点刻み吸着を外す（必要なら合計自体に±0.1〜0.4）
    ({ nat, cre, tot } = breakFiveStepTotal(nat, cre));

    const comment = (parsed.comment || "").toString().trim();

    return res.json({
      nat,  // 0〜50（0.1刻み、端数ばらけ）
      cre,  // 0〜50（0.1刻み、端数ばらけ）
      tot,  // 0〜100（0.1刻み、5点吸着回避）
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
