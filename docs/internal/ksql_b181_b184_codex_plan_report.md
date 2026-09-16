# B181〜B184 実装案の検討報告（codex・2026-09-16）

> `codex exec -s read-only` の最終メッセージをそのまま保存（[依頼書](ksql_b181_b184_codex_plan_request.md)）。Claude のソース確認: 引用行のうち B182 の `ARITH_COL` 分類（`parser.ts:1742-1747`・`hasAggregateColumns` に ARITH_COL 無し・集計実体化に ARITH_AGG_COL 分岐のみ）、`deriveOutputOrderSemantics` の STRFUNC_COL 既定 string（`process.ts:2205-2234`）、B181 の `b86FieldExists` 完全一致（`execute.ts:4804-4807`）と alias evaluator、B184 の `SelectColumn`（`ast.ts:273-287`）・`parseOrderByKey` の OVER 拒否（`parser.ts:3752-3762`）・`selectCompleteInputReasons` のトップレベル window のみ（`dmlGuard.ts:181-195`）、B183 の instructions 予算テスト（`metadataTools.test.ts:118-141`・`{ total: 663, catalog: 347, prose: 316 }` 固定・prose ≤ 320・段落 6）を確認し、いずれも報告どおり。動的な主張（テスト実行結果）は含まれていない。

## 1. 結論

- 推奨は **B182 → B181 → B183 → B184-A → B184-B** の5 PR。B182/B181/B183 は patch、B184 は A/Bを同一 minor リリースにまとめる。
- 規模は順に **M / M / S / L / L**。B184 は「パーサの門番を外すだけ」ではなく、AST・取得列収集・集計実体化・警告・EXPLAINまで変わる。
- B182 の推定は概ね正しいが、算術が 0 になる直接原因は `ARITH_COL` が集計実体化から漏れること。
- B184 の「制限はパーサだけ」「CTE経由と同じ警告判定」はソースと一致しない。
- 以下は静的調査のみ。実装、Git操作、MCP tool call、ビルド、テスト実行はしていない。

## 2. B181

### 根本原因

別名の保存側は次のとおり、小文字化した `alias` と元表記の `display` を分けています。

> `alias: tok.value.toLowerCase(), // alias は小文字で統一`

`src/parser/parser.ts:5056-5072`

一方、参照側は完全一致です。

- 実体化列の存在判定: `schema.validCodes.has(field)` — `src/execute.ts:4800-4806`
- CTE・一時表の列集合: `new Set(materialized.columns)` — `src/execute.ts:4886-4896`
- 不存在診断:

> `ArgumentError: unknown field code(s): ${unknown.join(", ")} (${schema.label})`

`src/execute.ts:4934-4953`

- 同一SELECTの `ORDER BY` alias は `evaluators.get(name)` — `src/engine/process.ts:1235-1245`, `src/engine/process.ts:1313-1315`
- canonical ORDER計画も `semantics.get(item.key.name)` の完全一致 — `src/core/optimization/canonicalOrderPlanner.ts:50-58`

したがって起票の原因説明は正しいです。出力側だけ小文字化され、参照側に同じ規則がありません。

### 実装案

第一案は、結果列名を変えず、参照解決だけを共通化する純加法です。

1. `resolveProjectedName(requested, available)` のような共通helperを追加する。
2. 解決順は以下に固定する。

   - 完全一致
   - `requested.toLowerCase()` と実体化列・SELECT alias の正規名との一致
   - 不一致

3. このfallbackは次にだけ適用する。

   - 同一SELECTの出力alias
   - CTE、一時テーブル、SHOW/DESCRIBE等の実体化列
   - UNIONの左枝から決まる結果列

4. 物理APPのfield code、DML対象列、JOIN先の物理field codeには適用しない。

ASTを実行直前に実体化スキーマへ束縛し、参照名を実在する小文字列名へ置換する方式が安全です。`resolveFieldRef()` 自体を大文字小文字非依存にすると物理field codeまで緩めるため避けます。

主な対象:

- `src/execute.ts`
  - `validateB86SelectFieldCodes`
  - materialized `columnMeta` resolver群
  - GROUP BY・JOIN・required-field用の実体化列解決
- `src/engine/process.ts`
  - `buildOrderByAliasEvaluator`
  - ORDER BYの意味型map参照
