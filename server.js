// ============================================================================
// Word AI Evaluation Service - 完全版
// 造語＋説明文を受け取り、AIによる採点とコメントを返すAPIサーバー
// 仕様:
//  - 日本語としてそれなりに書いてあれば一桁続出を防ぐ下限スコア
//  - 「ちゃんとした日本語」のみ高得点ガチャ(50/70/90点帯)を適用
//  - そのうえで約10%は30点以上になるボーナス
// ============================================================================

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

// tot が 5点刻みに吸着していたら、合計を±0.1〜0.4ずらす
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
    const r1 = tryNat(+d); if (r1) return r1;
    const r2 = tryNat(-d); if (r2) return r2;
  }
  return { nat, cre, tot };
}

// nat/cre に少し偏りを付ける（合計はおおむね維持）
function maybeSkewNatCre(natIn, creIn, p = 0.2) {
  let nat = round1(natIn), cre = round1(creIn);
  if (Math.random() >= p) return { nat, cre };

  const raiseNat = Math.random() < 0.5;
  const maxAddNat = Math.min(50 - nat, cre);
  const maxAddCre = Math.min(50 - cre, nat);
  const maxDelta  = raiseNat ? maxAddNat : maxAddCre;

  const candidates = [];
  for (let d = 3.0; d <= 10.0; d += 0.1) {
    d = round1(d);
    if (d <= maxDelta) candidates.push(d);
  }
  if (!candidates.length) return { nat, cre };

  const delta = pick(candidates);
  if (raiseNat) { nat = round1(nat + delta); cre = round1(cre - delta); }
  else          { cre = round1(cre + delta); nat = round1(nat - delta); }

  return { nat: clamp(nat, 0, 50), cre: clamp(cre, 0, 50) };
}

