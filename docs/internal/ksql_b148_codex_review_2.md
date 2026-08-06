# B148 仕様 R2 codex レビュー 2

- 実施: 2026-08-06（v3.56.3）
- 依頼: [レビュー依頼 R2](ksql_b148_codex_review_request_r2.md)
- 対象: [仕様 R2](ksql_b148_bare_column_group_by_spec_r2.md)
- 前回: [レビュー 1（R1 対象）](ksql_b148_codex_review_1.md)

**こちらの実測による検証は §5 に追記した。4/4 で codex が正しい。**

---

# 1. 結論

**現状の R2 のままでは実装着手不可です。**

方針自体――既存 B65 の依存検査を ordinary `GROUP BY` と `GROUP BY` なし集計へ広げること――は成立します。ただし、実装は R2 が述べる単純な「identity の差し替え」では済みません。B65 固有処理から、句共通の集計依存検査を分離する必要があります。

| 重大度 | 件数 |
|---|---:|
| Critical | 1 |
| High | 4 |
| Medium | 2 |

本レビューはコードと文書の静的確認のみです。SQL、MCP、テストは実行していません。実測が必要な事項は §4 に分離します。

# 2. 指摘

## Critical 1: 現行 B65 検査は identity を差し替えるだけでは ordinary に転用できない

**静的に確定しています。**

現行 `validateGroupingPlanning()` は、`normalizeGroupingSpec()` が `GROUPING_SETS` でなければ即座に `null` を返します。

- `src/core/groupingValidation.ts:241-257`
- `src/core/grouping.ts:71-100`

その後の依存検査も、次の B65 固有構造を前提にしています。

- grouping item の構築は `resolveGroupingSpec()` に依存し、対象は `GroupingFieldItem = FieldRef` だけ  
  `src/core/grouping.ts:112-141`  
  `src/types/ast.ts:737-759`
- grouping item と依存列の双方に `physical === true` を要求  
  `src/core/groupingValidation.ts:151-179,259-270`
- `GROUPING()` membership、B65 の item/set 制限、aggregate alias collision が同じ関数に混在  
  `src/core/groupingValidation.ts:277-322`
- wildcard 拒否も `GROUPING_SETS` 分岐の内側  
  `src/core/groupingValidation.ts:216-233`

一方、plain plan は grouping item の解決結果しか持ちません。

- `PHYSICAL` は source identity を持つ
- `ALIAS_SAFE` は `columnIndex`
- `EXPRESSION` は種別だけ

`src/core/optimization/plainGroupByPlan.ts:11-29,236-246`

さらに、`SELECT`／`HAVING`／`ORDER BY` の列参照を plain plan と同じ schema に対して `(sourceIndex, fieldCode)` へ解決する公開経路は存在しません。`resolveFieldName()` は grouping item 用の private 関数です。

`src/core/optimization/plainGroupByPlan.ts:177-229`

したがって R2 §0・§1 の「R2 の新規は identity だけ」「残りは付いてくる」は実装構造として不正確です。

### 対応案

- 案A: `validateGroupingPlanning()` に `PLAIN`／`NONE` 分岐を継ぎ足す
- 案B: B65 固有処理から、共通の「非集計依存検査」を分離する
- 案C: ordinary 用の検査を完全に別実装する

**推奨は案Bです。**

例えば次の3層に分けるのが安全です。

1. 共通層  
   `SELECT`／`HAVING`／`ORDER BY` の依存収集、集計内部・サブクエリ境界、wildcard、first error
2. ordinary policy  
   plain plan から `PHYSICAL`／`ALIAS_SAFE`／`EXPRESSION` identity を構築
3. B65 policy  
   物理フィールド限定、`GROUPING()` membership、set/item 制限、alias collision

R2 §5 の「identity 拡張を ordinary にだけ効かせる」も、この分離なら明確に実現できます。`GROUP BY` なし集計は ordinary policy に空の grouping identity 集合を渡せば処理できます。

