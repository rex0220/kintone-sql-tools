# B53 Phase1 仕様 R1 — codex 起草ブリーフ

- 作成日: 2026-07-23（Claude=仕様/観点）
- 目的: codex が **B53 Phase1 仕様 R1** を起草するための scope と判断論点の枠組み。
- 出力先: `docs/internal/ksql_b53_recursive_cte_cycle_phase1_spec.md`（R1 本体）
- 分担: **codex 起草 → Claude レビュー → R2**。git 操作は Claude 側（codex sandbox は .git 拒否）。仕様は実装せず**文書のみ**。
- 参照: [B53 評価](ksql_b53_recursive_cte_cycle_evaluation.md)（戦略 B・境界・CYCLE 最小形・API 回数）／[B40 Phase1 仕様](ksql_property_graph_phase1_spec.md)（章立ての手本）／B51・B52（v3.11.0 で堅牢化した実体化 CTE/JOIN/UNION 資産）／[横断: 文字列の扱い](ksql_string_semantics.md)（型付き比較）／B14（temp 列型メタ伝播）

## スコープ（Phase1 MVP・評価文書 §6 準拠）

- 単一再帰 CTE `WITH RECURSIVE name AS (seed UNION ALL 再帰項)`。自己参照は単一等値 JOIN。
- `UNION ALL` のみ（`UNION` 重複排除は Phase2）。
- **必須境界（深さ/行）＋ CYCLE 最小形（循環打ち切り＋mark 列）**。
- 実行は**戦略 B**（参照アプリを最初に1回だけ実体化 → 以降メモリ反復・API 回数は深さ非依存）。v3.11.0 の B51/B52 実体化 CTE/JOIN/UNION 資産を反復で回す。
- EXPLAIN に反復・境界・fail-closed・取得見積り `⌈R/P⌉` を表示。
- 対象外（Phase2）: 複数/相互再帰・`UNION`（重複排除）・CYCLE の path 列/`SEARCH` 句・戦略 C（深さ別 IN）・最短経路。

## 必要セクション（B40 Phase1 仕様の構成を踏襲）

1. スコープ（対象/対象外） 2. 構文 3. 意味論 4. 実行・エンジン 5. 境界・fail-closed 6. 終了保証 7. パーサ・予約語・AST 8. 面（CLI/MCP/plugin） 9. 受入条件（テスト化） 10. Phase2 引き継ぎ 11. 工数見積り

## R1 で確定すべき判断論点（曖昧にしないこと）

1. **【最重要・正しさ】CYCLE は爆発を止めない**。CYCLE は「循環データによる無限ループ」を防ぐが、**循環のない DAG（同じ部品が多所で再利用される BOM 等）の組み合わせ爆発は防げない**（各出現で再展開される）。したがって **CYCLE の有無に関わらず、絶対的な反復/総行/中間展開の上限を常時 fail-closed で強制**する。「CYCLE か境界のいずれか必須」ではなく「**境界は常時必須・CYCLE は任意の早期打ち切り**」と定義する。
2. **【正しさ】循環判定は path スコープ（SQL:2016 準拠）**。ある CYCLE 列値は「**現在の経路上に既出**」なら循環＝global visited 集合ではない（global だと合流を循環と誤判定して結果が欠落）。この意味論を明記し、実装（経路ごとの既出集合保持）まで落とす。
3. **CYCLE 句のサブセット**: `CYCLE <col> SET <mark> TO <値> DEFAULT <値>` を採用。`USING <path列>` は Phase1 任意（省略可・Phase2 で完全形）。CYCLE 列は単一/複数どちらを許すか確定する。
4. **再帰項の制約**（SQL 標準の非線形禁止に準拠）: 再帰項は**再帰 CTE を1回だけ参照**・INNER 単一等値 JOIN・WHERE・射影の算術（`深さ+1`・`累計員数 = r.累計 * c.員数`）まで。**集計/GROUP BY/DISTINCT/window/OUTER JOIN/再帰項内サブクエリ/ネスト再帰は Phase1 拒否**。
5. **seed と再帰項の列整合**: 列数一致必須・型は B14（temp 列型メタ）を伝播。不一致は planning error。
6. **他の非再帰 CTE との共存**: `WITH RECURSIVE r AS(...), other AS(...)` を許すか。推奨＝**非再帰 sibling は許可・再帰 CTE は1個・参照1回**（複数/相互再帰は Phase2）。
7. **外側クエリでの集約**: 再帰結果は temp 相当に実体化されるので、外側 `SELECT ... GROUP BY 子品目 SUM(累計員数)`（BOM 所要量ロールアップ）が既存集計経路でそのまま効くことを受入条件に含める。
8. **戦略 B の境界**: 参照アプリが `maxRecords` 内であること（超過は fail-closed・部分母集合で反復しない）。複数アプリ参照時は各アプリ個別に判定。大規模向け戦略 C は Phase2 オプションと明記。
9. **境界の既定値と設定**: 最大深さ・最大総行・最大中間展開の既定と設定経路（env/profile/CLI/MCP/plugin）。fail-closed は B1/B30（truncate 禁止・error 固定）と整合。
10. **$id/RECORD_NUMBER** の再帰結果での扱い。
11. **予約語**: `RECURSIVE`/`CYCLE`/`SET`/`TO`/`DEFAULT` は可能な限りソフトキーワード化（同名フィールドはバッククォート退避）。AST は再帰項が CTE 自身を参照する形＋seed/再帰項の分離を定義する。

## 受入条件に必ず入れる例

- BOM 多段展開（`親品目→子品目` を fixpoint まで・深さ列・累計員数の経路持ち回り・外側 GROUP BY 所要量ロールアップ）。
- 組織図の親↔子展開。
- 循環データで CYCLE mark 付与＋path スコープ判定＋打ち切り。
- **DAG 再利用の爆発**が絶対上限で fail-closed（CYCLE では止まらないことの回帰）。
- 境界超過（深さ/行/maxRecords）が全て error（truncate しない）。
- 既存の非再帰 CTE（B51/B52）非回帰。

## 制約

- git 操作は Claude 側。仕様は実装せず文書のみ。
- 実件数は事前に読めない前提を維持（EXPLAIN は見積りと境界を示す）。
- 公開構文の意味論は発明せず SQL:1999/2016 と主要 RDB（PostgreSQL/Oracle/SQL Server）を基準にする。