// コメント長調整
function tuneCommentByScore(comment, tot) {
  const t = (comment || "").trim();
  let min, max;

  if (tot <= 30) {
    min = 100; max = 200;
  } else if (tot <= 60) {
    min = 200; max = 350;
  } else {
    min = 350; max = 500;
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

// 日本語としてそれなりの文章かどうかの簡易チェック（ゆるめ）
function isLikelyGoodJapaneseSentence(text) {
  const s = (text || "").trim();
  if (s.length < 15) return false;             // 15文字未満はさすがに短すぎ
  const jpChars = s.match(/[\u3040-\u30FF\u4E00-\u9FFF]/g) || [];
  if (jpChars.length < 8) return false;        // 日本語っぽい文字が少なすぎる場合
  // 句読点がなくてもOK（会話文や短文にも対応）
  return true;
}

// ------------------------- /api/eval -------------------------
app.post("/api/eval", async (req, res) => {
  try {
    const { text, word } = req.body || {};
    if (!text || !word) {
      return res.status(400).json({ error: "text と word が必要です。" });
    }

    const prompt = `
あなたは日本語文章の審査員です。以下の作品を読み、
1) 自然さ nat（0〜50）
2) 独創性 cre（0〜50）
を採点し、合計 tot（0〜100）を算出してください。

【造語について】
- 造語には元々の意味はないとみなす。
- 説明文が造語の意味や由来を論理的に説明している必要はない。
- 説明文が日本語として成立していれば、それだけで評価対象として十分とする。

【評価基準】
- 文としておおむね読めれば「解釈可能」とする（内容が荒唐無稽でもよい）。
- nat, cre は文章そのものの自然さ・表現力・独自性に基づいて判断する。

【スコア表現ルール】
- nat, cre は 0〜50 の実数。
- スコアは必ず小数第1位（例: 27.3）。整数のみは禁止。
- tot は nat + cre を小数第1位で丸めた値。
- コメントは感想のみとし、助言・指示・改善案は書かない。

出力は JSON のみ：
{"nat": number, "cre": number, "tot": number, "comment": string}

【造語】${word}
【文章】${text}
`.trim();

    // ---------- LLM 呼び出し ----------
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 1.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "日本語で応答。必ず JSON オブジェクトのみを返す。" },
        { role: "user", content: prompt }
      ],
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(502).json({ error: "llm_parse_error", raw });
    }

    const textLen = (text || "").trim().length;

    // ---------- LLM 出力を整形 ----------
    let nat = round1(clamp(parsed.nat, 0, 50));
    let cre = round1(clamp(parsed.cre, 0, 50));

    // 軽く偏りをつける
    ({ nat, cre } = maybeSkewNatCre(nat, cre, 0.2));

    // .0/.5 端数を避ける
    ({ nat, cre } = dequantizeNatCre(nat, cre));

    // 合計
    let tot = round1(clamp(nat + cre, 0, 100));

    // 5点刻み吸着回避
    ({ nat, cre, tot } = breakFiveStepTotal(nat, cre));

    // ---------- 文字数による下限スコア（平均を上げる） ----------
    // 1〜14文字: 最低10点
    // 15〜39文字: 最低20点
    // 40文字以上: 最低30点
    let minTot = 0;
    if (textLen >= 1 && textLen < 15) {
      minTot = 10;
    } else if (textLen >= 15 && textLen < 40) {
      minTot = 20;
    } else if (textLen >= 40) {
      minTot = 30;
    }

    if (minTot > 0 && tot < minTot) {
      const diff  = minTot - tot;
      const base  = nat + cre;
      const share = base > 0 ? nat / base : 0.5;
      nat = round1(clamp(nat + diff * share, 0, 50));
      cre = round1(clamp(cre + diff * (1 - share), 0, 50));
      tot = round1(clamp(nat + cre, 0, 100));
    }

    // ---------- 高得点の確率ゲート（日本語としてそれなりの文章だけ） ----------
    const canUseLuckyGate = isLikelyGoodJapaneseSentence(text);

    if (canUseLuckyGate) {
      // 高得点ガチャ
      const r  = Math.random();
      const p90 = 1 / 5000; // 90〜100点帯
      const p70 = 1 / 1000; // 70〜90点帯
      const p50 = 1 / 30;   // 50〜70点帯

      let tier = null;
      if (r < p90)       tier = "90";
      else if (r < p70)  tier = "70";
      else if (r < p50)  tier = "50";

      if (tier) {
        let minT, maxT;
        if (tier === "90") {
          minT = 90.0; maxT = 100.0;
        } else if (tier === "70") {
          minT = 70.0; maxT = 90.0;
        } else { // "50"
          minT = 50.0; maxT = 70.0;
        }

        // その帯の中でランダムな tot を決める
        const span = maxT - minT - 0.1; // 端を少し避ける
        const targetTot = round1(minT + Math.random() * span);

        // nat/cre を targetTot に合わせて再構成
        const natMin = Math.max(0, targetTot - 50);
        const natMax = Math.min(50, targetTot);
        let natNew = round1(natMin + Math.random() * (natMax - natMin));
        let creNew = round1(targetTot - natNew);

        nat = round1(clamp(natNew, 0, 50));
        cre = round1(clamp(creNew, 0, 50));
        tot = round1(clamp(nat + cre, 0, 100));
      } else {
        // ガチャ外れ：50点を超えていれば 49.9 に抑える
        if (tot > 50) {
          const scale = 49.9 / tot;
          nat = round1(clamp(nat * scale, 0, 50));
          cre = round1(clamp(cre * scale, 0, 50));
          tot = round1(clamp(nat + cre, 0, 100));
        }
      }
    } else {
      // 日本語として成立していない or 短すぎる → 高得点ガチャ無効、50点超は禁止
      if (tot > 50) {
        const scale = 49.9 / tot;
        nat = round1(clamp(nat * scale, 0, 50));
        cre = round1(clamp(cre * scale, 0, 50));
        tot = round1(clamp(nat + cre, 0, 100));
      }
    }

    // ---------- 30点以上ボーナス（ちゃんとした日本語だけ・約10%） ----------
    if (isLikelyGoodJapaneseSentence(text)) {
      const r2 = Math.random();
      if (r2 < 0.10 && tot < 30) {
        // 30〜49.9点に引き上げ（50点以上の分布は確率ゲートに任せる）
        const targetTot2 = round1(30 + Math.random() * 19.8); // 30〜49.8くらい
        const base  = nat + cre || 1;
        const share = nat / base;
        let natNew = round1(clamp(targetTot2 * share, 0, 50));
        let creNew = round1(clamp(targetTot2 - natNew, 0, 50));
        nat = natNew;
        cre = creNew;
        tot = round1(clamp(nat + cre, 0, 100));
      }
    }

    // ---------- コメント長調整 ----------
    const comment = tuneCommentByScore((parsed.comment || "").toString(), tot);

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
