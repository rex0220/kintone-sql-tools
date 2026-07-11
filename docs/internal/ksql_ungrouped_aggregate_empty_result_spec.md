# 非グループ集計の 0 件時「1 行」返却 仕様案

- 作成日: 2026-07-11
- 更新履歴:
  - 2026-07-11 R2(codex レビュー反映・3件): ①(中)§4.1 の仮想グループ合成条件に**集計列の存在**を追加 — 旧条件では公開関数 `applyGroupBy` を非集計列のみで直接呼んだ場合も 1 行合成された(実経路 `runFullScan:806` は hasAggregate ゲート後のみ呼ぶため実害なしだが、関数単独の契約として脆弱)。判定述語は runFullScan `:801-805` と共有ヘルパに抽出し、§3.4 不変条件 7・§7.1 テストを追加 ②(中)§3.3 で CHANGELOG 個別告知とした高リスク挙動変更(EXISTS false→true / IN `{0}` / INSERT ... SELECT 1 行書き込み / LIMIT 0・OFFSET による合成行除去)の回帰テストを §7 に明記 ③(低)§3.1 の非集計 FIELD 混在の根拠を修正 — 標準 SQL では「未定義値」ではなく**クエリ自体が不正**(ksql が独自に許容している形)
  - 2026-07-11 R1: 初版(ドラフト)
- ステータス: **codex レビュー済み・R2 反映済み(指摘3件。反映を条件に「実装へ進める品質」判定)**
- 対象バージョン: v1.12.0(既定挙動の変更を含むため minor バンプ + CHANGELOG に挙動変更を明記)
- 現行バージョン: v1.11.0
- 関連仕様: `docs/ksql_batch_enhancement_phase1_spec.md` §2.2(ASSERT スカラーサブクエリ検証)、`docs/ksql_language_reference.md` §8(GROUP BY / 集計関数)・ASSERT 節
- 実装計画: [ksql_ungrouped_aggregate_empty_result_implementation_plan.md](ksql_ungrouped_aggregate_empty_result_implementation_plan.md)

## 1. 背景

### 1.1 現状の挙動(v1.11.0)

GROUP BY のない集計 SELECT(`SELECT COUNT(*) FROM APP100 WHERE ...`)は、WHERE の該当が 0 件のとき **「COUNT = 0 の 1 行」ではなく「0 行」** を返す。

原因は `applyGroupBy`(`src/engine/process.ts:182-234`)がグループ Map を入力行から構築するため、空入力では Map が空のまま空配列を返すこと。GROUP BY の有無を区別していないため、非グループ集計(全行を 1 グループとして集計するケース。`src/engine/process.ts:800-808`)でも 0 行になる。

これは SQL 標準からの逸脱である。標準(および SQLite / MySQL / PostgreSQL の実装)では、**GROUP BY のない集計クエリは入力が空でも常に正確に 1 行**を返す(COUNT は 0、SUM/AVG/MIN/MAX は NULL)。

集計を含む SELECT は常に FULL_SCAN モードに落ちる(`src/converter/selectToKintone.ts:65-70`)ため、集計の評価箇所は `runFullScan` → `applyGroupBy` の **1 箇所のみ**。SIMPLE モード(kintone プッシュダウン)に集計の別経路はない。

### 1.2 実害 — 健全性チェックの定番パターンが健全時にこそ落ちる

ASSERT のスカラーサブクエリは 0 行を実行時エラーにする(`src/execute.ts:735-737`、仕様: phase1 spec §2.2「0 行を NULL 扱いにしない」)。この設計自体は「空振りしたプローブを黙って通さない」ための意図的な厳格さだが、1.1 の非標準挙動と組み合わさると、健全性チェックの定番

```sql
ASSERT (SELECT COUNT(*) FROM APP100 WHERE 異常条件) = 0
```

が **異常 0 件の健全時にこそ** `AssertError: scalar subquery returned no rows (expected 1 row).` で落ちる。実運用(kSQL 検証シリーズ 010)で顕在化し、回避として「否定条件の件数 = 全件数」の一致比較パターンが必要になった。ただしこの回避は ①読み取り API が 2 倍 ②2 クエリ間のレコード変化でレースが起きる(健全でも偽陽性) ③否定条件が空値の扱いで元条件の補集合にならない罠がある、の3点で恒久策に適さない。

