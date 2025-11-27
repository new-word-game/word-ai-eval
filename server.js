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
const clamp  = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));
const frac1  = (v) => Math.round((Math.abs(v) * 10) % 10); // 小数第1位(0..9)
const is05   = (d) => d === 0 || d === 5;
const pick   = (a) => a[Math.floor(Math.random() * a.length)];

// 両方 .0/.5 → 端数を散らす（合計は維持）
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
    const d = pick(deltas);
    if (!tryShift( d)) tryShift(-d);
  }
  return { nat, cre };
}

// tot が 5点刻みに吸着していたら、合計自体を±0.1〜0.4ずらす
function breakFiveStepTotal(natIn, creIn) {
  let nat = round1(natIn);
  const cre = round1(creIn);
  let tot = round1(nat + cre);

  const isFiveStep = (t) => (Math.round(t * 10) % 50) === 0; // 25.0,30.0...判定
  if (!isFiveStep(tot)) return { nat, cre, tot };

  const deltas = [0.1, 0.2, 0.3, 0.4];
  const tryNat = (dx) => {
    const n2 = round1(nat + dx);
    if (n2 < 0 || n2 > 50) return null;
    if (is05(frac1(n2)) && is05(frac1(cre))) return null;
    const t2 = round1(n2 + cre);
    if ((Math.round(t2 * 10) % 50) !== 0) return { nat: n2, cre, tot: t2 };
    return null;
  };

  for (const d of deltas.sort(() => Math.random() - 0.5)) {
    const r1 = tryNat(+d); if (r1) return r1;
    const r2 = tryNat(-d); if (r2) return r2;
  }
  return { nat, cre, tot };
}

// 時々デコボコ（偏り）を作る：確率 p で nat/cre に±Δを付与（合計は維持）
function maybeSkewNatCre(natIn, creIn, p = 0.35) {
  let nat = round1(natIn), cre = round1(creIn);
  if (Math.random() >= p) return { nat, cre };

  // どちらを上げるか
  const raiseNat = Math.random() < 0.5;

  // 取りうる最大Δ（範囲内で）
  const maxAddNat = Math.min(50 - nat, cre);        // nat を上げる場合の最大
  const maxAddCre = Math.min(50 - cre, nat);        // cre を上げる場合の最大
  const maxDelta  = raiseNat ? maxAddNat : maxAddCre;

  // 最小3.0〜最大12.0の間で0.1刻み候補を作成（大きめの偏りも出る）
  const candidates = [];
  for (let d = 3.0; d <= 12.0; d += 0.1) {
    d = round1(d);
    if (d <= maxDelta) candidates.push(d);
  }
  if (!candidates.length) return { nat, cre };

  const delta = pick(candidates);
  if (raiseNat) { nat = round1(nat + delta); cre = round1(cre - delta); }
  else          { cre = round1(cre + delta); nat = round1(nat - delta); }

  return { nat: clamp(nat, 0, 50), cre: clamp(cre, 0, 50) };
}

// コメント長を200字前後に（長すぎるときだけ軽くトリム）
function tuneLength200(s, min = 160, max = 240) {
  const t = (s || "").trim();
  if (t.length <= max) return t;
  // 句点・読点・改行の直前で切れたらベター
  const cut = t.slice(0, max);
  const idx = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("、"), cut.lastIndexOf("\n"));
  return (idx >= min ? cut.slice(0, idx + 1) : cut) + "…";
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
- コメントは**200文字前後（目安160〜240字）**。情緒と比喩を自由に、罵倒はしない。
- 各スコアは**必ず小数第1位**（例: 37.4）。**整数のみ禁止**。
- **.0 と .5 に偏らせない**（nat と cre のどちらかは .0/.5 以外の端数）。
- **tot は nat + cre を小数第1位で丸めた値**。
- ときどき **nat と cre に大きめの差**が出ても良い（偏り歓迎）。
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

    // 時々デコボコ（偏り）にする
    ({ nat, cre } = maybeSkewNatCre(nat, cre, 0.35));

    // 端数散らし（両方 .0/.5 の場合）
    ({ nat, cre } = dequantizeNatCre(nat, cre));

    // 合計（0.1刻み）
    let tot = round1(clamp(nat + cre, 0, 100));

    // 5点吸着の回避
    ({ nat, cre, tot } = breakFiveStepTotal(nat, cre));

    // コメント長を200字前後に調整（長すぎ対策のみ）
    const comment = tuneLength200((parsed.comment || "").toString());

    return res.json({ nat, cre, tot, comment });

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