- `src/core/optimization/canonicalOrderPlanner.ts`
  - SELECT aliasとORDER keyの解決
- 必要なら新規 `src/core/projectedNameResolution.ts`
- `src/converter/selectToKintone.ts`
  - CTE参照を物理取得列として扱わないことの回帰確認

代替案Bの静的診断は、Aを採るなら不要です。Aを採らない場合だけ、B86のcollectorをEXPLAIN側の静的relation schemaにも接続します。

### テスト計画

既存テストで意図的に書き換えるものは見当たりません。小文字化契約を固定する `src/parser/__tests__/parser.test.ts:338-352` はそのまま通すべきです。

追加:

- `src/engine/__tests__/orderByAlias.test.ts`
  - `AS Amount ORDER BY Amount`
  - `AS Amount ORDER BY amount`
  - aliasと同名物理列がある場合もSELECT alias優先を維持
- `src/__tests__/b86MaterializedUnknownColumn.test.ts`
  - CTEの `Amount` / `amount`
  - `顧客No` / `顧客no`
  - WHERE、CASE、集計、GROUP BY、HAVING、window、JOIN、subquery、UNIONの各参照位置
  - 本当に存在しない列は従来の `unknown field code(s)` のまま
- `src/__tests__/executeBatch.test.ts`
  - 一時テーブル参照
  - 0行の一時テーブルでも同じ解決
- 物理APPでは `顧客No` と `顧客no` を別物として扱う負例
- ORDER BYは値 `9/10`、`99/100` をASC/DESC両方向で確認し、単なる行集合の等値比較で済ませない
- 文書の助言をそのまま実行する1本: 正規化後の小文字参照例

### 互換性リスク

- 結果の `columns` と行キーは従来どおり小文字。Dashboardの列設定は変わりません。
- CLI / MCP / `/flow` の `columns`・`warnings` shapeも不変です。
- 以前失敗したSQLが成功するだけですが、物理fieldまでcase-insensitiveにすると破壊的なので適用境界が最重要です。
- pluginのEXPLAIN文言は、Aだけなら変更不要です。Bを併用して診断を変える場合はplugin同梱engineにも波及します。
- 大文字小文字だけ異なる複数aliasは、現状すでに同一出力名へ畳まれます。新helper側でも独自の曖昧判定を追加せず、既存の後勝ち契約を維持します。

### 規模

**M**。変更量より、同一SELECT・CTE・一時表・UNION・JOIN・各式位置で参照解決を一貫させ、物理fieldだけ除外する範囲管理が理由です。

## 3. B182

### 根本原因

#### 並び順が文字列になる原因

`COALESCE` / `NULLIF` / `ISNULL` の評価値は文字列です。

> `case "COALESCE": return args.find((a) => a !== "") ?? "";`  
> `case "NULLIF": ...`  
> `case "ISNULL": ...`

`src/engine/evalFunc.ts:412-419`

ただし、本質は値のJS型より列メタデータです。現在の型推定は、既知の数値関数以外の `STRFUNC_COL` をすべて文字列にします。

- FULL_SCANのORDER意味型: `src/engine/process.ts:2205-2234`
- 実体化CTE列メタ: `src/execute.ts:5550-5565`, `src/execute.ts:5790-5799`
- HAVING比較: `src/execute.ts:3768-3771`
- WHERE/HAVINGの関数比較: `src/engine/evalWhere.ts:185-203`

このため、`COALESCE(SUM(...), 0)` は値を正しく実体化しても、後段のORDER BY・window ORDER BYでは文字列契約になります。起票 §2 の第一推定は正しいです。

#### 算術で 0 になる原因

こちらは推定をさらに具体化できます。

関数から始まる算術は通常の `ARITH_COL` に分類されます。

> `return ... { type: "ARITH_COL", expr: node ... }`

`src/parser/parser.ts:1740-1748`

しかし集計query判定は `AGGREGATE`、`ARITH_AGG_COL`、集計入り `STRFUNC_COL`、`SCALAR_VALUE_COL`、`CASE_COL` だけで、`ARITH_COL` 内の集計を見ません。

`src/engine/process.ts:431-439`

集計実体化にも `ARITH_COL` 分岐がありません。

`src/engine/process.ts:617-678`

射影時には通常算術として再評価されます。

`src/engine/process.ts:1589-1590`

その際、関数引数の集計値は合成キーから取得されますが、未実体化なので空文字となります。