### 1.3 決定的な論拠 — 言語リファレンス自身が自己矛盾している

`docs/ksql_language_reference.md` の ASSERT 節は CLI ヘルスチェックの模範例として

```bash
ksql -e "ASSERT (SELECT COUNT(*) FROM APP1 WHERE 異常フラグ = '1') = 0"
```

を掲載している(§ASSERT 使用例)が、**この公式例は現行実装では健全時(該当 0 件)に必ず失敗する**。また典型例1(`BETWEEN 1 AND 500`)・典型例2(`COUNT(*) FROM #src`)も、0 件時に「assertion failed (actual: 0)」ではなく無関係な no-rows エラーになりメッセージが誤誘導する。ドキュメントが約束する使い方を実装が満たしていないため、これは「改善候補」ではなく**実質的な仕様バグ**として扱う。

### 1.4 影響を受けるスカラーサブクエリ消費箇所(全 4 箇所)

0 件集計サブクエリは以下すべてで現在エラーになっており、本修正で一括解消される。

| 箇所 | 実装 | 現行の 0 行時挙動 |
|---|---|---|
| ASSERT オペランド | `src/execute.ts:735-737` | `AssertError: scalar subquery returned no rows` |
| WHERE のスカラー比較 `f = (SELECT ...)` | `src/execute.ts:2832-2838` | `スカラーサブクエリが値を返しませんでした` |
| UPDATE SET のサブクエリ | `src/execute.ts:2874` | `SET サブクエリが値を返しませんでした` |
| SELECT 列のスカラーサブクエリ | `src/execute.ts:2903-2907` | `スカラーサブクエリが値を返しませんでした` |

## 2. 変更概要

### 2.1 やること

**GROUP BY のない集計 SELECT は、入力(WHERE 適用後)が 0 行でも常に 1 行を返す。**

- 変更箇所はエンジン層 `applyGroupBy` の 1 箇所(§4.1)
- ASSERT の「0 行は AssertError」検証は**変更しない**(§2.2)。修正後、集計クエリは 0 行を返さなくなるため衝突せず、非集計プローブ(`SELECT f FROM t WHERE id = ...` の空振り)への検出力は維持される

### 2.2 やらないこと(非スコープ)

| 項目 | 扱い | 理由 |
|---|---|---|
| GROUP BY **あり** + 空入力の挙動変更 | しない(0 行のまま) | SQL 標準どおり(グループが存在しないので 0 行が正しい) |
| SUM/AVG/MIN/MAX の空集合を NULL(空文字)にする | しない(0 を返す。§3.1) | 標準 SQL は NULL だが、ksql は既存規約として「行はあるが対象値がすべて空」のグループで 0 を返す(`src/engine/process.ts:283-287`)。空集合だけ NULL にすると ksql 内部で不整合になる。「対象なし」と「合計 0」の区別が必要な場合は COUNT の併用で足りる(ドキュメントに注記) |
| ASSERT の 0 行エラーの緩和(NULL 扱い等) | しない | 非集計プローブの空振り検出は ASSERT の検出力として維持する(phase1 spec §2.2 の設計意図を保持) |
| 集計引数への CASE WHEN 対応(`SUM(CASE WHEN ...)`) | しない | 別件の機能追加。本修正が入れば健全性チェック用途では不要になる(COUNT + WHERE で表現可) |
| SIMPLE モードの変更 | しない | 集計は常に FULL_SCAN(§1.1)。SIMPLE 経路に集計は存在しない |
| EXPLAIN の表示変更 | しない | バッチ EXPLAIN プランは静的生成で行数を表示しない。単文 EXPLAIN も件数見積りに関与しない |
| `withScalarProbeLimit` の変更 | しない | 集計クエリは従来どおり probe(LIMIT 2 打ち切り)対象外(`src/execute.ts:755-761`)。修正後も全行取得が必要な点は不変 |

## 3. 仕様詳細

### 3.1 0 件時の集計値の定義

WHERE(および JOIN)適用後の入力が 0 行で、GROUP BY がなく、SELECT 句に集計(`AGGREGATE` / `ARITH_AGG_COL` / 集計入り `STRFUNC_COL`)が 1 つ以上ある場合、次の値を持つ 1 行を返す。

