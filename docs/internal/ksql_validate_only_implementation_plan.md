# B12-A `VALIDATE ONLY` 実装計画

- 作成日: 2026-07-16
- ステータス: **R4・v2.13.0 実装済み・実機確認済み（残存ゲートなし）**
- 親仕様: [ksql_on_error_skip_isolation_spec.md](ksql_on_error_skip_isolation_spec.md) R4
- 関連仕様: [ksql_update_from_spec.md](ksql_update_from_spec.md)（B11 v1 実装済み。B12-A は B11 v1.1 非依存）
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B12
- 対象: B12-A `VALIDATE ONLY` のみ。B12-B `ON ERROR SKIP` と B11 v1.1 は本計画の対象外
- 2026-07-16 R1: 初版。構文、結果セット、制約メタデータ、collect 型検証器、read-only 配線、`#err`、実装順を確定
- 2026-07-16 R2: Claude レビューを反映。通常書き込み経路との検証厳格度の非対称を明記し、B12-B の設計ゲートを追加。文字数境界の実機確認と truncate override の利用者向け明記を必須化
- 2026-07-16 R3: S0〜S7を実装。AST・解析ベースread-only分類、制約メタデータ、非throw正規化primitive、全対応候補行、`DmlValidationResult`、原子的`#err` append、MCP/CLI/plugin表示とfail-closedを配線。自動テスト・全bundle検証済み。文字数境界の実機確認は未完了→R4で消化

---

## 1. 目的

DML の候補行を kintone へ書き込まずに全件検証し、ローカルで判定できる Tier 0 エラーを結果セットとして返す。

```sql
UPSERT INTO APP4219 (顧客コード, 顧客名, 住所)
SELECT 顧客コード, 顧客名, 住所 FROM #tgt
ON DUPLICATE (顧客コード)
VALIDATE ONLY INTO #err;
```

B12-A で作る検証器、フィールド制約メタデータ、エラー結果、read-only 配線、`#err` ストアが、後続 B12-B の土台になる。

## 2. R2 の確定範囲

### 2.1 対応する文

| 文 | R2 | 備考 |
|---|---|---|
| 親レコード INSERT VALUES | 対応 | 書き込み 0 |
| 親レコード INSERT SELECT | 対応 | APP / #temp / JOIN を含む既存 SELECT ソース |
| UPSERT VALUES / SELECT | 対応 | 既存キー照合の read API は発生する |
| 親レコード UPDATE | 対応 | 一律 SET、算術、スカラーサブクエリを含む |
| UPDATE ... FROM v1 | 対応 | `$id` 結合。B11 v1.1 は不要 |
| サブテーブル INSERT / UPDATE | 非対応 | `_pid` / `_rid` を含むエラー行スキーマが未定義。suffix を ParseError にする |
| DELETE / REORDER | 非対応 | B12 親仕様の対象外 |
| ON ERROR SKIP | 非対応 | B12-B で実装。R2 では明示的な未実装エラー |

### 2.2 構文

```sql
<INSERT | UPSERT | UPDATE statement>
VALIDATE ONLY [INTO #<err_table>]
```

- `VALIDATE` / `ONLY` は**ソフトキーワード**とし、lexer の予約語へ追加しない。既存の `validate` / `only` フィールドコードを壊さない
- INSERT / UPDATE は文末、UPSERT は `ON DUPLICATE (...)` の後に置く
- `INTO #err` は一時表を後続文から参照する用途なので**複文バッチでのみ許可**。単文では `VALIDATE ONLY` の結果セットだけを返す
- 単文 `VALIDATE ONLY INTO #err` は静的に `ArgumentError: VALIDATE ONLY INTO requires a batch.`
- `VALIDATE ONLY` と `ON ERROR SKIP` の併記、`REJECT LIMIT` の付与は ParseError

### 2.3 対象外

- API 実行時エラー、権限、競合、既存レコードとの一意制約衝突、ユーザー等の実在性
- 書き込み成功の保証
- `WITH UNIQUE CHECK`、永続エラーログ、自動的な本実行
- B11 v1.1 業務キー結合
- 一般利用者向け `INSERT INTO #temp` / temp table 更新

## 3. 現行コードとの差分

