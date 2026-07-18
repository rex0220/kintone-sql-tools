# B41 v1 — 既存レコードの制約チェック（VALIDATE 文）仕様

- 作成日: 2026-07-19
- ステータス: **仕様 R1・codex レビュー済（要 R2・工数確定）**。**判定＝再利用成立・B37 より軽い（工数 4.5〜8.5 人日 ≈ B37 の 0.7〜0.9 倍）**。R2 で確定すべき 3 重大＝①**値は二系統**（組み込み検証＝生値 `record[code].value`／WHERE・CHECK＝`flatten` ProcessRow／`$err_value`＝生値文字列化。`ProcessRow` 直渡しだと USER/ORG/GROUP_SELECT の `"[]"` を非空扱いして必須違反を取り逃がす）②**内部行契約 `{record, flat, id}`** を取得直後から保持（`executeSelect` の projected 戻り値流用では生値・$id 対応を失う。取得は $id＋検証対象＋WHERE/CHECK 参照の和集合）③**read-only 分類の core 配管**（`VALIDATE` を `isReadOnlyType`/`isReadOnlyStatement`/`requiresCompleteInput`/`StatementAnalysis`/dispatch へ追加・`writesKintone=false`・`onLimit=truncate`→error・書込み API 0 回）。中＝B37 CHECK は型 resolver 込みで再利用・`INTO #err` は append 関数だけでは不足・`$err_value` のカスタム CHECK 時の値・REST Cursor は v1 で fetchAll の $id ページングに限定するか別スコープ・EXPLAIN。
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
