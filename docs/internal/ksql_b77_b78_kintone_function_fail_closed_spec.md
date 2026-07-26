# B77 + B78 — kintone 関数 fail-closed／ユーザー・複数値フィールド演算子仕様

- 作成日: 2026-07-27
- 版: **R1（Claude レビュー待ち）**
- ステータス: **仕様起草。実装未着手**
- 対象リリース: **B75 と同一リリース**
- SemVer 推奨: **major**（§13）
- オーナー決定: [B77 issue §0](ksql_b77_today_now_loginuser_fail_closed_issue.md#0-オーナー決定2026-07-27)／[B78 issue §0](ksql_b78_user_field_loginuser_issue.md#0-オーナー決定2026-07-27)
- 設計前提: [B67 評価](ksql_b67_rest_query_functions_evaluation.md)／[B72 spec](ksql_b72_relative_date_fullscan_exact_spec.md)
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B75 / B76 / B77 / B78
- 公式根拠: [kintone クエリの書き方](https://cybozu.dev/ja/kintone/docs/overview/query/)

## 1. 目的

B77 と B78 は、kintone server の実行文脈でしか正しく解決できない関数と、複数値・ユーザー値の比較を client へ落としたときの silent wrong result を同一リリースで閉じる。

現行には次の二つの穴がある。

1. `TODAY()` / `NOW()` / `LOGINUSER()` は、同じ kintone query function である相対日付 12 関数と違い、押し下げ不能時に `evalWhere()` で評価される。`TODAY()` / `NOW()` は実行環境の clock / TZ、`LOGINUSER()` は全環境で空文字となる。
2. `CREATOR` / `MODIFIER` / `CHECK_BOX` / `MULTI_SELECT` に `=` 等を書くと、kintone REST へは押し下げられないが拒否もされず、JSON 平坦値と文字列の局所比較に落ちて黙って 0 件になり得る。一方、正しい `作成者 in (LOGINUSER())` は parser が拒否する。

公開原則を次に固定する。

- kintone query function の値・日付境界・ユーザー文脈は kintone server が所有する。
- server function を含む predicate 自体、または B67 Phase2 A で証明済みの exact leaf を kintone へ送れない場合、records / cursor / mutation API 前に拒否する。
- server predicate に採用した関数部分を client で再評価しない。
- 「kintone REST に押し下げ可能」と「kSQL が局所評価して意味を保てる」を別契約として表す。
- parser が受理する関数を、kintone 公式表に根拠なく広げない。
- Node engine、CLI、MCP、Firefox plugin、Chrome plugin で受理判定、REST query、EXPLAIN、reason を一致させる。

## 2. スコープ

### 2.1 B77 対象

`WHERE` predicate 内の次の legacy kintone function 3 個を、相対日付 12 関数と同じ server-only plan guard の対象へ加える。

| 関数 | server での意味 | 現行 client 評価 | B77 後 |
|---|---|---|---|
| `TODAY()` | API 実行日 | `new Date()` のローカル日付 | 証明済み押し下げのみ。client 評価禁止 |
| `NOW()` | API 実行日時 | `new Date().toISOString()` | 証明済み押し下げのみ。client 評価禁止 |
| `LOGINUSER()` | API 実行ユーザー | 無条件に `""` | 証明済み押し下げのみ。client 評価禁止 |

「相対日付 12 関数と同じ」は、単純な whole-WHERE exact だけを意味しない。B67 Phase2 A、B72、B75 までに確立した allow-form を同じ条件で適用する。

1. whole-WHERE exact の SIMPLE / KORDER / exact DML。
2. B67 Phase2 A の exact server leaf ＋非関数 residual。例 `日付 = TODAY() AND LENGTH(件名) > 1` は、`日付 = TODAY()` を server prefilter とし、`LENGTH(...)` だけを client 評価する。
3. B72 の whole-WHERE exact ＋ local processing。
4. B75 の CTE / temp / inline context で許可済みの whole-WHERE exact。

したがって「SELECT が FULL_SCAN である」ことだけでは拒否理由にならない。関数 predicate が server で exact に評価され、client residual に関数 node が残らないことが判定基準である。

### 2.2 B78 対象

1. `IN` / `NOT IN` リストの要素として `LOGINUSER()` を受理し、`作成者 in (LOGINUSER())` を kintone query へ変換する。
2. `CREATOR` / `MODIFIER` / `CHECK_BOX` / `MULTI_SELECT` に対する `IN` / `NOT IN` 以外の比較演算子を、フィールドメタ取得後かつ records / cursor / mutation API 前に拒否する。
3. `LOGINUSER()` を含む IN predicate が押し下げ不能なら B77 の guard で拒否する。局所 `typedInContains()` で `LOGINUSER()` を解決しない。

### 2.3 明示的な対象外

- `CURRENT_DATE()` / `CURRENT_TIMESTAMP()` は kSQL scalar function であり、kintone query serializer に経路がない。`WHERE`、SELECT 式、SET / DECLARE 等の既存 client 評価を維持し、実行環境の clock / TZ で評価されることだけを文書化する。
- `TODAY()` / `NOW()` の SET / DECLARE 等、`WHERE` 以外の既存 scalar evaluation は対象外。`resolveKintoneFunc()` 自体を全面 throw 化してはならない。
- `DROP_DOWN` / `RADIO_BUTTON` はオーナー決定により B78(b) 対象外。kintone REST 公式表では `in` / `not in` のみだが、kSQL の局所値は素の文字列であり `=` 等の既存局所評価が意味を保つためである。
- `ORGANIZATION_SELECT` / `GROUP_SELECT` / `STATUS_ASSIGNEE`、サブテーブル構造制約の一般化、`PRIMARY_ORGANIZATION()` 実装は対象外。決定済み 4 型を越えて B78(b) を拡張しない。
- B76 JOIN predicate pushdown の新規能力は追加しない。B76 が未実装の形は B77 guard で閉じたままとする。
- `LOGINUSER()` と文字列を混在させる IN list、例 `in (LOGINUSER(), 'taro')` は R1 対象外。公式文書にある確実な形は singleton `in (LOGINUSER())` であり、混在形は実機根拠を得た別仕様で開く。

## 3. kintone 公式仕様から固定する型 × 演算子 × 関数

公式「フィールド、システム識別子ごとの利用可能な演算子と関数一覧」は、次を明示している。

| kintone / kSQL field type | 妥当な演算子 | 妥当な関数 |
|---|---|---|
| 作成者 `CREATOR` | `in` / `not in` | `LOGINUSER()` |
| 更新者 `MODIFIER` | `in` / `not in` | `LOGINUSER()` |
| ユーザー選択 `USER_SELECT` | `in` / `not in` | `LOGINUSER()` |
| 日付 `DATE` | 比較 6 演算子 | `TODAY()` と相対日付 12 関数。`NOW()` は不可 |
| 日時 `DATETIME` | 比較 6 演算子 | `TODAY()` / `NOW()` / 相対日付 12 関数 |
| 作成日時 `CREATED_TIME` | 比較 6 演算子 | `TODAY()` / `NOW()` / 相対日付 12 関数 |
| 更新日時 `UPDATED_TIME` | 比較 6 演算子 | `TODAY()` / `NOW()` / 相対日付 12 関数 |
| チェックボックス `CHECK_BOX` | `in` / `not in` | なし |
| 複数選択 `MULTI_SELECT` | `in` / `not in` | なし |

ここで比較 6 演算子は `=` / `!=` / `>` / `<` / `>=` / `<=` である。

### 3.1 IN list に許す値

| IN-list 要素 | parser | schema-aware 判定 | 根拠 |
|---|---|---|---|
| 文字列・数値・scalar batch variable | 現行どおり許可 | 現行型契約 | 既存 kSQL 契約 |
| `LOGINUSER()` singleton | **追加で許可** | `CREATOR` / `MODIFIER` / `USER_SELECT` × `IN` / `NOT IN` だけ許可 | 公式例 `作成者 in (LOGINUSER())` と型別表 |
| `TODAY()` | 拒否 | — | 公式表では日付系 field の比較 RHS。IN 関数ではない |
| `NOW()` | 拒否 | — | 公式表では日時系 field の比較 RHS。IN 関数ではない |
| 相対日付 12 関数 | 拒否 | — | 公式表では日付系 field の比較 RHS。IN 関数ではない |
| `PRIMARY_ORGANIZATION()` | 拒否 | — | kSQL 未実装。B54 / B67 Phase2 の別課題 |
| scalar kSQL function / field ref / sub-expression | 現行どおり拒否 | — | B78 で一般式 IN-list へ拡張しない |

B78 issue の「kintone 関数（`LOGINUSER()` 等）」は、現行 kSQL が実装済みで公式に IN-list 使用が確認できる関数へ具体化すると `LOGINUSER()` だけである。`TODAY()` / `NOW()` や相対日付 12 関数まで構文上受理し、後から型エラーにする案は採らない。利用不能な AST を増やすだけで、公式根拠もないためである。

## 4. parser / AST / serializer 契約

### 4.1 AST

現行 `InList.values` は `StringLiteral | NumberLiteral | VariableRef` に閉じている（`src/types/ast.ts:643-647`）。R1 は用途限定型を加える。

```ts
type InListFunction =
  Omit<LegacyKintoneFunction, "name"> & { name: "LOGINUSER" };

interface InList {
  type: "IN_LIST";
  values: (StringLiteral | NumberLiteral | VariableRef | InListFunction)[];
}
```

実装時は TypeScript の union 形に合わせて同等の named type または明示 interface としてよい。重要なのは `KintoneFunction` 全体を `InList.values` へ入れないことである。

`LegacyKintoneFunction` の既存 runtime shape `{ type:"KINTONE_FUNC", name:"LOGINUSER" }` は変えない。新しい AST node kind や `IN_FUNCTION_LIST` は作らない。

### 4.2 parser

`parseInValues()` は次を満たす。

- `LOGINUSER` token の直後に空引数 `()` を要求し、singleton 要素として AST 化する。
- `IN (LOGINUSER())` と `NOT IN (LOGINUSER())` を受理する。
- comma を伴う混在リストは R1 では明示エラー。
- `TODAY()` / `NOW()` / 相対日付関数は現行の IN-list ParseError を維持する。
- エラー文は少なくとも「文字列、数値、バッチ変数、または単独の LOGINUSER()」を列挙し、B73 が将来 `PARSE_ERROR` を構造化できる位置・token 情報を維持する。
- `IN ()`、二重引用文字列、未解決変数、符号付き数値の現行契約を変えない。

### 4.3 serializer と全 consumer 監査

B78 issue の「`whereToKintone` の既存仕組みで足りる」は、単一 RHS `KINTONE_FUNC` には正しいが IN list には当てはまらない。現行 `convertInList()` は variable を除外した後、文字列以外をすべて `numberLiteralText(item)` へ渡す（`src/converter/whereToKintone.ts:301-323`）。実装では次を同一 Step で行う。

- `LOGINUSER()` を `convertKintoneFunc()` と同じ byte 表現で `LOGINUSER()` にする。
- `IN (LOGINUSER())` を `(LOGINUSER())`、`NOT IN` も同じ list byte で生成する。
- `assertResolvedInListValues()` は variable 解決だけを保証し、関数 node を number と誤 narrowing しない。
- `evalWhere.ts` の同名 helper、`aggregateExpression.ts` の label、batch variable AST walker、EXPLAIN residual renderer、safe-leaf extractor、テスト fixture builder を `InList.values` union 拡張に対して監査する。
- `wherePredicatePushdown.ts` の選択肢文字列専用 safe-leaf は `LOGINUSER()` を通常の option literal として扱わない。B77 の server-function plan が所有する。
- formatter / EXPLAIN は `LOGINUSER(...)` でなく `LOGINUSER()` と表示する。

parser だけを先に merge してはならない。現行 converter / evaluator が新 AST を number / `.value` と誤認する中間状態になるためである。

## 5. 「押し下げ可能」と「妥当」の分離

### 5.1 結論

`NATIVE_OPERATORS` は拡張せず、引き続き **kintone REST へ exact pushdown できる field type × operator** の表とする。

別に、kSQL が client 側で比較しても意味を保てるかを示す **局所意味論契約**を設ける。実装名は `LOCAL_VALID_OPERATORS` または同等の明確な名前とし、少なくとも B78 の制限対象を partial map として表す。

```ts
const LOCAL_VALID_OPERATORS = new Map<string, ReadonlySet<NativeOperator>>([
  ["CREATOR", new Set(["in", "not in"])],
  ["MODIFIER", new Set(["in", "not in"])],
  ["CHECK_BOX", new Set(["in", "not in"])],
  ["MULTI_SELECT", new Set(["in", "not in"])],
]);
```

map に無い型を「全演算子有効」と一般推論して公開してはならない。無い型は B78 による新しい制限を持たず、既存 `hasLocalContract()` と evaluator 契約へ委譲するという partial policy である。

### 5.2 判定順

`classifyBinary()` は field metadata 解決後、pushdown capability を判定する前に次を行う。

1. B78 partial validity policy に field type がある。
2. operator が policy set に無い。
3. `UNSUPPORTED` と `WHERE_OPERATOR_INVALID_FOR_FIELD_TYPE` を返す。

その後に限り `NATIVE_OPERATORS` を参照し、exact pushdown / local residual を分類する。

同じ validity helper を `classifyLocalOnlyField()` からも呼び、`IS NULL` / `IS NOT NULL` を含む binary 以外の field operator も拒否する。B78 の「`in` / `not in` 以外」は比較 6 演算子や LIKE 系だけに限定しない。`BETWEEN` は parser が展開する各比較で拒否する。

これにより次を区別できる。

| 状態 | capability | reason |
|---|---|---|
| kSQL 局所比較としても意味がない | `UNSUPPORTED` | `WHERE_OPERATOR_INVALID_FOR_FIELD_TYPE` |
| 局所比較は正しいが REST exact でない | `LOCAL_ONLY` | `WHERE_RESIDUAL` |
| REST exact | `EXACT_PUSHDOWN` | `WHERE_EXACT` |

`NATIVE_OPERATORS` に `=` を追加して B78 を「直す」案は不採用である。kintone server が拒否する query を exact と偽装するためである。

### 5.3 既存利用箇所への影響

`NATIVE_OPERATORS` / `nativeWhereOperatorsForType()` は where capability unit test と planner が使用しており、値を変更しないため既存 REST capability snapshot は不変とする。

新 validity policy は `classifyWhereCapability()` の共有入口を通し、少なくとも次の経路で API 前に働く。

- SIMPLE / FULL_SCAN / canonical ORDER / KORDER SELECT。
- EXPLAIN。
- UPDATE / DELETE target。
- VALIDATE の WHERE。
- CTE / temp / UNION branch / scalar subquery の各 SELECT node。
- CLI / MCP / plugin が呼ぶ共有 engine。

`evalWhere()` の実行時比較エラーだけに依存してはならない。records 取得後に初めて失敗するため、B78 の「取得前拒否」を満たさない。

## 6. B77 server-function capability と plan guard

### 6.1 共有関数分類

相対日付だけを表す `RELATIVE_DATE_FUNCTION_NAMES` は、引数検証・公開名称のため維持する。別に WHERE server-only 集合を共有する。

```text
SERVER_ONLY_WHERE_FUNCTION_NAMES
= TODAY, NOW, LOGINUSER
+ relative-date 12 functions
```

walker / backstop はこの集合を使うが、型 × 関数 × operator 検査は関数クラスごとに分ける。

- `LOGINUSER`: `CREATOR` / `MODIFIER` / `USER_SELECT` × `IN` / `NOT IN`。RHS は singleton IN list。
- `TODAY`: `DATE` / `DATETIME` / `CREATED_TIME` / `UPDATED_TIME` ×比較 6。
- `NOW`: `DATETIME` / `CREATED_TIME` / `UPDATED_TIME` ×比較 6。
- 相対日付 12: B67 の既存 argument / field / operator policy を byte 非回帰。

現行 `isLegacyKintoneFunction()` を単なる「押し下げ可能 RHS」として残してはならない。field type / operator を見ずに exact 判定するため、`$id >= TODAY()` や `DATE = NOW()` を exact と誤分類し得る。legacy 3 関数も専用 schema-aware classifier を通す。

### 6.2 IN-list 内関数の検出

現行 walker は object tree を再帰するため、`InList.values` 内の `KINTONE_FUNC` も検出できる形を維持する。ただし classifier は `right.type === "KINTONE_FUNC"` だけでなく、`right.type === "IN_LIST"` の関数要素を明示的に分類する。

次の invariant を置く。

```text
WHERE に server-only function occurrence がある
→ occurrence は関数別の型・演算子契約を満たす
→ 許可 plan の server query に同 occurrence がある
→ client residual に occurrence が 0
→ それ以外は API 前 rejection
```

同名関数を複数含む場合、名前集合だけでなく occurrence multiset を検証する。B72 / Phase2 A と同じく、serializer が一つ落としても許可しない。

### 6.3 B75 との合成

B77 は B75 が開いた context を狭めない。B75 の `collectWith()` / `collectSelect()` flag 伝播をそのまま使い、関数名判定だけを server-only 15 関数へ一般化する。

- CTE body / WITH main / temp source / inline query の whole-WHERE exact は `TODAY()` / `NOW()` / `LOGINUSER()` でも B75 と同じ条件で許可。
- B75 が閉じた Phase2 residual、nested SELECT、`inheritedForbidden` context は閉じたまま。
- `inheritedForbidden` を子 node で false に上書きしない。
- B77 の一般化を理由に B75 flag や allow-form を再設計しない。

B75 の guard 緩和は既に runtime が完成していたが、B78 の parser 緩和は converter / classifier / guard / backstop が未完成である。両者を同じ「guard だけの変更」とみなしてはならない。

## 7. reason code と B73 整合

### 7.1 B77

`WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN` は流用しない。`TODAY()` は日付だが `LOGINUSER()` はユーザー文脈であり、相対日付という名前では利用者が原因を特定できない。

legacy 3 関数には次を追加する。

- `WHERE_KINTONE_FUNCTION_FIELD_TYPE_UNSUPPORTED`
- `WHERE_KINTONE_FUNCTION_OPERATOR_UNSUPPORTED`
- `WHERE_KINTONE_FUNCTION_CONTEXT_UNSUPPORTED`
- `WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN`

zero-argument syntax は parser が保証するため、B77 で argument-invalid code は新設しない。

拒否表示は相対日付と同じ二層にする。

```text
TODAY: WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN
(reason=WHERE_KINTONE_FUNCTION_CONTEXT_UNSUPPORTED)
(path=statement...)
```

primary `code` は最も具体的な reason、`reasonCodes` は具体 reason と `...REQUIRES_EXACT_PUSHDOWN` の両方を保持する。相対日付 12 関数の既存 code / byte 表示は変更しない。

### 7.2 B78 field operator

`CREATOR = 'taro'` 等は次を返す。

```text
ArgumentError: WHERE predicate is unsupported
(field=作成者, type=CREATOR, operator==,
 reason=WHERE_OPERATOR_INVALID_FOR_FIELD_TYPE)
```

既存 `WHERE_OPERATOR_UNSUPPORTED` は「局所 evaluator 契約自体が無い」場合に残し、B78 の「型は既知だがこの operator は意味を保てない」と区別する。

### 7.3 B73

B73 の構造化エラー実装前でも、functionName / field / fieldType / operator / path / reasonCodes を planner 内部で失わない。将来は文字列を再 parse せず、その payload を `PARSE_ERROR` / `EXECUTION_ERROR` の structured fields と i18n message key に移せる形にする。

## 8. runtime backstop

planner guard は第一防御、runtime は最後の防御とする。

- `evalWhere()` の RHS `KINTONE_FUNC` が `TODAY` / `NOW` / `LOGINUSER` に到達したら `WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN` で throw する。
- IN-list 内 `LOGINUSER()` が局所 `evalOp()` に到達しても、`.value` や空文字へ変換せず同 reason で throw する。
- 相対日付 12 関数の既存 backstop と reason は不変。
- `resolveKintoneFunc()` は SET / DECLARE 等の非 WHERE 呼び出しのため維持する。WHERE backstop を作るためにこの関数を全面禁止してはならない。
- `CURRENT_DATE()` / `CURRENT_TIMESTAMP()` は `evalFunc.ts` の既存 client path を維持する。
- backstop error 後に空 query、全件取得、client retry、部分結果へフォールバックしない。

## 9. `TODAY()` / `NOW()` 既存影響監査

2026-07-27 の R1 起草時に、`.git` / `node_modules` / build 生成物を除き `TODAY()` / `NOW()` を大小文字非区別で全件検索し、SQL の位置と plan を分類した。以下の数には、検索後に新規作成した本 R1 自身を含めない。

### 9.1 検索実数

| 区分 | ファイル数 | call token 数 | B77 後に新規エラー化する既存 case |
|---|---:|---:|---:|
| `src` の test / fixture | **13** | **38** | **0 file / 0 case** |
| 公開 `docs/ksql_language_reference.md` + `docs/ksql_batch_recipes.md` | **2** | **37** | **0 file / 0 example** |
| `docs/internal/**/*.md` | **29** | **159** | **0 executable case** |
| `docs/ksql_issue_tracker.md` | **1** | **13** | 説明文のみ |
| docs 全体 | **32** | **209** | **0 file / 0 example** |

test / fixture 13 ファイルは次のとおり（右端は call token 数）。

```text
src/parser/__tests__/b67RelativeDateFunctions.test.ts                 3
src/parser/__tests__/batch.test.ts                                    1
src/parser/__tests__/parser.test.ts                                   4
src/lexer/__tests__/lexer.test.ts                                     2
src/converter/__tests__/b67RelativeDateWhereToKintone.test.ts        13
src/converter/__tests__/dmlToKintone.test.ts                          1
src/core/optimization/__tests__/b67RelativeDateWhereCapability.test.ts 2
src/core/optimization/__tests__/wherePredicatePushdown.test.ts        1
src/__tests__/b67Phase2RelativeDateAcceptance.test.ts                 4
src/__tests__/executeBatch.test.ts                                    2
src/__tests__/explain.test.ts                                         1
src/mcp/__tests__/fixtures/ksqlFunctionCatalogFixtures.ts             2
src/node/__tests__/appProfiles.test.ts                                2
```

internal docs 29 ファイルの内訳も次のとおり。

```text
docs/internal/evidence/b55_claude_desktop_smoke.md                    2
docs/internal/evidence/b65_guard_benchmark.md                         1
docs/internal/evidence/b67_phase2_acceptance.md                       2
docs/internal/evidence/b67_relative_date_browser_smoke.md             2
docs/internal/kintone_sql_plugin_spec.md                              2
docs/internal/ksql_b55_impl_plan.md                                   2
docs/internal/ksql_b55_mcp_docs_tool_spec.md                          1
docs/internal/ksql_b67_impl_plan.md                                  10
docs/internal/ksql_b67_phase1_spec_r1_brief.md                        4
docs/internal/ksql_b67_phase2_impl_plan.md                            4
docs/internal/ksql_b67_phase2_superset_prefilter_spec.md              2
docs/internal/ksql_b67_rest_query_functions_evaluation.md             3
docs/internal/ksql_b67_rest_query_functions_phase1_spec.md           13
docs/internal/ksql_b72_relative_date_fullscan_exact_spec.md           2
docs/internal/ksql_b77_today_now_loginuser_fail_closed_issue.md      25
docs/internal/ksql_b78_user_field_loginuser_issue.md                  3
docs/internal/ksql_batch_processing_roadmap.md                        2
docs/internal/ksql_batch_variable_followon_b10_evaluation.md          2
docs/internal/ksql_batch_variable_reference_extension_spec.md         2
docs/internal/ksql_batch_variables_phase1a_spec.md                    25
docs/internal/ksql_batch_variables_phase1b_spec.md                     1
docs/internal/ksql_batch_variables_phase1c_spec.md                    11
docs/internal/ksql_like_predicate_pushdown_spec.md                    13
docs/internal/ksql_numeric_predicate_pushdown_spec.md                  1
docs/internal/ksql_scalar_function_bundle_spec.md                      1
docs/internal/ksql_sql_feature_comparison_evaluation.md               2
docs/internal/ksql_v2.1.0_plugin_verification_sql.md                  10
docs/internal/ksql_v3_5_0_implementation_plan.md                       1
docs/internal/ksql_validate_datetime_millisecond_issue.md            10
```

### 9.2 0 件になる理由

- runtime / EXPLAIN の既存 WHERE 例は、日付系フィールドとの whole-WHERE exact で server pushdown される。
- `SET @now = NOW()` / `SET @cutoff = TODAY()` は B77 の WHERE guard 対象外。
- parser / lexer / serializer byte test は実行 plan を要求せず、構文自体は維持する。
- `$id >= TODAY()` は `wherePredicatePushdown` の「safe leaf に採用しない」既存負例であり、成功 query ではない。
- 相対日付と `TODAY()` を組み合わせた既存拒否 test は、既に相対日付 reason で拒否されるため「新規エラー化」ではない。

したがってリポジトリ内回帰の実数は **0 file / 0 case** である。ただしこれは breaking impact が無い証拠ではない。今回の発端となった `日付 = TODAY() AND LENGTH(...)` 等の client fallback 成功形が既存 regression suite に無かったことを示す。受入 test で新規に固定する必要がある。

### 9.3 文書上の更新対象

既存例をエラー例へ書き換える必要はないが、次の説明は更新する。

- language reference の legacy 3 関数を server-only allow-form / fail-closed reason へ統合。
- `CURRENT_DATE()` / `CURRENT_TIMESTAMP()` の client clock / TZ を明記。
- MCP function catalog の「LOGINUSER resolves to an empty string in Node/MCP」を削除し、WHERE は server-only、非 WHERE の対応範囲を正確にする。
- B67 の「既存 3 関数は不変」は当時の historical spec として残し、新 release entry / B77 spec から supersede する。過去 CHANGELOG を書き換えない。

## 10. EXPLAIN

EXPLAIN は実行と同じ server-function plan を使い、API を呼ばない。

正例:

```text
kintone function: TODAY
kintone function evaluation: kintone server prefilter
where capability: SUPERSET_PREFILTER
server prefilter: 日付 = TODAY()
client residual: LENGTH(件名) > 1
kintone function client evaluations: 0
kintone query: 日付 = TODAY()
```

`作成者 in (LOGINUSER())` whole exact:

```text
kintone function: LOGINUSER
kintone function evaluation: kintone server
where capability: EXACT_PUSHDOWN
server predicate: 作成者 in (LOGINUSER())
client residual: (none)
kintone function client evaluations: 0
kintone query: 作成者 in (LOGINUSER())
```

拒否は実行可能な空 query を表示せず、functionName / path / specific reason / exact-pushdown reason を表示する。B67 相対日付 EXPLAIN の既存行・reason・snapshot を変更しない。

## 11. 受入条件

### 11.1 B77 正例

1. `日付 = TODAY()`、`日時 <= NOW()` が whole exact で server query に同じ byte を持ち、client evaluator 0。
2. `日付 = TODAY() AND LENGTH(件名) > 1` は B67 Phase2 A と同じく TODAY leaf を server prefilter、LENGTH だけを residual とし、全件 query に落ちない。
3. `日時 = NOW() AND LENGTH(件名) > 1` も同じ。
4. B72 の GROUP BY / DISTINCT / aggregate / window / canonical ORDER whole exact で legacy function を server へ送り、residual null。
5. B75 の CTE body / WITH main / temp source / inline whole exact で同じ。`inheritedForbidden` の入れ子は開かない。
6. exact UPDATE / DELETE、DML source の既存許可形は同じ query byte。mutation / confirm 前 guard を維持。
7. `CURRENT_DATE()` / `CURRENT_TIMESTAMP()` の既存 client 評価と SET / DECLARE の `TODAY()` / `NOW()` は非回帰。

### 11.2 B77 拒否

8. non-exact OR / NOT、JOIN residual、VALIDATE / REORDER / subtable、閉じた materialization context、KORDER の未証明形を API 前に拒否。
9. `DATE = NOW()`、`$id >= TODAY()`、文字列 field `= TODAY()` を具体的 field-type reason で拒否。
10. `CREATOR = LOGINUSER()` を operator / context reason 付きで拒否し、0 rows を成功として返さない。
11. planner bypass で legacy function を `evalWhere()` へ渡しても local date / ISO / `""` を返さず backstop error。
12. rejection 後は records / cursor / mutation / confirm 0、retry 0。

### 11.3 B78 parser / query

13. `CREATOR IN (LOGINUSER())` / `MODIFIER NOT IN (LOGINUSER())` / `USER_SELECT IN (LOGINUSER())` を parse。
14. AST は既存 `KINTONE_FUNC` shape を IN_LIST の singleton に保持。
15. serializer は `LOGINUSER()` を引用せず、number converter に渡さない。
16. `IN (TODAY())` / `IN (NOW())` / `IN (THIS_MONTH())` / `IN (LOGINUSER(), 'taro')` は parser で明示拒否。
17. LOGINUSER IN を FULL_SCAN / residual に落とす形は B77 reason で API 前拒否。
18. string / number / signed number / batch variable / `IN (SELECT ...)` / `IN @list` の既存 AST・query・error を非回帰。

### 11.4 B78 field operator

19. `CREATOR` / `MODIFIER` / `CHECK_BOX` / `MULTI_SELECT` の `=` / `!=` / range / LIKE / KLIKE / `IS NULL` / `IS NOT NULL` を `WHERE_OPERATOR_INVALID_FOR_FIELD_TYPE` で API 前拒否。
20. 同 4 型の `IN` / `NOT IN` は既存 literal / subquery / variable path を維持。
21. `DROP_DOWN = 'A'` / `RADIO_BUTTON = 'A'` の正しい局所評価は維持。
22. B78 対象外型へ partial policy を波及させない。

### 11.5 B71 / B72 教訓と mock

23. records mock は request の `fields` だけを返す。全 field 常時返却 mock で合格にしない。
24. getFields mock は対象 field の正しい kintone fieldType を返す。空 schema fallback で exact / rejection を通さない。
25. 初回 records request の `fields` と `query` を同時 assert し、関数 field と local residual field の両方が必要な形では欠落させない。
26. mock が client clock で TODAY / NOW / LOGINUSER を再現した結果を正しさの証明に使わない。server 適用済み fixture、query byte、client evaluator 0 を別 assert にする。
27. B72 の教訓に従い、関数固有の `maxRecords` / `onLimit=truncate` 非対称を追加しない。同値な日付 literal query と同じ complete-input 規則を使う。
28. B75 の教訓に従い、plan context / `inheritedForbidden` / allow flags を黙って無視しない。各 flag の true / false test を持つ。

## 12. 4 面 parity と release gate

共有 engine に加えて、次の 4 面を固定する。

| 面 | 固定する内容 |
|---|---|
| CLI | success query / rows、fail-closed stderr reason、API 0、EXPLAIN |
| MCP | `ksql_validate` parser、`ksql_query` runtime、`ksql_explain`、`ksql_docs` / function catalog |
| Firefox plugin | 実 kintone session の LOGINUSER 絞り込み、TODAY prefilter、拒否 reason |
| Chrome plugin | Firefox と同一 SQL・query・rows・reason |

必須 smoke:

1. `作成者 in (LOGINUSER())` がログインユーザーの実レコードを返す。
2. `日付 = TODAY() AND LENGTH(件名) > 1` が `日付 = TODAY()` を server query に含み、client TODAY 評価 0。
3. `作成者 = LOGINUSER()`、`タグ = 'A'`（CHECK_BOX）が取得前拒否。
4. non-exact OR 内 TODAY が新 reason で拒否。
5. `CURRENT_DATE()` / `CURRENT_TIMESTAMP()` の client semantics 非回帰。

ブラウザ smoke は Node mock で代替しない。Firefox / Chrome の実機出力を release gate とする。

## 13. 移行案内と SemVer

### 13.1 CHANGELOG 文面の骨子

> **Breaking: kintone query functions in WHERE are now fail-closed.**  
> `TODAY()` / `NOW()` / `LOGINUSER()` は、相対日付関数と同様に kintone server へ安全に押し下げられる形だけで使用できます。従来 client 評価へ落ちていた query は、実行環境の TZ 差や `LOGINUSER() = ""` による誤結果を避けるため、レコード取得前に `WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN` で拒否します。回避するには、`WHERE` 全体または対象 leaf を押し下げ可能な形にするか、`TODAY()` / `NOW()` を固定の日付・日時 literal に置き換えてください。`CURRENT_DATE()` / `CURRENT_TIMESTAMP()` は対象外で、引き続き client の clock / TZ で評価されます。
>
> `IN (LOGINUSER())` を追加し、作成者・更新者・ユーザー選択をログインユーザーで絞り込めるようにしました。`CREATOR` / `MODIFIER` / `CHECK_BOX` / `MULTI_SELECT` に `in` / `not in` 以外を書くと、従来の silent 0 rows ではなく取得前エラーになります。

### 13.2 言語リファレンス文面の骨子

- kintone server-only 15 関数を一つの節で示し、legacy 3 と相対日付 12 の型差を表にする。
- allow-form は B67 / B72 / B75 の現行 4 形を基準にし、「FULL_SCAN なら不可」と単純化しない。
- `LOGINUSER()` は `CREATOR` / `MODIFIER` / `USER_SELECT` の singleton IN / NOT IN で使う。
- `TODAY()` / `NOW()` / 相対日付 12 は IN-list に書けない。
- fail-closed reason と移行策を列挙する。
- `CURRENT_DATE()` / `CURRENT_TIMESTAMP()` は kSQL scalar、常に client clock / TZ と明記する。

### 13.3 SemVer

**major を推奨する。**

- `TODAY()` / `NOW()` は実行環境 TZ が kintone と一致する場合には正しい結果を返していたため、成功 query が取得前エラーへ変わる。
- B78(b) も成功 result（実質誤った 0 rows）を error に変える。
- リポジトリ内既存 fixture の新規エラー化が 0 でも、公開契約上の breaking change は消えない。

silent wrong result の修正を minor で出す既存ポリシーをオーナーが明示する場合だけ minor を再検討する。B75 自体は additive minor だが、同梱される B77/B78 の版数を弱める根拠にはならない。

## 14. 実装 Step

| Step | 変更 | 単独 merge の安全性 | 見積 |
|---|---|---|---:|
| 1. capability 契約分離 | `LOCAL_VALID_OPERATORS` partial policy、新 reason、legacy 関数の型×演算子 classifier、unit test。公開 parser はまだ開かない | silent 0 rows を取得前 error に変える B78(b) が完結。REST capability は不変 | 0.5〜0.75 人日 |
| 2. server-function guard＋runtime backstop | server-only 15 関数 walker、B67/B72/B75 allow-form 共有、new reason、EXPLAIN plan payload、WHERE 専用 backstopを**同一 merge**。TODAY/NOW Phase2 prefilter test、全拒否 path test | guard だけ／backstop だけの非対称を作らない。SET / DECLARE は維持 | 1.0〜1.5 人日 |
| 3. LOGINUSER IN parser＋runtime を同時配線 | `InList.values` 限定 union、parser、converter、classifier、occurrence check、IN backstop、全 consumer type audit を**同一 merge** | parser だけ先行して converter/evaluator が新 AST を誤処理する状態を作らない | 0.75〜1.0 人日 |
| 4. B75 合成・EXPLAIN・mock acceptance | CTE / temp / inline / nested / inheritedForbidden、B71 requested-fields mock、occurrence multiset、snapshot 非回帰 | 公開意味論は Steps 1〜3 と同じ。機能間合成を固定 | 0.5〜0.75 人日 |
| 5. docs・4面・release gate | language reference、CHANGELOG、tracker、MCP catalog / docs guards、CLI/MCP/Firefox/Chrome smoke、version / artifacts | B75+B77+B78 の公開契約を同期 | 0.75〜1.0 人日 |

総見積: **3.5〜5 人日**。

同一 merge 必須箇所:

- Step 2 の planner guard 対象拡張と WHERE runtime backstop。
- Step 3 の parser / AST 緩和と converter / capability / guard / runtime。

Step 1 は guard 緩和ではなく拒否強化であり単独 merge 可能。B75 の既存 guard 緩和と B77/B78 runtime を一つの巨大 Step にまとめる必要はないが、release はオーナー決定どおり同一にする。

## 15. 判断論点の決着表

| # | 論点 | R1 決着 |
|---:|---|---|
| 1 | 押し下げ演算子と妥当演算子 | `NATIVE_OPERATORS` は不変。別の partial `LOCAL_VALID_OPERATORS` を新設し B78 4 型を取得前検査 |
| 2 | IN-list 関数 | 現行公式根拠がある singleton `LOGINUSER()` だけ。TODAY/NOW/相対日付12/混在 list は対象外 |
| 3 | fail-closed reason | relative code は流用せず `WHERE_KINTONE_FUNCTION_*` を新設。specific reason＋requires-exact の二層。B73 payload を保持 |
| 4 | TODAY/NOW 影響 | test/fixture 13 files・38 calls、public docs/recipes 2 files・37 callsを監査。新規エラー化は **0 files / 0 cases** |
| 5 | 移行案内 | whole WHERE / exact leaf を押し下げ可能にする、または固定日付・日時 literal。CURRENT_* は client TZ と明記 |
| 6 | Step | guard＋backstop、parser＋runtime はそれぞれ同一 merge。B75 は同一 release |
| 7 | 4面 parity | CLI / MCP / Firefox / Chrome で SQL、query、rows、EXPLAIN、reason、API 0 を固定 |

## 16. 判断に迷った点・現行文書／コードの食い違い

1. **B78 の「kintone 関数一般」**: 公式型別表で IN-list 用と確認できる現行実装関数は `LOGINUSER()` のみ。`TODAY()` / `NOW()` / 相対日付を広げる根拠が無いため R1 は限定した。これはオーナー決定を実現可能な最小の公式準拠形へ具体化したもので、実現不能ではない。
2. **IN serializer の見立て**: B78 issue は `whereToKintone` の既存仕組みで足りるとしているが、実コードの `convertInList()` は string / number 専用である。parser 変更だけでは実現できず、Step 3 の同時配線が必要。
3. **LOGINUSER の環境説明**: MCP catalog / B67 評価は Node/MCP で空文字と読めるが、実コードは環境判定なしで plugin を含め無条件に空文字。B77 issue の訂正事実を採用する。
4. **DROP_DOWN / RADIO_BUTTON**: kintone 公式 REST 表は `in` / `not in` のみだが、オーナー決定は局所 `=` 等を維持する。R1 は「REST で妥当」とは呼ばず、「kSQL の局所意味論として正しい」と分離して矛盾を解く。
5. **“同じ fail-closed” の解釈**: legacy 3 関数を常に whole-WHERE exact に限定すると、B67 Phase2 A / B72 / B75 より狭くなりオーナー決定と矛盾する。R1 は既存の全 allow-form を共有し、関数 occurrence が client residual に残る形だけを拒否する。
6. **SemVer**: repo 内の新規エラー化は 0 だが、公開上は現在成功する TODAY/NOW client fallback を意図的に error 化する。R1 は major を推奨するが、最終版数はリリースポリシーのオーナー判断が残る。

現時点で、オーナー決定を実現不可能にする仕様矛盾はない。

---

## 17. Claude レビュー（2026-07-27・R1 承認）

**結論: R1 を承認する。実装へ進んでよい。** 以下は独立検証の結果と、実装時に留意すべき点。

### 17.1 公式仕様の裏取り（kintone-docs で確認）

§3 の型 × 演算子 × 関数表は**公式ドキュメントと完全に一致**することを確認した。
特に次の細部まで正しい。

- **`日付` の関数一覧に `NOW()` は無い**（`日時` / `作成日時` / `更新日時` にはある）
- `作成者` / `更新者` / `ユーザー選択` は `in` / `not in` のみ・関数は `LOGINUSER()`
- `グループ選択` は `in` / `not in` だが**関数は「なし」**（`LOGINUSER()` は不可）
- `組織選択` の関数は `PRIMARY_ORGANIZATION()`（kSQL 未実装・対象外で正しい）
- `ステータス` は `=` / `!=` / `in` / `not in`（`=` が妥当）
- チェックボックス / ラジオボタン / ドロップダウン / 複数選択は `in` / `not in`・関数なし

したがって §3.1「IN-list に追加するのは `LOGINUSER()` singleton だけ」という判断は
公式根拠にもとづく妥当な具体化であり、オーナー決定「kintone 関数（`LOGINUSER()` 等）」の
実現形として承認する。

### 17.2 B78(b) の対象 4 型が過不足ないことの検証

「`=` を書いたときに黙って 0 件になる型」を実測で洗い出した結果、
**R1 が挙げた 4 型と完全に一致**した。

| 型 | `=` の挙動 | B78(b) 対象 |
|---|---|---|
| `CREATOR` / `MODIFIER` | rows=0（エラーなし） | **対象** |
| `CHECK_BOX` / `MULTI_SELECT` | rows=0（エラーなし） | **対象** |
| `USER_SELECT` | ArgumentError | 既に正しい |
| `ORGANIZATION_SELECT` | ArgumentError | 既に正しい |
| `GROUP_SELECT` | ArgumentError | 既に正しい |
| `STATUS_ASSIGNEE` | ArgumentError | 既に正しい |
| `STATUS` | rows=1（正しい） | 公式でも `=` は妥当 |
| `DROP_DOWN` / `RADIO_BUTTON` | rows=1（正しい） | 対象外で正しい |

§2 の「決定済み 4 型を越えて B78(b) を拡張しない」は、**スコープの怠慢ではなく
正確な線引き**であることが確認できた。

### 17.3 R1 が発見した既存バグ（重要）

§6.1 の指摘、すなわち **`isLegacyKintoneFunction()` が field type / operator を見ずに
exact 判定するため `$id >= TODAY()` や `日付 = NOW()` を exact と誤分類し得る**、は
Claude の起票時調査では見落としていた実在の欠陥である。公式表で
「`日付` に `NOW()` は無い」ことが確認できたため、`日付 = NOW()` の押し下げは
**kintone 側でエラーまたは意図しない挙動になる**。実装時にテストで固定すること。

### 17.4 影響監査（§9）の読み方

「新規エラー化は 0 files / 0 cases」という結果は、R1 自身が注記しているとおり
**破壊的影響が無い証拠ではない**。リポジトリ内に client fallback 形のテストが
無かっただけである。**利用者のクエリに対する破壊性は別問題**として扱い、
移行案内（§13）を CHANGELOG と言語リファレンスの両方に必ず載せること。

### 17.5 実装時の追加確認事項

1. **`グループ選択` に `LOGINUSER()` を許さないこと。** 公式表では関数「なし」。
   §6.1 の対象が `CREATOR` / `MODIFIER` / `USER_SELECT` に限定されていることを
   テストで固定する。
2. **`日付` × `NOW()` を拒否すること**（§17.3）。
3. **サブテーブル内フィールドは対象外**で正しい。公式は「テーブル内のフィールドは
   `=` / `!=` の代わりに `in` / `not in` を使う」としているが、kSQL はサブテーブルを
   `APP$table` の仮想表として別機構で扱うため、本課題の型 × 演算子検査とは層が異なる。
   将来課題として認識だけしておく。
4. **B75 の allow-form を再設計しないこと**（§6.3 の明記どおり）。
5. **`onLimit` の対称性**を壊さないこと。B72 で相対日付だけ truncate 不可という
   非対称を作って実機で発覚した前例がある。

### 17.6 SemVer 【オーナー決定 2026-07-27＝minor（v3.25.0）】

**オーナー決定: minor（v3.25.0）で出す。** R1 と Claude の推奨（major）とは異なるが、
リリースポリシーはオーナーの判断による。

**この決定に伴う必須の措置:**

`^3` の範囲指定で依存している利用者には**自動更新で破壊的変更が届く**。
版数による警告が働かないため、**移行案内が唯一の防御線**になる。したがって
Step 5 では次を必須とする。

- CHANGELOG の当該バージョン見出し直下に、**破壊的変更である旨を最初に明記**する
- 言語リファレンスにも同じ内容を書く（片方だけにしない）
- 何がエラー化するかを**具体的なクエリ例**で示す（`WHERE 日付 = TODAY() AND LENGTH(件名) > 1`、
  `WHERE 作成者 = 'taro'` 等）
- 回避策（`WHERE` 全体を押し下げ可能にする／日付リテラルへ置換／`in` を使う）を併記する
- `release/README.txt` にも同旨を記載する

### 17.7 SemVer の技術的評価（記録）

R1 は **major を推奨**している。Claude も同意する。理由は次のとおり。

- リポジトリ内の新規エラー化は 0 件だが、**公開仕様として現在成功するクエリを
  意図的にエラー化する**（`TODAY()` / `NOW()` の client fallback、
  `CREATOR` / `MODIFIER` / `CHECK_BOX` / `MULTI_SELECT` への `=`）。
- B71（v3.23.0）は新規エラーを増やしつつ minor としたが、あれは
  **誤った結果を返していた形**をエラー化したもので、今回の `TODAY()` / `NOW()` は
  **TZ が一致していれば正しく動いていた**点が異なる。

ただし最終判断はオーナーに残る。


## 18. Step 5（docs）で必ず是正する既存記述の誤り

B75 のレビューで2件、B77/B78 Step 2 のレビューで1件、**言語リファレンスの相対日付まわりに
実挙動と食い違う記述**が見つかっている。B74 が「docs の不正確さ」で起票された経緯もあるため、
**Step 5 では書き足しより既存記述の是正を優先すること。**

| # | 誤った記述 | 実挙動（実測） | 状態 |
|---|---|---|---|
| 1 | 「`UNION` の枝は fail-closed」 | **トップレベルの UNION は枝ごとに判定**され、各枝が条件を満たせば使える。閉じているのは実体化文脈（CTE 本体 / `WITH` 最終 / 一時テーブル source）が UNION の場合のみ | B75 Step 4 で是正済み |
| 2 | 「DML の対象選択と `INSERT`/`UPSERT ... SELECT` の source は fail-closed」 | **whole-WHERE exact なら可**・prefilter＋残余は不可 | B75 Step 4 で是正済み |
| 3 | 「`KORDER BY`（native・Cursor とも）は fail-closed」 | **whole-WHERE exact なら通る**。getRecords 経路・Cursor 経路の**両方**で確認済み | **Step 5 で要是正** |

### 18.1 #3 の実測（2026-07-27）

```
SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY() KORDER BY 日付 LIMIT 5
→ OK  q=[日付 = YESTERDAY() order by 日付 asc limit 5]

SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY() KORDER BY 日付 LIMIT 600   （maxRecords 5000）
→ OK  CURSOR q=[日付 = YESTERDAY() order by 日付 asc]

SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY() AND LENGTH(件名) > 1 KORDER BY 日付 LIMIT 5
→ REJECT （非 exact のため。KORDER が理由ではない）
```

guard の第1許可形が `(orderBy.length === 0 || orderMode === "KINTONE_NATIVE")` を条件に
含めており、**KORDER は明示的に開かれている**（コード内コメントも
「Phase 1 only opens the explicit KORDER server plan for relative-date WHERE」と述べている）。

正しい記述は「**KORDER は whole-WHERE exact のときだけ使える。prefilter＋残余（第2許可形）や
FULL_SCAN_EXACT（第3許可形）では使えない**」である。`TODAY()` / `NOW()` も同じ。