R3 では「identity の差し替え」ではなく、**B65 の句依存検査を共通層として抽出し、ordinary 用 identity provider を追加する**と書くべきです。

---

## High 1: R2 §2.2／§8.4 は parser と公開契約に反している

**静的に確定しています。実測は不要です。**

R2 は、通常集計とウィンドウを同じ `SELECT` で併用した場合、ウィンドウ参照を集計後出力として扱う、としています。

`docs/internal/ksql_b148_bare_column_group_by_spec_r2.md:90-91,301-304`

しかし parser は、この組み合わせを明示的に拒否します。

`src/parser/parser.ts:1202-1206`

言語リファレンスも同じ契約です。

`docs/ksql_language_reference.md:1943-1945`

内部パイプラインだけを見ると、window は grouping／HAVING 後に走ります。

`src/engine/process.ts:1952-1995`

ただし `applyGroupBy()` の集約行には、グループ先頭行の全フィールドもコピーされています。

`src/engine/process.ts:293-308`

したがって parser を迂回した AST では、「集計後 alias」と「先頭入力行の非キー列」が同じ行に混在します。この内部状態を公開意味論に採用するのは危険です。

### 対応案

- 案A: B148 と同時に集計＋window を解禁し、名前空間と評価規則を新設する
- 案B: 現行どおり併用禁止とし、B148 検査では `WINDOW_COL` 全体を対象外にする
- 案C: §8.4 を未確定のまま残す

**推奨は案Bです。**

R3 では以下を明記してください。

- window-only query は集計クエリではない
- `WINDOW_COL` の引数・`PARTITION BY`・window `ORDER BY` は B148 の走査対象外
- 通常集計／`GROUP BY` と window の同一 `SELECT` 併用は、従来どおり `ParseError`
- 集約後に window を使う場合は CTE／一時表で段を分ける

§8.4 は「未確定」ではなく、併用禁止の回帰受入へ変更するのが適切です。

---

## High 2: CTE／一時表と EXPLAIN の schema-aware 判定位置が未設計

**静的に確定している構造上の問題です。**

通常実行では、statement 全体を再帰走査する planning preflight が実行本体より先に走ります。

`src/execute.ts:1047-1060,3111-3131`

しかしこの走査は `materializedTables` を渡しません。現行 B65 resolver は CTE／一時表を物理フィールドとして扱えず拒否します。

`src/execute.ts:3191-3201,3220-3231`

一方、CTE は順番に実行・実体化されます。

`src/execute.ts:5182-5207`

実体化後の通常実行では、CTE cache を渡して `executeSelect()`／`executeFullScanWithCte()` が検査できます。

`src/execute.ts:5263-5275,5284-5291`

EXPLAIN はさらに制約があり、未実体化 source を含む plain `GROUP BY` では plain plan の構築自体をスキップしています。

`src/execute.ts:9897-9908`

このため、次の R2 要件を同時に満たす方法が未記述です。

- AST 内の各 `SelectStatement` を事前検査
- CTE 本体をその CTE の取得前に拒否
- `ksql_explain` でも同じ schema-aware 診断
- records API 呼び出し回数 `0`

`docs/internal/ksql_b148_bare_column_group_by_spec_r2.md:148-157,225-250,256-258`

特に、先行 CTE の出力 schema が必要な後続 CTEについて、「records API 0」が文全体なのか、違反した `SelectStatement` 自身の取得だけなのかが不明です。

### 対応案

- 案A: 全 CTE の出力 schema を AST と metadata から事前推論する
- 案B: direct APP と実体化 source で検査時点を分け、API 0 の意味を SELECT 単位に定義する
- 案C: CTE／一時表と EXPLAIN を Phase 2 へ送る

**推奨は案Bです。**

R3 では次の境界を明記してください。

