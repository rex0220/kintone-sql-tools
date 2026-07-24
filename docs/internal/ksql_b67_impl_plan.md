# B67 Phase1 実装計画 — kintone 相対日付関数の exact pushdown

- ステータス: 📋 実装計画（仕様 R2 準拠）**・Claude レビュー済＝承認（2026-07-24）**。8 Step・各 Step gate・**Step 1 = runtime backstop を planner より先に独立導入**（R1/R2 レビューの核心）・§1.3 の code 裏取り表（evalWhere dispatch/resolveKintoneFunc default なし switch/whereCapability 一律 KINTONE_FUNC/execute.ts FULL_SCAN 再評価/BETWEEN 展開）が Claude 検証済みと一致・既存3関数 byte 不変を共通 gate に含む＝そのまま着手可能。**次＝実装着手可否の判断（7.0〜11.5 人日）**。
- 正仕様: [B67 Phase1 仕様 R2](ksql_b67_rest_query_functions_phase1_spec.md)
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B67
- 手本: [B66 実装計画](ksql_b66_impl_plan.md)／[B65 実装計画](ksql_b65_impl_plan.md)
- 実装分担: codex はファイル編集と自動検証まで。`git status`／`git diff`を含むgit操作、差分レビュー、commit、branch、push、PR、tagはすべてClaude側で行う。Release／publishはClaude／ユーザーが別途判断し、codexはgit／release操作を一切実行しない。

## 1. 結論と段階マージ方針

B67 Phase1 は、R2 で確定した方針 A、すなわち **押し下げ専用・server-only・fail-closed** で実装する。相対日付関数を kSQL／JavaScript の日時へ変換せず、型・演算子・関数名・物理計画の全条件が揃った場合だけ kintone REST query へそのままシリアライズする。条件が1つでも欠ける場合は records／Cursor／mutation／confirm の前に拒否し、FULL_SCAN や取得後の `evalWhere` へフォールバックしない。

実装は次の8 Stepに分ける。

1. **runtime backstop** — planner を通らず `evalWhere` へ到達しても silent `undefined` にせず必ず fail-closed
2. legacy byte 不変を維持した AST と WHERE 専用 contextual parser／soft keyword
3. legacy serializer の隣に後置する相対日付 serializer と byte snapshot
4. B32 `whereCapability` の型 × 演算子 × 関数名 allowlist
5. 全 statement／plan walk と `evalWhere` 到達経路の取得前拒否
6. EXPLAIN、KORDER native／cursor、DML、Node／CLI／MCP／plugin の統合
7. B55／B60 catalog、fixture、instructions、言語リファレンス同期
8. R2 受入 matrix、全面 smoke、Firefox／Chrome 実ブラウザ手順と evidence

**Step 1 が最重要であり、planner allowlist より先に独立 merge する。** 現行 `src/engine/evalWhere.ts` は `case "KINTONE_FUNC"` から `resolveKintoneFunc(value.name)` を無条件に呼び、`resolveKintoneFunc` の `switch` には `default` がない。型境界を bypass して相対日付名が入ると `undefined` を silent return し得る。Step 1 でこの穴を先に塞ぐことで、Step 4／5 の planner 列挙漏れや将来 drift があっても silent-wrong-result を防ぐ。ただし backstop は最後の砦であり、Step 4／5 の取得前拒否を省略する理由にはしない。

Step 2〜3 は構文と REST 表現を純加法で用意するが、Step 4〜6 の schema-aware／plan gate が揃うまで実行経路を開通させない。各 Step は単独レビュー・単独 commit 可能な単位とし、Claude が gate を確認して commit した後に次へ進む。

### 1.1 各 Step の共通 gate

各 Step 末で次を必須とする。

1. `npm test` が全 green。既存の `scripts/run-tests.mjs` 二段 runnerをそのまま使い、通常 gate に Jest 引数を追加しない。
2. `npm run build` が成功する。現行scriptは plugin／CLI／MCP／MCPB の既存4配布面にB66のengineを加えた5 buildを実行するため、指定4面の無回帰と `build:engine` greenの両方を確認する。
3. Step 固有 test／smokeと、影響面に対応する既存 smokeが成功する。
4. `src/parser/__tests__/__snapshots__/parser_compat.test.ts.snap` を含む既存 snapshot は無変更。B67 の新しい AST／query snapshot は B67 専用 test／snapshot に置く。
5. `TODAY()`／`NOW()`／`LOGINUSER()` の AST JSON、REST query、SELECT／DML／EXPLAIN query、client resolver 挙動は byte／behavior 不変。
6. エンジンの既存 SQL 比較意味論、B26 client 比較、LIKE／KLIKE、通常 SIMPLE／FULL_SCAN routingを変えない。B67は新しい12関数だけの純加法とする。
7. Claude が対象差分、test output、smoke output、既存 snapshot 無変更、必要な実測 evidenceをレビューし、Claude が commit する。codex は `git add`／`git commit` を含む git 操作を一切行わない。

### 1.2 全 Step を貫く非変更条件

- 相対日付関数を client の日付・日時・期間へ解決しない。
- Node／CLI／MCP／browser の時計、タイムゾーン、週境界、月末補正を使わない。
- `resolveKintoneFunc("TODAY" | "NOW" | "LOGINUSER")` の既存3 caseを変更しない。
- legacy `KintoneFunction` branchへ `args?` を追加しない。既存3関数の JSON shapeは `{ "type": "KINTONE_FUNC", "name": ... }` のままとする。
- legacy `convertKintoneFunc` を一般化して書き換えない。相対日付 serializerは隣接する後置分岐にする。
- 相対日付関数を一般 `ScalarValueExpr`、SELECT、SET／VALUES、CHECK、HAVING、JOIN ON、CASE、GROUP BY、ORDER BY keyへ広げない。
- kintone が正規な関数 queryを REST errorにした場合、FULL_SCAN／client評価へ retryしない。

## 2. 仕様 §1.3 と R2 安全性の実コード裏取り

計画作成時に確認した現行契約と実装接続点は次のとおり。行番号は R2 作成時の目印であり、実装着手時は関数名で再検索する。