| 項目 | 現状 | B12-A で必要な変更 |
|---|---|---|
| AST | INSERT / UPSERT / UPDATE に実行モードなし | `validateOnly` と `validationErrorTable` を追加 |
| parser | DML 本体を読んだら文終了 | DML suffix を共通解析。SELECT の暗黙 alias と soft keyword の衝突を防止 |
| DML分類 | `isDmlType()` / `isReadOnlyType()` が型名だけを見る | 文単位 `writesKintone()` / `requiresCompleteInput()` を追加 |
| フィールド情報 | code / label / type / options のみ | required / min-max / length / default を保持 |
| converter | `toKintoneValue()` が最初の不正値で throw | 非 throw の正規化・検証 primitive を抽出し既存 converter と共有 |
| 候補行 | 各 execute 関数内で直接 API payload を構築 | 書き込み前段の候補行 materialize を検証から再利用可能にする |
| temp store | CREATE の `Map.set()` のみ | `#err` 専用の原子的 create/append を追加 |
| 結果型 | SELECT / mutation / ASSERT | `DmlValidationResult` を追加 |
| MCP/CLI/UI | DML 型は mutation として扱う | validation result を read-only result set として表示 |

## 4. 公開結果契約

### 4.1 エンジン結果型

`src/execute.ts` の `ExecuteResult` に次を追加する。MCP の既存静的 `ValidationResult` と混同しないよう `DmlValidationResult` と命名する。

```ts
export interface DmlValidationResult {
  type: "VALIDATION";
  operation: "INSERT" | "UPDATE" | "UPSERT";
  validatedRows: number;
  validRows: number;
  invalidRows: number;
  errorCount: number;
  columns: string[];
  errors: ProcessRow[];
  errTable?: string;
  metrics?: ExecuteMetrics;
}
```

不変条件:

- `validatedRows = validRows + invalidRows`
- `errorCount = errors.length`
- `invalidRows <= errorCount`。1 行複数エラーでは不等号になる
- エラー 0 件でも `columns` は確定し、`errors=[]`
- `operation` と `$err_operation` は UPSERT の insert/update 分岐にかかわらず文種 `UPSERT`

### 4.2 MCP payload

単文 `ksql_query` は次を返す。

```json
{
  "ok": true,
  "type": "VALIDATION",
  "operation": "UPSERT",
  "validatedRows": 10,
  "validRows": 10,
  "invalidRows": 0,
  "errorCount": 0,
  "columns": ["顧客コード", "顧客名", "$err_statement", "$err_operation", "$err_row", "$err_field", "$err_code", "$err_message"],
  "errors": []
}
```

バッチでは `statements[].resultIndex` から `results[]` の validation result set を参照する。`results[]` に `type`, `operation`, 4件の件数、`columns`, `rows`, `rowCount`, `errTable` を含め、`maxTotalRecords` は `errorCount` を合計対象にする。

### 4.3 CLI / UI

- CLI table/csv/markdown/jsonl は `errors` を通常の表として stdout へ出す。stderr summary は `validated=N valid=N invalid=N errors=N`
- CLI json は上記 payload と同じキーを返す
- UI は件数サマリーの下にエラー表を表示する。0件は「検証エラーはありません」
- `errors` が多い場合のUI表示上限は既存 SELECT と同じ。返却データ自体は切り捨てない

## 5. 検証モデル

### 5.1 候補行の共通形

```ts
interface DmlValidationCandidate {
  rowNumber: number;                 // 1起点
  operation: "INSERT" | "UPDATE" | "UPSERT";
  mode: "create" | "update";       // required検証の切替
  payload: ReadonlyMap<string, unknown>;
}
```

- INSERT は全行 `create`
- UPDATE は全行 `update`
- UPSERT は既存キー照合後、非存在行を `create`、存在行を `update`
- INSERT / UPSERT SELECT の `rowNumber` は source SELECT materialize 後の順序
- UPDATE は取得した `$id` の数値昇順へ揃えて結果を決定的にする
- エラー順は candidate順 → DML対象フィールド順 → 検証規則順で固定する

### 5.2 行エラーと静的エラー

行エラーとして収集するもの:

