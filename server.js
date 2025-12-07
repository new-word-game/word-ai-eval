// ============================================================================
// Word AI Evaluation Service - 完全版（高得点確率制御 + 日本語文章チェック + 下限保証）
// ============================================================================

import express from "express";
import OpenAI from "openai";

const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());
app.use(express.static("."));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Utility ----------
const round1 = (v) => Math.round((Number(v) || 0) * 10) / 10;
const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));
const frac1 = (v) => Math.round((Math.abs(v) * 10) % 10);
const is05 = (d) => d === 0 || d === 5;
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function dequantizeNatCre(natIn, creIn) {
  let nat = round1(natIn);
  let cre = round1(creIn);
  if (is05(frac1(nat)) && is05(frac1(cre))) {
    const deltas = [0.1, 0.2, 0.3, 0.4];
    const tryShift = (dx) => {
      const n2 = round1(nat + dx);
      const c2 = round1(cre - dx);
      if (n2 >= 0 && n2 <= 50 && c2 >= 0 && c2 <= 50) {
        if (!(is05(frac1(n2)) && is05(frac1(c2)))) {
          nat = n2;
          cre = c2;
          return true;
        }
      }
      return false;
    };
    const d = pick(deltas);
    if (!tryShift(d)) tryShift(-d);
  }
  return { nat, cre };
}

function breakFiveStepTotal(natIn, creIn) {
  let nat = round1(natIn);
  const cre = round1(creIn);
  let tot = round1(nat + cre);

  const isFiveStep = (t) => (Math.round(t * 10) % 50) === 0;
  if (!isFiveStep(tot)) return { nat, cre, tot };

  const deltas = [0.1, 0.2, 0.3, 0.4];
  const tryNat = (dx) => {
    const n2 = round1(nat + dx);
    if (n2 < 0 || n2 > 50) return null;
    if (is05(frac1(n2)) && is05(frac1(cre))) return null;
    const t2 = round1(n2 + cre);
    if (!isFiveStep(t2)) return { nat: n2, cre, tot: t2 };
    return null;
  };

  for (const d of deltas.sort(() => Math.random() - 0.5)) {
    const r1 = tryNat(+d);
    if (r1) return r1;
    const r2 = tryNat(-d);
    if (r2) return r2;
  }
  return { nat, cre, tot };
}

function maybeSkewNatCre(natIn, creIn, p = 0.2) {
  let nat = round1(natIn),
    cre = round1(creIn);
  if (Math.random() >= p) return { nat, cre };

  const raiseNat = Math.random() < 0.5;
  const maxAddNat = Math.min(50 - nat, cre);
  const maxAddCre = Math.min(50 - cre, nat);
  const maxDelta = raiseNat ? maxAddNat : maxAddCre;

  const candidates = [];
  for (let d = 3.0; d <= 10.0; d += 0.1) {
    d = round1(d);
    if (d <= maxDelta) candidates.push(d);
  }
  if (!candidates.length) return { nat, cre };

  const delta = pick(candidates);
  if (raiseNat) {
    nat = round1(nat + delta);
    cre = round1(cre - delta);
  } else {
    cre = round1(cre + delta);
    nat = round1(nat - delta);
  }

  return { nat: clamp(nat, 0, 50), cre: clamp(cre, 0, 50) };
}

function tuneCommentByScore(comment, tot) {
  const t = (comment || "").trim();
  let min, max;

  if (tot <= 30) {
    min = 100;
    max = 200;
  } else if (tot <= 60) {
    min = 200;
    max = 350;
  } else {
    min = 350;
    max = 500;
  }

  if (t.length <= max) return t;

  const cut = t.slice(0, max);
  const idx = Math.max(
    cut.lastIndexOf("。"),
    cut.lastIndexOf("、"),
    cut.lastIndexOf("\n")
  );
  return (idx >= min ? cut.slice(0, idx + 1) : cut) + "…";
}

// ---------- ★ 日本語らしい文章かどうかの簡易チェック ----------
function isLikelyGoodJapaneseSentence(text) {
  const s = (text || "").trim();
  if (s.length < 30) return false;

  const jpChars = s.match(/[\u3040-\u30FF\u4E00-\u9FFF]/g) || [];
  if (jpChars.length < 10) return false;

  const hasPunct = /[。！？!?]/.test(s);
  return hasPunct;
}