`src/engine/evalFunc.ts:721-735`

したがって `COALESCE('', 0) + 0` 相当になり、全行0になります。起票 §2 の「集計後でなく評価される可能性」は方向として正しいものの、直接原因は **パーサ分類と集計依存materializationの非対称**です。

### 実装案

第一案は既存ASTをなるべく変えない二段修正です。

1. 集計依存値の実体化

   - `ARITH_COL` 内部も `collectAggregateRefs()` で走査
   - 集計を含む場合は `hasAggregateColumns()` の対象にする
   - 集計後に式内の `AGG_REF` / `AGG_ARITH` を確定値へ置換してから `evalArithExpr`
   - 既存の `materializeAggregateDependencies()` と `resolveAggInScalarValue()` を一般化して再利用

2. 結果意味型の推定

   - `COALESCE` / `ISNULL` / `NULLIF` / `GREATEST` / `LEAST` は、全引数が数値意味型ならnumber
   - 文字列または不明が1つでも混ざれば従来どおりstring
   - `CAST(... AS NUMBER)` と既知数値関数も同じ共通helperへ集約
   - `process.ts`、`execute.ts`、`evalWhere.ts` にある数値関数集合の重複を1か所へ寄せる

対象:

- `src/parser/parser.ts`
- `src/engine/process.ts`
- `src/engine/evalFunc.ts`
- `src/engine/evalWhere.ts`
- `src/execute.ts`
- `src/core/aggregateDependencyValidation.ts`
- 新規候補 `src/core/expressionSemantics.ts`

代替案は、集計入り関数算術をパーサで `SCALAR_VALUE_COL` に分類し直す方法です。ただしAST snapshot・converter・既存分岐への影響が大きく、最小案より互換性リスクがあります。

### テスト計画

既存で壊れるべきテストはありません。回帰対象は以下です。

- `src/engine/__tests__/b119AggregateStringFuncArg.test.ts`
- `src/engine/__tests__/b120AggregateCase.test.ts`
- `src/engine/__tests__/b121HavingNumericComparison.test.ts`
- `src/engine/__tests__/b122HavingAggregateExpression.test.ts`
- `src/parser/__tests__/b120AggregateCase.test.ts`

新規:

- `COALESCE(SUM(x),0) + 0`
- `COALESCE(SUM(x),0) * 1`
- `ISNULL(SUM(x),0) * 1`
- `COALESCE(SUM(x),0) * 100.0 / 2`
- GROUP BYあり・なし、0行、LEFT JOIN不一致
- `ORDER BY` ASC/DESC、`RANK`、累計window
- 値は `9/10`、`99/100`、`9,050,000/20,700,000` を両方向で使う
- `COALESCE(メモ,'－')`、数値と文字列が混ざる `COALESCE(SUM(x),'none')` はstringのまま
- `NULLIF` / `GREATEST` / `LEAST` も数値全引数・混在引数を分ける
- 文書の推奨3形、`CASE`、`SUM(COALESCE(x,0))`、`CAST(... AS NUMBER)` を同じデータで実行し、すべて数値順を確認

### 互換性リスク

- `columns` と列名は不変です。
- 既存の誤った行順・順位・累計・算術値は変わります。正しさ修正ですが、誤結果を前提にしたsnapshotは変わります。
- `warnings` shapeは不変で、新警告も不要です。
- CTE列メタがnumberになるため、CLI / MCP / `/flow`、CSV、Dashboardすべてで並び順が修正されます。
- pluginのEXPLAIN文言を変えなければ文字列波及はありません。型をEXPLAINへ新表示するならplugin側snapshot対象です。

### 規模

**M**。0値修正自体は局所的ですが、型推定をORDER BY、window ORDER BY、HAVING、CTEメタで一致させる必要があります。

## 4. B183

### 根本原因

現在のinstructionsの規則は1段落だけです。

> `Key rules: LIKE/NOT LIKE uses JavaScript semantics; JOIN ON allows one equality; derived tables are unsupported ...`

`src/mcp/index.ts:89-99`

提案された失敗回避策は含まれていません。起票の認識は正しいです。

### 実装案

`KSQL_MCP_INSTRUCTIONS` に、構文カタログとは別の `Writing rules` 段落を追加します。B181/B182後に実装し、回避策を恒久仕様として残さないのが最小です。

対象:

- `src/mcp/index.ts`
- 新規 `src/mcp/__tests__/writingRules.test.ts`
- `src/mcp/__tests__/metadataTools.test.ts`
- 必要なら `src/mcp/docsResources.ts`
- `docs/ksql_language_reference.md` の参照先確認

### テスト計画

既存で必ず変わるもの:

- `src/mcp/__tests__/metadataTools.test.ts:120-139`
  - exact word budget
  - prose/total上限
  -空行区切りの段落数

`statementSyntaxCatalog.test.ts` はテンプレートを重複させなければ変更不要です。

追加:

- 8規則の安定した識別句が1回ずつ含まれる
- 各規則が指す言語リファレンス節・レシピキーが存在する
- 構文カタログやfunction catalogとの重複を避ける
- 文書の助言をそのまま使うfixture SQLを、既存のmock clientで最低1本実行
- Claude Desktopで同一依頼をbefore/after各3回。これは自動テスト外の受入

### 互換性リスク

エンジン、`columns`、`warnings`、CLI、`/flow`、Dashboardは不変です。MCP initialize時の固定コンテキスト量とAIの生成傾向だけが変わります。

### 規模

**S**。コード変更は小さいですが、実機before/afterの3回測定は別作業です。

## 5. B184

### 根本原因

現行の拒否規則は確かにあります。

> `ウィンドウ関数は GROUP BY / 集計関数と同じ SELECT では使用できません`

`src/parser/parser.ts:1352-1356`

式内利用も明示拒否しています。

> `ウィンドウ関数の結果は同じ SELECT の式では使えません。`

`src/parser/parser.ts:337-347`, `src/parser/parser.ts:1680-1684`

ただし、起票の「パーサの門番だけ」という推定は不十分です。

- `SelectColumn` はwindowをトップレベルの `WindowColumn` としてしか表現できない — `src/types/ast.ts:272-287`
- 式ASTにはwindow nodeがない — `src/types/ast.ts:336-380`
- `applyWindow()` はSELECT列中の `WINDOW_COL` だけを列挙する — `src/engine/process.ts:1322-1335`
- window値は列indexに紐づくmaterialized valueとして保持される — `src/engine/process.ts:1374-1380`
- `project()` は全 `WINDOW_COL` を公開列へ出す — `src/engine/process.ts:1677-1686`, `src/engine/process.ts:1822-1826`
- 取得field collectorもトップレベルwindowのみ対応 — `src/converter/selectToKintone.ts:778-784`

評価順自体は起票どおりです。

`src/engine/process.ts:2307-2387`

しかしBを実現するには隠しwindowを表現・収集・評価し、公開列から除外する内部モデルが必要です。

### 実装案

#### A. 集計との同一SELECT

第一案:

- `parser.ts` の門番を外す前に、window specification用の解決モデルを追加
- `PARTITION BY` / `ORDER BY` / window引数を次に限定
  - GROUP BYキー
  - 実体化済み集計alias
  - 集計式
- 集計式は `aggregateSyntheticName()` に正規化し、必要なら非表示のaggregate dependencyとして実体化
- 非group列は既存 `aggregateDependencyValidation.ts` のpolicyで拒否
- group → HAVING → windowの実行順は維持
- same-SELECT group key集合をwindow警告判定へ明示的に渡す

対象:

- `src/types/ast.ts`
- `src/parser/parser.ts`
- `src/core/aggregateDependencyValidation.ts`
- `src/core/dmlGuard.ts`
- `src/converter/selectToKintone.ts`
- `src/engine/process.ts`
- `src/execute.ts`

#### B. 式内window

Aと分けて実装できます。

- `SelectStatement` に公開 `columns` とは別の内部 `hiddenWindows` を追加
- ネストwindowを一意な内部IDへ抽出し、式側はそのIDを参照
- `applyWindow` は公開windowとhidden windowを評価
- `project`、`computeOutputKeys`、column meta、CSV、DISTINCTにはhidden windowを渡さない
- WHERE / HAVING / JOIN ONは従来どおり拒否
- 同一window式の重複抽出を避けるか、少なくとも決定的な順序とIDを保証

公開 `columns` に `hidden: true` の列を混ぜる案は、列indexがmaterialized valueのキーであり、`project()` が全列を公開する現在の設計と衝突します。別配列の方が安全です。

### テスト計画

