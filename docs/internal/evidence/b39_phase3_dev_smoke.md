# B39 Phase 3（cli-kintone 互換 段0/1・BY NAME）dev 実機 smoke 証跡

- 日付: 2026-07-19
- 対象: v3.6.0 Phase 3（BY NAME＋列分類＋複数値 LF＋段0 数値互換）
- 環境: profile `dev`・APP4221（FILE/LINK フィールド追加後・39 フィールド）・`node dist-cli/ksql.js`
- 対象コミット: Phase 3 実装＋preserveCodes 検証

## 結果（全 pass・可逆）

| # | 検証 | 結果 |
|---|---|---|
| 1 | BY NAME 名前対応（ヘッダ=フィールドコード・順不同） | valid=1 ✓ |
| 2 | 複数値セル内 LF 分割（CHECK_BOX） | `["A","B"]`（LF→配列）・ERR_CHOICE_INVALID＝TypeError クラッシュでなく検証到達 ✓ |
| 3 | 未知列 既定拒否 | `ERR_IMPORT_UNKNOWN_COLUMN: unknown CSV header "unknownCol"` ✓ |
| 4 | 既知非書込み列（レコード番号/計算）監査付き無視＋`IGNORE UNKNOWN COLUMNS` | clean valid=1（レコード番号/計算/unknownCol 全て無視）✓ |
| 5 | **FILE を INTO 指定 → analyze error** | `ArgumentError: DML target field 添付ファイル is not writable (FILE).` ✓（実 FILE フィールドで確認）|
| 6 | **FILE 非INTO=監査無視＋LINK 書込み可** | リンクWEB を INTO・添付ファイルは無視 → valid=1 ✓ |
| 7 | BY NAME clean INSERT → DELETE | INSERT $id133 → DELETE 復帰 ✓ |
| 8 | EXPLAIN | `mapping: BY_NAME`・`multipleValueDelimiter: LF`・`sourceValueMode: string-preserving`・FILE policy 表示 ✓ |
| 9 | 3ソースモード回帰（BY NAME/positional CSV/JSON） | 全て正常 validate（codex の execute.ts 変更後）✓ |

## レビューで確定した P2（latent-bug 修正）
`preserveCodes`（assertValidDmlRecords＋validateDmlCandidates）＝**既存 USER/ORG/GROUP `INSERT/UPSERT…SELECT` DML の payload を正しい `[{code}]` に修正**（従来 INSERT…SELECT は string[]・UPSERT…SELECT は JSON 文字列＝kintone REST 書込み形式と不一致だった）。`VALUES` 経路は非該当で不変。UPSERT 値変換を INSERT と一貫化。CHANGELOG「修正（正しさ）」に明記・回帰テスト追加。

## npm test
- 本体 2,019＋CLI 25 = **2,044 pass**（Phase 2 の 2,028 から +16）