- direct APP の query block: statement preflight で全 arm／subquery を検査してから records GET
- CTE 本体: その CTE の実行直前、利用可能な先行 CTE schema を渡して検査
- 後続 CTE／最終 query の違反: 先行 CTE の取得済み回数は許容するが、違反 block 自身の records GET は `0`
- EXPLAIN: 行の実体化はせず、CTE output columns を推論する relation-schema plan を用いる
- wildcard など output schema を確定できない場合の EXPLAIN 契約も明記する

受入の API count も「statement 全体」と「違反 query block 自身」を分ける必要があります。

---

## High 3: canonical identity の対象 AST と「式を葉にする」規則が不足している

R2 §3.2 の保守的構造一致という方針は正しいですが、対象ノードが不足しています。

`ALIAS_SAFE` は関数・算術式だけではありません。現行 plan は以下をすべて `SAFE` にできます。

- フィールド
- リテラル
- 算術式
- `CASE`
- 文字列／日付関数
- 汎用 scalar expression
- scalar subquery

`src/core/optimization/plainGroupByPlan.ts:60-81`

言語リファレンスも、別名の元として `CASE`、リテラル、フィールド参照、scalar subquery を契約しています。

`docs/ksql_language_reference.md:1420-1430`

AST も複数の式体系に分かれています。

- `SelectColumn`: `src/types/ast.ts:224-239`
- `GroupByKey`: `src/types/ast.ts:731-735`
- `ArithNode` と `ScalarValueExpr`: `src/types/ast.ts:1065-1111`

R2 の canonical 規則と受入例は、主に関数・算術式しか固定していません。

`docs/internal/ksql_b148_bare_column_group_by_spec_r2.md:119-142,259-271`

また、次のような「grouping expression を部分木として使う式」の扱いが未定義です。

```sql
SELECT YEAR(日付) + 1, SUM(個数)
FROM APP4228
GROUP BY YEAR(日付)
```

`日付` 自体は grouping field ではありませんが、`YEAR(日付)` は grouping item と完全一致します。R2 §2.2 の「grouping item を葉に持つ式」を実現するには、単なる field-leaf 検査ではなく、**canonical grouping expression と一致する部分木で探索を止める**必要があります。

### 対応案

- 案A: 主用途の関数・算術式だけ canonicalize する
- 案B: canonical key の対象ノードと再帰規則を列挙し、grouping expression 一致部分木を semantic leaf とする
- 案C: expression grouping は式全体一致だけ許可する

**推奨は案Bです。**

R3 と受入へ最低限、次を追加してください。

- `FIELD`／`FIELD_REF`／`AGG_GROUP_KEY` の統一方法
- `STRING`、`NUMBER`、`VARIABLE`
- `ARITH`／`SCALAR_ARITH`／`CONCAT_OP`
- `STRING_FUNC`
- `CASE_WHEN` と条件式
- scalar subquery alias の identity
- wrapper (`ARITH_COL`、`FUNC_KEY` など) を identity に含めない規則
- grouping expression と一致する部分木で依存走査を停止する規則
- 修飾／非修飾が同じ source へ一意解決された場合の成功例
- `CASE`／リテラル／scalar subquery alias の回帰例

「判定不能ならエラー」だけでは、現在契約済みの正当な `ALIAS_SAFE` query を偽陽性で落とす危険があります。

---

## High 4: エラーの「GROUP BY へ追加」案が、すべての違反式では実行可能でない

R2 §6.1 は複合式に対しても、式を追加した完全な `GROUP BY` 句を示すことを要求しています。

`docs/internal/ksql_b148_bare_column_group_by_spec_r2.md:185-195`

しかし ordinary `GROUP BY` が直接受け取れる AST は、フィールド・算術式・関数式だけです。

`src/types/ast.ts:731-735`

一方、違反する SELECT 式には `CASE` や汎用 scalar expression があり得ます。これらは SELECT alias 経由なら grouping できますが、式をそのまま `GROUP BY CASE ...` と示すことは現行 grammar と一致しません。