| 実コード | 現行契約の裏取り | B67 の変更／不変条件 | 主 Step |
|---|---|---|---:|
| `src/types/ast.ts` `KintoneFunction` | `type` と `TODAY | NOW | LOGINUSER` の `name` だけを持つ | legacy branchを形ごと残し、新規 relative branchだけ discriminated `args` を持つ | 2 |
| `src/lexer/tokens.ts` | 既存3関数は専用 `TokenKind`／`KEYWORDS` | legacy tokenを変えない。12関数名と引数語をグローバル hard keywordにせず、WHERE値位置の IDENT contextual spelling／soft keywordとして扱う | 2 |
| `src/parser/parser.ts` `PARSER_CONTEXTUAL_FUNCTION_TOKEN_MAP`／`parseSqlValue()` | 既存3関数は専用 tokenから引数なし `KINTONE_FUNC` を生成 | legacy branchを先に保持し、相対日付は `IDENT + LPAREN` の WHERE専用 parserへ分離する | 2 |
| `src/parser/parser.ts` `parseCompareExpr()` | `BETWEEN` は `>=` と `<=` の `AND` へ展開される | 展開後の両比較を capability／plan walkで判定し、片方でも非exactなら文全体を拒否する | 2, 4, 5 |
| `src/converter/whereToKintone.ts` `convertValue()`／`convertKintoneFunc()` | `KINTONE_FUNC` は `${v.name}()` で出力される | legacy serializerを変更せず、相対日付専用 serializerを後置。関数名・引数を検証済み ASTからだけ出力 | 3 |
| `src/engine/evalWhere.ts` `resolveValue()` | `case "KINTONE_FUNC"` は `resolveKintoneFunc(value.name)` へ無条件 dispatch | 相対日付名は共通 client評価境界で必ず `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` をthrow | **1** |
| `src/engine/evalWhere.ts` `resolveKintoneFunc()` | 既存3関数だけの defaultなし `switch`。型境界 bypass時に silent `undefined` となり得る | 既存3 caseを維持し、相対日付名を値へ変換する前に明示 backstop。bypass test必須 | **1** |
| `src/core/optimization/whereCapability.ts` `classifyBinary()` | 右辺 typeが `KINTONE_FUNC` なら関数名を見ず、一律 push可能候補。型別 native operatorだけで exactになり得る | `right.type`／`right.name` を渡す型 × 演算子 × 関数名 allowlistへ拡張 | 4 |
| `src/core/optimization/whereCapability.ts` reason union | 現在は汎用 `WHERE_*` reasonのみ | R2 §5.3 の相対日付5 reasonを共用 unionへ追加し、関数名を診断へ保持 | 4 |
| `src/execute.ts` FULL_SCAN／取得後 filter | FULL_SCANや `VALIDATE` 等に元 WHEREを `evalWhere` で再評価する経路がある | 相対日付を含む SELECT／statementを plan walkし、records／Cursor／mutation／confirm前に拒否 | 5 |
| `src/core/optimization/korderPlanner.ts` `planKorder()` | `staticMode=SIMPLE`、`whereCapability=EXACT_PUSHDOWN` を必須とし、`KORDER_NATIVE`／`KORDER_CURSOR` を選択 | exactな相対日付 WHEREだけ双方へ通し、同じ REST queryを使用。非exactはfallbackせずB67 reasonを保持 | 6 |
| `src/mcp/docsResources.ts` `KSQL_FUNCTION_CATALOG.contextual` | contextualは既存3関数 | 12関数を追加し、B55双方向 drift guardとfixtureを同期 | 7 |
| `src/mcp/index.ts` `FUNCTION_CATALOG_PARAGRAPH`／`KSQL_MCP_INSTRUCTIONS` | catalogからinstructionsを生成 | 長いserver-only説明を重複せず、catalog追加後の実測語数期待値を更新し `<= 550` を維持 | 7 |
| `src/mcp/__tests__/functionCatalog.test.ts`／`fixtures/ksqlFunctionCatalogFixtures.ts` | catalog ⇔ parser ⇔ fixtureを双方向検査 | contextual IDENT spellingを含めた12関数の公式引数fixtureを追加 | 7 |
| `docs/ksql_language_reference.md`／`src/mcp/docsResources.ts` | 言語リファレンスをMCP docs resourceへ埋め込む | WHERE相対日付節、server-only、型・演算子・引数・fail-closed・backtick退避を同期 | 7 |

### 2.1 R2 で確定した安全性の要

安全性は次の二段で成立させる。

1. **planner側の取得前拒否**  
   型 × 演算子 × 関数名 allowlistと全 SELECT／statement plan walkにより、相対日付関数を含む計画を「WHERE全体が物理アプリへ `EXACT_PUSHDOWN`」または「API前拒否」の二択にする。
2. **runtime backstop**  
   plannerを bypassした手組み AST、列挙漏れ、将来の新経路から `evalWhere` へ相対日付関数が到達しても、`undefined`、空文字、現在時刻、その他のclient値を返さず、関数名と `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` を含むerrorをthrowする。

受入条件は両方のtestが greenであることとする。planner testだけ、またはbackstop testだけではB67を完了にしない。

## 3. Step 1 — runtime backstop（最重要・plannerより先にmerge）

### 3.1 目的

現行の defaultなし `switch` による silent `undefined` を最初に除去する。相対日付関数がどの経路からclient evaluatorへ来ても、誤値で比較せず明示 fail-closedにする。このStepはB67 parser／allowlistの開通に依存させず、手組みASTのbypass fixtureで独立に固定する。

### 3.2 対象ファイル

- 既存
  - `src/engine/evalWhere.ts`
  - 必要なら既存共通error／reason型の配置ファイル（新規共通moduleを採る場合は下記へ集約）
- 新規候補
  - `src/core/relativeDateFunction.ts` — 12関数名集合、`isRelativeDateFunctionName()`、reason code定数。parser／planner／serializer／backstopが同じtruth sourceを参照する
  - `src/engine/__tests__/b67RelativeDateBackstop.test.ts`
