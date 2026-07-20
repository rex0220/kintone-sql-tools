# B44 APPLY 実機 smoke 証跡（v1/v1.1/v1.2）

- 実施: 2026-07-20・ブランチ feat/b44-apply-patch・APP4221（devenxyfi）
- CLI: working tree ビルド（`npm run build:cli`）。read-only 経路（VALIDATE ONLY/EXPLAIN）と mutation（`--allow-dml --yes`）を実行。
- **$id=7 は一切変更せず温存**（B42/B43 の証拠フィクスチャ）。専用レコード $id=1195「B44-smoke」を新規作成し、全項目後に削除。

## 手順と結果（全 pass）

| # | 検証 | SQL 要旨 | 結果 |
|---|---|---|---|
| 0 | 専用レコード作成 | add-records（テーブル3行: AAA/10・BBB/20・CCC/30） | $id=1195・_rid 7229578/7229580/7229582（_idx 0/1/2） |
| 1 | VALIDATE ONLY | `… PATCH SET 文字列T2='PPP' WHERE _rid='7229580' VALIDATE ONLY` | validated=1 valid=1 invalid=0・mutation 0 |
| 2 | EXPLAIN | 同文 `--dry-run --allow-dml` | records API=0・mutation API=0・revision required・dmlMaxRows=100・**dmlMaxSubtableRows=500**・payload preservation 表示 |
| 3 | **親+子同時 PATCH（B44 の核心）** | `SET タイトル='B44-patched' … PATCH SET 文字列T2='PPP' WHERE _rid='7229580'` | **1 PUT で親 タイトル と子 _rid=7229580 のみ更新**・対象外行/未指定セル 数値T1/行ID/行順すべて保持 |
| 4 | APPEND（既定値の明示補完） | `APPEND (文字列T2) VALUES ('DDD'),('EEE')` | 末尾へ2行追加（_idx 3/4）・**未指定 数値T1 が既定値1000で補完**（kintone 自動投入に依存せず送信） |
| 5 | REMOVE（中間行） | `REMOVE WHERE _rid='7229580'` | 中間行のみ削除・存続4行の id/全値/相対順を保持・kintone が _idx 再採番 |
| 6 | 複合 1文（PATCH+APPEND+REMOVE） | `PATCH …; APPEND …; REMOVE …` | 3操作を1 PUT で合成・結果整合（XPP/CCC/DDD/FFF） |
| 7 | post-image 検証 | `PATCH SET 文字列T2='X' … VALIDATE ONLY` | ERR_LENGTH_MIN を **`$err_subrow_id=7229578`** つきで検出・invalid=1・mutation 0 |
| 8 | scope 拒否（EXPECT ROWS） | `REMOVE … EXPECT ROWS 1` | `UnsupportedError: APPLY v1.2 scope does not support EXPECT ROWS` |
| 9 | scope 拒否（複数親） | `WHERE $id > 1 …` | `UnsupportedError: … single condition $id = <positive safe integer>` |
| 10 | REMOVE ALL ROWS | `REMOVE ALL ROWS` | 全子行削除（COUNT=0） |
| 11 | **$id=7 温存確認** | `SELECT … WHERE _p.$id=7` | _rid 7224309/7224313/7224317・値ともテスト前と完全一致 |
| 12 | 専用レコード削除 | delete-records 1195 | 削除済み |

## 複数テーブル実機（APP4223・2026-07-20 追記）

APP4221 をコピーし **SUBTABLE を2つ（テーブル・テーブル2、子コードは _0 サフィックスで区別）** 持つ APP4223 で、v1.1 の複数テーブル合成を実機検証（$id=1「B44-multi」）。

| # | 検証 | 結果 |
|---|---|---|
| M1 | VALIDATE ONLY（2テーブル分の apply[]） | valid=1 invalid=0・mutation 0 |
| M2 | **複数テーブル同時 APPLY を1 PUT** | `APPLY テーブル (PATCH; APPEND) APPLY テーブル2 (PATCH; REMOVE; APPEND)` を **affected=1（単一 PUT record）** で反映 |
| M2詳細 | テーブル | 7229594→XA1（数値T1=10 保持）・7229596 不変・NEW1 追加（数値T1 既定1000） |
| M2詳細 | テーブル2 | 7229598(PQR) 削除・7229600→YB1（数値T1_0=200 保持）・NEW2 追加（数値T1_0 既定1000） |
| M3 | 同一テーブル重複ブロック拒否（裁定3） | `ArgumentError: APPLY v1.2 scope allows only one block for table テーブル` |
| M4 | 他テーブルの子コード指定拒否 | `ArgumentError: APPLY child 文字列T2_0 does not belong to subtable テーブル` |

**複数テーブルで PATCH＋APPEND＋REMOVE を1文=1 PUT に合成できることを実機実証**。各テーブルが独立の payload 形（テーブル=PATCH_ONLY・テーブル2=FULL_SURVIVORS）で正しく処理された。

## 環境制約（コードの問題ではない）

- **MCP fail-closed の live 確認は不可**: 接続中の MCP サーバは公開版 3.6.1 で APPLY 構文を知らず ParseError になる（新ビルドではない）。新ビルドの MCP mutation 拒否（AST 判定・API 0）は unit テスト（`src/mcp/__tests__/tools.test.ts`）で検証済み。
- revision conflict の非 retry は unit テスト（GET 後別更新→旧 revision PUT 拒否）で検証済み。

## 結論

APPLY v1（PATCH）/v1.1（APPEND）/v1.2（REMOVE）の中核機能が実機で期待どおり動作。特に **B44 の目的「テーブル外項目とテーブル内項目を1 PUT で同時更新」を手順3で実証**。行 ID・行順・未指定セルの保持、APPEND 既定値の明示補完、REMOVE の存続行保持、post-image 検証のロケータ、scope 拒否、$id=7 温存をすべて確認。