言語リファレンスも、広い式種別を grouping できるのは SELECT alias 経由だと説明しています。

`docs/ksql_language_reference.md:1420-1430`

したがって「示した形が実際に動く」という要件を、現行の一律な案内では満たせません。

### 対応案

- 案A: 常に `MIN(<違反式>)` と `GROUP BY <違反式>` を表示する
- 案B: 式種別と alias 解決結果に応じて移行案を変える
- 案C: GROUP BY 案を廃止して MIN/MAX だけ表示する

**推奨は案Bです。**

例えば次のように分けます。

- 単純列: `MIN(x)` または `GROUP BY ..., x`
- 直接 grouping 可能な算術／関数式: `MIN(expr)` または `GROUP BY ..., expr`
- `CASE`／concat／scalar expression:
  - alias が安全なら「`AS alias` を付け、`GROUP BY ..., alias`」
  - alias が無い／物理同名衝突があるなら MIN 案だけを表示
- scalar subquery: parser が受ける実際の修正形だけを表示

受入では、生成した各修正例を再 parse・実行して成功することまで確認すべきです。

---

## Medium 1: reason code の契約が自己矛盾している

R2 は `ksql_validate`、EXPLAIN、実行で同じ reason code と定義しています。

`docs/internal/ksql_b148_bare_column_group_by_spec_r2.md:242-250`

しかし §6.2 のエラー骨子には reason code がなく、具体的な code 名も定義されていません。

`docs/internal/ksql_b148_bare_column_group_by_spec_r2.md:197-211`

現行の依存違反は `B65_NON_GROUPED_DEPENDENCY` です。

`src/core/groupingValidation.ts:168-179`

§6.3 で拡張 grouping 側の文面も変更するため、既存のエラー契約・テストへの影響も明示する必要があります。

### 対応案

- 案A: reason code を廃止し、全文だけを契約する
- 案B: human-readable message と machine reason を分離し、1つの code を固定する
- 案C: ordinary と B65 で別 code にする

**推奨は案Bです。**

後方互換を優先するなら `B65_NON_GROUPED_DEPENDENCY` を維持し、人間向け本文からだけ `B65`／`Phase1` を除く方法があります。新 code に改称するなら、それ自体を明示的な破壊的変更として受入へ含めるべきです。

---

## Medium 2: 起票文書が、R2 と現在コードに対して古い事実を残している

起票は現在も次のように記述しています。

- ガードが存在しない
- 該当テストが見つからない

`docs/internal/ksql_b148_bare_column_group_by_issue.md:77-85`

しかし R2 と実コード上、拡張 grouping には依存検査が存在します。

- `docs/internal/ksql_b148_bare_column_group_by_spec_r2.md:14-28`
- `src/core/groupingValidation.ts:168-179,241-323`

実装者が起票から読み始めると、「新規 validator」なのか「既存検査の共通化」なのかを誤ります。

### 対応案

- 案A: 起票は初期観測としてそのまま残す
- 案B: 初期見立てだったことを残しつつ、R2 で判明した現状へ更新する
- 案C: R2 だけを正本とし、起票から実装状態の記述を削除する

**推奨は案Bです。**

「ordinary にはガードが無いが、拡張 grouping には B65 検査が既にある」と修正するのが正確です。

# 3. 仕様が正しかった点

R3 で次は消さないでください。

- **集計クエリの開始条件を `SELECT` 集計または `GROUP BY` としたこと**  
  `GROUP BY` なし集計は空の grouping item 集合として検査できます。現行実行も `GROUP BY` なしの SELECT 集計を1グループとして扱います。  
  `docs/internal/ksql_b148_bare_column_group_by_spec_r2.md:69-78`  
  `src/engine/process.ts:1952-1978`