- 回帰
  - `src/engine/__tests__/evalWhere.test.ts`

### 3.3 実装内容

1. `evalWhere.ts` の `resolveValue()` にある `case "KINTONE_FUNC"` dispatch、または `resolveKintoneFunc` に入る直前の共通境界で相対日付名を判定する。
2. 12関数名なら、関数名と `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` を含むerrorを必ずthrowする。
3. `TODAY()`／`NOW()`／`LOGINUSER()` は既存 `resolveKintoneFunc` の型、3 case、戻り値、Node／MCP差を変更しない。
4. 未知の `KINTONE_FUNC` 名も silent `undefined` にしない。B67相対日付名は規定reason、その他の不可能な値はinternal exhaustive errorとしてdefault denyにする。
5. planner／serializerを呼ばず、FULL_SCAN相当の `evalWhere` へ手組み相対日付ASTを直接渡すtest seamを作る。
6. `FROM_TODAY`だけでなく、引数なし・週・月・年の各shapeを代表する最低4分類をbypass testする。結果booleanではなくthrowとreasonを観測する。

### 3.4 gate

共通 gateに加え、次を満たす。

- plannerを通さず `evalWhere` へ到達させた `YESTERDAY`、`FROM_TODAY`、`THIS_WEEK`、`LAST_MONTH`、`NEXT_YEAR` がすべて `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` でthrowする。
- `undefined`、`""`、現在日時、false比較結果、部分結果を1件も返さない。
- 既存3関数のresolver testは無変更でpassし、既存3関数入り FULL_SCAN の挙動を変えない。
- Step 1では相対日付SQLをparserで受理せず、実行能力を開かない。
- Claudeが「planner非依存の防御」「既存3case不変」「未知名default deny」を確認してClaudeがcommitする。

### 3.5 Claude 確認観点

- backstopが `evalWhere` の全 `KINTONE_FUNC` client評価に共通して効き、特定planner経路だけのguardになっていないか。
- errorを投げる前に `resolveKintoneFunc`、`Date`生成、文字列比較を行っていないか。
- 既存3関数の入力unionと挙動を広げていないか。
- bypass testがplanner mockの自己証明ではなく、実際の `evalWhere` dispatchを通っているか。

想定: **0.5〜0.75人日**。

## 4. Step 2 — AST、WHERE専用 contextual parser、soft keyword

### 4.1 目的

legacy ASTをbyte不変で残し、R2 §2／§7の12関数と引数だけをWHERE比較右辺で受理する。同名fieldを壊さず、引数語をhard keyword化せず、不完全呼出しを通常field／scalar関数へfallbackしない。

### 4.2 対象ファイル

- 既存
  - `src/types/ast.ts`
  - `src/lexer/tokens.ts`
  - `src/parser/parser.ts`
  - `src/execute.ts`（Step 5の精密plan gateまでの暫定一律拒否だけ）
  - `src/parser/__tests__/parser_compat.test.ts`
- Step 1で新設した場合
  - `src/core/relativeDateFunction.ts`
- 新規
  - `src/parser/__tests__/b67RelativeDateFunctions.test.ts`
  - `src/parser/__tests__/__snapshots__/b67RelativeDateFunctions.test.ts.snap`（snapshotを採る場合）

### 4.3 実装内容

1. `KintoneFunction` を legacy branchと `RelativeDateFunction` のdiscriminated unionにする。legacy branchは `type`／`name` の2 propertyだけとし、相対日付branchだけが必須 `args` を持つ。
2. 相対日付branchはR2 §7.2どおり、少なくとも `NONE`、`FROM_TODAY`、`WEEK`、`MONTH` の引数shapeを関数名と対応させ、不正な関数名×引数を型で表現不能にする。
3. `FROM_TODAY.offset` は `Number.isSafeInteger`、`offsetText` は検証後の最短10進表記とする。`-0`／先頭ゼロは`0`／最短表記へ正規化し、serializerで再丸めしない。
4. 12関数名は `TokenKind`／`KEYWORDS` のhard keywordへ追加しない。汎用 `parseSqlValue()` 全体へ分岐を足すのではなく、`parseCompareExpr()` の通常比較右辺と `BETWEEN` のlow／highだけが呼ぶ `parseWhereSqlValue()`／`parseRelativeDateFunction()` 相当の専用入口で、`IDENT` かつ直後が `LPAREN` の場合だけ認識する。
5. `DAYS`／`WEEKS`／`MONTHS`／`YEARS`、7曜日、`LAST` は該当引数位置の非引用IDENTを大文字比較するsoft keywordとする。STRING／BIDENTは引数として拒否する。
6. 既存 `PARSER_CONTEXTUAL_FUNCTION_TOKEN_MAP` と既存3関数の引数なし分岐を先に残す。相対日付は別の `PARSER_IDENT_RELATIVE_DATE_FUNCTIONS` 等へ分け、Step 7で `PARSER_FUNCTION_SPELLINGS` に統合できるexportを用意する。
7. 空引数／必須引数／余分引数／末尾カンマ／小数／指数／`+5`／式／変数／安全整数外／月0・32／未知曜日をParseErrorにする。
8. `IN`／`NOT IN` 内へ相対日付関数を一般化しない。`BETWEEN` は現行の2比較展開を維持し、low／highだけをWHERE専用値parserから生成する。
9. `DAYS`、曜日、`LAST`、12関数名と同名の通常field／aliasを従来どおり受理し、backtick退避も固定する。
10. Step 2を単独mergeしても不完全なserializer／plannerで相対日付SQLが実行されないよう、Step 5完了までは相対日付ASTを含むstatementをmetadata以外のAPI前に `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` で一律拒否する暫定preflightを置く。Step 5で精密plan gateへ置換する。

### 4.4 gate

