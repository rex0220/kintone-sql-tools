# B181 SELECT 別名の小文字正規化と参照解決の非対称 — `AS 顧客No` を次の段から `顧客No` で参照すると実行時にだけ失敗する

- 状態: 📝 **起票（2026-09-16）**。未着手。実測 v3.77.0（MCP・dev profile・SFA パック）。方針未決（案 A: 参照側を正規化して解決／案 B: validate・EXPLAIN で検出）

## 1. 現象

SELECT の列別名に英字が含まれると、結果列名は小文字へ正規化される（言語リファレンス §1「大文字・小文字」・`src/parser/parser.ts:5070` の `alias: tok.value.toLowerCase()`）。ところが、その別名を**元の大文字のまま参照**すると、正規化後の名前と一致せず解決できない。参照する側（CTE の次の段・一時テーブル・同じ文の `ORDER BY`）は正規化されない。

| # | SQL | `ksql_validate` | `ksql_explain` | `ksql_query` |
| :-: | :--- | :--- | :--- | :--- |
| 1 | `WITH t AS (SELECT 売上 AS Amount FROM APP4149) SELECT Amount FROM t ORDER BY Amount DESC LIMIT 1` | ok | **ok**（SELECT 列は検査しない） | `ArgumentError: unknown field code(s): Amount (t)` |
| 2 | 同上の参照を `amount` に | ok | ok | 成功（列名 `amount`） |
| 3 | `CREATE TEMP TABLE #t AS SELECT 売上 AS Amount FROM APP4149; SELECT Amount FROM #t …` | ok | ok | `unknown field code(s): Amount (#t)` |
| 4 | `SELECT 売上 AS Amount FROM APP4149 ORDER BY Amount DESC LIMIT 1` | ok | **`ORDER BY key has no canonical comparison contract (reason=ORDER_KEY_UNRESOLVED)`** | 同左 |
| 5 | 同上の `ORDER BY amount` | ok | ok | 成功 |
| 6 | #1 の参照をバッククォートで囲んだもの（SELECT と ORDER BY の Amount を `` `Amount` `` に） | ok | ok | `unknown field code(s): Amount (t)`（バッククォートでも同じ） |
| 7 | `WITH t AS (SELECT c.顧客No AS 顧客No, c.会社名 FROM APP4148 AS c) SELECT 顧客No FROM t …` | ok | ok | `unknown field code(s): 顧客No (t)` |
| 8 | 同上を別名なし `c.顧客No` に | ok | ok | 成功（列名 `顧客No` のまま） |
| 9 | 同上の参照を `顧客no` に | ok | ok | 成功（列名 `顧客no`） |

- #7〜#9 が重要。**物理フィールド `顧客No` を「同じ名前」で別名にすると、列名が `顧客no` に変わる**。書いた本人は名前を変えたつもりが無いので、次の段の `顧客No` が失敗する理由に気づけない
- `会社名 AS 会社名` のように英字を含まない別名は影響を受けない（`ABC区分` は `abc区分` になる）
- 静的検査で捕まるのは #4（同じ文の `ORDER BY`）だけで、CTE・一時テーブル越しの参照（#1・#3・#7）は `EXPLAIN` も通り、実行で初めて失敗する

## 2. なぜ問題か

- 言語リファレンス §1 は「結果列名で小文字へ正規化される」と**出力側**だけを書いており、「参照するときも小文字で書く必要がある」は書かれていない。`ORDER BY` は「エイリアスを優先」と書いてあるが、大文字小文字の扱いは触れていない（§8 付近「名前の解決順」）
- AI が書く SQL は `AS 顧客No` / `AS ABC区分` / `AS Amount` のように英字を含む別名を自然に使う。Qiita「kSQL 実践 #3」の依頼文に対する Claude Desktop の回答は `ksql_validate` を通ったうえで実行時に 2 か所（`顧客No`・`ABC区分`）で失敗した。Claude は別名を変えて自力で通したが、原因の説明は「RECORD_NUMBER と同名の別名」「CASE 式の別名か英字と漢字の混在」で、**2 つとも外れ**だった。正本に書いていないので、AI も人間も正しい理由に辿り着けない
- 第 9 回で整理した「三層」のうち、この誤りは `validate` と `explain` を通り抜ける。SELECT 列の存在検査を EXPLAIN が持たない（§9.14 の既知）ことと重なる

## 3. 対応案