既存で書き換えが必要:

- `src/parser/__tests__/window.test.ts:57-63`
- 同ファイル `101-112`
- B129診断テスト `115-143`
- nested VALUE window拒否 `183-188`
- GROUP BY併用拒否 `205-211`

追加:

- A:
  - 集計aliasと集計式直書きの両方
  - GROUP BYキー、未group化物理field、曖昧alias
  - HAVING後の行集合でwindow評価
- B:
  - `ROUND(SUM(x) OVER (),1)`
  - `x - LAG(x) OVER (...)`
  - windowを含む算術、関数、CASE
  - WHERE / HAVINGでは拒否
- 1段版と既存3段版を同一入力で比較
- `9/10`、`99/100`、大きい値と小さい値をASC/DESC両方向
- 同順位、`RANK`、累計ROWS、既定RANGE
- hidden列が `columns`、row key、DISTINCT、CSV、Dashboard列に出ない
- `completeInputReasons()` にhidden aggregate windowの `AGGREGATE_WINDOW`、hidden orderの `WINDOW_ORDER` が出ること
- 文書の1段SQLをそのまま実行するテスト

### 互換性リスク

- A/Bとも構文拡張であり既存成功SQLは維持できますが、parser ASTと内部列indexの変更リスクは大きいです。
- B129の従来エラーを期待する利用者・テストは成功結果へ変わります。
- pluginのEXPLAIN表示は変更されます。共通engineを使うためplugin側も確認必須です。
- CLI / MCP / `/flow` のshapeは維持できますが、hidden列漏出時は `columns`、CSV、Dashboardが壊れます。
- `warnings` は同じ公開配列のままですが、同一SELECT group keyの一意性を証明するなら警告件数が変わります。
- `DISTINCT` は現在window後・project前にSELECT列を評価します。hidden列をdistinct tupleへ含めないことが必須です。

### 規模

A、Bとも **L**。Aはaggregate dependencyとwindow specificationの解決、Bは新しい内部ASTと非公開materializationが必要です。

## 6. 横断

### B181とB182

同じ経路ではありません。

- B181: 名前をどの列へ束縛するか
- B182: 束縛後の式・列をどの比較意味型で扱うか

ただしCTEやORDER BYでは、最終的に「列名→`columnMeta` / `orderSemantics`」のmap参照で合流します。ASCIIを含む `AS Total` に `ORDER BY Total` を使う場合、B181だけ直すと列は解決しても、B182未修正なら `COALESCE(SUM(...),0)` は文字列順のままです。逆にB182だけ直しても `Total` 参照は解決しません。

### B183の8行

B181/B182修正後の扱い:

| 行 | 判断 |
|---|---|
| 1. DESCRIBE・lookup copy target | 残す |
| 2. JOINの向き・pushdown | 残す |
| 3. WHEREの日付条件 | 残す |
| 4. 空値・COALESCE回避 | 「集計をCOALESCEで包むな」は削除。空文字と除数guardは残す |
| 5. 集計/windowの段分け | B184完了までは残す。B184後もWHERE/HAVINGと検証容易性の助言へ弱める |
| 6. ASCII alias禁止 | 禁止は削除。出力名が小文字化される契約だけ残す |
| 7. 要求列・RANK | 残す |
| 8. validate→explain・根拠 | 残す |

修正文例:

- `Empty cells are ''. Guard a denominator with x = '' OR x = 0; COALESCE/ISNULL preserve numeric semantics only when every argument is numeric.`
- `Column aliases are lowercased in result names. Later-stage references resolve materialized aliases case-insensitively; omit redundant aliases when the original physical field spelling must remain the output name.`

### B184とB182

依存します。隠しwindow列の意味型は、window引数・結果型と、その結果を包む式の型推定に必要です。特に `COALESCE(SUM(...) OVER (),0)` やwindow結果を含む `GREATEST` / `CASE` はB182と同じ推定器を使うべきです。

順序はB182先行が妥当です。B184側で独自の型推定を作ると再び経路差が生まれます。

### 起票外の副作用