| 列種別 | 0 件時の値 | 根拠 |
|---|---|---|
| `COUNT(*)` / `COUNT(f)` / `COUNT(DISTINCT f)` | `0` | SQL 標準と同じ |
| `SUM(f)` / `AVG(f)` / `MAX(f)` / `MIN(f)`(DISTINCT 含む) | `0` | ksql 既存規約(全値空グループの 0。§2.2)と統一。**標準 SQL の NULL とは異なる**ことをドキュメントに明記 |
| `ARITH_AGG_COL`(例 `SUM(a) - SUM(b)`) | 各 `AGG_REF` を上記の値として算術評価(`evalAggArithExpr`。0 除算は既存どおり NaN) | 既存の評価器をそのまま空配列に適用 |
| 集計入り `STRFUNC_COL` | `resolveAggInStringFuncExpr` に空配列を渡して解決後、通常評価 | 同上 |
| 非集計の `FIELD` | 空文字 | コピー元行が存在しないため空の仮想行から解決される。**標準 SQL では集計との混在(GROUP BY なし)はクエリ自体が不正**であり、ksql が独自に許容している形(R2) |
| `LITERAL_COL` / `ARITH_COL` / `CASE_COL` / 非集計 `STRFUNC_COL` | 空行(全フィールド空文字)に対する既存の評価値 | project の既存評価をそのまま適用 |
| `SCALAR_SUBQUERY_COL` | scalarCache の解決値(入力行数と無関係に事前解決済み) | 既存挙動のまま |

実装上の要点: `evalAggregate`(`src/engine/process.ts:247-289`)・`evalAggArithExpr`(同 `:304-317`)は**既に空配列入力で上記の値を返せる**(COUNT → `eff.length` = 0、SUM → `reduce(..., 0)` = 0、AVG/MAX/MIN → `nums.length === 0 ? 0` ガード)。また `project` の AGGREGATE 列には `?? "0"` フォールバック(同 `:607`)が既にあり、値の型(文字列 `"0"`)も既存出力と一致する。したがって新しい値決定ロジックは**一切追加しない** — 追加するのは「空の仮想グループを 1 つ作る」ことだけ(§4.1)。

### 3.2 パイプライン上の位置と後段への影響

合成は `applyGroupBy` 内(パイプライン第 4 段)で行い、後段(HAVING → DISTINCT → ORDER BY → LIMIT/OFFSET → project)は合成行を通常の 1 行として処理する。

- **HAVING**: 合成行にも適用される。例: `SELECT COUNT(*) FROM t HAVING COUNT(*) > 0` は 0 件時に 1 行合成 → HAVING で除外 → **0 行**。これは SQL 標準と同じ挙動であり、この場合にスカラーサブクエリ消費側(§1.4)がエラーになるのは正当(意図的に行を消しているため)
- **ORDER BY / LIMIT / OFFSET**: 1 行に対する自明な適用(`LIMIT 0` なら 0 行 — 既存どおり)
- **columns 導出**: `project` の `orderedKeys` は先頭行から構築されるため、従来 0 行時に `columns: []` だった集計クエリが正しい列名リストを返すようになる(サブクエリ・temp table 実体化の列導出も同時に正常化)

### 3.3 波及する挙動変更(すべて標準準拠化の方向)

| 経路 | v1.11.0 | v1.12.0 |
|---|---|---|
| `ASSERT (SELECT COUNT(*) ... WHERE 異常) = 0`(健全時) | `AssertError: ... no rows` で**失敗** | **成立**(actual: 0) |
| `ASSERT (SELECT COUNT(*) ...) BETWEEN 1 AND 500`(0 件時) | no-rows エラー(誤誘導) | `assertion failed ... (actual: 0)`(正しい診断) |
| WHERE `f = (SELECT COUNT(*) ...)` / SET / SELECT 列(0 件時) | 「値を返しませんでした」エラー | `0` として比較・設定・出力 |
| `f IN (SELECT COUNT(*) ...)`(0 件時) | 空集合(全行不一致) | `{0}` との照合 |
| `EXISTS (SELECT COUNT(*) ...)`(0 件時) | false | **true**(標準 SQL でも `EXISTS(SELECT COUNT(*)...)` は常に真。EXISTS に集計を書くこと自体が誤用だが、標準と同じ結果になる) |
| `CREATE TEMP TABLE #t AS SELECT COUNT(*) ...`(0 件時) | 0 行の #t(列も導出されない) | 1 行の #t(列名あり) |
| `INSERT INTO app (...) SELECT COUNT(*) ...`(0 件時) | 「SELECT の列数(0)...」エラー(v1.9.0 仕様書の既知挙動) | 1 行書き込まれる(dmlMaxRows / confirm の既存ガード対象) |
| 素の `SELECT COUNT(*) ...`(0 件時)の表示 | 0 行 | `COUNT(*) = 0` の 1 行 |