共通 gateに加え、全12関数の大文字／小文字正例、R2 §10.2／§10.3の引数負例、safe integer上下限、`-0`正規化、同名field corpusをpassさせる。既存3関数のparse AST JSONをbyte比較し、`parser_compat` snapshotは変更しない。相対日付関数がSELECT列、SET／VALUES、CHECK、CASE result、ORDER key等でparse可能になっていないことを負例で固定する。構文正例を実行しようとしても暫定preflightによりrecords／Cursor／mutation／confirm 0で拒否されることを確認する。Claudeがlegacy branchに`args`がないこと、soft keywordであること、WHERE専用であること、Step 5前の実行能力が閉じていることを確認してcommitする。

### 4.5 Claude 確認観点

- 12関数名をhard keywordにせず、同名fieldの既存SQLを壊していないか。
- legacy `KintoneFunction` のruntime JSONにoptional propertyすら増えていないか。
- `offsetText`がsafe integer確認後の正規化済み文字列であり、指数／丸めを持ち込まないか。
- parse失敗時に通常fieldや一般scalar functionへfallbackしていないか。
- 暫定preflightがStep 1 backstopへ到達してから止めるのではなく、metadata以外のAPIとclient評価より前に拒否するか。

想定: **1.5〜2.5人日**。

## 5. Step 3 — 相対日付 serializer と legacy byte snapshot

### 5.1 目的

検証済みrelative ASTだけをR2 §6のREST表現へ変換する。既存3関数のserializerを変更せず、相対日付専用分岐を隣に後置して純加法を証明する。

### 5.2 対象ファイル

- 既存
  - `src/converter/whereToKintone.ts`
- 新規
  - `src/converter/__tests__/b67RelativeDateWhereToKintone.test.ts`
  - `src/converter/__tests__/__snapshots__/b67RelativeDateWhereToKintone.test.ts.snap`（snapshotを採る場合）
- 回帰
  - `src/converter/__tests__/whereToKintone.test.ts`
  - SELECT／UPDATE／DELETE／EXPLAINの既存query生成test

### 5.3 実装内容

1. `convertKintoneFunc` のlegacy `${v.name}()` 分岐を先にそのまま残す。
2. 新しい `convertRelativeDateFunction` を後置し、関数名・単位・曜日・`LAST`を大文字、引数区切りを`, `、引数なしを`NAME()`で出力する。
3. `FROM_TODAY` は `offsetText` を使用し、`Number.toString()`で再丸めしない。
4. fieldとoperatorは既存 `convertField`／`convertOp`を再利用し、`<>`→`!=`、論理式の括弧付けを変えない。
5. 関数引数をSQL文字列としてquote／escapeしない。AST discriminant不整合はinternal fail-closedにする。
6. `BETWEEN`展開後の `日付 >= FROM_TODAY(-7, DAYS) and 日付 <= TODAY()` をbyte snapshotする。

### 5.4 gate

共通 gateに加え、R2 §6の全代表出力、全12関数、負offset、曜日、`LAST`、31、引数なしをbyte比較する。`TODAY()`／`NOW()`／`LOGINUSER()` 単体とSELECT／UPDATE／DELETE／EXPLAIN queryを変更前baselineとbyte比較し、空白・括弧・論理式の組み方まで不変とする。Claudeがlegacy先行分岐、relative後置分岐、`offsetText`使用を確認してcommitする。

### 5.5 Claude 確認観点

- 共通可変長args serializerへ既存3関数を巻き込んでいないか。
- parserで検証していない任意文字列をserializerが通さないか。
- `, `、大文字、最短10進、`<>`正規化が仕様どおりか。
- snapshot更新がB67専用追加だけで、既存snapshot更新を正当化していないか。

想定: **0.5〜0.75人日**。

## 6. Step 4 — B32 型 × 演算子 × 関数名 allowlist

### 6.1 目的

現行の「右辺typeが `KINTONE_FUNC` なら一律push候補」を廃し、相対日付だけを関数名まで含むexact allowlistで判定する。既存3関数の能力を狭めず、相対日付は4型×6比較だけをexactにする。

### 6.2 対象ファイル

- 既存
  - `src/core/optimization/whereCapability.ts`
  - `src/core/optimization/__tests__/whereCapability.test.ts`
- Step 1で新設した場合
  - `src/core/relativeDateFunction.ts`
- 新規
  - `src/core/optimization/__tests__/b67RelativeDateWhereCapability.test.ts`

### 6.3 実装内容

1. `classifyBinary()` に `right.type`だけでなく実際の `SqlValue`／`KINTONE_FUNC.name`を渡し、関数名別判定を可能にする。
2. 相対日付関数は `DATE`／`DATETIME`／`CREATED_TIME`／`UPDATED_TIME` × `=`／`!=`／`<`／`<=`／`>`／`>=` のみ `EXACT_PUSHDOWN` とする。
3. `TIME`、非日付型、型不明、非物理列、サブテーブル、関連レコード、collection型は `WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED`。
4. `IN`／`NOT IN`、LIKE系、許可6比較外は `WHERE_RELATIVE_DATE_OPERATOR_UNSUPPORTED`。
5. 関数左辺、式列、一般 scalar context等は `WHERE_RELATIVE_DATE_CONTEXT_UNSUPPORTED`。
6. 相対日付を含み `SUPERSET_PREFILTER`／`LOCAL_ONLY`／`UNSUPPORTED` となる組合せは、後続plan gateが `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` として取得前拒否できる情報を保持する。
7. reason unionへR2の5 codeを追加する。
   - `WHERE_RELATIVE_DATE_ARGUMENT_INVALID`
   - `WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED`
   - `WHERE_RELATIVE_DATE_OPERATOR_UNSUPPORTED`
   - `WHERE_RELATIVE_DATE_CONTEXT_UNSUPPORTED`
   - `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN`
8. reasonには少なくとも関数名、field、fieldType、operatorを保持し、EXPLAINとruntimeが同じ判定結果を再利用できる形にする。
9. 既存3関数は既存の型×native operator契約を維持し、B67の4型制限を逆適用しない。

### 6.4 gate