**案 A（エンジン・純加法）**: 別名・CTE 列・一時テーブル列に対する**参照側の識別子も同じ規則で正規化**してから照合する。物理フィールドは kintone の定義どおり区別ありのまま（`顧客No` は `顧客No`）。#8 の「別名なしなら `顧客No` で通る」と #9 の「別名ありなら `顧客no`」が、どちらの書き方でも通るようになる。結果列名の正規化そのものは変えない（Dashboard の列設定など既存の依存を壊さない）

**案 B（診断・純加法）**: `ksql_validate` / `EXPLAIN` の静的検査で、「別名 `Amount` は `amount` として出力される。参照 `Amount` は解決できない」を警告またはエラーにする。同じ文の `ORDER BY`（#4）は既に EXPLAIN で落ちるので、CTE・一時テーブル越しの参照に広げる形

**案 C（文書のみ）**: §1「大文字・小文字」に「参照するときも正規化後の名前（小文字）で書く。物理フィールドと同名の別名を付けると列名が変わる」を追記し、§8「名前の解決順」に相互参照を置く

推奨は **A + C**。B は A を入れれば不要になる（照合が通るため）。A を入れない場合は B + C。

### 3.1 追記（codex 調査・2026-09-16・[報告](ksql_b181_b184_codex_plan_report.md) §2）

- 参照側の完全一致箇所: 実体化列の存在判定 `b86FieldExists`（`execute.ts:4804-4807`・CTE は `validCodes.has(field)`）、CTE・一時表の列集合 `new Set(materialized.columns)`（`execute.ts:4886-4896`）、`unknown field code(s)` 診断（`4934-4953`）、同一 SELECT の ORDER BY alias `evaluators.get(name)`（`process.ts:1235-1245`・`1313-1315`）、canonical ORDER 計画の `semantics.get(item.key.name)`（`canonicalOrderPlanner.ts:50-58`）
- **案 A の具体化**（codex 第一案・M）: 結果列名は変えず、参照解決だけを共通 helper `resolveProjectedName(requested, available)` に寄せる。解決順は「完全一致 → `requested.toLowerCase()` と実体化列・SELECT alias の正規名の一致 → 不一致」。適用は**同一 SELECT の出力 alias・CTE / 一時テーブル / SHOW・DESCRIBE の実体化列・UNION 左枝の結果列だけ**。物理 APP のフィールドコード・DML 対象列・JOIN 先の物理フィールドには適用しない（`resolveFieldRef()` 自体を大文字小文字非依存にすると物理フィールドまで緩むので避ける）。AST を実行直前に実体化スキーマへ束縛して参照名を実在の小文字列名へ置換する方式
- 対象: `execute.ts`（`validateB86SelectFieldCodes`・materialized `columnMeta` resolver 群・GROUP BY / JOIN / required-field の実体化列解決）、`process.ts`（`buildOrderByAliasEvaluator`・ORDER BY 意味型 map）、`canonicalOrderPlanner.ts`、新規 `src/core/projectedNameResolution.ts`、`selectToKintone.ts`（CTE 参照を物理取得列として扱わない回帰確認）
- 波及: SELECT 以外に CTE をソースにした INSERT / UPSERT・`UPDATE … FROM`・サブクエリ・UNION の参照解決にも同じ helper を通す
- 大文字小文字だけ違う複数 alias は現状すでに同一出力名へ畳まれる（後勝ち）。新 helper でも曖昧判定を足さず既存契約を維持
- 案 A を採れば案 B（診断）は不要

## 4. 受入条件

- #1・#3・#7 が成功し、#2・#5・#9 の結果と同じ列名・同じ行を返す（案 A）。または #1・#3・#7 が `ksql_validate` か `EXPLAIN` で診断される（案 B）
- #8（別名なしの物理フィールド参照）の挙動と結果列名 `顧客No` が変わらない
- 結果列名の小文字正規化（§1 の既存契約・Dashboard の列設定）が変わらない
- 言語リファレンス §1 と §8 の追記（案 C）
- 助言をそのまま実行するテストを 1 本（「参照は小文字で」の文書例が実際に通ること）

## 5. 経緯

- 2026-09-16: Qiita「kSQL 実践 #3」の「Claude に頼むなら」の依頼文に対する Claude Desktop の回答を実機検証して発見（計画書 §9.8 の第 3 回 R8 メモ）。切り分けは #1〜#9。記事側は第 3 回に「Claude が書いた SQL を検証する」、第 9 回の誤り表と落とし穴に反映済み
- 関連: §9.14「EXPLAIN が SELECT 列の存在を検査しない」（別課題候補・未起票）。本件は列が「無い」のではなく「名前が変わっている」ケースで、検出経路は同じ