### 3.4 不変条件(レビュー時のチェックリスト)

1. 入力が 1 行以上ある集計クエリの結果は v1.11.0 と完全一致(合成パスは `rows.length === 0` のみで発動)
2. GROUP BY ありの空入力は従来どおり 0 行
3. 非集計 SELECT(集計列なし)は `applyGroupBy` を通らず、空入力 → 0 行のまま
4. ASSERT の 1 行 1 列検証(0 行・複数行・複数列エラー)は非集計プローブに対して不変(既存テスト `src/__tests__/executeAssert.test.ts:126-142` がそのまま green であること — 同テストの 0 行ケースは非集計 `SELECT 売上 FROM APP300` を使っており修正後も有効)
5. `withScalarProbeLimit` の probe 判定・LIMIT 2 打ち切りは不変
6. DML ガード(dmlMaxRows / dmlTotalMaxRows / confirm)は本修正と独立に機能する(INSERT ... SELECT 集計が 1 行書くようになっても件数判定の仕組みは不変)
7. **公開関数 `applyGroupBy` 単独の契約**(R2): 空入力 + GROUP BY なし + **集計列なし**の直接呼び出しでは合成せず 0 行を返す(合成条件に集計列の存在を含める — §4.1)

## 4. 変更点一覧

### 4.1 src/engine/process.ts(実装の本体 — これのみ)

まず、`runFullScan` の集計列判定(`:801-805`)を共有ヘルパに抽出する:

```ts
/** SELECT 句に集計（AGGREGATE / ARITH_AGG_COL / 集計入り STRFUNC_COL）が含まれるか */
export function hasAggregateColumns(columns: SelectColumn[]): boolean {
  return columns.some((c) =>
    c.type === "AGGREGATE" ||
    c.type === "ARITH_AGG_COL" ||
    (c.type === "STRFUNC_COL" && hasAggregateInStringFuncExpr(c.expr))
  );
}
```

`runFullScan:801-805` はこのヘルパの呼び出しに置き換え(挙動不変)、`applyGroupBy` のグループ Map 構築後に、**非グループ集計**の空入力に限り空の仮想グループを 1 つ挿入する:

```ts
// GROUP BY なし集計は入力 0 行でも 1 行返す（SQL 標準準拠。COUNT=0、SUM/AVG/MIN/MAX は
// 全値空グループと同じ 0 — 空集合だけ NULL にすると ksql 内の既存規約と不整合になる）。
// 集計列の存在を条件に含めるのは applyGroupBy 単独の契約のため（runFullScan 経由では
// hasAggregate ゲート後のみ呼ばれ常に真だが、非集計列のみの直接呼び出しで合成しない — R2）
if (groups.size === 0 && groupByKeys.length === 0 && hasAggregateColumns(columns)) {
  groups.set("", []);
}
```

以降は既存ループがそのまま処理する:

- `const outRow = { ...groupRows[0] }` — `groupRows[0]` は undefined だが、undefined のスプレッドは `{}` になる(JS 仕様)。**暗黙に依存せずコメントで明示する**
- 式キー上書きループ(`:202-208`)は `groupByKeys` が空のため実行されない
- 集計評価(`:210-229`)は §3.1 のとおり空配列対応済み

判定を `groups.size === 0` とするのは、`rows.length === 0` と等価だが「グループが 1 つもできなかった」という意図に近いため(rows が非空なら groups は必ず非空)。

### 4.2 変更しないもの