共通 gateに加え、4型×6比較×12関数の正matrix、`TIME`／非日付／未知型／非物理列、全不正operatorの負matrixをpassさせる。AND／OR／BETWEEN展開で一部だけexactの場合にWHERE全体をexactと誤判定しないこと、既存B32 matrixと既存3関数の結果が不変であることを確認する。Claudeが「typeだけでなくnameを見ている」「既存3関数を狭めていない」「reasonを後段で再利用できる」を確認してcommitする。

### 6.5 Claude 確認観点

- `rightType === "KINTONE_FUNC"` の旧一括exact条件が残っていないか。
- allowlistのtruth sourceがparser／serializer／backstopとdriftしないか。
- `TIME`をrange operator対応だけを理由に許可していないか。
- `BETWEEN`の両枝、AND／ORのcombineで相対日付reasonを失っていないか。

想定: **1.0〜1.5人日**。

## 7. Step 5 — plan walk と全 `evalWhere` 到達経路の取得前拒否

### 7.1 目的

R2 §5.2の全経路を、statement内の各SELECTノードまで再帰walkして拒否する。serializer可能かどうかではなく、「物理アプリのWHERE全体がexactに押し下げられ、取得後に同じ関数ノードを評価しない」ことを実行条件にする。

### 7.2 対象ファイル

- 既存
  - `src/execute.ts`
  - `src/converter/selectToKintone.ts`
  - `src/core/optimization/whereCapability.ts`
  - `src/core/optimization/wherePredicatePushdown.ts`
  - `src/core/optimization/sharedPlanner.ts`
  - `src/types/ast.ts`（walk helperに必要な型参照のみ）
- 新規候補
  - `src/core/optimization/relativeDatePushdownGuard.ts`
  - `src/core/optimization/__tests__/b67RelativeDatePlanGuard.test.ts`
  - `src/__tests__/b67RelativeDateExecutionPaths.test.ts`
- 回帰対象
  - `src/__tests__/execute.test.ts`
  - `src/__tests__/validate*.test.ts`
  - UPDATE FROM／APPLY／REORDER／subtable DML／CTE／temp関連既存test

### 7.3 実装内容

1. 相対日付関数の存在検査をASTの単純top-level WHEREだけに置かず、statement／SELECT treeを再帰walkする共通helperにする。
2. `SELECT`、`WITH`の全CTE bodyとmain、`UNION`の左右、SELECT sourceを持つ文を個別に検査する。
3. 各相対日付付きSELECTは次をすべて満たす場合だけ許可する。
   - 対象が一意な物理kintone appのトップレベルfield
   - WHERE全体がB32 `EXACT_PUSHDOWN`
   - 実際のREST queryへ関数付き比較がserializeされる
   - 取得後 `evalWhere` 再評価がない
4. 次の経路を records／Cursor／mutation／confirm 前に `WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` で拒否する。
   - JOIN、JOIN残余WHERE
   - aggregate、window、DISTINCT、通常 `ORDER BY`、ローカル式等のFULL_SCAN
   - `SUPERSET_PREFILTER`／`LOCAL_ONLY`／`UNSUPPORTED`
   - materialized CTE、temp table、派生／ローカル結果
   - existing-record `VALIDATE`
   - サブテーブル UPDATE／DELETE
   - UPDATE FROM
   - APPLY親選択と各補助取得
   - REORDER
   - その他、取得後にWHEREを再評価するSELECT source／DML補助経路
5. top-level UPDATE／DELETE／`VALIDATE ONLY` は既存B32 DML境界でWHERE全体exactかつ取得後相対関数評価0の経路だけを許可する。
6. 拒否時はfield metadata取得だけを許し、records GET、Cursor POST／GET／DELETE、mutation、confirmを0回にする。
7. executionとEXPLAINで別のwalk／判定を複製せず、共通plan resultをStep 6へ渡す。
8. Step 1 backstop testを維持し、plan guardが漏れた場合にもruntimeで同じreasonへ閉じる。

### 7.4 gate

共通 gateに加え、R2 §5.2／§10.4の経路matrixをtable-driven testにし、各拒否で records／Cursor／mutation／confirm 0を確認する。SIMPLE SELECTと許可DMLはquery内に関数を保持し、client evaluator spy 0とする。WITH／UNIONは「statement全体」ではなく各SELECT nodeの混在正負を検査する。planner matrixとStep 1 bypass testの双方を同じgateで再実行する。Claudeが経路一覧、API 0、副作用境界、walkの再帰完全性を確認してcommitする。

### 7.5 Claude 確認観点

- 「whereToKintoneで変換できる」だけで許可していないか。
- FULL_SCANがREST prefilter後に元WHERE全体を再評価する事実を見落としていないか。
- `WITH`／`UNION`／SELECT source文で内側SELECTを取りこぼしていないか。
- `VALIDATE`、temp／CTE、subtable DML、UPDATE FROM、APPLY、REORDERのAPI作成前にguardが走るか。
- planner guardとruntime backstopが独立testされ、どちらか一方で代用されていないか。

想定: **1.5〜2.5人日**。

## 8. Step 6 — EXPLAIN、KORDER、DML、4実行面の統合

### 8.1 目的

schema-aware capability／plan reasonをEXPLAINと実行で共有し、KORDER native／cursor、SELECT、DML、Node／CLI／MCP／pluginの判定とREST queryを一致させる。

### 8.2 対象ファイル

- 既存
  - `src/core/optimization/korderPlanner.ts`
  - `src/core/optimization/canonicalOrderPlanner.ts`
  - `src/core/explainMetadata.ts`
  - `src/execute.ts`
  - `src/converter/selectToKintone.ts`
  - `src/mcp/tools.ts`
  - `src/mcp/schemas.ts`（description driftがある場合だけ。受理契約は増やさない）
- 新規／更新test
  - `src/core/optimization/__tests__/b67RelativeDateKorder.test.ts`
  - `src/__tests__/b67RelativeDateExplain.test.ts`
  - `src/__tests__/b67RelativeDateDml.test.ts`
  - CLI／MCP／plugin共有engine経路の既存integration test
  - `scripts/mcp-smoke.mjs`（B67 assertionを追加）

### 8.3 実装内容

