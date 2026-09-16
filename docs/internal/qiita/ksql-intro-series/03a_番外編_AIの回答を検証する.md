<!-- タイトル案: 【kSQL 実践 番外編】Claude に ABC 分析の SQL を書かせて検証したら、2 回とも違う形で間違えた -->
<!-- 投稿時タグ案: kintone, SQL, Claude, MCP, AI -->
<!--
状態: 草稿 R3・**公開可（第 9 回と合わせて）**（2026-09-16 R3: v3.78.0 リリース後に §4・§5・まとめ 5 行を追加。当初の方針: 第 3〜8 回を先に公開し、B181・B182・B183 の対応とリリース後に、本稿へ「4. 作り方を MCP に組み込む（B183・before/after）」「5. 正本を直す（B181・B182 修正後に 1〜2 巡目の SQL を再実行）」を足して 1 本の番外編として完成させ、第 9 回と合わせて公開する。旧 03b の構成案は本稿末尾のコメントに統合）。R2: 3 巡目「作り方のルールを前置き」を追加: user が kSQL作成ルール_試験用.md の 21 項目 + 改訂前の依頼文を Claude Desktop に渡した結果を Claude Code が実行し、10 行・順位・区分すべて第 3 回の表と一致（列順と FROM の向きだけ違い、後者は Claude が推測と明示）。R1: 第 3 回 R8〜R9 の「Claude が書いた SQL を検証する」を分離して独立記事に。実測はすべて計画書 §9.8 の第 3 回 R8/R9 メモのとおり。公開可）。ルール全文は第 9 回に載せる予定（第 9 回未反映）。
公開前チェック: 第 3 回の URL（冒頭）／第 9 回の URL（末尾・公開後）／課題台帳の B181・B182 が GitHub に push 済みであること／このコメント自体を削除
掲載 SQL と結果は §1〜3 が v3.77.0 の MCP、§4〜5 が v3.78.0（dev profile・CLI）で実行。Claude の回答は user が Claude Desktop で取得したものを原文のまま（抜粋）掲載。手元環境は顧客管理 215 件・案件管理 20 件
-->
<!-- 計画書へのリンク（docs-check 用・公開時は削除）: [計画書.md](計画書.md) -->

> **結論（3 行）**
>
> - 第 3 回の依頼文で Claude Desktop に ABC 分析の SQL を書かせたところ、`ksql_validate` と `ksql_explain` は通り、**実行で止まりました**。原因は列別名の英字が小文字に正規化される仕様で、Claude 自身の原因説明は 2 つとも外れでした
> - 依頼文を直して書かせ直すと、今度は**エラーなく実行でき、結果が静かに間違っていました**。`COALESCE(SUM(…), 0)` で 0 埋めした列が型を失い、順位・累計・並び順が文字列順になっていました
> - 依頼文を戻し、代わりに kSQL の作り方を 21 項目のルールとして先頭に置くと、**同じ依頼で 1 回目から正しい結果**になりました。依頼文は「何を出すか」、ルールは「どう書くか」。それでも実行して結果を見る工程は人間の側に残ります
> - 見つかった 2 件は kSQL v3.78.0 で直し、ルールの要点は MCP の instructions に組み込みました。修正後は元の依頼文のままで正しい結果になりますが、**SQL の形を変えたのはエンジンの修正で、instructions は作法までは変えませんでした**（3 回実測）

