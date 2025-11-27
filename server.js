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

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.json());
app.use(express.static(".")); // 同フォルダの new-word.html を配信

// ======================
// ユーティリティ
// ======================
const clamp = (v,min,max)=>Math.max(min,Math.min(max,v));
const rp = (arr)=>arr[Math.floor(Math.random()*arr.length)];
const U  = (a,b)=>a + Math.random()*(b-a);

// --- 指定の“出目”を満たす合計点トス ---
// ・平均はだいたい 35 点帯
// ・1/1000 ≈ 90+、1/500 ≈ 70+、1/100 ≈ 50超、1/100 ≈ 10未満
// （上位バンドは下位を内包しないよう階層化）
function sampleTotal() {
  const r = Math.random();
  if (r < 0.001) {             // 0.1% → 90〜100
    return U(90, 100);
  } else if (r < 0.001 + 0.002) { // 0.2% → 70〜90
    return U(70, 90);
  } else if (r < 0.001 + 0.002 + 0.01) { // 1% → 50〜70
    return U(50, 70);
  } else if (r < 0.001 + 0.002 + 0.01 + 0.01) { // 1% → 0〜10
    return U(0, 10);
  } else {
    // 残り（約97.7%）は 20〜50 を中心にゆらぐ（平均≒35）
    // 三角分布で 20..50 の間に山（モード ≈ 35）
    const a = 20, b = 50, c = 35;
    const r1 = Math.random(), r2 = Math.random();
    const tri = (r1 < (c-a)/(b-a))
      ? a + Math.sqrt(r1*(b-a)*(c-a))
      : b - Math.sqrt((1-r1)*(b-a)*(b-c));
    // 微小なノイズで停滞回避
    return clamp(tri + (r2-0.5)*2.0, 0, 100);
  }
}

// 合計点を自然さ/独創性（各0..50）に分割
function splitNatCre(tot){
  // nat:cre の比率は 0.35〜0.65 の間でランダム
  const share = U(0.35, 0.65);
  let nat = clamp(tot*share, 0, 50);
  let cre = clamp(tot - nat, 0, 50);
  // どちらかが50で切れたらもう片方を微調整
  if (nat + cre !== tot){
    const diff = tot - (nat + cre);
    if (nat < 50) nat = clamp(nat + diff, 0, 50);
    else          cre = clamp(cre + diff, 0, 50);
  }
  // 小数1桁
  return { nat: +nat.toFixed(1), cre: +cre.toFixed(1) };
}

// “コメントそのもの”を採点点数に応じて演出（低=ボロクソ／高=美辞麗句）
function spicyComment({ tot, word }) {
  const tag = word ? `《${word}》` : "";
  const T = +tot;

  // バリエーションを大きく（テンペレート=100相当）
  const ultraPraise = [
    "神話が更新された。言葉が本能を直撃し、理性が追いつかない。",
    "花火の芯だけが夜空に残る。眩しく、潔く、完璧だ。",
    "言葉の刃が無音で通過した。遅れて拍手と鳥肌が来る。",
    "天井が割れた。比喩が現実になってしまったみたいだ。",
    "呼吸のリズムが狂う。美しさが物理現象になった瞬間。"
  ];
  const highPraise = [
    "鋭い。最後の一打で名勝負に化ける手前だ。",
    "一文ごとに温度が上がる。あと半歩で沸点。",
    "視線を攫う重心。着地だけ、より高く。",
    "余白の使い方が巧い。締めの一言で刺青にしよう。"
  ];
  const midNeutral = [
    "悪くない。骨はある。もっと肉をのせて動かせ。",
    "輪郭は見えた。焦点距離を固定して撃ち抜け。",
    "半熟。熱をもう少し。言い換え一回で化ける。",
    "芯はある。周辺のノイズを削れば見違える。"
  ];
  const lowRoast = [
    "記憶に残らない。明日には跡形もなく消える薄さだ。",
    "無風。比喩も意外性も来ない。心拍数が動かない。",
    "読後に何も残らない。氷水でもぬるま湯でもない中途半端。",
    "地味に弱い。句点ごとに眠くなる。"
  ];
  const brutal = [
    "これは砂。噛んでも噛んでも味が出ない。",
    "言葉の骨が折れている。立たない。歩けない。走れない。",
    "曇天。雷も虹も来ない。ページを閉じたくなる。",
    "読後に真空が広がる。何も掴めない。"
  ];

  // スコア帯
  if (T >= 90) {
    return `${tag}【S】${rp(ultraPraise)}\n👑 完璧の上に遊びがある。拍手。`;
  } else if (T >= 70) {
    return `${tag}【A】${rp(highPraise)}\n✨ あと一段、火力を。`;
  } else if (T >= 50) {
    return `${tag}【B】${rp(midNeutral)}\n🔧 主要語を一つ“太字のつもり”で置け。`;
  } else if (T >= 10) {
    return `${tag}【D】${rp(lowRoast)}\n🧪 主語→動詞→着地の三連だけでも整う。`;
  } else {
    return `${tag}【F】${rp(brutal)}\n🧨 最初の一文に牙を。いまのままでは噛まれない。`;
  }
}

// ========================================
// /api/eval
// ========================================
app.post("/api/eval", async (req, res) => {
  try {
    const { text, word } = req.body || {};
    if (!text || !word) {
      return res.status(400).json({ error: "text と word が必要です。" });
    }

    // ---- 参考程度のLLM採点（コメント原文として保持）。多様性のため温度↑ ----
    // ※ ここは“コメント内容の方法論”ではなく、作品そのものの出来栄えを
    //    率直に評する口調に寄せています（ただし最終表示は comment_spicy を推奨）。
    const prompt = `
JSONのみで返答。次の文章の出来栄えを、容赦なく短評してください。
- 自然さ(nat 0-100) と 独創性(cre 0-100) も返す（小数一点OK）
- 文章そのものを直球で評価。助言は最小限、比喩や断言で面白く。
- 出力は {"nat":..,"cre":..,"comment":".."} の1オブジェクトのみ。

造語: ${word}
文章: ${text}`.trim();

    let llmNat = 30, llmCre = 40, llmComment = "—";
    try {
      const response = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 1.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "日本語で短評だけ返す。JSON以外は書かない。" },
          { role: "user", content: prompt }
        ],
      });
      const content = response.choices[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(content);
      llmNat = clamp(+parsed.nat || 0, 0, 100);
      llmCre = clamp(+parsed.cre || 0, 0, 100);
      llmComment = (parsed.comment || "").toString();
    } catch {
      // LLM失敗時はダミー
      llmNat = 30 + (text.length % 15);
      llmCre = 40 + ((text.length * 7) % 15);
      llmComment = "（AI原文）短評生成に失敗したためダミー。";
    }

    // ---- 指定分布で合計点をサンプリング ----
    let tot = sampleTotal();

    // ---- 合計に合わせて nat/cre を分割（0..50） ----
    let { nat, cre } = splitNatCre(tot);

    // 小数1桁で整形
    tot = +tot.toFixed(1);

    // ---- “楽しい”スパイシー短評（点数帯で美辞麗句/ボロクソ） ----
    const comment_spicy = spicyComment({ tot, word });

    // 返却：クライアントは comment_spicy を優先表示、必要なら comment も併記
    return res.json({
      nat,            // 0..50
      cre,            // 0..50
      tot,            // 0..100（分布は要件どおり）
      comment: llmComment,     // AI原文（参考／併記用）
      comment_spicy             // サーバーが生成する“ゲーム風”短評
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