- **window-only query を通常集計扱いしないこと**  
  現行 `hasAggregateColumns()` は `WINDOW_COL` を含めません。  
  `docs/internal/ksql_b148_bare_column_group_by_spec_r2.md:80-88`  
  `src/engine/process.ts:239-247`

- **grouping token の解決結果を identity の出所にすること**  
  物理フィールド優先、alias fallback、JOIN source identity を再実装しない方針は正しいです。  
  `docs/internal/ksql_b148_bare_column_group_by_spec_r2.md:95-109`  
  `src/core/optimization/plainGroupByPlan.ts:177-229`

- **SELECT 式内の参照を SELECT alias へ fallback させないこと**  
  `GROUP BY` token の解決規則と、SELECT 式の名前解決を分離する原則は正しいです。  
  `docs/internal/ksql_b148_bare_column_group_by_spec_r2.md:111-117`

- **canonical 構造一致を保守的にすること**  
  `raw` や表示情報を除外し、代数的同値性を認めず、不確実なら拒否する安全方針は維持すべきです。  
  `docs/internal/ksql_b148_bare_column_group_by_spec_r2.md:119-142`

- **各 `SelectStatement` を独立した query block とすること**  
  UNION arm、subquery、CTE、temp table、SELECT-based DML を同じ規則で扱う範囲設定は妥当です。  
  `docs/internal/ksql_b148_bare_column_group_by_spec_r2.md:146-164`  
  静的 batch 検査にも再帰 walk の前例があります。  
  `src/core/batch.ts:206-218`

- **`UPDATE ... FROM` を本件の直接対象外としたこと**  
  relation source を直接持ち、`SelectStatement` を持たない別構造です。  
  `src/types/ast.ts:1027-1045`

- **拡張 grouping の物理フィールド限定を維持すること**  
  ordinary identity を拡張 grouping へ漏らさない判断は正しいです。  
  `docs/internal/ksql_b148_bare_column_group_by_spec_r2.md:168-177`

- **`ksql_validate` を AST-only と schema-aware の二段階契約にしたこと**  
  metadata を読まない surface で物理フィールド／alias 競合まで断定しない方針は妥当です。  
  `docs/internal/ksql_b148_bare_column_group_by_spec_r2.md:232-250`

- **受入を公開結果と API 呼び出し境界で観測すること**  
  内部関数名を受入条件にしていません。mock client の records API count は、「取得前」という公開挙動を観測する妥当な方法です。  
  `docs/internal/ksql_b148_bare_column_group_by_spec_r2.md:254-258`

- **adversarial case の中心部分**  
  物理フィールドと alias の衝突、左右 JOIN source の分離、曖昧な非修飾参照、subquery／UNION の独立検査、first error は有効です。  
  `docs/internal/ksql_b148_bare_column_group_by_spec_r2.md:286-299`

# 4. 決めるために測るべきこと

以下はコード読解だけでは現在の全 surface の結果まで確定できないため、**未確認**です。

1. **canonical 表記ゆれの before 値**

   - `1` と `1.0`
   - 修飾／非修飾が同じ source へ解決される形
   - parser 関数別名
   - `CASE`／concat／scalar subquery alias
   - grouping expression を部分木として使う式

2. **CTE／一時表の API 呼び出し順**

   少なくとも次を別々に測る必要があります。

   - 最初の CTE 本体が違反
   - 先行 CTE は正常、後続 CTE が違反
   - CTE 本体は正常、最終 query が違反
   - CTE／一時表を JOIN した最終 query
   - UNION の片 arm だけが違反

   statement 全体の records API count と、違反 block に起因する count を分けて記録すべきです。

3. **EXPLAIN の CTE output schema**

   行を取得せずに、明示列・alias・`SELECT *`・UNION の output columns をどこまで確定できるか。現行 explain path は未実体化 source の plain plan を構築していません。

4. **全 `ALIAS_SAFE` 種別の回帰**

   主用途の `DATE_FORMAT` だけでなく、フィールド alias、算術、`CASE`、リテラル、scalar value、scalar subquery alias が通り続けるか。