1. EXPLAINは共通plan resultから、関数名、evaluation=`kintone server`、field／type、operator、`EXACT_PUSHDOWN`、client evaluation=`forbidden`、kintone queryを表示する。
2. 拒否EXPLAINは実行可能なGET／Cursor planを表示せず、関数名とR2 reason codeを表示する。フォームmetadata以外のrecords／Cursor／mutation APIは0。
3. `planKorder()` の既存 `staticMode=SIMPLE`＋`whereCapability=EXACT_PUSHDOWN`条件を維持する。許可相対日付WHEREは `KORDER_NATIVE`／`KORDER_CURSOR` の双方で同一queryを使う。
4. nonexact相対日付WHEREは通常ORDER／FULL_SCANへfallbackせず、`KORDER_WHERE_NOT_EXACT`だけに潰さずB67 reasonを診断へ保持する。
5. cursor切替後もclient evaluatorを呼ばず、server queryの関数表現を変えない。
6. SELECT、UPDATE、DELETE、`VALIDATE ONLY`、EXPLAINのschema-aware判定を同じguardへ集約する。
7. Node library、build済みCLI、MCP `ksql_query`／`ksql_explain`、pluginが別parser／serializer／allowlistを持たず、engineの同じ判定を使うことをtestする。
8. MCP `ksql_validate` は構文／引数検査のみで、metadataのない経路から実行可能と断定しない。schema-awareなquery／explain／実行で最終判定する。

### 8.4 gate

共通 gateに加え、EXPLAIN正負、SELECT／DML、KORDER native／cursorをpassさせる。native／cursorのREST query byte一致、client evaluator 0、Cursor error時もclient fallback 0を確認する。build済みCLIとMCP smokeで同じSQLのquery／reason codeを比較し、plugin test harnessも同じengine結果を使うことを確認する。ClaudeがEXPLAIN＝実行、native＝cursor、4面同一を確認してcommitする。

### 8.5 Claude 確認観点

- EXPLAIN専用の重複allowlistが実行判定とdriftしないか。
- KORDER非exact時に既存汎用reasonがB67の本質的reasonを隠していないか。
- cursor pathでWHEREを再構築して空白／大文字／引数を変えていないか。
- MCP validateの構文成功をschema-aware実行成功として表現していないか。

想定: **0.75〜1.25人日**。

## 9. Step 7 — catalog、fixtures、instructions、言語リファレンス

### 9.1 目的

B55／B60の完全関数カタログへ12関数をcontextualとして追加し、parser、fixture、MCP instructions、embedded docs、公開言語リファレンスのdriftを自動検出する。

### 9.2 対象ファイル

- 既存
  - `src/parser/parser.ts` `PARSER_FUNCTION_SPELLINGS`
  - `src/mcp/docsResources.ts` `KSQL_FUNCTION_CATALOG.contextual`
  - `src/mcp/index.ts` `FUNCTION_CATALOG_PARAGRAPH`／`KSQL_MCP_INSTRUCTIONS`
  - `src/mcp/__tests__/functionCatalog.test.ts`
  - `src/mcp/__tests__/fixtures/ksqlFunctionCatalogFixtures.ts`
  - `src/mcp/__tests__/docsResources.test.ts`
  - `docs/ksql_language_reference.md`
  - 必要に応じて `scripts/mcp-smoke.mjs`
- 新規候補
  - `src/mcp/__tests__/b67RelativeDateDocs.test.ts`
  - `docs/internal/evidence/b67_relative_date_smoke.md`

### 9.3 実装内容

1. `KSQL_FUNCTION_CATALOG.contextual`へ次の12関数を追加する。
   - `YESTERDAY TOMORROW FROM_TODAY`
   - `THIS_WEEK LAST_WEEK NEXT_WEEK`
   - `THIS_MONTH LAST_MONTH NEXT_MONTH`
   - `THIS_YEAR LAST_YEAR NEXT_YEAR`
2. `PARSER_FUNCTION_SPELLINGS`を、既存token mapだけでなく相対日付IDENT contextual spellingも含む形へ純加法で一般化する。
3. `KSQL_FUNCTION_SQL_FIXTURES`へ各関数1件以上の公式引数shapeを追加する。週曜日、月`LAST`／数値、`FROM_TODAY`単位をfixture全体で代表させる。
4. catalog ⇔ parser ⇔ fixtureの双方向drift guardを維持し、12関数の片側追加漏れをfailさせる。
5. `KSQL_MCP_INSTRUCTIONS`のcomplete function catalogへcatalog経由で反映する。server-onlyの長文をinstructionsへ重複せず、既存 `Use ksql_docs for arguments and constraints.` から言語リファレンスへ誘導する。
6. 現行529語、12関数追加後の概算541語を実測し、期待値を実測値へ更新する。`<= 550` guardを維持し、超えた場合は意味を削らず既存重複文を圧縮する。
7. `docs/ksql_language_reference.md` のWHERE／日付関数節へ、対象関数、引数、4型、6比較、BETWEEN、server-only、exact pushdown必須、client fallbackなし、reason code、soft keyword／backtick退避を記載する。
8. `docsResources`埋込みsectionから同じ説明へ到達できることをtestし、Node／MCP docsの差を作らない。
9. CLI／plugin helpやschema descriptionに重複一覧が見つかった場合はcatalog生成へ寄せるか同一性guardを追加し、手書きの第2一覧を放置しない。

### 9.4 gate

共通 gateに加え、function catalog双方向test、全fixture parse、docs resource test、instructions実測語数期待値、`<= 550` guard、MCP build後のinstructions／docs smokeをpassさせる。既存3 contextual関数の順序・説明・LOGINUSER注記を不必要に変更しない。Claudeが12関数、fixtureの引数妥当性、541語前後の実測、言語リファレンスのserver-only説明を確認してcommitする。

### 9.5 Claude 確認観点

- parserで受理する12 spellingとcatalog／fixtureが完全一致するか。
- instructionsへ長文を足して550語guardを破っていないか。
- `ksql_validate`とschema-aware実行の違いがdocsで誤解されないか。
- 既存3関数とB67相対日付関数のclient評価可否を混同していないか。