- required の空値・create時の必須列欠落
- NUMBER / DATE / TIME / DATETIME の変換不能
- minValue / maxValue、minLength / maxLength
- DROP_DOWN / RADIO / CHECK_BOX / MULTI_SELECT の定義外選択肢
- UPSERT キー空値、ソース内キー重複

文全体を停止する静的エラー:

- 対象フィールド不存在、重複列、列数不一致
- CALC・システム列・ルックアップコピー先等の書込不可列
- 式評価失敗、UPDATE FROM の構造エラー、`#err` schema不一致
- source取得上限、検索10万件打ち切り、timeout、tempTableMaxRows超過

### 5.3 正規化 primitive

`src/converter/dmlToKintone.ts` の変換処理を次の形へ分離する。

```ts
export type DmlValueValidation =
  | { ok: true; value: KintoneValue }
  | { ok: false; code: DmlValidationErrorCode; message: string };

export function validateAndNormalizeDmlValue(
  raw: unknown,
  field: KintoneFieldInfo
): DmlValueValidation;
```

- `toKintoneValue()` / `convertProcessRowValue()` はこの primitive を呼び、NGなら従来どおり `DmlConvertError` を throw する
- B12-A は throw せず結果を収集する
- DATE / TIME / DATETIME は形式だけでなく実在日・時刻範囲も検証する。現行の「変換失敗なら raw を返して API に委ねる」挙動は句なしDMLでは維持する
- このため `VALIDATE ONLY` は通常の書き込み経路より厳密な場合がある。ここで返すエラーは「kSQL がローカルで検出した Tier 0 問題」であり、「同じ値を kintone API が必ず拒否する」という予測ではない
- B12-A ではプレビューとしてこの厳密検証を採用する。B12-B は、APIなら受理し得る行まで隔離する false isolation を避けて書き込み経路へ厳格度を合わせるか、Tier 0 厳格検証をそのまま隔離条件にするかを、実装着手前に親仕様で確定する
- NUMBER は空値をrequiredとは別に扱い、非空なら有限数であることを検証する
- R3 の範囲検証で参照した「厳密数値比較」は一般比較器には未実装（B9保留）。B12-A はschema境界比較専用の10進文字列比較を局所実装し、WHERE/ASSERTの意味論は変更しない
- length は **UTF-16 code units（JS `String#length`）** で判定する（**kintone 実測 2026-07-16・APP4221 で確定**: 𩸽×6=12units が maxLength=10 で CB_VA01 拒否・結合文字×5=10units は受理）。あわせて **minLength は空文字にも適用される**（明示・create 未指定とも CB_VA01）ことを実測し、ローカル判定を同一挙動へ修正済み（実測 fixture を回帰テストで固定）
- choice は配列型では各要素を検証し、1フィールドにつき1つの `ERR_CHOICE_INVALID` を返す
- 親仕様の既存コード体系を維持し、DATE / TIME / DATETIME の形式エラーは `ERR_TYPE_DATE` に集約する

### 5.4 create / update の required 規則

- create: 明示payloadに必須列がなければ、フォーム定義の `defaultValue` が有効か確認する。有効な既定値もなければ `ERR_REQUIRED`
- update: SET対象列だけを検証する。未送信の必須列は検証しない
- 明示的な空値は create/update の双方で `required=true` なら `ERR_REQUIRED`
- defaultValue はAPI値をrawのまま保持する。空文字・空配列・nullは有効な既定値とみなさない

## 6. フィールド制約メタデータ

`FormFieldProperty` と `KintoneFieldInfo` に以下を追加する。

```ts
required?: boolean;
minValue?: string;
maxValue?: string;
minLength?: string;
maxLength?: string;
defaultValue?: unknown;
```

- kintone API の文字列値を取得時に number 化しない
- TABLE 子フィールドを含め `flattenFormFieldProperties()` で欠落なく転送する
- node client / UI client は共通 flatten 関数を使っているため通信処理は変更不要
- `fieldInfoCache` を単一の情報源とし、制約別の重複キャッシュは作らない
- 書込可否に追加メタデータが必要な型は `FormFieldProperty` に最小限追加し、静的検査関数へ閉じ込める

## 7. read-only と安全制御

### 7.1 文単位分類

`src/core/dmlGuard.ts` に追加する。

