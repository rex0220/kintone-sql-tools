# B41 v1 — 既存レコードの制約チェック（VALIDATE 文）仕様

- 作成日: 2026-07-19
- ステータス: **仕様 R2・codex レビュー待ち**（2026-07-19）。R1 の 3 重大＋中を **§10 で確定**（Claude がコード裏取り済み）＝①**値は二系統**（組み込み＝生値 `record[code].value`／WHERE・CHECK＝flat `ProcessRow`／`$err_value`＝生値化。`isEmpty`（dmlValidation.ts:154）は空配列を空と判定するが flatten 済み `"[]"`（process.ts:85）は非空扱い→ProcessRow 直渡しは USER/ORG/GROUP/複数選択の必須違反を取り逃がす）②**内部行契約 `{id, record, flat}`** を fetch 直後保持（取得＝$id∪制約∪WHERE∪CHECK・executeSelect の projected 戻り値は流用しない）③**read-only 配管**（新文 `VALIDATE` を `isReadOnlyType`（dmlGuard.ts:64）へ・`isDmlType` に入れず `writesKintone=false`・`requiresCompleteInput=true`＝onLimit=truncate→error・StatementAnalysis/dispatch/MCP `ksql_query`・書込み API 0 回）。中＝CHECK は `evaluateCustomChecks(groups, flat, resolveFieldType)`（dmlCustomCheck.ts:61）で B37 再利用・`INTO #err` は温度テーブル実体化（append だけでは不足）・`$err_value` の CHECK 時は空・Cursor は v1 で $id ページング限定・EXPLAIN。**判定＝再利用成立・B37 より軽い（工数 4.5〜8.5 人日 ≈ B37 の 0.7〜0.9 倍・据え置き）**。詳細 §10。
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
- 実装は既存 **`validateAndNormalizeDmlValue(現在値, fieldInfo, numberPrecision)`**（[dmlValidation.ts:50-97](../../src/core/dmlValidation.ts)）を流用。書込み経路（[execute.ts:3721](../../src/execute.ts)）と同じ呼び方で、値の出所が「書込み値」→「fetch 済みレコード値（`ProcessRow[code]`）」に変わるだけ。
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

- `WHERE` で監査対象を絞り、既存 fetch（`fetchAll`・大規模は Cursor）で取得。取得上限は既存 `maxRecords`／`onLimit`＝fail-closed（無音打ち切りしない）。
- 全面（CLI/MCP/プラグイン）で同一＝engine 側の純検証。面ごとの配管不要。

## 6. パーサ・AST・再利用

- 新文 `ValidateStatement { appId, fields?, where?, checkGroups?, errorTable? }`。`Statement` union（[ast.ts:15](../../src/types/ast.ts)）へ追加。`VALIDATE <app>` の解析を先頭文キーワードとして追加（`VALIDATE ONLY` サフィックスと分離）。
- 実行：`WHERE`＋対象フィールドで records を fetch（既存 SELECT/FULL_SCAN 経路流用）→ 各 `ProcessRow` に §3.1 組み込み検証＋§3.2 CHECK →違反行を生成 → 結果集合 or `INTO #err`。
- 再利用：`validateAndNormalizeDmlValue`（組み込み）・`evaluateCustomChecks`（B37）・`getFieldsCached`（制約）・`fetchAll`/`runFullScan`（取得）。**新規は「文法＋既存レコードへ検証を回す実行経路＋出力生成」のみ**。

## 7. 受入条件（テスト化）

- 組み込み：必須空・数値上下限違反・文字数違反・**選択肢の定義外値（記事の看板ケース）**・数値桁超過を既存レコードで検出。対象フィールド省略＝全制約フィールド・`(fields)` 指定で限定。
- カスタム：B37 `CHECK` が既存レコードで発火（グループ先勝ち・`||`/`CONCAT`/`@var`・`ERR_CHECK`）。
- 出力：`$id`/`$err_field`/`$err_code`/`$err_message`/`$err_value`・1 レコード複数違反＝複数行・違反 0 件で列保持・CLI CSV。
- 絞り込み：`WHERE` で対象限定・大規模は Cursor・`maxRecords` 超過 fail-closed。
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