- `src/execute.ts` — ASSERT 検証・スカラーサブクエリ消費 4 箇所(§1.4)はすべて無変更。集計クエリが 1 行を返すようになることで挙動だけが変わる
- `src/converter/` — モード判定・変換は無変更
- プラグイン / CLI / MCP の入出力層 — 無変更(エンジンの返す行がそのまま流れる)

## 5. モデル向けメタデータ(v1.4.1 の教訓: コードと同時に更新し smoke で固定)

- 実装時に `src/mcp/schemas.ts` / `src/mcp/index.ts` を `no rows` / `1 row` / `COUNT` / `aggregate` で grep し、0 件集計の旧挙動を前提にした記述がないか洗い出す(現時点の把握では ASSERT の describe は「1 行 1 列要求」の一般論のみで、集計 0 件の特記はない見込み — **grep での網羅確認を必須とする**)
- `ksql_query` / `ksql_mutate` の description に挙動変更の追記が必要かは grep 結果で判断する。追記する場合の文言案: 「Aggregate SELECT without GROUP BY always returns exactly one row (COUNT=0 on empty input), so `ASSERT (SELECT COUNT(*) ... WHERE anomaly) = 0` works as a health check.」
- describe を更新した場合は `scripts/mcp-smoke.mjs` の assertion に新フレーズを追加し、**旧バンドルで red になることを先に確認**する(regression ガード方式)

## 6. ドキュメント更新

| ファイル | 内容 |
|---|---|
| `docs/ksql_language_reference.md` §8(集計関数) | 「0 件時の挙動」小節を追加: GROUP BY なし集計は常に 1 行(COUNT → 0、SUM/AVG/MIN/MAX → 0。**標準 SQL の NULL と異なる**こと、「対象なし」と「合計 0」の区別には COUNT を併用することを明記)。GROUP BY ありは 0 行 |
| `docs/ksql_language_reference.md` ASSERT 節 | 「0 行を NULL 扱いにしません」の段落に「集計サブクエリ(GROUP BY なし)は 0 件でも 1 行を返すため、`= 0` 型の健全性チェックが成立する(v1.12.0)。0 行エラーは非集計プローブの空振り・HAVING で行が消えた場合に発生」と追記。§サブクエリ(スカラー 1 行 1 列)の記述も同様に更新 |
| `docs/ksql_batch_enhancement_phase1_spec.md` | §2.2 エラー表に注記 + 更新履歴 R 追記: 0 行エラーは v1.12.0 以降、非集計プローブ等に限られる |
| `docs/ksql_batch_temp_table_spec.md` | §(ASSERT エラー表)同上の注記 + R 追記。0 件集計ソースの temp table が 1 行実体化になる点(§3.3)も追記 |
| `docs/ksql_mcp_changes.md` | v1.12.0 エントリ追加(MCP 経由で観測可能な挙動変更のため) |
| `CHANGELOG.md` | v1.12.0 追加。**Changed(挙動変更)** として §3.3 の表の要点を列挙(特に INSERT ... SELECT 集計・EXISTS の変化) |

## 7. テスト計画

### 7.1 src/engine/__tests__/process.test.ts(単体)

1. `applyGroupBy`: 空入力 + GROUP BY なし — `COUNT(*)` → `"0"` の 1 行
2. 同 — `COUNT(f)` / `COUNT(DISTINCT f)` / `SUM` / `AVG` / `MAX` / `MIN` → すべて `"0"`
3. 同 — `ARITH_AGG_COL`(`SUM(a) - SUM(b)` → `"0"`、`SUM(a) / COUNT(*)` → 0 除算で既存の NaN 挙動)
4. 同 — 集計入り `STRFUNC_COL`、集計 + 非集計 FIELD の混在(FIELD は空文字)
5. `applyGroupBy`: 空入力 + GROUP BY **あり** → 0 行(不変条件 2)
6. `applyGroupBy`: 空入力 + GROUP BY なし + **非集計列のみ**の直接呼び出し → 0 行(不変条件 7・R2)
7. `runFullScan` 統合: `WHERE` 全滅 + `COUNT(*)` → 1 行、columns に列名が入る(§3.2)
8. `runFullScan`: `HAVING COUNT(*) > 0` + 空入力 → 0 行(§3.2)
9. `runFullScan`: 合成行への `LIMIT 0` → 0 行、`OFFSET 1` → 0 行(§3.2 の後段適用・R2)
10. 既存テスト全件 green(入力 1 行以上の回帰なし — 不変条件 1)