```ts
writesKintone(stmt): boolean
isReadOnlyStatement(stmt): boolean
requiresCompleteInput(stmt): boolean
```

- 通常DML: `writesKintone=true`, `requiresCompleteInput=true`
- VALIDATE ONLY: `writesKintone=false`, `isReadOnly=true`, `requiresCompleteInput=true`
- SELECT等: 従来どおり。通常SELECTは `requiresCompleteInput=false`

`StatementAnalysis` に `isValidationOnly` / `requiresCompleteInput`、`BatchAnalysis` に `containsValidationOnly` / `requiresCompleteInput` を加える。既存 `containsDml` は「mutation toolと承認が必要」の意味を維持する。

### 7.2 fail-closed

`VALIDATE ONLY` はread-onlyだが、入力の一部だけを検証して成功扱いにしてはならない。

- MCP `onLimit=truncate`、CLI `--on-limit truncate`、plugin UI設定にかかわらず `onLimitReached="error"`
- 検索10万件打ち切りは警告化せず `SearchAbortedError`
- UPDATE / UPSERT の照合readも同じ完全性要件
- dmlMaxRows / dmlTotalMaxRows / allowDml / confirmText / DML確認ダイアログは不要
- 候補件数の上限はread側 `maxRecords`。超過時は結果を返さずエラー
- `continueOnError` はVALIDATE ONLYだけのバッチでは許可する

## 8. `#err` create / append

### 8.1 schema

列順は次で固定する。

1. 入力payload列（INSERT/UPSERTはDML対象列順、UPDATEは`$id`＋SET列順）
2. `$err_statement`
3. `$err_operation`
4. `$err_row`
5. `$err_field`
6. `$err_code`
7. `$err_message`

元の不正値をpayload列へ保持し、正規化値で上書きしない。1入力行に複数エラーがあれば同じpayloadを持つ複数行を作る。

### 8.2 batch analysis

- 最初の `VALIDATE ONLY INTO #err` は暗黙のtemp table作成として `tempTablesCreated` に入れる
- 同じ名前への後続VALIDATEはappendとして許可し、最初の作成を維持する
- DROP後の再作成は許可する
- ASTから確定できるpayload列が異なる場合はvalidate-all-firstで静的エラー
- CREATE TEMP TABLE由来などschemaが静的確定できない既存表との一致は実行直前に確認する
- 後続SELECTの依存先は最初に表を作成した文。append失敗は原子的なので、`continueOnError` 時は既存行を参照可能とする

### 8.3 store API

```ts
appendValidationErrors(
  store: Map<string, MaterializedTable>,
  name: string,
  columns: readonly string[],
  rows: readonly ProcessRow[],
  maxRows: number
): void;
```

- 未作成なら作成
- 既存列名・列順が完全一致した場合だけappend
- `existing.rows.length + rows.length` を追加前に検査
- schema不一致・上限超過時はstoreを変更しない
- 汎用temp DMLとしてexportしない

## 9. 実装ステップ

### S0: 契約テストを先行追加

- parser、batch分類、form metadata、converter collect、execute write 0、MCP routing の失敗テストを先に置く
- 現行mainで期待どおり赤になることを確認してから実装する

### S1: AST / parser

対象: `src/types/ast.ts`, `src/parser/parser.ts`, parser tests

- 4つのDML AST（INSERT/INSERT_SELECT/UPSERT/UPSERT_SELECT）とUPDATEへ共通validation suffix属性を追加
- `parseValidationSuffix()` をDML本体解析後に1か所から適用
- SELECT-sourceでは `VALIDATE ONLY` を暗黙table aliasとして消費しない終端lookaheadを追加
- soft keyword互換、句順、重複句、subtable拒否をテスト

### S2: フィールドメタデータ

対象: `src/core/formFieldInfo.ts`, `src/execute.ts`, node/UI client fixtures, `formFieldInfo.test.ts`

- M2の制約値を型とflattenへ追加
- 親/子フィールド、false/0/空値、default配列の保持をテスト
- cacheContext別キャッシュの既存挙動を維持

### S3: converter共通化と検証器

対象: `src/converter/dmlToKintone.ts`, 新規 `src/core/dmlValidation.ts`, unit tests