想定: **0.5〜0.75人日**。

## 10. Step 8 — 受入 matrix、全面 smoke、実ブラウザ手順

### 10.1 目的

R2 §10をtest／smoke／実機evidenceへ1対1で対応付け、Node／CLI／MCP／Firefox plugin／Chrome pluginでSQL、REST query、reason codeが一致することをrelease gateとして固定する。

### 10.2 対象ファイル

- 新規
  - `src/__tests__/b67RelativeDateAcceptance.test.ts`
  - `docs/internal/evidence/b67_relative_date_acceptance.md`
  - `docs/internal/evidence/b67_relative_date_browser_smoke.md`
- 更新
  - `scripts/mcp-smoke.mjs`
  - CLI smokeの既存script（代表query／EXPLAIN／拒否reasonを追加）
  - plugin browser smokeの既存harness／手順文書
  - 本計画 `docs/internal/ksql_b67_impl_plan.md`（完了status／実測値のみ）
  - `docs/ksql_issue_tracker.md`（実装完了時）
- 回帰
  - parser、converter、whereCapability、execute、EXPLAIN、KORDER、DML、catalog／docsのStep 1〜7全test

### 10.3 実装内容

1. 正例matrix
   - 全12関数、大文字／小文字入力、全4型、全6比較。
   - `FROM_TODAY`負／0／正、安全整数上下限。
   - 曜日、月日1／31／`LAST`、引数なし週／月／年。
   - BETWEEN展開と既存 `TODAY()` との混在。
   - SIMPLE SELECT、許可UPDATE／DELETE／`VALIDATE ONLY`。
   - KORDER native／cursor。
2. 負例matrix
   - 全引数エラー、safe integer外。
   - `TIME`、非日付、未知型、サブテーブル、関連レコード。
   - SELECT／HAVING／SET／CHECK／CASE／算術／ORDER key／関数左辺。
   - IN／NOT IN／NOT BETWEEN。
3. planner拒否matrix
   - FULL_SCAN、JOIN残余、aggregate、window、DISTINCT、通常ORDER BY。
   - materialized CTE、temp、`VALIDATE`、subtable DML、UPDATE FROM、APPLY、REORDER。
   - AND／ORの一部だけexact、serverがREST errorを返す場合。
4. backstop matrix
   - planner test seamを意図的にbypassし、FULL_SCAN／`evalWhere`へ相対日付ASTを到達させる。
   - `undefined`／空文字／現在時刻／誤booleanではなく、関数名＋`WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN`をthrow。
5. legacy byte matrix
   - 既存3関数のAST JSON、converter、SELECT／DML／EXPLAIN query、resolver。
6. 全面matrix
   - Node engine、build済みCLI、build済みMCP、plugin harnessで同じSQL／query／reason。
   - MCP `ksql_validate`は構文結果、`ksql_explain`／`ksql_query`はschema-aware結果として差を意図どおり確認。
7. 実ブラウザsmokeはユーザー実施手順として次を文書化する。
   - 同一buildのFirefox／Chrome pluginを使用。
   - SIMPLE records GET、KORDER_NATIVE、KORDER_CURSORの各1件。
   - DevTools／mock記録で送信queryが期待byteと一致し、client evaluator 0。
   - FULL_SCAN代表と非対応型代表がAPI前reasonで拒否され、records／Cursor／mutation 0。
   - kintone serverが返した結果を記録し、ローカル日付計算の期待値で置換しない。
   - 両browserのSQL、query、plan kind、結果／error、versionをevidenceへ貼る。

### 10.4 gate

1. 共通 gate。
2. `npm test` 全green、既存snapshot無変更。
3. `npm run build` でplugin／CLI／MCP／MCPB全成功。
4. B67 parser／serializer／capability／plan／backstop／EXPLAIN／KORDER／DML／catalog test全成功。
5. `npm run mcp:smoke`、MCP pack／MCPB verify等の既存配布smoke無回帰。
6. build済みCLIとMCPの代表正例・拒否例が同じquery／reason。
7. Firefox／Chrome実ブラウザsmokeはユーザーが実施し、両方のevidenceが揃うまでbrowser release gate未完了とする。Node testで代替しない。
8. ClaudeがR2 §10との受入ID対応、全output、API 0、legacy byte不変、両browser evidenceをレビューし、Claudeがcommitする。

### 10.5 Claude 確認観点

- R2 §10.2〜§10.5の全項目がtestまたは実機evidenceへ対応しているか。
- planner側拒否とruntime bypassの両方が独立にgreenか。
- 実ブラウザをNode／jsdom／plugin build成功で代替していないか。
- server結果をclient日時計算で予測・補正していないか。
- 全面で同一engine契約を使い、surface別の例外allowlistを作っていないか。

想定: **0.75〜1.5人日**（Firefox／Chromeのユーザー実施時間を除く）。

## 11. 段階マージ順と安全境界

| 順 | 独立レビュー単位 | 開く能力 | merge時の安全境界 |
|---:|---|---|---|
| 1 | runtime backstop | client評価のsilent-wrong防止 | parser未開通、planner非依存 |
| 2 | AST／parser | SQL構文と検証済みAST | 実行経路は未開通 |
| 3 | serializer | REST query表現 | schema／plan gate前は実行不可 |
| 4 | B32 allowlist | exact候補の型判定 | 非exactはまだ開かない |
| 5 | plan walk | SIMPLE exactだけ実行可 | API前拒否＋Step 1 backstop |
| 6 | EXPLAIN／KORDER／DML／4面 | 全実行経路の統合 | execution＝EXPLAIN、native＝cursor |
| 7 | catalog／docs | 公開発見性 | 550語guard、drift guard |
| 8 | acceptance／browser | release可否の証拠 | Firefox／Chromeはユーザー実施必須 |

