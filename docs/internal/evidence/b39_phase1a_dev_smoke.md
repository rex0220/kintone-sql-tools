# B39 Phase 1A dev 実機 smoke 証跡

- 日付: 2026-07-19
- 対象: v3.6.0 Phase 1A（v1 フラット CSV IMPORT・core＋CLI）
- 環境: profile `dev`・APP4221・`node dist-cli/ksql.js`（uncommitted 後にビルドした dist-cli）
- コミット: `f9b198c`（Phase 1A 実装）

## 結果（全 pass・可逆）

| # | 検証 | 結果 |
|---|---|---|
| 1 | gate OFF（`--import-csv` 無し）で IMPORT を parse 拒否 | `IMPORT is not supported (capability is disabled).` ✓ |
| 2 | gate ON（`--import-csv s=...`）で EXPLAIN プラン表示 | `IMPORT INSERT INTO APP4221 / source: CSV s / projection: SELECT expressions / gate: enabled / writesKintone: true` ✓ |
| 3 | VALIDATE ONLY（read-only・実スキーマ検証） | `validated=2 valid=0 invalid=2 errors=4`＝文字列MIN/MINMAX の minLength 既存制約を実スキーマで検出・射影値（タイトル/金額）正確・書込み0 ✓ |
| 4 | VALIDATE ONLY（必須補完） | `validated=2 valid=2 invalid=0 errors=0`＝clean pass ✓ |
| 5 | INSERT（`--allow-dml --yes`） | `INSERT insertedCount=2`（$id 129/130）・DML guard（`--allow-dml` 要求）＋confirm（`--yes` 要求）が IMPORT で機能・射影値正確 ✓ |
| 6 | DELETE（cleanup） | `DELETE deletedCount=2`・復帰確認 `rowCount=0` ✓ |

## 決定的証拠
- **gate**: OFF で parse 拒否・ON で EXPLAIN＝off-by-default capability gate が実経路で機能。
- **全経路**: CSV named source load → RFC4180 decode → SELECT 射影（`code→タイトル`・`CAST(amount AS NUMBER)→金額`）→ 実スキーマ検証 → POST が実 kintone で成立。
- **DML 分類**: IMPORT が `--allow-dml`/confirm を要求＝`isDmlType` 分類が正しい。
- **可逆**: INSERT→DELETE で原状復帰。

## npm test
- 本体 1,976＋CLI 25 = **2,001 pass**（baseline 1,955＋25 から +21 本）。
