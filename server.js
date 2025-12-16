// ============================================================================
// Word AI Evaluation Service - Server
// ============================================================================
// 造語と文章を受け取り、AIによる採点とコメントを返すAPIサーバー
// 
// 主な機能:
// - OpenAI APIを使用した自然さ・独創性の採点
// - 得点に応じた動的なコメント生成（低得点=辛口、高得点=美辞麗句）
// - スコアの偏り生成と端数処理によるバリエーション確保
// 
// エンドポイント:
// - POST /api/eval : 採点リクエスト { text, word } → { nat, cre, tot, comment }
// - GET /         : ヘルスチェック
// ============================================================================
// 履歴 
// 25.11.28 cloud 平均点30点に調整,得点に応じたコメント長の動的変更,得点によるトーンの変更
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

  const raiseNat = Math.random() < 0.5; // どちらを上げるか
  const maxAddNat = Math.min(50 - nat, cre);
  const maxAddCre = Math.min(50 - cre, nat);
  const maxDelta  = raiseNat ? maxAddNat : maxAddCre;

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


// ------------------------- /api/eval -------------------------
app.post("/api/eval", async (req, res) => {
  try {
    const { text, word } = req.body || {};
    if (!text || !word) {
      return res.status(400).json({ error: "text と word が必要です。" });
    }

    // ★ MODIFIED: 平均30点、得点別トーン変更
    const prompt = `
あなたは厳格な審査員です。以下の作品を読み、
1) 自然さ nat（0〜50）
2) 独創性 cre（0〜50）
を採点し、合計 tot = nat + cre（0〜100）を算出してください。
元々意味のない言葉に、適当に考えた意味なので、フィーリングで判断すること。
考えた意味が、文章になっていない場合は低い得点。

厳守：
- 採点は**非常に厳格**。全体の平均は**総合20点前後**に収まるのが自然。**40以上は50%未満、50以上は40%未満、60以上は30%未満、70以上は10%未満 80以上は5%未満**の"稀"な評価とする。
- スコアは**必ず小数第1位**（例: 27.3）。**整数のみ禁止**。
- **.0 と .5 に偏らせない**（nat と cre のどちらかは .0/.5 以外の端数）。
- **tot は nat + cre を小数第1位で丸めた値**。
- ときどき **nat と cre に大きめの差**が出ても良い（偏り歓迎）。

【コメントのトーンと長さ】得点によって以下のように変える：
- totが 0〜15点（低得点）:
  - 辛辣でぼろくそに批評。容赦なく欠点を指摘し、厳しい言葉で評価。ただし人格攻撃や侮辱はしない。ただし最後に励ましを一言入れる。
  - コメントは必ず 50〜100字の範囲に収めること。

- totが 15〜30点（低得点）:
  - 客観的。良い点と、課題点を半々くらいに述べる。良い点も必ず一つは入れる。
  - コメントは必ず 50〜100字の範囲に収めること。

- totが 31〜50点（中得点）:
  - 良い点を中心にコメントする。最後に一言、課題や改善点を述べる。
  - コメントは必ず 100〜150字の範囲に収めること。

- totが 51〜70点（高得点）:
  - 良い点を中心にコメントし、課題や改善点は述べない。
  - コメントは必ず 150〜200字の範囲に収めること。

- totが 71〜100点（超得点）:
  - 美辞麗句を尽くして絶賛。詩的で華やかな表現を使い、作品の素晴らしさを讃える。課題や改善点は全く入れず、最初から最後までとにかく褒めちぎる。
  - コメントは必ず 200〜250字の範囲に収めること。

コメントは「感想」のみ。指示・改善案は禁止。
出力は **JSONのみ**：{"nat": number, "cre": number, "tot": number, "comment": string}

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

    // ★ MODIFIED: 得点に応じたコメント長調整
    const comment = (parsed.comment || "").toString();
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