[第 3 回: ABC 分析](https://qiita.com/rex0220/items/d417ba52766f73cb965d)の課題を Claude に頼む依頼文を書き、実際に Claude Desktop（kSQL MCP 導入済み）へ渡して、返ってきた SQL を検証した記録です。本編の題材から外れるので番外編に分けました。

依頼文はこれです。

```text
kSQL MCP で、APP4149（案件管理）の売上を APP4148（顧客管理）の会社別に集計し、
売上の大きい順に順位・構成比・累積構成比を付けて、累積 80% までを A、95% までを B、残りを C に区分する SQL を書いてください。
集計・ウィンドウ・区分の 3 段の CTE に分け、累計のフレームは ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW を明示し、
ORDER BY は会社名までのタイブレークを付けてください。ksql_validate で検証してください。実行はしないでください。
```

## 1 巡目 — validate も explain も通り、実行で止まる

返ってきた SQL です（`win` 段は第 3 回の `ranked` とほぼ同じで、`ROW_NUMBER` と `顧客No` までのタイブレークを使っています）。Claude は `ksql_validate` で `ok: true` を確認し、依頼どおり実行はしていません。

```sql
WITH agg AS (
  SELECT c.顧客No AS 顧客No, c.会社名 AS 会社名, SUM(d.売上) AS 売上合計
  FROM APP4148 AS c
  INNER JOIN APP4149 AS d ON d.顧客No_ = c.顧客No
  GROUP BY c.顧客No, c.会社名
), win AS (
  SELECT 顧客No, 会社名, 売上合計,
         ROW_NUMBER() OVER (ORDER BY 売上合計 DESC, 会社名 ASC, 顧客No ASC) AS 順位,
         SUM(売上合計) OVER () AS 総計,
         SUM(売上合計) OVER (ORDER BY 売上合計 DESC, 会社名 ASC, 顧客No ASC
                            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS 累計
  FROM agg
), ranked AS (
  SELECT 順位, 顧客No, 会社名, 売上合計,
         ROUND(売上合計 * 100.0 / 総計, 2) AS 構成比,
         ROUND(累計 * 100.0 / 総計, 2) AS 累積構成比,
         CASE WHEN 累計 * 100.0 / 総計 <= 80 THEN 'A'
              WHEN 累計 * 100.0 / 総計 <= 95 THEN 'B' ELSE 'C' END AS ABC区分
  FROM win
)
SELECT 順位, 顧客No, 会社名, 売上合計, 構成比, 累積構成比, ABC区分
FROM ranked
ORDER BY 順位 ASC, 売上合計 DESC, 会社名 ASC
```

構造は第 3 回と同じ 3 段で、`ROWS` の明示もタイブレークも入っています。ところが実行すると止まります（`EXPLAIN` は通ります）。

```text
ArgumentError: unknown field code(s): 顧客No (agg)
```

### 原因は別名の小文字正規化

第 0 回の早見表に「**結果列名の英字は小文字に正規化される**」と書きました。`c.顧客No AS 顧客No` と書いた瞬間に、`agg` の列名は `顧客no` になります。次の段が `顧客No` で参照すると、正規化後の名前と一致せず解決できません。`ABC区分` も同じで、`abc区分` になっています。

切り分けの実測です。

| 書き方 | `validate` | `explain` | 実行 |
| :--- | :--- | :--- | :--- |
| `WITH t AS (SELECT 売上 AS Amount FROM APP4149) SELECT Amount FROM t` | ok | ok | `unknown field code(s): Amount (t)` |
| 同上、参照を `amount` に | ok | ok | 成功 |
| `WITH t AS (SELECT c.顧客No AS 顧客No … ) SELECT 顧客No FROM t` | ok | ok | `unknown field code(s): 顧客No (t)` |
| 同上、別名なしの `c.顧客No` | ok | ok | 成功（列名は `顧客No` のまま） |
| `SELECT 売上 AS Amount FROM APP4149 ORDER BY Amount` | ok | **`ORDER_KEY_UNRESOLVED`** | 同左 |

同じ文の `ORDER BY` だけは `EXPLAIN` が止めますが、CTE や一時テーブル越しの参照は実行まで通り抜けます。物理フィールドを「同じ名前」で別名にすると列名が変わる、というのが一番気づきにくい形です。対処は、`AS 顧客No` を外すか、参照側を `顧客no` / `abc区分` にするか、別名に英字を入れないことです。

### 直せたことと、理由が分かっていることは別

ここで実行を許可すると、Claude は 2 か所とも別名を変えて（`顧客番号`・`区分`）自力で通しました。対処は正しいのですが、原因の説明は「RECORD_NUMBER と同名の別名は CTE から参照できない」「CASE 式の別名か、英字と漢字の混在が解決されない」で、どちらも外れです。`順位` や `構成比` が通ったのは英字を含まないからで、`AS Amount` のような英字だけの別名も同じように失敗します。理由が違うと、次に同じ形を書いたときにまた踏みます。

直したうえで第 3 回の表と比べると、違いは 3 つです。

- 同額 0 の 2 社が `ROW_NUMBER` なので 9 位と 10 位になる（第 3 回は `RANK` で 9 位が 2 つ）
- 割合が小数第 2 位（第 3 回は第 1 位）
- 総計 0 のときの `CASE WHEN 総計 = 0` が無い（第 3 回の「境界条件」）

いずれも依頼文に書いていなかったことなので、Claude の誤りではなく依頼の不足です。逆に、依頼していない `顧客No` 列が結果に足されています。

## 依頼文を直す

見つかった差は、依頼文に足りなかったことの裏返しです。次の依頼文にすると、上の 6 点はすべて依頼の側で塞げます。

```text
kSQL MCP で、APP4149（案件管理）の売上を APP4148（顧客管理）の会社別に集計し、
売上の大きい順に順位・構成比・累積構成比を付けて、累積 80% までを A、95% までを B、残りを C に区分する SQL を書いてください。
集計・ウィンドウ・区分の 3 段の CTE に分け、累計のフレームは ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW を明示し、
ORDER BY は会社名までのタイブレークを付けてください。
順位は RANK()（同額は同順位）、割合は ROUND(…, 1)、総計が 0 のときは CASE WHEN 総計 = 0 で 0 と 'C' にしてください。
出力列は 順位・会社名・顧客ランク・案件数・売上合計・構成比・累積構成比・区分 だけにし、依頼していない列は足さないでください。
列の別名には英字を使わないでください（別名の英字は小文字に正規化され、次の段から元の名前で参照できません）。
ksql_validate で検証してください。実行はしないでください。
```

## 2 巡目 — エラーなく実行でき、結果が静かに間違う

この依頼文で Claude が返した SQL は、6 点をすべて満たしていました。別名は日本語だけ、`RANK`、`ROUND(…, 1)`、総計 0 のガード、列は指定どおり、タイブレークは会社名まで。`集計` 段だけ載せます。

```sql
WITH 集計 AS (
  SELECT 顧.会社名 AS 会社名, 顧.顧客ランク AS 顧客ランク,
         COUNT(案.案件No_) AS 案件数,
         COALESCE(SUM(案.売上), 0) AS 売上合計
  FROM APP4148 AS 顧
  LEFT JOIN APP4149 AS 案 ON 案.顧客No_ = 顧.顧客No
  GROUP BY 顧.会社名, 顧.顧客ランク
), …
```

`ksql_validate` も `ksql_explain` も通り、実行もエラーなく終わります。結果の先頭 8 行がこれです。

| 順位 | 会社名 | 売上合計 | 累積構成比 | 区分 |
| --: | :--- | --: | --: | :--- |
| 1 | 篠村食品株式会社 | 9,050,000 | 11.1 | A |
| 2 | 株式会社テクノロジーサービス | 7,200,000 | 19.9 | A |
| 3 | 株式会社橘川ケミカル | 6,700,000 | 28.1 | A |
| 4 | 平川ファイナンスサービス株式会社 | 5,400,000 | 34.7 | A |
| 5 | 橋本ネットワーク通信株式会社 | 3,600,000 | 39.1 | A |
| 6 | 株式会社サイボウズ商事 | 20,700,000 | 64.4 | A |
| 7 | 株式会社キントーンシステムズ | 15,550,000 | 83.4 | B |
| 8 | 株式会社倉本インターナショナル | 13,600,000 | 100.0 | C |

売上 2,070 万の会社が 6 位で、905 万の会社が 1 位です。順位・累計・並び順のすべてが**文字列の順**（`'9…' > '7…' > … > '2…' > '1…'`）で評価されています。

### 原因は `COALESCE` が型を持たないこと

`COALESCE(SUM(案.売上), 0)` は、案件の無い会社の売上を 0 にするために Claude が足したものです。値は正しいのですが、`COALESCE` の結果は型を持ちません。その列を `ORDER BY` やウィンドウの `ORDER BY` に使うと、言語リファレンス §10 の「型を確定できない式は文字列として並ぶ」規則が働きます。

| `集計` 段の書き方 | 並び |
| :--- | :--- |
| `SUM(案.売上)` | 数値順 |
| `COALESCE(SUM(案.売上), 0)` | **文字列順** |
| `CASE WHEN SUM(案.売上) = '' THEN 0 ELSE SUM(案.売上) END` | 数値順 |
| `SUM(COALESCE(案.売上, 0))` | 数値順 |
| `CAST(COALESCE(SUM(案.売上), 0) AS NUMBER)` | 数値順 |

さらに `COALESCE(SUM(…), 0) + 0` のように算術で包むと、値そのものが 0 になります（実測。JOIN も GROUP BY も無い `SELECT COALESCE(SUM(売上), 0) + 0 FROM APP4149` でも 0）。第 2 回で 0 埋めに `COALESCE` ではなく `CASE` を使ったのは、この型の問題を避けるためでもあります。

もう 1 つ、Claude は顧客管理を起点に `LEFT JOIN` を選び、案件の無い 205 社が売上 0・区分 C で末尾に並ぶ 215 行を返しました。依頼に「案件のある会社だけ」と無かったので、判断としては筋が通っています。ただし第 1 回のとおり `LEFT JOIN` では押し下げが効かず、顧客 215 件と案件 20 件を全件取ります。

## 3 巡目 — 作り方のルールを前置きする

依頼文を直す代わりに、kSQL の作り方を 21 項目のルールにして会話の先頭に貼り、依頼文は**1 巡目と同じ改訂前のもの**に戻して書かせました。ルールは第 0〜9 回の実測から出た規則で、たとえば「0 埋めは `CASE`、集計値を `COALESCE` で包まない」「別名に英字を使わない」「依頼された列だけ出す」「`ksql_describe_app` と `ksql_docs` を読んでから書く」です（全文は第 9 回に載せます）。

Claude は両アプリを `ksql_describe_app` で確認し、`ksql_docs` の R15・§10.1・§7・§13 を読んでから、次を返しました。

```sql
WITH 集計 AS (
  SELECT c.会社名, SUM(a.売上) AS 売上合計
  FROM APP4148 AS c
  INNER JOIN APP4149 AS a ON c.顧客No = a.顧客No_
  GROUP BY c.会社名
), 順位付き AS (
  SELECT 会社名, 売上合計,
         RANK() OVER (ORDER BY 売上合計 DESC) AS 順位,
         SUM(売上合計) OVER () AS 総計,
         SUM(売上合計) OVER (
           ORDER BY 売上合計 DESC, 会社名
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) AS 累計
  FROM 集計
)
SELECT 会社名, 売上合計, 順位,
       CASE WHEN 総計 = 0 THEN 0 ELSE ROUND(売上合計 * 100.0 / 総計, 1) END AS 構成比,
       CASE WHEN 総計 = 0 THEN 0 ELSE ROUND(累計 * 100.0 / 総計, 1) END AS 累積構成比,
       CASE WHEN 総計 = 0 THEN 'C'
            WHEN 累計 * 100.0 / 総計 <= 80 THEN 'A'
            WHEN 累計 * 100.0 / 総計 <= 95 THEN 'B'
            ELSE 'C' END AS 区分
FROM 順位付き
ORDER BY 売上合計 DESC, 会社名
```

実行すると 10 行で、順位・構成比・累積構成比・区分のすべてが第 3 回の表と一致しました（実測）。別名は日本語だけ、`COALESCE` は無く、`RANK` と `CASE WHEN 総計 = 0` が入り、依頼に無い列もありません。1 巡目と 2 巡目の誤りは、依頼文を変えずにルールだけで消えました。

第 3 回と違うのは 2 点で、どちらも誤りではありません。列の並びが `会社名, 売上合計, 順位` であること。そして FROM が顧客側であることです。ルールには「件数の少ない側を FROM に」とありますが、実行禁止なので件数は分からず、Claude は「顧客が案件より少ないという前提は推測で、逆なら FROM を入れ替えても結果は同じ」と**推測を推測と書いて**います。手元は顧客 215 件・案件 20 件なので逆で、第 1 回のとおり案件を FROM にすれば取得量は減ります。結果は同じです。

## 4. 作り方を MCP に組み込む

3 巡目のルールは効きましたが、毎回 21 項目を貼るのは不便です。kSQL の MCP サーバーには、接続時に AI へ渡る **instructions** という文があります。ツール一覧とは別に常時見える短い文で、kSQL では「LIKE は JavaScript 評価」「JOIN ON は等値 1 本」のような要点と、文型・関数のカタログがここに入っています（v3.77.0 で 5,722 文字）。ルールをここに置けば、依頼文に何も足さなくても届きます。

v3.78.0 で、この instructions に **Writing rules 8 行**を足しました（[課題台帳](https://github.com/rex0220/kintone-sql-tools/blob/main/docs/ksql_issue_tracker.md) の B183）。21 項目のうち「文書に書いてあっても AI が読まない種類のもの」を英語で 1 行ずつにし、各行を言語リファレンスの該当節で裏づけ、規則どおりの SQL が実行できることをテストで固定しています。

```text
Writing rules (learned from real failures):
- Check field codes with ksql_describe_app first. "コピー元: YES" identifies lookup copy targets.
- INNER JOIN: put the side you filter with WHERE (or the smaller side) in FROM; the join-key prefilter flows only FROM -> JOIN target and applies only to INNER JOIN. With LEFT/RIGHT JOIN, materialize the filtered side into a temp table first.
- Date conditions: use relative-date functions or literal half-open ranges in WHERE; never wrap the column (DATE_FORMAT/YEAR) in WHERE. Relative-date functions are WHERE-only; use CURRENT_DATE() in SELECT.
- Empty cells are '' (there is no NULL). Zero-fill with CASE WHEN x = '' THEN 0 ELSE x END and guard a denominator with CASE WHEN total = '' OR total = 0 (LEFT JOIN misses and empty aggregates yield ''). COALESCE/ISNULL keep numeric semantics only when every argument is numeric.
- Aggregates and window functions cannot share a SELECT, and a window result cannot be used in an expression of the same SELECT: split stages with WITH or temp tables. Running totals: ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW plus a tie-break on the key.
- Column aliases are lowercased in result names while physical field codes keep their case; later stages may reference an alias by either spelling. Do not alias a physical field to its own name when its original spelling must stay the output name.
- Output only the requested columns; do not add ORDER BY, LIMIT, or filters that were not asked for. Rank with RANK() unless told otherwise.
- After writing: ksql_validate, then ksql_explain; report the fetch summary and reason lines. State assumptions as assumptions.
```

長さは 7,369 文字（+29%）になりました。接続時に渡るツール定義まで含めた固定分では +4.5% です。

### before / after

v3.78.0 の MCP で、**1 巡目と同じ依頼文を前置きなし・新しい会話で 3 回**渡し、返った SQL を実行して第 3 回の表と突き合わせました。2 回目と 3 回目は、過去の巡の会話を拾わないよう「他のスレッドは参照しない」を依頼文に足しています。before は v3.77.0 の 1 巡目です。

| 版 | 回 | `validate` | 実行 | 第 3 回の表と | 順位 | 除数のガード | 依頼に無い列 | 別名 |
| :-- | :-: | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| v3.77.0 | 1 巡目 | ok | **エラー** | — | `ROW_NUMBER` | なし | `顧客No` | `顧客No`・`ABC区分` |
| v3.78.0 | 1 | ok | ok | 10 行すべて一致 | `ROW_NUMBER` | なし | `顧客No` | `顧客No` |
| v3.78.0 | 2 | ok | ok | 10 行すべて一致 | `ROW_NUMBER` | なし | `顧客No`・`案件数` | `顧客No` |
| v3.78.0 | 3 | ok | ok | 10 行すべて一致 | `ROW_NUMBER` | なし | `顧客No`・`案件数` | `顧客No`・`ABC区分` |

3 回とも売上合計・構成比・累積構成比・区分は一致し、違いは順位（`ROW_NUMBER` で 9 位と 10 位）だけです。ただし表をよく見ると、**返ってきた SQL の形は v3.77.0 の 1 巡目とほぼ同じ**です。3 回目は 1 巡目と同じ `AS 顧客No`・`AS ABC区分` を使っています。結果が正しくなったのは、次の節で書くエンジン側の修正で 1 巡目の書き方がそのまま通るようになったからで、Writing rules が SQL の形を変えた形跡は、2 回目に顧客管理を FROM に置いたこと以外にありません。

効かなかったのは、3 巡目では効いた「`RANK()` を使う」「除数をガードする」「依頼された列だけ」の 3 行です。会話の先頭に貼った 21 項目は効き、instructions の 8 行は効かない。同じ内容でも、会話の中に見える文と、接続時に渡る文とでは重みが違うようです。3 回の実測なので傾向としか言えませんが、**instructions は「知っているかどうか」の穴（構文・型の規則）を埋め、「どう書くか」の作法までは変えない**、と今は見ています。作法は依頼文に書くのが確実です。

## 5. 正本を直す

1 巡目と 2 巡目の原因は kSQL 側の課題として直しました（v3.78.0・B181 と B182）。修正版で同じ SQL を再実行した結果です。

| 巡 | SQL | v3.77.0 | v3.78.0 |
| :-: | :--- | :--- | :--- |
| 1 | `c.顧客No AS 顧客No` を次の段で `顧客No` と参照 | `unknown field code(s): 顧客No (agg)` | **成功**。10 行が第 3 回の表と一致。列名は `顧客no`・`abc区分`（小文字化は変わらない） |
| 2 | `COALESCE(SUM(案.売上), 0)` の列で順位・累計 | 文字列順（905 万が 1 位） | **数値順**。先頭 8 行が第 3 回の表と一致 |
| — | `SELECT COALESCE(SUM(売上), 0) + 0 FROM APP4149` | 0 | 81,800,000 |

別名は「完全一致 → 小文字に正規化した名前」の順で解決されるようになり、元の表記でも小文字でも通ります。結果列名が小文字になる規則はそのままです。`COALESCE` / `ISNULL` / `NULLIF` は全引数が数値なら数値として並び、算術でも集計値そのものを使います。

もう 1 つ、第 3 回で「kSQL ではできない」と書いた、集計と同じ SELECT にウィンドウ関数を書く形と、ウィンドウの結果を式の中で使う形も、v3.81.0 で通るようになりました（[課題台帳](https://github.com/rex0220/kintone-sql-tools/blob/main/docs/ksql_issue_tracker.md) の B184）。集計とウィンドウを 1 つの SELECT にまとめた形は、3 段版と同じ 10 行を返します（v3.82.0 で実測）。AI が最初に書く形が通るようになったので、この番外編の 1〜3 巡目で毎回起きていた「3 段に直す 1 往復」は今後は要りません。

ただし、この注記を書くために「標準 SQL ならこう書く」の形（集計を `base` に分け、次の SELECT で `CASE WHEN SUM(売上合計) OVER () = 0 THEN …` と書く）を流したところ、v3.82.0 では `unknown field code(s): __ksql_window_0 (base)` で落ちました。CTE や一時テーブルを元にした SELECT で、CASE の条件の左辺にウィンドウ関数を置いた形だけが漏れていた修正漏れです（[課題台帳](https://github.com/rex0220/kintone-sql-tools/blob/main/docs/ksql_issue_tracker.md) の B190、v3.83.0 で修正）。「直った」と書く前に、直した形の隣の形まで流す。この番外編で繰り返してきたことが、記事の注記 1 行にも要りました。

この 2 件が直ったので、3 巡目のルールにあった「別名に英字を使わない」「集計値を `COALESCE` で包まない」は Writing rules に入れていません。回避策を恒久のルールにせず、正本を直して仕様として書く。instructions に残すのは、文書に書いてあっても読まれない種類のものだけです。

## まとめ

| 巡 | 依頼 | 版 | `validate` | `explain` | 実行 | 結果 | 見つけた手段 |
| :-: | :--- | :-- | :--- | :--- | :--- | :--- | :--- |
| 1 | 元の依頼文 | v3.77.0 | ok | ok | **エラー** | — | 実行 |
| 2 | 依頼文を改訂 | v3.77.0 | ok | ok | ok | **静かに間違う** | 結果の 1 行目を見る |
| 3 | 元の依頼文 + 作り方のルール | v3.77.0 | ok | ok | ok | 一致 | 実行して突き合わせ |
| 4 | 元の依頼文（Writing rules を MCP に組み込み・3 回） | v3.78.0 | ok | ok | ok | 一致（SQL の形は 1 巡目と同じ） | 実行して突き合わせ |
| 5 | 1・2 巡目の SQL をそのまま再実行 | v3.78.0 | ok | ok | ok | 一致 | 実行して突き合わせ |

2 巡目は、エラーが出ず、`EXPLAIN` は通り、区分の列も A/B/C で埋まっていました。**結果の 1 行目を見て「905 万が 1 位はおかしい」と気づく**以外に止める道具はありません。依頼文で塞げるのは「何を出すか」までで、静かに間違う書き方までは塞げません。書き方は 3 巡目のように**作り方のルール**で渡すと、既知の落とし穴は消えます。

- 書かせた SQL は**実行して結果を見る**。`validate` と `explain` は通っても、実行で止まるものと、実行しても分からないものがある
- 説明は**鵜呑みにせず切り分ける**。1 巡目の Claude は直せたが、理由は 2 つとも違った
- 依頼文は「何を出すか」、ルールは「どう書くか」。**kSQL の作法はルールとして会話の先頭に置く**。ただしルールは過去の実測の集合なので、次に踏むのは書いていない形であり、実行して見る工程は残る

- 正本で直せるものは直し、残った作法は依頼文に書く。instructions に入れても、作法までは変わらなかった

見つかった 2 件は kSQL 側の課題として起票し、v3.78.0 で修正しました（[課題台帳](https://github.com/rex0220/kintone-sql-tools/blob/main/docs/ksql_issue_tracker.md) の B181・B182。Writing rules は B183）。人間がレビューする手順の全体は[第 9 回](https://qiita.com/rex0220/items/XXXXXXXX)にまとめます。

---

リポジトリ・ドキュメント:

- https://github.com/rex0220/kintone-sql-tools
- npm: `@rex0220/kintone-sql-tools`（CLI / プラグイン / MCP サーバー同梱）

<!--
R3（2026-09-16）: §4・§5・まとめ 5 行を追加。実測はすべて v3.78.0（dev profile・SFA パック・CLI 再ビルド版）。
§4 の before/after は user が Claude Desktop（MCP 3.78.0）で 3 回実行した SQL を Claude Code が実行して突き合わせた（1 回目は前置きなし、2・3 回目は「他のスレッドは参照しない」を追加。1 回目が過去スレッドを拾った可能性は否定できないが、3 回とも SQL の形は同じ）。
第 1・2 回の依頼文の before/after は未実施（必要なら追記）。第 9 回の URL は公開後に置換。
-->