- `validateAndNormalizeDmlValue()` を非throw primitiveとして作成
- 既存throw converterをprimitiveへ委譲
- required/range/length/choiceと安定error codeを実装
- 句なしDMLのrequest snapshotが不変であることを回帰テスト

### S4: 候補行materialize

対象: `src/execute.ts` と必要に応じて新規 `src/core/dmlValidationCandidates.ts`

- INSERT VALUES/SELECT、UPSERT VALUES/SELECT、UPDATE各経路から候補行を作るhelperを抽出
- UPSERTは既存 `resolveUpsertTargets()` を共有しcreate/updateを確定
- UPDATEは既存対象取得、算術評価、UPDATE FROM matchingを共有するがPUT payloadは送信しない
- 全静的検査を候補検証より先、全候補materializeを結果返却より先に完了する

### S5: execute / batch temp store

対象: `src/execute.ts`, `src/core/batch.ts`, `src/core/dmlGuard.ts`, `src/output/batchEnvelope.ts`

- validation dispatchと `DmlValidationResult` を追加
- `writesKintone` / `requiresCompleteInput` を全呼び出し層へ配線
- `appendValidationErrors()` と暗黙temp依存解析を実装
- metricsはread/field callsだけ増え、post/put/deleteは常に0を確認

### S6: MCP / CLI / plugin UI

対象: `src/mcp/tools.ts`, `src/mcp/index.ts`, `src/mcp/schemas.ts`, `src/cli/index.ts`, `src/ui/desktop.ts`, `src/ui/renderResult.ts`

- `ksql_query` で単文/バッチを受理し専用payloadへ整形
- `ksql_mutate` はVALIDATE ONLY単独をqueryへ案内。通常DML混在バッチは従来どおりmutate
- CLI/pluginの承認判定を型名ベースから文単位へ変更
- fail-closed用 `requiresCompleteInput` をruntime optionsへ反映
- tool description、保存クエリrouting、JSON/table/UI snapshotを更新

### S7: ドキュメント・bundle・検証

- 言語リファレンス、MCP/CLI/plugin仕様、CHANGELOG、課題台帳を更新
- 言語リファレンスと MCP tool description / server仕様には、`VALIDATE ONLY` が完全入力を必要とするため、利用者の `onLimit=truncate` / `--on-limit truncate` / UI truncate 設定を無視して error 扱いにすることを明記する
- 【R4 消化済み】kintone 実機（APP4221）で境界確認済み: 計数=UTF-16 code units・空文字にも minLength 適用。ローカル判定を修正し実測値を fixture 固定（ASCII/数値境界・サロゲートペア・結合文字・空文字・create 未指定の全パターンでローカル==実機を確認）
- package minor versionは実装PR時に決定
- `npm test`
- `npm run build`
- `npm run build:cli`
- `npm run build:mcp`
- `npm run mcp:verify`
- `npm run mcpb:verify`
- `git diff --check`

## 10. ファイル別変更一覧

| ファイル | 主変更 |
|---|---|
| `src/types/ast.ts` | validation suffix AST、結果関連型参照 |
| `src/parser/parser.ts` | soft suffix parser、句順・subtable guard |
| `src/core/dmlGuard.ts` | 文単位write/read/complete分類 |
| `src/core/batch.ts` | validation分析属性、暗黙`#err`生成・append依存 |
| `src/core/formFieldInfo.ts` | 制約メタflatten |
| `src/core/dmlValidation.ts`（新規候補） | 行検証、error code、error row構築 |
| `src/converter/dmlToKintone.ts` | 非throw primitiveとthrow wrapper |
| `src/execute.ts` | 候補materialize、validation実行、結果型、temp append |
| `src/output/batchEnvelope.ts` | validation result set |
| `src/mcp/tools.ts` | query routing / payload / fail-closed |
| `src/cli/index.ts` | 承認判定、出力、summary |
| `src/ui/desktop.ts`, `src/ui/renderResult.ts` | 確認抑止、validation表示 |
| node/UI kintone client tests | API制約メタ保持 |

## 11. テスト計画

### 11.1 parser / analysis

