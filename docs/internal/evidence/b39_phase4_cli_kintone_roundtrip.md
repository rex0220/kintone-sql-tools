# B39 Phase 4（レコード番号純 UPDATE）＋ cli-kintone 実 export round-trip 証跡

- 日付: 2026-07-19
- 環境: profile `dev`・APP4221・`node dist-cli/ksql.js`・**cli-kintone v1.21.0（グローバル）で実 export**
- 対象: v3.6.0 Phase 4（`IMPORT UPDATE … MATCH RECORD NUMBER SOURCE`）＋ Phase 3 BY NAME の実データ検証

## A. cli-kintone フラット export → kSQL BY NAME READ round-trip（Phase 3 実データ検証）

cli-kintone で APP4221 のフラット項目を実 export（`record export --app 4221 --fields "レコード番号,タイトル,金額,チェックボックス,複数選択,リンクWEB,ドロップダウン"`）。

- **多値は引用符セル内 LF**（cli-kintone 実形式）: `"M1\nM2"`・`"Y\nZ"`。
- kSQL `BY NAME VALIDATE ONLY` で読取: チェックボックス `["X"]`/`["Y","Z"]`・複数選択 `["M1","M2"]`/`["M2","M4"]`・ドロップダウン `d1`/`d2` に**正しく配列化**。
- **レコード件数の整合**: APP4221 総数 10 件 → `validated=10`。**RFC4180 のセル内 LF が誤マージ/分割なく正しくグループ化**（多物理行=1レコード）。
- レコード番号列は監査付き無視・エラーは既存 minLength 違反のみ（フォーマット読取は正常）。

→ **cli-kintone フラット export CSV をそのまま kSQL BY NAME で取込める**ことを実データで実証。

## B. cli-kintone export → kSQL IMPORT UPDATE round-trip（Phase 4）

| # | 検証 | 結果 |
|---|---|---|
| 1 | valid レコード INSERT（$id=136 取得） | INSERT 1 ✓ |
| 2 | cli-kintone で 136 を export（`--condition "レコード番号 = 136"`） | `"136","RECNUM_ORIG"` ✓ |
| 3 | **`IMPORT UPDATE INTO APP4221 (タイトル) FROM CSV u BY NAME MATCH RECORD NUMBER SOURCE レコード番号`** | `UPDATE 1`・**タイトル→RECNUM_UPDATED・新規なし（INSERT 0）** ✓ |
| 4 | 未一致番号（9999999） | `ERR_RECORD_NUMBER_NOT_FOUND`（隔離可能 row error）・書込み0 ✓ |
| 5 | source 重複（136×2） | `ERR_RECORD_NUMBER_DUP_SOURCE` 文全体拒否（照合 read 前）✓ |
| 6 | `ON DUPLICATE` 併用 | parse error「IMPORT UPDATE and ON DUPLICATE are mutually exclusive」✓ |
| 7 | cleanup DELETE 136 | DELETE 1 ✓ |

## 決定的証拠
- **レコード番号照合の純 UPDATE**: cli-kintone が付与するレコード番号で既存レコードを更新・**INSERT 0**（新規行を作らない）。
- **番号は照合専用**: PUT payload に入らず（`タイトル` のみ更新）。
- **source 重複は照合 read 前に global 拒否**・未一致は隔離可能。
- cli-kintone `record import --update-key=レコード番号` に相当する round-trip UPDATE を kSQL IMPORT で実現。

## npm test
- 本体 2,025＋CLI 25 = **2,050 pass**（Phase 3 の 2,044 から +6）
