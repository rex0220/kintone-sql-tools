# B39 Phase 5D（CSV `*` 行 ID 全置換・破壊的）＋ cli-kintone 実 export round-trip 証跡

- 日付: 2026-07-19
- 環境: profile `dev`・APP4221（SUBTABLE=`テーブル`）・`node dist-cli/ksql.js`・**cli-kintone v1.21.0 実 `*` export**
- 対象: v3.6.0 Phase 5D（cli-kintone CSV `*` 行 ID 全置換・破壊的・REPLACE SUBTABLES）

## レビューで検出・修正した P1（cli-kintone 実 export smoke でのみ露見）
- **症状**: `ERR_IMPORT_PARENT_VALUE_ON_CONTINUATION`。**cli-kintone の実 `*` export は継続行に親フィールド値（レコード番号・タイトル）を繰り返す**が、kSQL は継続行の親セル非空を無条件拒否 → **cli-kintone 実 export をそのまま読めない**（互換仕様 §7.1 が実フォーマットと乖離）。
- **cli-kintone 公式**: 継続行の親値は「ignored」。
- **修正**: 継続行親値が**空 or 親開始行と一致なら無視・不一致のみ error**。互換仕様 §7 訂正・実 cli-kintone 形式の回帰テスト追加。

## 実 cli-kintone `*` export フォーマット（確認）
```csv
*,"レコード番号","タイトル","テーブル","文字列T1",...
*,"140","P5D_RT","7224989","a",...
,"140","P5D_RT","7224991","b",...     ← 継続行に親値 140/P5D_RT 繰り返し
,"140","P5D_RT","7224993","c",...
```
`テーブル` 列＝サブテーブル行 ID。

## 結果（修正後・全 pass・可逆）

| # | 検証 | 結果 |
|---|---|---|
| 1 | **継続行に親値繰り返し（cli-kintone 形式）を受理** | `ERR_..._CONTINUATION` なし・正常処理 ✓ |
| 2 | 破壊的全置換 UPDATE（既存更新1/空ID追加1/欠落削除2） | confirm `existing=3 input=2 update=1 add=1 delete=2`・削除警告 ✓ |
| 3 | 結果 | テーブル 2行＝UPDATED（7224989 更新・ID 維持）＋newrow（空ID 採番）・**旧 b/c（7224991/7224993）削除** ✓ |
| 4 | 別 smoke（未知 ID） | `rowIdNotFound=1`＋追加（先行 smoke で確認） ✓ |
| 5 | cleanup DELETE | 復元 ✓ |

## 決定的証拠
- **cli-kintone 実 `*` export（親値繰り返し）を kSQL がそのまま読み、破壊的全置換 round-trip が成立**。
- 既存 ID 更新（ID 維持）・空 ID 追加・未知 ID 追加（rowIdNotFound）・欠落 ID 削除＝cli-kintone `record import --update-key=レコード番号` 相当の subtable 全置換を実現。
- confirm 削除警告・PRESERVE（CSV）/DROP（JSON）分離・MCP は detail 承認不能で fail-closed。

## npm test
- 本体 2,052＋CLI 25 = **2,077 pass**（5C の 2,075 から +2）