- 全対応DML形式の `VALIDATE ONLY` / `INTO #err`
- `validate` / `only` を通常フィールド名として使う既存SQLの回帰
- suffix句順違反、重複、subtable、ON ERROR SKIPの先行利用を拒否
- 単文は `isReadOnly=true`, `isDml=false`, `isValidationOnly=true`
- validation専用バッチは `isReadOnlyBatch=true`, `containsDml=false`
- 通常DML混在バッチは `containsDml=true`
- 暗黙`#err`作成、同schema append、異schema、DROP後再作成、後続SELECT依存

### 11.2 metadata / validator

- required、既定値、数値上下限、文字列長、単一/複数選択肢
- minLength / maxLength は ASCII、BMP日本語、サロゲートペア、結合文字、異体字セレクタの境界を単体テストし、実機確認結果を fixture / 回帰テストへ固定する
- NUMBER/DATE/TIME/DATETIME正常・異常・境界値
- 1行複数エラー、複数行、空ソース
- UPSERTキー空値・全重複行の隔離
- error順、row番号、元値保持、安定code
- 句なしDML converterの既存snapshot不変

### 11.3 execute

- §2.1の全対応経路（VALUES/SELECT、UPSERT、UPDATE、UPDATE FROM）でwrite API 0
- UPSERT / UPDATEで必要なread APIだけ発生
- update create/update required規則の差
- maxRecords、検索打ち切り、timeoutでfail-closed
- `#err` append成功、schema不一致、上限超過の原子性
- metricsのpost/put/deleteが0

### 11.4 surface

- MCP query単文/バッチpayload、mutateへの誤routingなし
- CLI allow-dml/確認不要、全format、stderr summary、exit code
- plugin確認ダイアログなし、0件/複数件表示
- saved queryをread-onlyとして実行可能
- batch envelopeとCLI JSONが一致

## 12. 受入条件

- [x] 対応DMLへ `VALIDATE ONLY` を付けると候補全行を検証しwrite APIを1回も呼ばない
- [x] 1行複数エラーで `invalidRows=1`, `errorCount>1`
- [x] UPSERTは照合後のcreate/updateでrequired規則を切り替える
- [x] `VALIDATE ONLY` はksql_query/CLI/pluginでDML承認なしに動く
- [x] truncate設定でも完全性不足を成功扱いせずfail-closed
- [x] 言語リファレンスとMCP説明に、VALIDATE ONLYではtruncate設定を無視してerror扱いにすることが明記されている
- [ ] minLength / maxLength の文字数計数をkintone実機で境界確認し、結果がテストへ固定されている
- [x] 同名`#err`へのappendが原子的でschema/上限を守る
- [x] MCP/CLI/UIで同じ件数・列順・error codeを観測できる
- [x] 句なしDMLのAST、API request、結果、確認、API回数に回帰がない
- [x] B12-B/B11 v1.1のコードを含めない

## 13. 主なリスクと対策

| リスク | 対策 |
|---|---|
| read-only扱いによりtruncateが通る | `requiresCompleteInput`をwrite分類と分離して全surfaceでerror固定 |
| converter共通化で既存DMLが変わる | throw wrapper維持＋request snapshot回帰 |
| 厳密検証によりAPIなら通る行をB12-Bが隔離する | B12-AではTier 0プレビューとして明記し、B12-B着手前に隔離厳格度を親仕様で確定 |
| Unicode文字数がkintoneの計数とずれる | サロゲートペア・結合文字・異体字セレクタを実機境界確認しfixture化 |
| SELECT末尾のsoft keywordがaliasに吸われる | DML-source parse contextと境界テスト |
| UPSERT照合を検証器と実行器で二重実装 | `resolveUpsertTargets`とcandidate materializeを共有 |
| UPDATE経路ごとの候補差 | 一律/算術/subquery/FROMを個別テストしrow順を固定 |
| temp append途中失敗 | schema/件数を先に検査してから単一`set` |
| MCP静的validateとSQL VALIDATEの名称混同 | 内部型を`DmlValidationResult`、文書では「静的validate」と明示 |

---

実装着手順は **S0 → S1 → S2 → S3 → S4 → S5 → S6 → S7**。S3とS4がB12-Aの中心であり、S5以降は検証結果を既存surfaceへ安全に配線する工程とする。
