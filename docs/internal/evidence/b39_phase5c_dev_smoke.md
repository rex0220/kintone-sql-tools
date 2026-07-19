# B39 Phase 5C（JSON nested サブテーブル INSERT/UPSERT）dev 実機 smoke 証跡

- 日付: 2026-07-19
- 環境: profile `dev`・APP4221（SUBTABLE=`テーブル`・子=文字列T1/文字列T2(minLength>2)/数値T1）・`node dist-cli/ksql.js`
- 対象: v3.6.0 Phase 5C（JSON nested INSERT/UPSERT・ID なし全置換・confirm detail）

## レビューで検出・修正した P1（write smoke でのみ露見）
- **症状**: JSON subtable INSERT が `CB_IJ01「不正なJSON文字列」`で拒否。
- **根因**: POST payload に **INTO 外の全 39 フィールドがデフォルト値込みで混入**（`prepareImportRecords` の create デフォルト補完が INTO 外まで parent.top に格納）→ 特に **`添付ファイル`(FILE)={value:""}** が invalid（FILE は `[{fileKey}]` 形式必須）。**Phase 2 と同型**・最小フォームのユニットテストでは素通り。
- **修正**: INTO 対象だけを書込み payload へ・フォーム全体 create 検証は破棄用レコードへ分離。回帰テスト（FILE・既定値 DROP_DOWN・非 INTO を含むフォームで POST/PUT payload=INTO＋宣言 subtable のみ）追加。

## 結果（修正後・全 pass・可逆）

| # | 検証 | 結果 |
|---|---|---|
| 1 | JSON subtable INSERT（親＋子2行） | `affected=1`・$id=137・テーブル 2行 ✓ |
| 2 | payload | INTO フィールド＋宣言 subtable のみ（FILE 等混入なし）✓ |
| 3 | UPSERT 全置換（2→1行） | WARNING＋`existing=2 input=1 add=1 delete=2` → テーブル 1行・**全 row ID 新採番**（ID なし全置換）✓ |
| 4 | `[]` 全削除 | WARNING＋`existing=1 input=0 add=0 delete=1` → テーブル 0行 ✓ |
| 5 | confirm 削除警告 | `WARNING: existing subtable rows will be deleted/replaced.` 最上位表示 ✓ |
| 6 | CSV subtable mutation | `UnsupportedError … until Phase 5D`（未開通維持）✓ |
| 7 | cleanup DELETE | 復元 ✓ |

## 決定的証拠
- **ID なし全置換**: UPSERT で既存 row を全削除し新採番（`_rid` 非投入・v2 R1 §7）。
- **`[]` 全削除**・**欠落 table 維持**（confirm 内訳で件数明示）。
- **confirm detail＋削除警告**が実機表示・内訳表示不能面 fail-closed。
- payload P1 修正の実証（FILE 混入 CB_IJ01 解消）。

## npm test
- 本体 2,050＋CLI 25 = **2,075 pass**（5B の 2,071 から +4）