Step 2／3だけをmergeしても相対日付の実行を有効にしない。Step 2の暫定preflightで全相対日付ASTをAPI前拒否し、Step 5で精密plan gateへ置換する。Step 4／5の取得前拒否とStep 1のbackstopが揃って初めてSIMPLE exact経路を開く。Step 6でEXPLAIN／KORDER／DML／全surfaceを揃え、Step 8の両browser evidenceがない状態は「Node／CLI／MCP自動gate完了、browser release gate未完了」と明記する。

## 12. 再見積り

| Step | 領域 | 人日 |
|---:|---|---:|
| 1 | runtime backstop／bypass test | 0.5〜0.75 |
| 2 | AST／WHERE専用parser／soft keyword／引数検証 | 1.5〜2.5 |
| 3 | serializer／legacy byte snapshot | 0.5〜0.75 |
| 4 | B32 型×演算子×関数allowlist／reason | 1.0〜1.5 |
| 5 | recursive plan walk／全取得後評価経路拒否 | 1.5〜2.5 |
| 6 | EXPLAIN／KORDER／DML／4面統合 | 0.75〜1.25 |
| 7 | catalog／fixtures／instructions／docs | 0.5〜0.75 |
| 8 | acceptance／smoke／browser手順 | 0.75〜1.5 |
| **合計** | **B67 Phase1** | **7.0〜11.5人日** |

正仕様の6〜10人日から増えた理由は、R2で明示されたruntime backstopをplannerより先の独立Step／bypass testにしたこと、§5.2の全 `evalWhere` 到達経路をtable-driven matrixにしたこと、EXPLAIN／KORDER native・cursor／DML／4面同一性と両browser手順を独立gateにしたことである。相対日付のclient評価を追加しないため、タイムゾーン／週境界／月末計算の実装工数は含めない。

## 13. 着手前に Claude 確認が要る点

仕様R2の公開意味論は確定済みであり、方針Aを再選択しない。着手前のClaude確認は実装境界とmerge順に限定する。

1. **最重要:** Step 1のruntime backstopをplanner allowlistより先に独立mergeし、`evalWhere`直達bypass testを最初の停止gateにすること。
2. backstopの挿入点を `resolveValue()` の `case "KINTONE_FUNC"` dispatch直前とするか、`resolveKintoneFunc`直前の共通guardとするか。いずれも既存3関数の入力union／3caseを変えず、相対日付名を値へ変換する前にthrowすること。
3. 12関数名集合・type guard・reason codeを `src/core/relativeDateFunction.ts` の単一truth sourceへ置き、parser／serializer／planner／backstopで共有する配置。
4. legacy `KintoneFunction`を形ごと保持し、新規branchだけ必須`args`を持つdiscriminated union設計。
5. 相対日付関数名をIDENT contextual spellingにし、引数位置の12 soft keyword（4単位＋7曜日＋`LAST`）をhard keyword化しないparser方針。
6. B32 reason unionへR2の5 codeを追加し、EXPLAINとruntimeで共通plan resultを使う設計。
7. §5.2のplan walkを `src/core/optimization/relativeDatePushdownGuard.ts` 等の専用moduleに集約し、`execute.ts`へ経路別の重複ifを散らさない配置。
8. top-level UPDATE／DELETE／`VALIDATE ONLY`のうち、既存B32境界でWHERE全体exactかつ取得後相対関数評価0の経路だけを許可すること。
9. KORDERは既存 `staticMode=SIMPLE`＋`EXACT_PUSHDOWN`を維持し、native／cursor双方を許可、非exact時に通常ORDER／FULL_SCANへfallbackしないこと。
10. instructionsは12関数名のcatalog追加だけを基本とし、詳細は言語リファレンスへ置いて実測`<= 550`を維持すること。
11. 8 Stepのcommit分割、各Step共通gate、Claudeレビュー→Claude commit、codex git非実行の分担。
12. 再見積りを **7.0〜11.5人日** とし、Firefox／Chrome実ブラウザsmokeの実施時間はユーザー側として別扱いにすること。

## 14. 完了判定

B67 Phase1を完了と呼べるのは、次がすべて成立したときだけである。

1. 相対日付関数は許可された物理appのWHERE比較でだけparseされる。
2. 4型×6比較×12関数だけがschema-aware `EXACT_PUSHDOWN`になる。
3. SIMPLE SELECT／許可DML／KORDER native・cursorのREST queryへ関数がbyte正確に入る。
4. FULL_SCAN、JOIN残余、VALIDATE、temp／CTE、subtable DML、UPDATE FROM、APPLY、REORDER等はAPI前に拒否される。
5. planner bypassでもruntime backstopがsilent `undefined`を許さない。
6. EXPLAINと実行、Node／CLI／MCP／pluginが同じcapability／reason／queryを使う。
7. 既存 `TODAY()`／`NOW()`／`LOGINUSER()` のAST／query／resolverがbyte／behavior不変である。
8. catalog／parser／fixture／instructions／docsのdrift guardと`<= 550`語guardがgreenである。
9. `npm test`全green、plugin／CLI／MCP／MCPBの既存4面とengine build無回帰、既存snapshot無変更、該当smoke成功。
10. Firefox／Chrome実ブラウザevidenceをユーザーが取得し、Claudeが全gateをレビューしてcommitする。

## 15. 最終要約

1. 実装は8 Step。最重要のStep 1で、plannerより先にruntime backstopとbypass testを入れる。
2. parser／AST／serializerはlegacy branchをbyte不変で保持し、新規relative branchだけを純加法で追加する。
3. B32は型×演算子×関数名allowlistへ拡張し、Step 5のplan walkとStep 1のbackstopの二段でserver-onlyを守る。
4. §5.2のFULL_SCAN／JOIN残余／VALIDATE／temp・CTE／subtable DML／UPDATE FROM／APPLY／REORDERをAPI前拒否する。
5. EXPLAIN、KORDER native／cursor、DML、Node／CLI／MCP／pluginを同じengine判定へ統合する。
6. catalog／instructions／言語リファレンスを同期し、12関数追加後もinstructions `<= 550`語を維持する。
7. 再見積りは **7.0〜11.5人日**。codexは編集と自動検証まで、gitとcommitはClaude側、Firefox／Chrome実機smokeはユーザー実施とする。
