// ------------------------- /api/eval -------------------------

// ------------------------- /api/eval -------------------------
app.post("/api/eval", async (req, res) => {
  try {
    const { text, word } = req.body || {};
    if (!text || !word) {
      return res.status(400).json({ error: "text と word が必要です。" });
    }




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

【造語と説明文の関係について】
- ここで扱う「造語」には、もともと明確な意味はないものと仮定する。
- 説明文が、その造語の意味や由来を論理的・因果的に説明している必要は**まったくない**。
- 説明文が「日本語として文法的に成立している」「おおまかな内容や情景が読める」のであれば、
  それだけで**評価対象として十分な文章**とみなす。
- 造語と無関係なテーマの文章であってもよい。その場合は、
  「日本語としての自然さ」「表現の豊かさ・独自性」に基づいて nat / cre を評価する。

【文章の質と下限スコアの関係】
- 次の条件を満たす場合、「きちんと内容が書かれている普通の文章」とみなす：
  - 日本語として文法的におおむね成立している（主語と述語の対応などが完全に崩壊していない）。
  - 全体として何について書かれているかが理解できる（話題や状況がイメージできる）。
  - 同じ語の連打や無意味な記号列のみではなく、複数の語句から構成されている。
- この「きちんとした普通の文章」に対しては、原則として以下を守ること：
  - **合計 tot を 10点未満にはしない。**
  - よほど稚拙でちぐはぐな内容でない限り、**tot は 20点前後〜40点台に収まりやすくする。**
  - 明らかに平均的な出来の文章なら、**tot 30〜50点程度**を目安とする。
- **内容が荒唐無稽であっても、造語と無関係であっても、日本語として読めるなら「解釈不能」とはみなさない。**

【解釈不能の扱い】
- 次のような場合のみ、「解釈不能」と判断する：
  - 同じ文字・記号の連打が大部分を占め、文としての構造がほとんどない。
  - 単語や文節の断片がバラバラに並んでいるだけで、文としてつながっていない。
  - 全体の文字数が非常に少なく（目安として10文字未満）、話題や内容を読み取ることがほぼ不可能である。
- 「解釈不能」と判断した場合：
  - nat と cre は 0〜5 点の範囲に収め、tot もそれに対応する低い値にする。
- それ以外の、ある程度の長さがあり、日本語の文章として成立しているものについては、
  たとえ内容が奇妙であっても「解釈不能」とはせず、通常どおり採点する。

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

    const textLen = (text || "").trim().length;

    // ---------------- 解釈不能ルート ----------------
    // LLM が uninterpretable=true を出してきても、
    // ある程度の長さがある文章なら「解釈不能」とは扱わない。
    if (parsed.uninterpretable === true && textLen < 15) {
      const nat = round1(clamp(parsed.nat, 0, 5));
      const cre = round1(clamp(parsed.cre, 0, 5));
      const tot = round1(clamp(nat + cre, 0, 10));
      const comment =
        "入力された文章から一貫した意味や内容を読み取ることができませんでした。そのため、評価は低くなります。内容や意図が伝わるように、もう少し具体的に書き直してみてください。";
      return res.json({ nat, cre, tot, comment });
    }

    // ---------------- 通常ルート ----------------
    // 0.1刻み＆範囲
    let nat = round1(clamp(parsed.nat, 0, 50));
    let cre = round1(clamp(parsed.cre, 0, 50));

    // ★ 第1段階：LLM が極端に低く出してきた場合のソフト底上げ
    let totRaw = round1(clamp(nat + cre, 0, 100));
    if (textLen >= 10 && totRaw < 20) {
      const bump = 20 - totRaw; // 合計が20になるように増やす
      const addNat = Math.min(bump / 2, 50 - nat);
      const addCre = Math.min(bump - addNat, 50 - cre);
      nat = round1(clamp(nat + addNat, 0, 50));
      cre = round1(clamp(cre + addCre, 0, 50));
      totRaw = round1(clamp(nat + cre, 0, 100));
    }

    // 時々デコボコ（偏り）にする（合計は維持される）
    ({ nat, cre } = maybeSkewNatCre(nat, cre, 0.15));

    // 端数散らし（両方 .0/.5 の場合）
    ({ nat, cre } = dequantizeNatCre(nat, cre));

    // 合計（0.1刻み）
    let tot = round1(clamp(nat + cre, 0, 100));

    // 5点吸着の回避
    ({ nat, cre, tot } = breakFiveStepTotal(nat, cre, tot));

    // ★ 第2段階：最終的なハード下限（ここで完全に止めを刺す）
    if (textLen >= 10 && tot < 20) {
      const bump2 = 20 - tot;
      const addNat2 = Math.min(bump2 / 2, 50 - nat);
      const addCre2 = Math.min(bump2 - addNat2, 50 - cre);
      nat = round1(clamp(nat + addNat2, 0, 50));
      cre = round1(clamp(cre + addCre2, 0, 50));
      tot = round1(clamp(nat + cre, 0, 100));
    }

    // 得点に応じたコメント長調整
    const comment = tuneCommentByScore((parsed.comment || "").toString(), tot);

    return res.json({ nat, cre, tot, comment });
  } catch (err) {
    console.error("API error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