- B181はSELECT以外に、CTEをsourceにしたINSERT/UPSERT、UPDATE FROM、subquery、UNIONの参照解決にも波及します。
- B182の型推定はORDERだけでなくHAVING・CASE条件・MIN/MAX/MODEの比較意味論にも影響し得ます。
- B184のhidden windowはrequired-field収集、complete-input判定、0行時の列復元、column metaにも登録が必要です。
- 同一SELECT aliasは通常のSELECT式から見えない既存契約です。B184で見えるようにするのはwindow specification内の「集計後値」に限定し、一般のSELECT式へ広げてはいけません。`docs/ksql_language_reference.md:1633-1644`
- same-block GROUP BYのwindow警告抑止は、新しい証明規則です。既存のderived/CTE判定はgroup key一意性を証明できず、明示的に警告を残します。`src/execute.ts:3610-3630`, `src/execute.ts:3641-3648`

## 7. PR分割の比較と推奨

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| 1本 | B181〜B184を一括 | リリース作業は1回 | 原因・契約が異なり、回帰時の切り戻し不能。patch修正とminor構文拡張が混在 |
| 4本 | B182 / B181 / B183 / B184 A+B | B181〜B183は明確 | B184のA/Bが大きく、レビューと切り戻しが難しい |
| **5本・推奨** | **B182 / B181 / B183 / B184-A / B184-B** | 正しさ修正を先に出せる。B184を段階検証できる | 共通基盤に後続PRが依存する |

推奨順とゲート:

| PR | 版 | 規模 | 受入ゲート |
|---|---:|---:|---|
| B182 | patch | M | 対象Jest、`npm test`、`npm run docs:check`、`npm run version:check` |
| B181 | patch | M | 対象Jest、全参照位置、`npm test`、docs/version check |
| B183 | patch | S | MCP instruction tests、budget更新、`npm test`、docs/version check |
| B184-A | minor候補 | L | parser/engine/window/EXPLAIN/complete-input、`npm test`、docs/version check |
| B184-B | 同じminor | L | hidden列・DISTINCT・CSV・全surface、`npm test`、docs/version check |

B184-A/Bは別PRにしつつ同一minorでリリースするのが妥当です。Bだけを先に出さず、A→Bの順にします。

## 8. 起票文書との食い違い・見落とし

1. **B182 §2の算術原因は不完全**  
   「関数が集計を評価しない」だけでなく、`COALESCE(SUM(...),0)+0` が `ARITH_COL` になり、`hasAggregateColumns()` とmaterializationから漏れるのが直接原因です。

2. **B184 §1「パーサで拒否する。エンジン側の制約ではない」は過大評価**  
   実行順は対応済みですが、AST・`applyWindow`・required-field collector・projectがトップレベル `WINDOW_COL` 前提です。

3. **B184-Aの例 `ORDER BY SUM(売上)` は、必ずしも1355の門番まで到達しない**  
   windowの `parseOrderByKey()` はaggregateを解析後に位置を戻し、aggregate用のORDER keyを生成しません。`src/parser/parser.ts:3752-3762`。`ORDER BY s` と集計式直書きを別受入に分ける必要があります。

4. **B184 §3の「CTE経由の現行判定と同じ根拠」は不一致**  
   現行CTE経路は通常の集計キーを一意と証明せず、警告文中で「すでに一意でも証明できない」と明記しています。`src/execute.ts:3641-3648`

5. **B184のhidden列はcomplete-input判定にも必要**  
   現在は `stmt.columns` のトップレベルwindowだけを見ます。`src/core/dmlGuard.ts:181-195`

6. **B183のbudget test更新が起票の変更ファイル候補から漏れている**  
   exact値・上限・段落数を固定しています。`src/mcp/__tests__/metadataTools.test.ts:120-139`

## 9. Claudeが実機で確かめるべき残項目

- B182: SFAデータで `20,700,000 > 9,050,000` のORDER、RANK、累計、算術値。
- B181: MCP・CLI・pluginでCTE、一時表、同一SELECT ORDER BYの `Amount` / `amount`、`顧客No` / `顧客no`。
- B181: 物理field codeの大文字小文字が引き続き区別されること。
- B183: 同一依頼をbefore/after各3回。生成SQL、列順、RANK、総計0 guard、余計な列の有無を記録。
- B184-A/B: 1段版と既存3段版の10行・値・列順・警告・EXPLAINを比較。
- plugin: EXPLAIN文言、エラー全文、hidden列非表示。
- Dashboard・CSV export: `columns` と行キーに内部window列が出ないこと。
- `/flow`・MCP・CLI JSON: `columns`・`warnings` のshapeが不変であること。

