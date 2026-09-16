# B190 CTE／一時テーブルを source にした非集計 SELECT で、CASE 条件の左辺にウィンドウ関数を書くと `unknown field code(s): __ksql_window_0` で落ちる

- 状態: ✅ **v3.83.0 でリリース（2026-09-16）**。Claude が直接修正・テスト追加（codex 未介在・1 行修正のため）。`src/converter/selectToKintone.ts` の `walkFieldValue` に `hiddenWindowRef` の除外 1 行（walkArith / walkScalar と同じ扱い）。テスト 2 本を `b184bWindowInExpression.test.ts` に追加（CTE source・一時テーブル source）。起票時の実測 v3.82.0（MCP・dev profile・SFA パック APP4148/4149）。バグ（B184-B の取りこぼし・結果は落ちるだけで静かに間違わない・規模 S）

## 1. 現象

B184-B（v3.81.0）で「ウィンドウ関数の結果を同じ SELECT の式の中で使える」ようになったが、**source が CTE か一時テーブル**（実体化テーブル）で、**CASE の WHEN 条件の左辺**にウィンドウ関数を置いた形だけが落ちる。

| 形 | source | 結果 |
| :--- | :--- | :--- |
| `ROUND(売上合計 * 100.0 / SUM(売上合計) OVER (), 1)`（算術の中） | CTE / 一時テーブル | 通る |
| `CASE WHEN 売上合計 = 0 THEN 0 ELSE ROUND(... / SUM(売上合計) OVER (), 1) END`（THEN / ELSE の中） | CTE / 一時テーブル | 通る |
| `CASE WHEN SUM(売上合計) OVER () = 0 THEN ...`（**WHEN 条件の左辺**） | CTE | **`ArgumentError: unknown field code(s): __ksql_window_0 (base)`** |
| 同上 | 一時テーブル | **`unknown field code(s): __ksql_window_0 (#base)`** |
| 同上 | 物理アプリ（`FROM APP4149`） | 通る |
| 同上 | 集計 SELECT（`GROUP BY` と同じ SELECT・B184-A） | 通る |

第 3 回の「標準 SQL ならこう書く」（`base` CTE で集計 → 次の SELECT でウィンドウを式の中で使う）をそのまま kSQL に書いた形が該当する。集計とウィンドウを 1 つの SELECT にまとめた形（`RANK() OVER (ORDER BY SUM(b.売上) DESC)` …）は通り、3 段版と同じ 10 行を返す（実測）。

## 2. 原因

`collectRequiredFieldsByTable`（`src/converter/selectToKintone.ts`）は SELECT 列・WHERE・CASE 条件を歩いて「取得列」と「B86 の存在検査対象」を集める。隠しウィンドウ参照（`hiddenWindowRef: true`・内部名 `__ksql_window_n`）は `walkArith`（FIELD_REF）と `walkScalar`（FIELD）では除外していたが、**CASE 条件の左辺 `FieldValue`（`walkFieldValue` の `type: "FIELD"`）だけ除外が無かった**。parser は条件の左辺にウィンドウ関数があると `{ type: "FIELD", field: "__ksql_window_0", hiddenWindowRef: true }` を返す（`parser.ts` `parseFieldValue`）。

- 実体化テーブル（CTE / 一時テーブル）は `validateB86SelectFieldCodes` で列集合が **authoritative** なので、`__ksql_window_0` が未知列として fail-closed に止まる
- 物理アプリは同じ名前が kintone の `fields` パラメータに混ざるだけで、kintone が未知のフィールドコードを無視するため通っていた（取得列の汚れ＝副作用）
- 集計 SELECT は B184-A の経路で CASE 条件の集計依存が先に実体化されるため通っていた

B184-B のテスト（`b184bWindowInExpression.test.ts`）は CASE 条件の隠し窓を**物理アプリと集計 SELECT でしか**確かめていなかった。

## 3. 対応

`walkFieldValue` の `FIELD` 分岐の先頭に `if (fv.hiddenWindowRef) return;` を追加（純加法・取得列と EXPLAIN は不変。物理アプリ経路では `fields` に `__ksql_window_n` が混ざらなくなる）。

テスト 2 本（`b184bWindowInExpression.test.ts`）:

- CTE source の非集計 SELECT で `CASE WHEN SUM(売上合計) OVER () = 0 …` と `CASE WHEN RANK() OVER (…) <= 2 …` が通り、2 段版（ウィンドウを列に出す → 次段で CASE）と同じ行を返す。`fields` に `__ksql_window_` が出ない
- 一時テーブル source（`executeBatch`）で同じ形が通る

## 4. 受入条件

- §1 の表の CTE / 一時テーブル行が通り、物理アプリ・集計 SELECT と同じ値になる
- 既存の B184-A / B184-B / B86 / B185 テストが不変
- 実機（dev profile）で第 3 回の「標準 SQL ならこう書く」を kSQL の名前に置き換えた形（`base` CTE + 式内ウィンドウ + CASE 条件）が 3 段版と同じ 10 行を返す

## 5. 経緯

- 2026-09-16: Qiita 第 3 回の公開済み記事に付ける v3.81.0 注記（「1 段版がそのまま通る」）の裏取りで、CTE 版を dev で実行して発見。B184 のリリース確認では集計 SELECT の 1 段版と物理アプリの CASE しか流していなかった（「直したら隣の経路も測る」の型）
- 関連: B184-B（隠しウィンドウ列）、B86（実体化テーブルの列存在検査）
