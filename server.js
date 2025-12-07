// ------------------------- /api/eval -------------------------
app.post("/api/eval", async (req, res) => {
  try {
    const { text, word } = req.body || {};
    if (!text || !word) {
      return res.status(400).json({ error: "text と word が必要です。" });
    }

    // ★ 修正版プロンプト：平均30〜40点・たまに70点以上も出る

    const prompt = `
あなたは厳格だが公平な審査員です。以下の作品を読み、
1) 自然さ nat（0〜50）
2) 独創性 cre（0〜50）
を採点し、合計 tot = nat + cre（0〜100）を算出してください。

【全体の分布ルール】
- 採点は**やや厳格**だが、不当に低得点に寄せない。
- 全体の平均は**総合30〜40点程度**を目安とする。
- **60点以上の作品は全体の5〜10%程度**出てよい。
- **70点以上は1000回に数回程度（0.1〜0.5%程度）発生してよいレベルの“優れた作品”**とする。
- **80点以上はごく稀だが、不可能ではない特別な評価**とする。

【スコア表現のルール】
- スコアは**必ず小数第1位**（例: 27.3）。**整数のみは禁止**。
- **.0 と .5 に偏らせない**（nat と cre のどちらかは .0/.5 以外の端数にする）。
- **tot は nat + cre を小数第1位で丸めた値**。
- ときどき **nat と cre に大きめの差**が出ても良い（偏り歓迎）。

【文章の質と下限スコアの関係】
- 次の条件を満たす場合、「きちんと内容が書かれている普通の文章」とみなす：
  - 文としておおむね文法的に成立している（主語と述語の対応などが崩壊していない）。
  - 全体として何について書かれているかが理解できる（テーマや話題が分かる）。
  - 同じ語の連打や意味不明な記号列のみではない。
- この「きちんとした普通の文章」に対しては、原則として以下を守ること：
  - **合計 tot を 10点未満にはしない。**
  - よほど稚拙でちぐはぐな内容でない限り、**tot は 20点前後〜40点台に収まりやすくする。**
  - 明らかに平均的な出来の文章なら、**tot 30〜50点程度**を目安とする。
- 逆に、**合計 tot が 0〜9.9 点となるのは、ほぼ「解釈不能に近いレベル」の場合に限る。**

【解釈不能の扱い】
- 入力された造語や文章が、意味を成さず、まともな内容として解釈できない場合（例：同じ文字の連打のみ、文章として成立していない断片だけなど）は、「解釈不能」と判断する。
  - このとき nat と cre は 0〜5 点の範囲に収め、tot もそれに対応する低い値にする。
- それ以外の、テーマや内容が理解できる普通の文章の場合は、「解釈不能」とはせず、上記の下限ルールにしたがって通常どおり採点する。

【コメントのトーンと長さ】得点によって以下のように変える：
- **0-30点（低得点）**: **辛辣でぼろくそに批評**。容赦なく欠点を指摘し、厳しい言葉で評価。ただし人格攻撃や侮辱はしない。**100-200字程度**。
- **31-60点（中得点）**: 冷静かつ客観的。良い点と課題点をバランスよく。**200-350字程度**。
- **61-100点（高得点）**: **美辞麗句を尽くして絶賛**。詩的で華やかな表現を使い、作品の素晴らしさを讃える。比喩や情緒的な言葉を多用。**350-500字程度**。

コメントは「感想」のみ。助言・提案・指示・改善案は禁止。

出力は **JSONのみ**：
{"nat": number, "cre": number, "tot": number, "comment": string, "uninterpretable": boolean}

【造語】${word}
【文章】${text}
`.trim();

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      // ★ バリエーションをさらに出すために少し高め
      temperature: 1.5,
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

    // LLM が「解釈不能」と判定した場合は、ここで低得点＋専用コメントを返して終了
    if (parsed.uninterpretable === true) {
      const nat = round1(clamp(parsed.nat, 0, 5));
      const cre = round1(clamp(parsed.cre, 0, 5));
      const tot = round1(clamp(nat + cre, 0, 10));
      const comment =
        "入力された文章から一貫した意味や内容を読み取ることができませんでした。そのため、評価は低くなります。内容や意図が伝わるように、もう少し具体的に書き直してみてください。";
      return res.json({ nat, cre, tot, comment });
    }

    // 0.1刻み＆範囲
    let nat = round1(clamp(parsed.nat, 0, 50));
    let cre = round1(clamp(parsed.cre, 0, 50));

    ({ nat, cre } = maybeSkewNatCre(nat, cre, 0.35));

    // 端数散らし（両方 .0/.5 の場合）
    ({ nat, cre } = dequantizeNatCre(nat, cre));

    // 合計（0.1刻み）
    let tot = round1(clamp(nat + cre, 0, 100));

    // 5点吸着の回避
    ({ nat, cre, tot } = breakFiveStepTotal(nat, cre, tot));

    // 得点に応じたコメント長調整
    const comment = tuneCommentByScore((parsed.comment || "").toString(), tot);

    return res.json({ nat, cre, tot, comment });
  } catch (err) {
    console.error("API error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});