### 7.2 src/__tests__(execute 層)

1. `executeAssert.test.ts`: `ASSERT (SELECT COUNT(*) FROM APP300 WHERE ...) = 0` が**空アプリで成立**する(本件の発端パターン)
2. 同: 非集計 0 行プローブの AssertError が不変(既存 `:126-130` の維持で足りる)
3. WHERE スカラーサブクエリ: `WHERE f = (SELECT COUNT(*) FROM 空)` が `0` と比較される
4. SELECT 列スカラーサブクエリ / UPDATE SET サブクエリ: 0 件集計が `0` に解決される
5. `CREATE TEMP TABLE #t AS SELECT COUNT(*) FROM 空` → 1 行実体化、後続 `SELECT * FROM #t` で参照可
6. バッチ: 言語リファレンスの CLI 例と同形(`ASSERT (SELECT COUNT(*) ... WHERE 異常フラグ='1') = 0` → 成立 → 後続文が実行される)
7. **挙動反転の固定**(§3.3 で CHANGELOG 個別告知とした変更 — R2):
   - `WHERE EXISTS (SELECT COUNT(*) FROM 空)` → 全行が **true** 側(v1.11.0 の false から反転)
   - `WHERE f IN (SELECT COUNT(*) FROM 空)` → `f = "0"` の行が一致(空集合 → `{0}`)
   - `INSERT INTO app (...) SELECT COUNT(*) FROM 空` → **1 行書き込まれ**、confirm / dmlMaxRows の件数判定に 1 行として乗る(v1.11.0 の「SELECT の列数(0)」エラーから変化)

### 7.3 回帰確認

- jest 全件(現行 731 件基準)+ tsc 10 件基準 + `npm run build` + mcp:verify / mcpb:verify
- e2e(console / dml_guard)は既知の並列コールドランフレークに注意(再実行で安定)

## 8. 受け入れ条件

1. `ASSERT (SELECT COUNT(*) FROM APPn WHERE 異常条件) = 0` が該当 0 件で成立し、1 件以上で `assertion failed ... (actual: n)` になる
2. `docs/ksql_language_reference.md` ASSERT 節の CLI ヘルスチェック例・典型例 1・典型例 2 が、0 件/1 件以上のどちらでも記載どおりの結果・エラーメッセージになる(ドキュメントと実装の自己矛盾解消)
3. GROUP BY ありの空入力・非集計 SELECT の空入力は 0 行のまま(不変条件 2・3)
4. 入力 1 行以上のすべての既存テストが無変更で green(不変条件 1)
5. §3.3 の表の全経路が新挙動どおり動作する(特に temp table 実体化と INSERT ... SELECT)
6. CHANGELOG / 言語リファレンス / phase1 spec / batch_temp_table_spec が §6 のとおり更新されている

## 9. 互換性・リスク

- **後方互換**: 「0 件集計が 0 行を返すこと」に依存した既存利用は理論上あり得るが、主要パターンでは影響が軽微:
  - `ASSERT (SELECT COUNT(*)...) > 0` を「存在ゲート」に使っていた場合 — 0 件時のエラーが no-rows から `assertion failed (actual: 0)` に変わるだけで、**バッチが停止する事実・skippedReason は不変**。むしろ診断メッセージが正しくなる
  - 0 件集計の空表示に依存した UI/スクリプト — 1 行(値 0)の表示に変わる。SQL として標準の結果であり、CHANGELOG の Changed で告知する
  - `EXISTS (SELECT COUNT(*)...)` — false → true に変わる(§3.3)。標準準拠化だが挙動反転のため CHANGELOG で個別に言及する
- **リスク最小化**: 変更は `applyGroupBy` の合成条件 3 行 + 集計列判定の共有ヘルパ化(`runFullScan:801-805` の既存述語を抽出・挙動不変。R2)のみで、値決定ロジックは既存評価器を無変更で再利用する。発動条件が「空入力 かつ GROUP BY なし かつ 集計列あり」に閉じているため、非空入力・GROUP BY あり・非集計クエリへの影響経路がない
