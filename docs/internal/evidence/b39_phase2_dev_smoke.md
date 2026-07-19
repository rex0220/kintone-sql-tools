# B39 Phase 2（v2a JSON）dev 実機 smoke 証跡

- 日付: 2026-07-19
- 対象: v3.6.0 Phase 2（`FROM JSON <source>`・フラット）
- 環境: profile `dev`・APP4221（37 フィールド）・`node dist-cli/ksql.js`（uncommitted 後ビルド）
- コミット: `26be7c0`

## レビューで検出・修正した P1（dev 実機でのみ露見）
- **症状**: JSON IMPORT を INTO より多いフィールドのアプリ（APP4221=37）に実行 →「列数 37 と … 4 が一致しません」。VALIDATE/INSERT/UPSERT 全経路。
- **根因**: `materializeJsonDmlSource` の出力列を呼び出し元の field infos（アプリ全体）に依存。ユニットテストは少フィールドで素通り。
- **修正**: `materializeDmlSource` で JSON 列を `stmt.fields`（INTO 順）から一元導出。回帰テスト追加（5フィールドアプリ・INTO 2列・`b,a` 順で名前対応）。

## 結果（修正後・全 pass・可逆）

| # | 検証 | 結果 |
|---|---|---|
| 1 | VALIDATE ONLY（string 金額・必須補完） | `validated=2 valid=2 invalid=0` ✓ |
| 2 | 19桁 string 金額 | `ERR_NUMBER_INTEGER_DIGITS`（12桁制限）＝**string が float に潰れず厳密10進検証に到達＝精度保持** ✓ |
| 3 | JSON number → NUMBER field | `precision target requires a JSON string` ✓（`{"金額":1000}` 拒否・`"1000"` 必須）|
| 4 | 全階層 duplicate key | `JSON duplicate key "タイトル" (offset=13, line=1, column=14)` ✓ |
| 5 | JSON INSERT | `INSERT insertedCount=2`（$id 131/132・名前対応で値正確）✓ |
| 6 | DELETE 復帰 | `DELETE deletedCount=2` ✓ |

## 決定的証拠
- **精度保持**: 19桁 JSON string 金額が桁数制約違反として検出＝JS float 化していない（B9 厳密10進が JSON 経路で機能）。
- **precision NUMBER は string 必須**: JSON number は NUMBER フィールドで拒否。
- **名前対応＋未知キー拒否・欠落 vs null 区別**: presence で INSERT/UPSERT/validation 一貫。
- **裸 JSON.parse 不使用**: dup-key を位置付きで検出。

## npm test
- 本体 2,003＋CLI 25 = **2,028 pass**（Phase 1 の 2,005 から +23）
