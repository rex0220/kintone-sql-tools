# B41 v1 — 既存レコードの制約チェック（VALIDATE 文）仕様

- 作成日: 2026-07-19
- ステータス: **仕様 R4・実装着手可**（2026-07-19・保守 v1）。R3 review の P1×5 を §13 で確定（$err_value 空値=""＋normalizeRaw export・修飾参照静的拒否・prefilter は extractSafePushdownLeaves＋local 再評価・サブクエリ専用静的拒否・#err は B12 validateOnly 分岐を範に固定5列＋列メタ・EXPLAIN 専用 plan builder）。核心（二系統・{id,record,flat}・read-only・SelectResult・raw fetch＋local 評価・NUMBER/onLimit）は R2/R3 review で妥当と確認済み。工数 4.5〜8.5 人日（計画上 6〜8.5 寄り）・SemVer minor。R2 review の P1×10 を §12 で確定（KLIKE/サブクエリ禁止＋`SelectResult`）＝`$err_value`=`renderValidationValue`（code 配列 JSON）・B29 は全 NUMBER 対象・VALIDATE 専用 collector・WHERE は plain＋local 再評価・result=`SelectResult`・単文 INTO 拒否・#err は B41 独自5列・onLimit は executor＋全 surface で強制・EXPLAIN/dispatch 配線・fetchAll は Cursor 非使用。工数 4.5〜8.5 人日維持・SemVer minor。核心（二系統・`{id,record,flat}`・read-only 方針）は R2 review で妥当と確認済み（§11）。R1 の 3 重大＋中を **§10 で確定**（Claude がコード裏取り済み）＝①**値は二系統**（組み込み＝生値 `record[code].value`／WHERE・CHECK＝flat `ProcessRow`／`$err_value`＝生値化。`isEmpty`（dmlValidation.ts:154）は空配列を空と判定するが flatten 済み `"[]"`（process.ts:85）は非空扱い→ProcessRow 直渡しは USER/ORG/GROUP/複数選択の必須違反を取り逃がす）②**内部行契約 `{id, record, flat}`** を fetch 直後保持（取得＝$id∪制約∪WHERE∪CHECK・executeSelect の projected 戻り値は流用しない）③**read-only 配管**（新文 `VALIDATE` を `isReadOnlyType`（dmlGuard.ts:64）へ・`isDmlType` に入れず `writesKintone=false`・`requiresCompleteInput=true`＝onLimit=truncate→error・StatementAnalysis/dispatch/MCP `ksql_query`・書込み API 0 回）。中＝CHECK は `evaluateCustomChecks(groups, flat, resolveFieldType)`（dmlCustomCheck.ts:61）で B37 再利用・`INTO #err` は温度テーブル実体化（append だけでは不足）・`$err_value` の CHECK 時は空・Cursor は v1 で $id ページング限定・EXPLAIN。**判定＝再利用成立・B37 より軽い（工数 4.5〜8.5 人日 ≈ B37 の 0.7〜0.9 倍・据え置き）**。詳細 §10。
- 分担: Claude=仕様/観点・Codex=実装/テスト
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B41
- 評価: [ksql_existing_record_validation_evaluation.md](ksql_existing_record_validation_evaluation.md)
- 参考: [rex0220「kintone レコード制約チェッカー」](https://qiita.com/rex0220/items/de02e64dc34f3362d1f8)
- 関連: [B37 カスタムチェック](ksql_custom_check_spec.md)・[B12 VALIDATE ONLY](ksql_validate_only_implementation_plan.md)・[B29 数値精度](ksql_number_precision_semantics_spec.md)

## 1. 目的・スコープ

kintone のフォーム制約は過去データに効かないため、**既存レコードを組み込み制約＋カスタムチェックで監査し違反を報告する読み取り操作**を追加する。書込みは行わない。

- **対象（v1）**：親レコードのトップレベルフィールドの組み込み制約（必須/数値上下限/文字数/選択肢/B29 桁）＋カスタムチェック（B37 構文）。`WHERE` で監査対象を絞れる。出力は違反の結果集合（`INTO #err` で複文再利用）。
- **対象外（v2 以降）**：サブテーブルセルの監査（記事は対応・強い v2 候補）・ユニーク（kintone 側強制）・違反の自動修復（書込み）・レコード横断制約。

## 2. 構文

```sql
VALIDATE <app> [ ( <field1>, <field2>, ... ) ]     -- 任意: 対象フィールド（省略=制約を持つ全フィールド）
[ WHERE <条件> ]                                    -- 任意: 監査対象レコードの絞り込み
[ CHECK WHEN <条件> THEN <メッセージ> ... ]          -- 任意: カスタムチェック（B37 構文）
[ INTO #err ];                                      -- 任意: 違反を一時テーブルへ
```

例:
```sql
VALIDATE APP4221 WHERE 作成日時 >= '2026-01-01'
CHECK WHEN 数値1 > 数値2 THEN CONCAT('数値1=', 数値1, ' > 数値2=', 数値2)
INTO #err;
SELECT $id, $err_field, $err_message, $err_value FROM #err;
```

- `VALIDATE` はソフトキーワード（既存の `VALIDATE ONLY` サフィックスと別物。**先頭 `VALIDATE <app>` で既存レコード監査文**・`<DML> … VALIDATE ONLY` は従来の書込み候補検証）。パーサは「先頭 `VALIDATE` の直後がアプリ参照」で分岐。
- **読み取り操作**：書込みなし。MCP は `ksql_query`・CLI は `--allow-dml` 不要・プラグインは確認ダイアログなし（B12 VALIDATE ONLY と同じ read-only 扱い）。
- 対象フィールド省略時は**制約を持つ全フィールド**（フォーム定義から自動導出）。`(fields)` 指定で対象限定。

## 3. 意味論

各既存レコードに対し、**①組み込み制約 → ②カスタムチェック**の順で評価し、違反を 1 件ずつ報告する（1 レコード複数違反＝複数行・B37/#err と同じ多重モデル）。

### 3.1 組み込み制約（既存検証の読み取り再利用）

- フォーム定義（`getFieldsCached`・[execute.ts:160](../../src/execute.ts) の `KintoneFieldInfo`）の `required/minValue/maxValue/minLength/maxLength/選択肢/数値桁(B29)` を、**既存レコードの現在値**に適用する。
- 実装は既存 **`validateAndNormalizeDmlValue(生値, fieldInfo, numberPrecision)`**（[dmlValidation.ts:31](../../src/core/dmlValidation.ts)）を流用。書込み経路と同じ呼び方で、値の出所が「書込み値」→**「fetch 済みレコードの生値 `record[code].value`」**に変わる（**`ProcessRow`（flat）ではない**＝§10.2。flat 直渡しは空配列を取り逃がす）。
- 検出コード＝既存の `ERR_REQUIRED/ERR_RANGE_MIN/MAX/ERR_LENGTH_MIN/MAX/ERR_CHOICE_INVALID/ERR_NUMBER_INTEGER_DIGITS`。記事の「必須・数値上下限・文字数・選択肢」を包含。

### 3.2 カスタムチェック（B37 構文）

- B37 の `CHECK WHEN … THEN …`（グループ先勝ち・ブロック独立・メッセージ `||`/`CONCAT`・`ERR_CHECK`）を**既存レコード（`ProcessRow`）**に適用。B37 の `evaluateCustomChecks`（[core/dmlCustomCheck.ts](../../src/core/dmlCustomCheck.ts)）と型付き比較を流用。トップレベルフィールドのみ（v1）。

## 4. 出力スキーマ

違反の結果集合（`INTO #err` 省略時は文の結果として返す）。

| 列 | 値 |
|---|---|
| `$id` | レコード番号（違反レコード） |
| `$err_field` | 違反フィールドコード（カスタムチェックは空） |
| `$err_code` | `ERR_REQUIRED`/`ERR_RANGE_*`/`ERR_LENGTH_*`/`ERR_CHOICE_INVALID`/`ERR_NUMBER_INTEGER_DIGITS`/`ERR_CHECK` |
| `$err_message` | エラー内容（カスタムは評価済みメッセージ） |
| `$err_value` | **現在値**（記事の CSV 列に対応） |

- CLI は `--format csv` で記事同等の CSV（`--output` でファイル）。`INTO #err` で複文再利用（`GROUP_CONCAT($err_message)` 等で集計可）。
- 違反 0 件でも列スキーマを保持（B2 の空 SELECT 列と同じ扱い）。

## 5. 取得・境界・面

- `WHERE` で監査対象を絞り、既存 `fetchAll`（**offset＋`$id` keyset ページング。Cursor API は使わない**＝§10.5）で取得。取得上限は既存 `maxRecords`／`onLimit`＝fail-closed（無音打ち切りしない・強制箇所は §10.3/R3）。
- 全面（CLI/MCP/プラグイン）で同一＝engine 側の純検証。面ごとの配管不要。

## 6. パーサ・AST・再利用

- 新文 `ValidateStatement { appId, fields?, where?, checkGroups?, errorTable? }`。`Statement` union（[ast.ts:15](../../src/types/ast.ts)）へ追加。`VALIDATE <app>` の解析を先頭文キーワードとして追加（`VALIDATE ONLY` サフィックスと分離）。
- 実行：`WHERE`＋対象フィールドで records を fetch → 各 `ValidationRow`（§10.1）の**生値**に §3.1 組み込み検証、**flat** に §3.2 CHECK → 違反行を生成 → 結果集合 or `INTO #err`。
- 再利用：`validateAndNormalizeDmlValue`（組み込み）・`evaluateCustomChecks`（B37）・`getFieldsCached`（制約）・`fetchAll`/`runFullScan`（取得）。**新規は「文法＋既存レコードへ検証を回す実行経路＋出力生成」のみ**。

## 7. 受入条件（テスト化）

- 組み込み：必須空・数値上下限違反・文字数違反・**選択肢の定義外値（記事の看板ケース）**・数値桁超過を既存レコードで検出。対象フィールド省略＝全制約フィールド・`(fields)` 指定で限定。
- カスタム：B37 `CHECK` が既存レコードで発火（グループ先勝ち・`||`/`CONCAT`/`@var`・`ERR_CHECK`）。
- 出力：`$id`/`$err_field`/`$err_code`/`$err_message`/`$err_value`・1 レコード複数違反＝複数行・違反 0 件で列保持・CLI CSV。
- 絞り込み：`WHERE` で対象限定・大規模は `fetchAll`（offset＋`$id` keyset・Cursor 非使用）・`maxRecords` 到達で fail-closed。
- read-only：書込み API を呼ばない（MCP `ksql_query`・CLI `--allow-dml` 不要）。全面一致。
- 非回帰：`VALIDATE ONLY` サフィックス（書込み候補検証）と混同しない・既存クエリ不変。

## 8. v2 引き継ぎ（対象外）
サブテーブルセル監査（行番号付き・記事対応）・違反の自動修復（`UPDATE … FROM #err` 等での書き戻しレシピ化）・ユニーク/レコード横断制約。

## 9. 工数の目安
検証ロジック・型解決・`CHECK`・fetch は既存流用。新規は**新文法＋既存レコードへ検証を回す実行経路＋出力生成**。**B37 より軽い見込み**（B37 は評価行契約・全 DML 横断が重かったが、B41 は読み取り単文・書込み経路なし）。codex レビューで再利用の裏取りと工数を確定。

---

## 10. R2 確定事項（2026-07-19・Claude・コード裏取り済み）

R1 review の 3 重大＋中を、実装可能な形へ確定する。以下は該当コードを読んで裏取りした。

### 10.1 内部行契約 `{id, record, flat}`（重大②・①の基盤）

VALIDATE は `executeSelect` の projected 戻り値を流用しない（生値・$id 対応を失うため）。取得直後に各レコードを 3 面で保持する内部型を新設する。

```ts
interface ValidationRow {
  id: string;               // $id（RECORD_NUMBER 相当）
  record: KintoneRecord;    // 生レコード（field.value そのまま。組み込み検証・$err_value 用）
  flat: ProcessRow;         // flatten 済み（WHERE / CHECK 用）
}
```

- **取得フィールド = `$id` ∪ 検証対象フィールド ∪ WHERE 参照 ∪ CHECK 参照**の和集合。`(fields)` 省略時は「制約を持つ全フィールド」＋WHERE/CHECK 参照。
- `flat` は `record` から既存 flatten（[process.ts:85](../../src/engine/process.ts#L85) の `typeof val === "string" ? val : JSON.stringify(val)`）で 1 回生成。両面を同一 fetch から作る。

### 10.2 値は二系統（重大①）

| 検証 | 値の出所 | 経路 |
|---|---|---|
| 組み込み制約 | **生値** `record[code].value` | `validateAndNormalizeDmlValue(生値, fieldInfo, numberPrecision)`（[dmlValidation.ts:31](../../src/core/dmlValidation.ts#L31)） |
| WHERE | `flat`（ProcessRow） | 既存 `evalWhere` |
| CHECK | `flat` | `evaluateCustomChecks(groups, flat, resolveFieldType)`（[dmlCustomCheck.ts:61](../../src/core/dmlCustomCheck.ts#L61)） |
| `$err_value` | **生値**の文字列化 | `rawScalarText` 相当（空配列→空文字・選択系→code） |

- **裏取り**: `isEmpty`（[dmlValidation.ts:154](../../src/core/dmlValidation.ts#L154)）= `value === "" || (Array.isArray(value) && value.length === 0)`。組み込み検証を `flat` の値で回すと、USER/ORG/GROUP_SELECT・複数選択の空セル（生値 `[]`）が flatten で `"[]"`（2 文字の JSON 文字列）になり **`isEmpty=false` → 必須違反を取り逃がす**。よって組み込み検証は生値必須。数値・文字数・選択肢・B29 桁も生値で既存 DML 経路と同一に判定できる。
- WHERE/CHECK は既存の flatten 前提（evalWhere・B37）をそのまま使うため `flat` 側。二系統を同じ `ValidationRow` から供給する。

### 10.3 read-only 分類の core 配管（重大③）

新文 `VALIDATE`（`Statement` union に `type: "VALIDATE"` 追加）を read-only として全経路へ配線する。

- `isReadOnlyType`（[dmlGuard.ts:64](../../src/core/dmlGuard.ts#L64)）に `"VALIDATE"` を追加。
- **`isDmlType`（[dmlGuard.ts:54](../../src/core/dmlGuard.ts#L54)）には入れない**。`writesKintone`（[dmlGuard.ts:82](../../src/core/dmlGuard.ts#L82)）は `isDmlType && !validateOnly` なので、VALIDATE は自動的に `writesKintone=false`。
- `isReadOnlyStatement`（[dmlGuard.ts:88](../../src/core/dmlGuard.ts#L88)）= `!writesKintone && (isReadOnlyType || isDmlType)` → VALIDATE は isReadOnlyType 経由で true。
- `requiresCompleteInput`（[dmlGuard.ts:93](../../src/core/dmlGuard.ts#L93)）に VALIDATE の case を追加し **true** を返す（部分監査で「違反なし」と誤らせない＝`onLimit=truncate` を error へ）。
- `analyzeBatch` / `StatementAnalysis` / dispatch / MCP `ksql_query`（read-only 入口）で VALIDATE を受理。**受入条件＝書込み API 0 回**。CLI は `--allow-dml` 不要、プラグインは確認ダイアログなし（B12 `VALIDATE ONLY` と同じ read-only 扱い）。
- パーサは「先頭 `VALIDATE <app>`」で本文へ分岐。`<DML> … VALIDATE ONLY`（DML サフィックス）とは別物で衝突しない（VALIDATE トークンは既存）。

### 10.4 `INTO #err`（中）

- append 関数だけでは不足。VALIDATE は違反行を**一時テーブル `#err` として実体化**する（B12/B37 の `#err` と同じ多重違反モデル）。列＝`$id` / `$err_field` / `$err_code` / `$err_message` / `$err_value`。`INTO #err` 省略時は同スキーマの結果集合を文の結果として返す。
- 1 レコード複数違反＝複数行。違反 0 件でも列スキーマを保持（B2 の空 SELECT 列と同じ）。
- 評価順＝各 `ValidationRow` につき **①組み込み制約 → ②CHECK**。CHECK 由来違反は `$err_field`=空・`$err_code`=`ERR_CHECK`・`$err_message`=評価済みメッセージ・**`$err_value`=空**（特定フィールドに紐付かないため。参照値はメッセージへ `||`/`CONCAT` で埋める運用＝B37 と同じ）。

### 10.5 取得・境界（中）

- v1 の取得は `fetchAll` の **`$id` 昇順ページング**。大規模は既存 Cursor を流用するが、v1 は `$id` ページングに限定（KORDER Cursor の窓最適化は別スコープ）。
- 取得上限は既存 `maxRecords`。超過は §10.3 の `requiresCompleteInput=true` により fail-closed（`onLimit=truncate` は error へ）。無音の部分監査をしない。

### 10.6 EXPLAIN（中）

- `EXPLAIN VALIDATE APP… [WHERE…] [CHECK…]` は「read-only 監査・取得フィールド（`$id`∪制約∪WHERE∪CHECK）・fetch 経路（fetchAll / `$id` ページング）・書込み API なし」を表示する。**実際の違反件数は出さない**（レコード API を呼ばない契約＝B40 の EXPLAIN 方針と同じ）。

### 10.7 工数（据え置き）

4.5〜8.5 人日（B37 の 0.7〜0.9 倍）。R2 の最大の新規は「内部行契約 `ValidationRow` ＋二系統の値配線」。検証ロジック（`validateAndNormalizeDmlValue`）・CHECK（`evaluateCustomChecks`）・flatten・fetch・read-only 分類は既存流用。

### 10.8 受入条件の追補（R1 §7 に追加）

- **二系統**: USER/ORG/GROUP_SELECT・複数選択の**空セルが必須違反として検出される**（生値 `[]` 経路。flat 直渡しでは取り逃がす回帰を固定）。
- **read-only**: VALIDATE 実行で mutation API・confirm を 0 回（`writesKintone=false`・全面）。`onLimit=truncate` 指定でも error（`requiresCompleteInput=true`）。
- **#err 実体化**: `VALIDATE … INTO #err; SELECT … FROM #err` が動く・違反 0 件で列保持・1 レコード複数違反＝複数行・CHECK 違反の `$err_field` 空/`$err_value` 空。
- **EXPLAIN**: 取得フィールドの和集合表示・書込み API なし表示。

---

## 11. codex レビュー結果（R2・2026-07-19・要 R3）

Claude が P1-1/6/9/10 を実ファイルで裏取り済み。**判定＝R3 必須・R2 のままでは実装着手不可**。核心（二系統・`{id,record,flat}`・`executeSelect` projected 非流用・`validateAndNormalizeDmlValue(生値)`・`evaluateCustomChecks(flat)` 再利用・`VALIDATE` を isReadOnlyType/非 isDmlType・多重違反行・EXPLAIN で件数非表示・minor）は妥当と確認された。

### P1（誤り・要修正）
1. **R1 §3.1/§6 が §10.2 と矛盾**（本文が「組み込み検証に `ProcessRow`」のまま）→ **本文を生値へ統一済み**（本コミット）。
2. **`$err_value` の直列化は既存流用でなく新規**。`rawScalarText`（[dmlValidation.ts:103](../../src/core/dmlValidation.ts#L103)）は private＋配列/オブジェクトを空文字化・`renderValidationValue`（[dmlValidationCandidates.ts:108](../../src/core/dmlValidationCandidates.ts#L108)）は配列を JSON 化。→ R3 で「USER/ORG/GROUP の複数 code＝JSON 配列か区切りか・CHECK_BOX/MULTI・単一/空/`null`・code か name か」を確定。
3. **B29 は全 NUMBER が対象**。数値桁は `getNumberPrecision()`（アプリ設定・[execute.ts:3315](../../src/execute.ts#L3315)）由来で、フォームの min/max が無い NUMBER も監査対象に含める必要がある。「制約フィールドをフォーム定義から導出」だけでは B29 対象を落とす。
4. **取得列 collector をそのまま流用できない**。`collectRequiredFieldsByTable`（[selectToKintone.ts:341](../../src/converter/selectToKintone.ts#L341)）は private・`SelectStatement` 引数。CHECK 参照は別 collector `collectCheckFieldRefs`（[dmlCustomCheck.ts:13](../../src/core/dmlCustomCheck.ts#L13)）。→ R3 で「WHERE 収集を汎用 helper に抽出し CHECK と和集合」or「VALIDATE 専用 collector」を確定（架空 SELECT 経由は不適）。
5. **WHERE 範囲が未確定**。KLIKE は local `evalWhere` で必ず例外（[evalWhere.ts:107](../../src/engine/evalWhere.ts#L107)）・SELECT は `klikeValidation`（[klikeValidation.ts:110](../../src/core/klikeValidation.ts#L110)）で安全押し下げ形のみ許可。→ R3 で「v1 は KLIKE/EXISTS/IN-subquery を禁止するか押し下げ実装するか・UNSUPPORTED capability のエラー・残余のローカル再評価」を確定。
6. **`requiresCompleteInput=true` は onLimit を強制しない**（分類関数）。強制は surface 側（MCP `containsValidationOnly ? "error" : onLimit`・[tools.ts:583](../../src/mcp/tools.ts#L583)／CLI/plugin 同様）。→ R3 で **VALIDATE executor 内で常に error 強制**＋各 surface の強制条件へ VALIDATE を追加。
7. **dispatch/surface の見落とし**。少なくとも単文 dispatch（[execute.ts:617](../../src/execute.ts#L617)）・CLI supported type（[cli/index.ts:1621](../../src/cli/index.ts#L1621)）・batch `INTO #err` 分岐（[execute.ts:1031](../../src/execute.ts#L1031)）・`analyzeBatch` 暗黙 temp/schema/依存辺（[batch.ts:287](../../src/core/batch.ts#L287)）・KLIKE static switch（[klikeValidation.ts:43](../../src/core/klikeValidation.ts#L43)）・`EXPLAIN VALIDATE`（ExplainStatement.query union＋parser＋plan dispatch＋metadata 必要性）を配線。
8. **公開結果型が未確定**。`ExecuteResult` は union で、新 result 型を作ると renderResult/CLI formatter/MCP payload/batch envelope の exhaustiveness 更新が要る。既存 `VALIDATION`（INSERT/UPDATE/UPSERT 固定・[execute.ts:313](../../src/execute.ts#L313)）は流用不可。→ **最小は通常出力を `SelectResult` にする**（R3 確定）。
9. **§10.4 の B12/B37 スキーマ説明が不正確**。実際は 元ペイロード列＋6列（`$err_statement/$err_operation/$err_row/$err_field/$err_code/$err_message`・[dmlValidationCandidates.ts:26](../../src/core/dmlValidationCandidates.ts#L26)）で **`$err_value` を持たない**。B41 の5列は別スキーマ・`$err_value` は B41 新規（「B37 と一致」でない）。`appendValidationErrors` は runtime 実体化する（[execute.ts:678](../../src/execute.ts#L678)）ので「append だけでは不足」は analyzeBatch 暗黙作成の意味に限る。単文 `VALIDATE … INTO #err` の拒否可否（B12 は拒否・[batch.ts:212](../../src/core/batch.ts#L212)）も明記。
10. **「大規模は Cursor」は誤り**（反映済み）。`fetchAll` は offset＋`$id` keyset（[fetchAll.ts:199](../../src/api/fetchAll.ts#L199)）で Cursor API 非使用（Cursor は KORDER_CURSOR 専用）。

### P2（改善）
1. `maxRecords` は境界到達でも fail-closed（[fetchAll.ts:143](../../src/api/fetchAll.ts#L143)）→「上限到達時は完全性を証明できねば error」と表現・ちょうど上限＋満杯ページを受入に。
2. EXPLAIN は metadata（フォーム定義/数値精度）は読む。「レコード/mutation API は呼ばない・違反件数は出さない」と正確化。
3. `(fields)` の静的エラー（未知/重複/サブテーブル子/制約なし/`$id`・システム）を R3 で追加（`inSubtable`・型は `formFieldInfo` にある）。
4. 工数 4.5〜8.5 人日は、WHERE 全機能＋専用 result 型まで含めると上限が厳しい。**v1 で KLIKE/subquery 禁止＋`SelectResult`** なら成立し得る。R3 スコープ確定後に再見積り。
5. SemVer minor 妥当（3.5.0 相当）。既存 `VALIDATION` payload 兼用は避ける。

### R3 の確定8点（提案する保守的 v1 の既定）
①R1 raw/flat 統一（済）②`$err_value`＝`renderValidationValue` 相当の JSON（配列は code 配列）③B29＝全トップレベル NUMBER を対象に含める④**WHERE v1 は KLIKE/EXISTS/IN-subquery を禁止**（`klikeValidation` へ VALIDATE 追加・plain 比較＋AND/OR/BETWEEN/IN リテラル＋選択系 IN を local 評価）⑤result type＝`SelectResult`⑥単文 `INTO #err` は拒否（B12 同様）・#err は 5 列 B41 スキーマ⑦onLimit＝VALIDATE executor で常時 error＋各 surface に VALIDATE 追加⑧fetchAll は Cursor 非使用（済）。この保守スコープなら工数 4.5〜8.5 人日を維持。

---

## 12. R3 確定事項（2026-07-19・Claude・保守 v1・実装着手可）

§11 の 8 点を保守 v1 スコープで確定する（KLIKE/サブクエリ禁止＋`SelectResult`）。各決定はコード裏取り済み。

### 12.1 R1 本文の raw/flat 統一（P1-1）
§3.1/§6/§5/§7 を「組み込み＝生値・WHERE/CHECK＝flat・fetchAll は Cursor 非使用」へ統一（反映済み）。

### 12.2 `$err_value` の直列化（P1-2）
- **`$err_value = renderValidationValue(normalizeRaw(record[code].value, fieldType))`**（[dmlValidationCandidates.ts:108](../../src/core/dmlValidationCandidates.ts#L108)・export 済み）。NUMBER=raw 字句／STRING=そのまま／USER・ORG・GROUP・CHECK_BOX・MULTI_SELECT=**code 配列の JSON**（`["c1","c2"]`・name は含めない）／空配列・`null`=空文字。
- CHECK 由来違反は `$err_value=""`（§10.4・B41 新規契約。B37 は `$err_value` 列自体を持たない）。

### 12.3 検証対象フィールドの自動導出＝制約 ∪ 全 NUMBER（P1-3）
- `(fields)` 省略時の対象 = 制約を持つフィールド（required/min/max/minLength/maxLength/選択肢）**∪ トップレベル NUMBER 全体**（B29 桁は `getNumberPrecision()`（[execute.ts:3315](../../src/execute.ts#L3315)）由来で、フォーム min/max が無い NUMBER も対象）。
- 対象に NUMBER を含むときだけ `getNumberPrecision()` をアプリごと 1 回取得（既存 DML と同じ・取得失敗は fail-closed）。

### 12.4 取得フィールド collector（P1-4）
- **VALIDATE 専用 collector を新設**：検証対象（§12.3）∪ WHERE 参照 ∪ CHECK 参照（`collectCheckFieldRefs`・[dmlCustomCheck.ts:13](../../src/core/dmlCustomCheck.ts#L13)）∪ `$id` の和集合。
- WHERE 参照は `collectRequiredFieldsByTable`（private・SelectStatement 専用）を流用せず、VALIDATE の単一 WHERE から FIELD 参照を集める小 helper を新設（既存 WhereExpr walker を共有・架空 SELECT は採らない）。

### 12.5 WHERE 範囲＝保守 v1（P1-5）
- **v1 は KLIKE / EXISTS / `IN (SELECT…)` / スカラーサブクエリを WHERE で禁止**。`klikeValidation` の `validateStatement` switch（[klikeValidation.ts:43](../../src/core/klikeValidation.ts#L43)）に `case "VALIDATE"` を追加し KLIKE を拒否、サブクエリ系は parse/analyze で拒否。
- 許可＝plain 比較・`AND/OR/NOT/()`・`BETWEEN`・`IN (リテラル/選択系)`・`IS NULL`・`LIKE`（JS）。
- 取得は raw records を `fetchAll` で取り、**kintone 押し下げ可能な部分を prefilter（superset）に使い、正しさは取得後 `flat` への local `evalWhere` で担保**（既存 whereToKintone＋evalWhere の再利用）。押し下げ最適化の拡張・フル WHERE は v2。

### 12.6 result type＝`SelectResult`／単文 INTO／#err スキーマ（P1-8, P1-9）
- 通常出力（`INTO #err` 省略）= **`SelectResult`**（[execute.ts:229](../../src/execute.ts#L229)）。`columns=["$id","$err_field","$err_code","$err_message","$err_value"]`・rows=違反 `ProcessRow`。新 result 型を作らず renderResult/CLI/MCP/batch envelope の exhaustiveness を触らない。
- `INTO #err` = 同 5 列を温度テーブルへ実体化（**B41 独自スキーマ**・B12/B37 の 6 列 `VALIDATION_META_COLUMNS`（[dmlValidationCandidates.ts:26](../../src/core/dmlValidationCandidates.ts#L26)）とは別物・`$err_value` は B41 新規）。`analyzeBatch` の暗黙 temp 作成・schema・依存辺に VALIDATE INTO を登録（[batch.ts:287](../../src/core/batch.ts#L287)）。
- **単文 `VALIDATE … INTO #err` は拒否**（temp scope なし・B12 と同じ [batch.ts:212](../../src/core/batch.ts#L212) の判定へ VALIDATE の `errorTable` を含める）。単文 `VALIDATE …`（INTO なし）は `SelectResult` を返す。

### 12.7 read-only／onLimit 強制／dispatch 配線（P1-6, P1-7）
- read-only 分類は §10.3（`isReadOnlyType` 追加・非 `isDmlType`・`writesKintone=false`）。
- **onLimit=error は 2 段で強制**：①VALIDATE executor が `fetchAll` を常に `onLimit="error"` で呼ぶ（分類関数に依存しない）②各 surface の強制条件に VALIDATE を追加＝CLI（[cli/index.ts:1685](../../src/cli/index.ts#L1685)）・MCP（`containsValidationOnly ? "error" : onLimit`・[tools.ts:583](../../src/mcp/tools.ts#L583)）・plugin（[desktop.ts:2008](../../src/ui/desktop.ts#L2008)/2140）。
- dispatch 配線：単文 switch（[execute.ts:617](../../src/execute.ts#L617)）・batch `INTO #err` 分岐（[execute.ts:1031](../../src/execute.ts#L1031)）・CLI supported type（[cli/index.ts:1621](../../src/cli/index.ts#L1621)）・KLIKE static switch（§12.5）・`EXPLAIN VALIDATE`（`ExplainStatement.query` union [ast.ts:51](../../src/types/ast.ts#L51)＋parser [parser.ts:425](../../src/parser/parser.ts#L425)＋plan dispatch [execute.ts:5923](../../src/execute.ts#L5923)＋metadata 必要性 [explainMetadata.ts:47](../../src/core/explainMetadata.ts#L47)＝VALIDATE は WHERE 無しでもフォーム制約取得が要る）。

### 12.8 取得境界・EXPLAIN（P1-10, P2-1, P2-2）
- 取得は `fetchAll`（offset＋`$id` keyset・Cursor 非使用）。`maxRecords` **到達**で fail-closed（境界＋満杯ページも error・[fetchAll.ts:143](../../src/api/fetchAll.ts#L143)）。
- EXPLAIN＝「レコード/mutation API を呼ばない・フォーム定義/数値精度 metadata は読む・違反件数は出さない・取得フィールド和集合／WHERE capability／ページング方式／完全入力要否を表示」。

### 12.9 `(fields)` の静的エラー（P2-3）
`(fields)` 指定時に静的拒否＝未知フィールド・重複・サブテーブル子フィールド・`$id`/システムフィールド・制約も NUMBER でもない（監査対象外）フィールド。`formFieldInfo` の `inSubtable`・型で検証（[formFieldInfo.ts:43](../../src/core/formFieldInfo.ts#L43)）。

### 12.10 工数・SemVer（P2-4, P2-5）
保守 v1（KLIKE/サブクエリ禁止＋`SelectResult`）で **4.5〜8.5 人日**維持。フル WHERE・専用 result 型・サブテーブル監査は v2。**SemVer minor（3.5.0 相当）**。既存 `VALIDATION` payload の兼用はしない。

### 12.11 受入条件の追補（R3）
- **二系統**（§10.8）＋**$err_value**＝USER/ORG/GROUP/複数選択が code 配列 JSON・NUMBER が raw・CHECK 違反は空。
- **WHERE**＝KLIKE/`IN (SELECT)`/EXISTS/スカラーサブクエリを静的拒否・plain/BETWEEN/IN リテラル/選択系 IN/IS NULL/LIKE は動作・local 再評価で正しさ担保。
- **result**＝単文 `VALIDATE`（INTO なし）は `SelectResult`・単文 `VALIDATE … INTO #err` は拒否・複文 `VALIDATE … INTO #err; SELECT … FROM #err` は動作。
- **onLimit**＝全 surface で VALIDATE が truncate を無視し error（境界＋満杯ページ含む）。
- **EXPLAIN VALIDATE**＝取得フィールド/書込みなし/違反件数なしを表示。
- **(fields)**＝未知/重複/サブテーブル子/システム/監査対象外の静的エラー。

---

## 13. R4 確定事項（2026-07-19・Claude・保守 v1・実装着手可）

§12 R3 review の P1×5 を確定。コード裏取り済み。**これで実装着手可**。

### 13.1 `$err_value` の空値＝空文字（P1-1）
- **B41 専用レンダラ**: `$err_value = isEmptyDmlValue(生値) ? "" : renderValidationValue(normalizeRaw(生値, fieldType))`。`isEmptyDmlValue`（export 済・[dmlValidation.ts:144](../../src/core/dmlValidation.ts#L144)）で空配列/空文字/`null` を `""` に確定（`renderValidationValue([])` は `"[]"` を返すため必須）。非空は `normalizeRaw` で正規化後 `renderValidationValue`（NUMBER=raw・STRING・選択系=code 配列 JSON）。
- **`normalizeRaw` を export**（現在 private・[dmlValidation.ts:121](../../src/core/dmlValidation.ts#L121)）。`renderValidationValue` 自体の契約は変えない（B12/B37 出力に影響させない）。

### 13.2 修飾フィールド参照を静的拒否（P1-2）
- v1 は WHERE / CHECK 内の**修飾参照（`tableAlias !== null`・`APP4221.金額` 形）を静的拒否**。VALIDATE は単一アプリで alias が無く、`flatten(record, null)`（[process.ts:78](../../src/engine/process.ts#L78)）は非修飾キーのみ生成・`evalWhere`（[evalWhere.ts:316](../../src/engine/evalWhere.ts#L316)）は修飾キーを直接引き非修飾へフォールバックしない→受理すると存在値を空と誤評価するため。非修飾のみ許可。

### 13.3 prefilter アルゴリズム（P1-3）
`whereToKintone` 単独は LIKE で例外（[whereToKintone.ts:60](../../src/converter/whereToKintone.ts#L60)）のため、取得 WHERE の押し下げは次の順:
1. WHERE が **EXACT_PUSHDOWN** なら全体を `whereToKintone`。
2. それ以外は **`extractSafePushdownLeaves`**（export 済・[wherePredicatePushdown.ts:34](../../src/core/optimization/wherePredicatePushdown.ts#L34)）を取得済み field type/options＋`allowKlike:false` で実行し、AND 安全 leaf だけを prefilter に。
3. 安全 leaf が無ければ query=`""`（対象スコープ全件取得）。
4. **どの場合も取得後に元 WHERE 全体を `evalWhere(flat, resolver)` で再評価**（正しさは local 評価で担保）。
- **サブクエリ拒否は専用静的検証**：VALIDATE の WHERE を走査し `EXISTS`／`SUBQUERY_IN_LIST`／`SCALAR_SUBQUERY`（[ast.ts:373/533](../../src/types/ast.ts#L373)）を拒否（klikeValidation switch は KLIKE のみ）。KLIKE 拒否は `validateKlikeStatement` の switch（[klikeValidation.ts:43](../../src/core/klikeValidation.ts#L43)）へ VALIDATE case 追加。

### 13.4 batch `INTO #err` の runtime 配線（P1-4）
- 実行は **B12 の validateOnly 分岐を範とする VALIDATE 専用分岐**（[execute.ts:961-975](../../src/execute.ts#L961)：検証 → `validationErrorTable` があれば `appendValidationErrors(tempTables, table, columns, …)`。onLimitReached は `"error"` 固定）。**§12.7 が指した execute.ts:1031 は「temp 参照文」分岐で誤り**（訂正）。
- `analyzeBatch`（[batch.ts:287](../../src/core/batch.ts#L287)）の schema signature は DML payload 列前提→VALIDATE は **常に B41 固定 5 列**（`fields` を signature に使わない）。runtime も固定 5 列を `appendValidationErrors` へ。列メタ＝`$id`=number・残り 4 列=string（B12 が `$id`/`$err_row` に数値意味型を付ける [execute.ts:3805](../../src/execute.ts#L3805) と同じ）。
- 単文 `VALIDATE … INTO #err` 拒否＝[batch.ts:212](../../src/core/batch.ts#L212) の validationTable 抽出に VALIDATE の `errorTable` を追加。

### 13.5 EXPLAIN 専用 plan builder（P1-5）
- **VALIDATE 専用 plan builder** を用意し、`buildExplainPlan`（[execute.ts:5923](../../src/execute.ts#L5923)）で SELECT へ fallthrough させない（未知型 fallthrough は from/orderBy を参照して壊れる）。
- `buildExplainWhereAnalysis`（[execute.ts:5615](../../src/execute.ts#L5615)）に VALIDATE を追加＝フォーム定義を取得し、NUMBER 対象があれば `getNumberPrecision` を読む。
- traced client（[execute.ts:5600](../../src/execute.ts#L5600)）＋ metadata 表示型（[execute.ts:5585](../../src/execute.ts#L5585)）に **number precision 集合**を追加（現状 getFields/getProcessStatuses のみ）。
- CLI の metadata 不要 dry-run 判定（[explainMetadata.ts:47](../../src/core/explainMetadata.ts#L47)）に VALIDATE を追加（WHERE 無しでもフォーム定義が要る）。
- 単文・バッチ EXPLAIN 共通（execute.ts:5731 も同 builder）。表示＝取得フィールド和集合・WHERE capability・ページング方式・完全入力要否・フォーム定義/数値精度の読み込み。records/mutation API は呼ばない・違反件数は出さない。

### 13.6 受入条件の追補（R4）
- `$err_value`：空選択系/空複数選択=`""`（`"[]"` でない）・非空 USER=code 配列 JSON・NUMBER=raw。
- 修飾参照 `APP4221.金額` を WHERE/CHECK に書くと静的エラー。
- prefilter：`WHERE 金額>0 AND 件名 LIKE '%x%'` が「金額>0 を安全 leaf 押し下げ＋全体 local 再評価」で正しい違反集合。EXACT な WHERE は全体押し下げ。`IN (SELECT)`/EXISTS/スカラーサブクエリは静的エラー。
- 単文 `VALIDATE … INTO #err` 拒否・複文で #err が固定 5 列（$id number・他 string）で実体化。
- `EXPLAIN VALIDATE` が VALIDATE 専用 plan（SELECT fallthrough でない）・フォーム定義/数値精度の読み込み表示・書込み/違反件数なし。