// ------------------------- /api/eval -------------------------
app.post("/api/eval", async (req, res) => {
  try {
    const { text, word } = req.body || {};
    if (!text || !word) return res.status(400).json({ error: "text と word が必要です。" });

    const prompt = `
あなたは日本語文章の審査員です。以下の作品を読み、
自然さ nat（0〜50）、独創性 cre（0〜50）を採点し、tot = nat + cre を算出。

【造語】
意味は元々ないものとする。説明文と因果関係は不要。

【評価基準】
- 日本語として読めるなら OK（内容は無関係でもよい）
- nat/cre は文章そのものの自然さ・独自性で判断
- スコアは必ず小数第1位（整数禁止）
- コメントは感想のみ（助言禁止）

JSON 形式：
{"nat": number, "cre": number, "tot": number, "comment": string}

【造語】${word}
【文章】${text}
`.trim();

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 1.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "日本語で応答。JSON のみ返す。" },
        { role: "user", content: prompt },
      ],
    });

    let parsed;
    try {
      parsed = JSON.parse(response.choices[0]?.message?.content ?? "{}");
    } catch {
      return res.status(502).json({ error: "llm_parse_error" });
    }

    const textLen = (text || "").trim().length;

    // ---------- LLM 出力整形 ----------
    let nat = round1(clamp(parsed.nat, 0, 50));
    let cre = round1(clamp(parsed.cre, 0, 50));

    ({ nat, cre } = maybeSkewNatCre(nat, cre, 0.2));
    ({ nat, cre } = dequantizeNatCre(nat, cre));

    let tot = round1(clamp(nat + cre, 0, 100));
    ({ nat, cre, tot } = breakFiveStepTotal(nat, cre));

    // ---------- 下限点（短文でも一桁にならない） ----------
    let minTot = 0;
    if (textLen >= 5 && textLen < 20) minTot = 10;
    else if (textLen >= 20 && textLen < 60) minTot = 20;
    else if (textLen >= 60) minTot = 30;

    if (minTot > 0 && tot < minTot) {
      const diff = minTot - tot;
      const base = nat + cre;
      const share = base > 0 ? nat / base : 0.5;
      nat = round1(clamp(nat + diff * share, 0, 50));
      cre = round1(clamp(cre + diff * (1 - share), 0, 50));
      tot = round1(clamp(nat + cre, 0, 100));
    }

    // ---------- ★ 高得点確率ゲート（日本語の文章だけ対象） ----------
    const canUseLuckyGate = isLikelyGoodJapaneseSentence(text);

    if (canUseLuckyGate) {
      const r = Math.random();
      const p90 = 1 / 5000;
      const p70 = 1 / 1000;
      const p50 = 1 / 30;

      let tier = null;
      if (r < p90) tier = "90";
      else if (r < p70) tier = "70";
      else if (r < p50) tier = "50";

      if (tier) {
        let minT, maxT;
        if (tier === "90") {
          minT = 90;
          maxT = 100;
        } else if (tier === "70") {
          minT = 70;
          maxT = 90;
        } else {
          minT = 50;
          maxT = 70;
        }

        const targetTot = round1(minT + Math.random() * (maxT - minT - 0.1));
        const natMin = Math.max(0, targetTot - 50);
        const natMax = Math.min(50, targetTot);
        let natNew = round1(natMin + Math.random() * (natMax - natMin));
        let creNew = round1(targetTot - natNew);

        nat = natNew;
        cre = creNew;
        tot = round1(nat + cre);
      } else {
        if (tot > 50) {
          const scale = 49.9 / tot;
          nat = round1(nat * scale);
          cre = round1(cre * scale);
          tot = round1(nat + cre);
        }
      }
    } else {
      // 日本語として成立していない → 高得点禁止
      if (tot > 50) {
        const scale = 49.9 / tot;
        nat = round1(nat * scale);
        cre = round1(cre * scale);
        tot = round1(nat + cre);
      }
    }

    const comment = tuneCommentByScore(parsed.comment || "", tot);
    return res.json({ nat, cre, tot, comment });

  } catch (err) {
    console.error("API error:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

// ----------- ping -----------
app.get("/", (req, res) => {
  res.type("text/plain").send("OK: word-ai-eval-service is running.");
});

// ----------- start -----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running → http://localhost:${PORT}`);
});