5. **エラーに表示する修正例**

   `GROUP BY` あり／なし、JOIN、CTE、一時表、サブテーブル、`CASE`、複合式について、表示された SQL をそのまま実行して成功するか。

6. **拡張 grouping のエラー契約**

   §6.3 の文面変更後も、既存の reason code、first error、`GROUPING()` membership、wildcard、aggregate alias collision の意味が変わらないか。

7. **プラグイン bundle**

   通常実行と EXPLAIN の両方で、同じ違反箇所・reason codeが表示され、records API の前で停止するか。

なお、通常集計と window の同一 `SELECT` 併用については測定で意味論を決める必要はありません。parser と言語リファレンスから、現在の公開契約は「併用不可」と確定しています。


---

## 5. 実測による検証（Claude・2026-08-06・APP4228）

**動的な主張を実機で確かめた。4 件とも codex が正しい。**

### 5.1 High 1 — **併用は既に `ParseError`。§8.4 は「未確定」ではなかった**

```
SELECT 製品名, SUM(個数) AS 合計, ROW_NUMBER() OVER (ORDER BY 製品名) AS 順
FROM APP4228 GROUP BY 製品名
  → ParseError: ウィンドウ関数は GROUP BY / 集計関数と同じ SELECT では使用できません
```

**R2 §8.4 を「未確定」として残したのは誤り。** **公開契約として既に禁止されている。**
**R3 では「併用禁止」を回帰受入として書く**（codex 推奨案 B）。

**内部パイプラインでは window が grouping の後に走り、集約行にはグループ先頭行の全フィールドも
コピーされている**という codex の指摘は重要＝**parser を迂回した AST では
「集計後 alias」と「先頭入力行の非キー列」が同じ行に混在する**。
**この内部状態を公開意味論に採用してはいけない。**

### 5.2 High 3 — **grouping 式を部分木に持つ式は実在し、正しく動く**

```
SELECT YEAR(日付) + 1 AS 翌年, SUM(個数) AS 合計 FROM APP4228 GROUP BY YEAR(日付)
  → 翌年 2026 / 合計 38525
    翌年 2027 / 合計 46913
```

**`日付` 自体は grouping field ではないが、`YEAR(日付)` は grouping item と完全一致する。**
**R2 の「grouping item を葉に持つ式」では表現できない**＝
**canonical grouping expression と一致する部分木で走査を止める**必要がある。

**`ALIAS_SAFE` の広さも確認した。**

```
SELECT CASE WHEN 個数 > 100 THEN '大' ELSE '小' END AS 区分, SUM(個数) AS 合計
FROM APP4228 GROUP BY 区分
  → 大 48425 / 小 37013
```

**`CASE` の別名グループ化は現行の契約どおり動く。**
**R2 の受入は関数・算術式しか固定しておらず、これらを落とすと偽陽性になる。**

### 5.3 High 4 — **`GROUP BY <式>` は一律には案内できない**

```
SELECT CASE WHEN ... END AS 区分, SUM(個数) FROM APP4228 GROUP BY CASE WHEN ... END
  → ParseError: フィールド名またはテーブル名が必要です（トークン:「CASE」）
```

**`CASE` は別名経由でしかグループ化できない。**
**R2 §6.1 の「追加後の完全な `GROUP BY` 句として示す」は、`CASE` では実行できない形になる。**
**「従うと壊れる助言」を 4 度目に出すところだった。**

**codex 推奨案 B（式種別と alias 解決結果に応じて移行案を変える）を採る。**

### 5.4 傾向（6 回目の観測）

**今回は動的な主張も 4/4 で当たった。** 前回（R1）は Critical 3 が外れている。
**違いは「parser が明示的に拒否している」ことをコードで示せたかどうか**で、
**根拠に行番号が付いている主張は、動的でも当たる。**
