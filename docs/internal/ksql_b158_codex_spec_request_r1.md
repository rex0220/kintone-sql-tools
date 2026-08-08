# B158 仕様 R1 作成依頼（codex）——CROSS JOIN（直積）の新設

**仕様の作成依頼。コードは 1 行も変更しないこと。ファイルへの書き込みも不要。**
git 操作・kSQL MCP・MEMORY.md 禁止。

対象リポジトリ: `C:\Users\rex02\Projects\kintone-sql-tools`（v3.62.0）

## 0. 依頼

**B158（直積が書けない）の仕様 R1 を、そのまま実装依頼に出せる形で書く。**

| ファイル | 役割 |
|---|---|
| `docs/internal/ksql_b158_cross_join_grid_issue.md` | 起票（実測 3 形・実需・設計論点） |
| `docs/internal/ksql_b128_window_phase2_spec.md` | 再開順序（B158 が①・2a の前提） |
| 依頼元意見（issue からリンク） | 実需の出所（製品別 0 埋め・R17 の暦日化・行数ガードの提案） |

## 1. 決まっていること（変更しない）

- **構文＝明示 `CROSS JOIN` を新設**（オーナー判断 2026-08-08）。
  `ON 1=1` の受理・カンマ結合は**開けない**（`JOIN ON` の「等値 1 本・両辺列」契約は不変）
- **行数ガード必須**＝直積の生成行数（左×右）に上限。`GENERATE_SERIES` の
  10,000 行ガード（`WITH` 文内合計・事前算出）の前例に乗る形で、上限値と算出時点を仕様で確定
- **EXPLAIN 契約**＝生成行数を事前表示（`row guard:` の前例）。**records API を呼ばない**・
  dry-run は API 0 回（B150/B155/B157 の教訓＝CLI e2e まで受入に含める）
- **許可判定・行数算出は 1 実装**（B155 の教訓＝経路ごとの複製を作らない）
- 結果の意味論＝標準 SQL の直積（左 N 行 × 右 M 行 = N×M 行。空側があれば 0 行）。
  `LEFT/RIGHT CROSS JOIN` は存在しない（ParseError）

## 2. あなたがコードから決めること（ファイル:行を添えて）

1. parser の変更点（`CROSS` の語・既存 JOIN 句との共存・エラーメッセージ）
2. **経路の網羅**＝CTE・一時テーブル・物理 APP・サブテーブル仮想テーブルの組ごとに
   許可/拒否と理由（本命は「系列 CTE × 小さいマスタ」。物理×物理の大直積を
   ガードがどう受けるか）。FULL_SCAN・完全入力・maxRecords との関係
3. 結合キー prefilter・WHERE 押し下げ（B150/B155 の機構）との相互作用＝
   CROSS JOIN の右側に WHERE 葉があるとき prefilter に乗せられるか、乗せないなら理由
4. ウィンドウ・GROUP BY・ORDER BY を重ねた形（0 埋め実需の実際の書き方）での
   実行計画とメタデータ要否（explainNeedsAppMetadata への追随＝B123 族の穴に注意）
5. 上限値の提案（GENERATE_SERIES と共有の 10,000 か・独立か）と超過時のエラー文

## 3. 仕様に必ず含めること

B151/B152/B155 と同じ型＝規則・適用経路・EXPLAIN 契約・受入条件（逐語 SQL・
実 serializer 形・依頼元 R17 の製品別暦日形＝**「日付系列 CROSS JOIN 製品マスタ CTE →
LEFT JOIN 実績 → 固定境界ウィンドウ」の 3 段が通り、取引の無い日×製品の行が 0 で出る**・
dry-run API 0 回・既存 JOIN 全回帰）・Phase 線引き・Claude 実測項目の列挙。

## 4. 書き方の制約

従来どおり。**仕様の全文（Markdown）を最終メッセージで出力**。
