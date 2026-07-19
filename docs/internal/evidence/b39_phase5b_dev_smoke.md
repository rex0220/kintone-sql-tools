# B39 Phase 5B（サブテーブル read-only 検証）dev 実機 smoke 証跡

- 日付: 2026-07-19
- 環境: profile `dev`・APP4221（SUBTABLE=`テーブル`・子=文字列T1/数値T1）・`node dist-cli/ksql.js`
- 対象: v3.6.0 Phase 5B（child 検証＋VALIDATE ONLY 実データ preflight＋4層 #err＋親隔離・**非破壊**）

## 結果（全 pass・書込み 0）

| # | 検証 | 結果 |
|---|---|---|
| 1 | 正常 subtable（テーブル 2 行）VALIDATE ONLY | `validated=1 valid=1 invalid=0`・4層エラー列（`$err_subtable/$err_subrow/$err_source_row`）が schema に存在 ✓ |
| 2 | 不正 child（数値T1=notnum）→ 親隔離＋4層エラー | `$err_row=1・$err_field=数値T1・$err_subtable=テーブル・$err_subrow=1・ERR_TYPE_NUMBER`・正常な2行目含め**親全体 invalid**（`invalid=1`）✓ |
| 3 | $err_source_row（JSON） | 空（設計どおり・JSON は物理行なし）✓ |
| 4 | 通常 subtable INSERT（VALIDATE なし） | **`UnsupportedError: … until Phase 5C/5D; use VALIDATE ONLY`**（mutation 未開通）✓ |
| 5 | 書込み 0 | レコード数不変（10）・POST/PUT/DELETE 0 ✓ |

## 決定的証拠
- **4層エラー位置**が実機で機能: 親行/subtable/subrow/child field を特定。
- **親単位隔離**: 1 child error で正常 child 含む親全体が invalid。
- **mutation fail-closed 維持**: 通常 subtable IMPORT は Unsupported・VALIDATE ONLY のみ開通・write API 0。
- gate 漏れなし: dmlValidation はエラーコード追加のみ・batch schema は IMPORT subtable 専用の追加分岐（VALIDATE/UPDATE/既存 B12/B34 不変）。

## npm test
- 本体 2,046＋CLI 25 = **2,071 pass**（5A の 2,064 から +7）
