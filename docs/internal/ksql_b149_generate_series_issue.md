# B149 `generate_series()`（数値・日付系列の生成関数）

- 起票: 2026-08-07
- ステータス: ✅ **v3.59.0 でリリース・publish 済み・実機確認済み（2026-08-07）**。
  MCP 実機確認＝版名乗り 3.59.0・0 埋め（実データで 0 が並ぶ）・警告抑止（LAG / 既定 RANGE とも `warnings` 空）・
  **JOIN 後は警告維持（実データの重複キー n=646 で発火）**・validate の静的拒否と変数保留・
  変数解決後の上限 10001 拒否・`TODAY()` 終端・EXPLAIN（`records API: none`）・
  保存クエリ round-trip（変数注入・書込承認なし・確認後削除済み）。
  **未実施＝プラグインのブラウザ smoke のみ**（Firefox / Chrome。zip は同梱 desktop.js 再生成済み）
- 検証: 全体テスト成功を Claude が実測（`npm test` exit 0・受入 50 件）。[最終チェック報告](ksql_b149_codex_final_check_report.md)＝警告抑止の fail-open なし・上限回避経路なし・境界ずれなし。[実装・修正報告](ksql_b149_codex_impl_report.md)
- 仕様: [R2 正本](ksql_b149_generate_series_spec_r2.md)（codex 作・R1 は破棄）／
  [R1 レビュー](ksql_b149_codex_review_1.md)（指摘 6 件・実測付き）／[R2 検証](ksql_b149_codex_review_2.md)（全反映確認・警告文の実測照合一致）
- R1-2 の決定: **案 a**＝生成系列列を直接読むウィンドウは全順序警告を抑止（オーナー判断 2026-08-07）。JOIN 等で証明できない形は警告維持
- 方向確定: **整数＋日付（DATE）・文 CTE 形・PG 準拠境界**（オーナー判断 2026-08-07）
- 出典: オーナー起票（PostgreSQL 仕様の参照資料付き・2026-08-07）
- 関連: [B134](ksql_b134_series_generation_issue.md)（需要側の台帳＝「取引の無い日を 0 として並べる」。
  方向確定＝案 A・着手は実需待ち）／[B53](ksql_b53_recursive_cte_cycle_phase1_spec.md)（再帰 CTE。
  入れば標準 SQL の書き方で日付系列を代替できる可能性——B134 と同じ関係）

---

## 1. 何を入れるか（提案の形）

PostgreSQL 系の `generate_series(start, stop [, step])`。
指定した範囲の連続する値（数値・日付/時刻）を**テーブル形式で生成する集合返却関数（SRF）**。

### 参照仕様（PostgreSQL・起票時に添付された資料の要点）

| 項目 | 挙動 |
|---|---|
| 引数 | `start`（必須）/ `stop`（必須）/ `step`（任意・既定 1。日付系は `INTERVAL`） |
| 整数 | `generate_series(1, 5)` → 1,2,3,4,5。負ステップ可（`(10, 2, -2)` → 10,8,6,4,2） |
| 小数 | `generate_series(0.1, 0.5, 0.1)` → 0.1〜0.5 |
| 日付 | `generate_series('2026-01-01'::timestamp, '2026-01-03'::timestamp, '1 day'::interval)` |
| 境界 | 生成値が `stop` を**超えない**範囲まで（`(1, 6, 2)` → 1,3,5。6 は含まない） |
| 0 行 | `start > stop` で step 正／`start < stop` で step 負は**エラーにならず 0 行** |
| step = 0 | PostgreSQL はエラー |
| 位置 | SRF として `FROM` 句にテーブルのように置く |

### 他 RDBMS

| RDBMS | 対応 | 特徴 |
|---|---|---|
| PostgreSQL / CockroachDB | 標準対応 | 数値・日付・時刻・小数・負ステップに完全対応 |
| SQL Server 2022〜 | あり | **数値型のみ**（日付は `DATEADD` と組み合わせ） |
| MySQL / Oracle | 未対応 | 再帰 CTE / `CONNECT BY LEVEL` で代替 |

---

## 2. B134 との関係（重複ではなく具体化）

**B134 が需要（0 埋め日次系列が作れない・「動きが止まった製品」が表から消える）、
本件はその具体の関数形。** B134 の案 A（`CALENDAR(from, to)`）／案 B（`SERIES(1, n)`）に対し、
**PG 互換名 `generate_series` を採る案**が加わった。

**名前は「最初に書かれる形」で選ぶべき**（B124 で確立した物差し＝実需は「計算できるか」ではなく「最初に書かれる形が通るか」で測る）。
標準 SQL に慣れた人と AI エージェントが最初に書くのは `generate_series` であり、
独自名（`CALENDAR` / `SERIES`）は**覚えた人しか書けない**。
B134 の着手条件にも「`SERIES` や `CALENDAR` を最初に書いた形が観測された」が挙がっている。

---

## 3. kSQL に載せるときの設計論点（仕様 R1 の前に方向を決める）

1. **`FROM` に関数を置く構文が無い。** kSQL の `FROM` は `APPn` / `APPn$tbl` / `#temp` のみで、
   derived table 非対応。**前例は `WITH d AS (DESCRIBE APP100)`**——`SHOW APPS` / `DESCRIBE` は
   `WITH` の中で文として使える。同じ形 `WITH s AS (GENERATE_SERIES(...)) SELECT ... FROM s` が
   最小の追加か、`FROM` 直置きも許すか。
2. **`INTERVAL` 型が無い。** 日付 step の表現をどうするか
   （`'1 day'` 文字列を解釈する／単位を引数で渡す／日付特化の別関数にする）。
3. **小数 step の浮動小数点誤差。** PG は `numeric` なら正確だが kSQL の算術は JS number。
   0.1 刻みの累積で `0.30000000000000004` を出す。10 進で扱うか、小数 step を対象外にするか。
4. **NULL が無い。** 引数が空文字・非数値のときの挙動
   （`NaN` にせず `ArgumentError` に寄せる——B124 の `@変数` と同じ整理が候補）。
5. **行数上限のガード。** 無から行を作るため引数次第で爆発する。`step = 0` はエラー（PG 準拠）。
   `tempTableMaxRows` 等の既存上限との関係を決める。
6. **生成列の列名。** PG は関数名がそのまま列名。kSQL では既定名を何にするか・`AS` を必須にするか。
7. **対応型の範囲（段階案）。** 整数のみでは最初の実需（日付 0 埋め）を満たせない——**日付が本丸**。
   SQL Server は「数値のみ + `DATEADD`」の構成だが、kSQL で同じ構成にすると
   0 埋めレシピが 2 段になる。タイムゾーン（`DATETIME` 系列）も日付側の論点。
8. **`LEFT JOIN` の起点として使えること。** 本件の価値は系列の生成そのものではなく
   **系列を左辺に置いた `LEFT JOIN` で 0 埋めできること**。CTE 実体化後の
   CTE 間 JOIN（B51/B52 で修正済みの経路）に乗る想定でよいかを仕様で明示する。

---

## 4. 次の一手

1. **実需の確認**（B134 の着手条件と同じ物差し。本起票がその観測に当たるかを含めて）
2. **方向判断**＝汎用 `generate_series`（数値+日付）か日付特化か。B53（再帰 CTE）との関係整理は
   B134 で決着済み（**B53 を待たない**）
3. 方向確定後、**仕様 R1 は codex**（2026-08-07 の分担）。Claude はレビュー・実測・リリース
