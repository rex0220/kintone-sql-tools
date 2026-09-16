# B184-B 実装報告（codex・2026-09-16）

- 依頼: [ksql_b184b_codex_impl_request.md](ksql_b184b_codex_impl_request.md)（式内ウィンドウ・隠しウィンドウ列）
- 起票: [ksql_b184_window_in_same_select_issue.md](ksql_b184_window_in_same_select_issue.md)
- 作業ブランチ: `b184/dev`（B184-A コミット 32bcebc の上）
- 末尾に Claude のレビュー節（実機確認）を追記

---

## 変更ファイル一覧

- `src/types/ast.ts:255`
- `src/parser/parser.ts:1290`
- `src/engine/process.ts:1387`
- `src/converter/selectToKintone.ts:82`
- `src/core/dmlGuard.ts:181`
- `src/core/aggregateDependencyValidation.ts:236`
- `src/core/explainMetadata.ts:64`
- `src/core/optimization/canonicalOrderPlanner.ts:72`
- `src/execute.ts:3653`
- `src/parser/__tests__/window.test.ts:133`
- `src/engine/__tests__/b184bWindowInExpression.test.ts:51`
- `src/core/__tests__/b65GroupByConsumerAllowlist.test.ts:28`
- `docs/ksql_language_reference.md:2108`
- `docs/ksql_batch_recipes.md:591`

## 修正箇所 ↔ 根拠行

| 修正箇所 | 根拠 |
|---|---|
| `SelectStatement.hiddenWindows` と内部参照マーカーを追加 | `src/types/ast.ts:255`、`src/types/ast.ts:610`、`src/types/ast.ts:1126` |
| SELECT式内windowを `__ksql_window_n` へ切り出し、構文的同一式を統合 | `src/parser/parser.ts:1290`、`src/parser/parser.ts:1972`、`src/parser/parser.ts:1986` |
| SELECT外window・window内windowを従来のB129文言で拒否 | `src/parser/parser.ts:1986`、`src/parser/parser.ts:3948` |
| 公開windowと隠しwindowを同じ段で評価し、隠し値は `byLookupKey` のみに保存 | `src/engine/process.ts:143`、`src/engine/process.ts:1387` |
| B184-Aの集計依存実体化を隠しwindowへ接続 | `src/engine/process.ts:513`、`src/engine/process.ts:616`、`src/engine/process.ts:765` |
| window適用後に最終式を評価し、集計段で先行評価しない | `src/engine/process.ts:644`、`src/engine/process.ts:737`、`src/engine/process.ts:1598` |
| B182 helperへ隠しwindowの意味型を渡す | `src/engine/process.ts:2292`、`src/engine/process.ts:2347`、`src/engine/process.ts:2358` |
| 取得フィールドから内部IDを除外し、隠しwindowの物理参照を収集 | `src/converter/selectToKintone.ts:82`、`src/converter/selectToKintone.ts:558`、`src/converter/selectToKintone.ts:755` |
| 完全入力理由に隠しwindowを含める | `src/core/dmlGuard.ts:181` |
| GROUP BY依存検査では内部参照を物理列として扱わず、隠しwindow本体は検査 | `src/core/aggregateDependencyValidation.ts:236`、`src/core/aggregateDependencyValidation.ts:288` |
| EXPLAIN・canonical order・column metaへ隠しwindowを接続 | `src/core/explainMetadata.ts:64`、`src/core/optimization/canonicalOrderPlanner.ts:72`、`src/execute.ts:8444` |
| Dashboard向けcolumn metaで `COALESCE(LAG(...), 0)` 等の型を解決 | `src/execute.ts:5989`、`src/execute.ts:6064` |

## 追加・変更したテストと結果

追加・変更:

- `B184-B: 構成比・累積構成比・ABC の1段版を実行する`
  - 1段版と3段CTE版の行、値、列順、`columns`、`warnings` を比較
  - `9 / 10`、`99 / 100`、`9,050,000 / 20,700,000`、同額2社を収録
- `LAG` の算術、`CASE`、`COALESCE`、文字列連結、複数隠しwindow
- 非集計SELECTの `売上 - LAG(売上)`
- 隠し列の `columns`、行キー、DISTINCT、CSV、column meta非露出
- `WINDOW_ORDER` / `AGGREGATE_WINDOW`、取得フィールド
- B182境界値による数値ORDER BYとnumber meta
- R16掲載SQLの実行
- WHERE／HAVING／JOIN ON／GROUP BY／文レベルORDER BY／window内windowのB129拒否
- パーサの切り出し・同一式統合テスト
- B65 allowlistは意味変更なしの行番号更新のみ

結果:

```text
Test Suites: 309 passed, 309 total
Tests:       6620 passed, 6620 total
Snapshots:   27 passed, 27 total
```

失敗数: `0`

```text
[docs-check] ok（リンク 3975 件 / 台帳 13 行）
```

ビルドは依頼どおり未実行です。

## 文書の差分

### `docs/ksql_language_reference.md`

追記・改めた本文:

> v3.81.0 から、ウィンドウ関数を関数の引数・算術・`CASE`・`||` の中に書ける。同じウィンドウ式を複数箇所に書いた場合は1回だけ評価する。`WHERE` / `HAVING` / `JOIN ON` / `GROUP BY` / 文レベルの `ORDER BY` では使えない

> `SUM(DISTINCT x) OVER (...)` のような引数の `DISTINCT`、`GROUP_CONCAT`・統計集計の `OVER`、ウィンドウ関数の中にウィンドウ関数を書く形は未対応

> v3.81.0 から、前月差・前月比のような計算もウィンドウ関数と同じ SELECT に書けます。先頭行の `LAG` は空文字を返し、算術では0として扱われます。空文字のまま返したい場合は `CASE` で判定します。

```sql
SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月,
       SUM(個数) AS 出庫数,
       SUM(個数) - LAG(SUM(個数)) OVER (ORDER BY DATE_FORMAT(日付, '%Y-%m')) AS 前月差,
       CASE WHEN LAG(SUM(個数)) OVER (ORDER BY DATE_FORMAT(日付, '%Y-%m')) = '' THEN ''
            ELSE ROUND((SUM(個数) - LAG(SUM(個数)) OVER (ORDER BY DATE_FORMAT(日付, '%Y-%m'))) * 100.0
                       / LAG(SUM(個数)) OVER (ORDER BY DATE_FORMAT(日付, '%Y-%m')), 1)
       END AS 前月比
FROM APP4228
WHERE 入出庫区分 = '出庫'
GROUP BY DATE_FORMAT(日付, '%Y-%m')
ORDER BY 年月
```

> v3.81.0 から、ウィンドウ関数を関数の引数・算術・`CASE` の中に書けます。`WHERE` / `HAVING` では使えません。たとえば全社売上に対する構成比は1段で書けます。

```sql
SELECT 会社名,
       SUM(売上) AS 売上合計,
       ROUND(SUM(売上) * 100.0 / SUM(SUM(売上)) OVER (), 1) AS 構成比
FROM APP100
GROUP BY 会社名
ORDER BY 売上合計 DESC, 会社名
```

> 集計・ウィンドウ・最終計算を段ごとに確かめたいときは、従来どおり CTE または一時テーブルで3段に分けても同じ結果になります。

### `docs/ksql_batch_recipes.md`

R15の改訂本文:

> v3.81.0 から、集計・ウィンドウ・割り算・`ROUND`・`CASE` を同じ SELECT に書けます。総計は **`SUM(SUM(x)) OVER ()` で各集計行に載る値**として使うため、JOIN も相関サブクエリも要りません。

```sql
SELECT 製品名,
       SUM(個数) AS 出庫量,
       ROUND(SUM(個数) * 100.0 / SUM(SUM(個数)) OVER (), 1) AS 構成比,
       ROUND(SUM(SUM(個数)) OVER (
         ORDER BY SUM(個数) DESC, 製品名
         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
       ) * 100.0 / SUM(SUM(個数)) OVER (), 1) AS 累積構成比,
       CASE
         WHEN SUM(SUM(個数)) OVER (
           ORDER BY SUM(個数) DESC, 製品名
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) * 100.0 / SUM(SUM(個数)) OVER () <= 80 THEN 'A'
         WHEN SUM(SUM(個数)) OVER (
           ORDER BY SUM(個数) DESC, 製品名
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) * 100.0 / SUM(SUM(個数)) OVER () <= 95 THEN 'B'
         ELSE 'C'
       END AS 区分
FROM APP4228
WHERE 入出庫区分 = '出庫'
GROUP BY 製品名
ORDER BY 出庫量 DESC, 製品名
```

> 段ごとに値を確かめたいときは、従来の3段版も使えます。

R16の改訂本文:

> 月次集約の直前行を `LAG` で参照し、前月差・前月比を出します。v3.81.0 から、月次集約・`LAG`・最終計算を同じ SELECT に書けます。

```sql
SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月,
       SUM(個数) AS 出庫数,
       SUM(個数) - LAG(SUM(個数)) OVER (ORDER BY DATE_FORMAT(日付, '%Y-%m')) AS 前月差,
       CASE WHEN LAG(SUM(個数)) OVER (ORDER BY DATE_FORMAT(日付, '%Y-%m')) = '' THEN ''
            ELSE ROUND((SUM(個数) - LAG(SUM(個数)) OVER (ORDER BY DATE_FORMAT(日付, '%Y-%m'))) * 100.0
                       / LAG(SUM(個数)) OVER (ORDER BY DATE_FORMAT(日付, '%Y-%m')), 1)
       END AS 前月比
FROM APP4228
WHERE 入出庫区分 = '出庫'
GROUP BY DATE_FORMAT(日付, '%Y-%m')
ORDER BY 年月
```

> 集計値、前月値、比率を段ごとに確かめたいときは、従来の段分けも使えます。

## §4 の5項目

1. `hiddenWindows` の伝播

   `/flow` の `executeStatement`、engine-library、プラグインEXPLAIN、`buildBatchExplainPlans`、CTE、サブクエリ、UNIONはいずれもパーサが返した `SelectStatement` を共有実行系へ渡しており、`columns` だけを使ってSELECT ASTを再構築する経路はありません。EXPLAINの再帰走査・order metadata・行数推定にも `selectWindowColumns()` を接続しました。通さない経路は見つかりませんでした。

2. 隠し列が漏れ得る出口

   - `project` / `computeOutputKeys`: 公開 `stmt.columns` のみ
   - DISTINCT: 公開 `stmt.columns` のtupleのみ
   - `SelectResult.columns` / 行キー: `project` の公開列のみ
   - CSV: `SelectResult.columns` のみ
   - column meta / Dashboard: 公開列だけをmap化し、隠しwindowは型解決用mapにのみ保持
   - `/flow`: 同じ `SelectResult` を返し、export serializerも公開 `columns` のみ
   - 根拠テスト: `B184-B: 非集計 SELECT、DISTINCT、CSV、column meta に隠し列を出さない`
   - `/flow`、engine-library、Dashboard関連の既存スイートも全体テストで通過

3. 意味型

   `src/engine/process.ts:2358` で、順位・`COUNT`・`SUM`・`AVG`をnumber、`LAG` / `LEAD`・`MIN`・`MAX`を引数型として解決し、`src/engine/process.ts:2347` からB182の `expressionSemanticKind` / `stringFunctionSemanticKind` へ渡しています。column meta側も同じ隠しID→window型mapを使用します。物理・派生relationのmetadataから引数型を解決できない `LAG` / `LEAD` / `MIN` / `MAX` は従来どおりstringへフォールバックします。

4. 同一window式の統合規則

   aliasを除いた正規化済みwindow ASTを `JSON.stringify` し、構造が一致する式を同一と判定します。識別子・方向・フレーム・引数などが異なれば別windowです。構文表現が異なるが意味的に等しい式は統合しません。統合しなくても結果は変わらず、window評価回数と内部lookup数だけが増えます。

5. プラグイン・MCP・CLI・`/flow` の同値性

   各面は共有パーサ、共有 `executeParsedStatement`、共有FULL_SCAN engine、共有EXPLAIN builderを使用します。CLI、MCP、flow-library、engine-library、UIを含む全309スイートが通過しています。MCP tool callは禁止に従い実施していません。

## Claude が実機で確かめるべき残項目

- SFAパックでR15の構成比・累積構成比・ABC一段版を実行し、既存3段版と照合
- 第3回データで、同額2社の`RANK`同順位とROWS累計のタイブレークを確認
- 第2回データで、先頭月の `LAG = ''`、前月差、前月比を確認
- MCP v3.80.0との結果・warnings・EXPLAIN比較
- プラグイン同梱EXPLAINで、新しい行を追加せず `complete input reason` に `WINDOW_ORDER` / `AGGREGATE_WINDOW` が出ることを確認

## 上限内に終わらなかった項目

なし。git操作、ビルド、MCP tool call、version・CHANGELOG・README・release・台帳・起票文書の変更は行っていません。


---

## Claude レビュー（2026-09-16）

### 1. 判定

codex 版をそのまま採用（修正なし）。設計は依頼どおり「公開 `columns` とは別の内部 `hiddenWindows`」で、隠し列の値は `byLookupKey` にだけ載り `project` / `computeOutputKeys` / DISTINCT / CSV / column meta に渡らない。旧契約（式内ウィンドウの拒否）を固定していたテストは「SELECT 列内は受理・WHERE / HAVING / JOIN ON / GROUP BY / 文レベル ORDER BY / ウィンドウ内ウィンドウは拒否」に分けて残っている。

### 2. 実機（dev profile・SFA パック・`npm run build:cli` 後の CLI）

| 形 | 結果 |
| :--- | :--- |
| 第 3 回の 1 段版（順位・構成比・累積構成比・区分をすべて同じ SELECT に。`SUM(SUM(売上)) OVER ()` を 5 か所） | 既存 3 段版と**行・値・列順が完全一致**（10 行・25.3 / 19 / 16.6 …・A4 / B2 / C4）。`columns` と行キーは公開 6 列だけ、`warnings` 0 |
| 第 2 回の `COUNT(*) - LAG(COUNT(*)) OVER (…)` + `CASE WHEN LAG(...) = ''` の 1 段版 | 2 段版と同一（先頭月の前月比は `''`） |
| 集計の無い SELECT の `売上 - LAG(売上) OVER (ORDER BY $id)` | 評価される（先頭行は `LAG` が `''` → 算術で 0 扱い） |
| `SELECT DISTINCT CASE WHEN <累積構成比> <= 80 THEN 'A' ELSE 'BC' END` | 2 行（隠し列が DISTINCT の比較に混ざらない） |
| `--export-csv` | 公開 2 列だけ（隠し列なし） |
| EXPLAIN | `complete input reason: GROUP_BY, LOCAL_ORDER, WINDOW_ORDER, AGGREGATE_WINDOW, AGGREGATE`・`fields: 会社名, 売上`（新しい行なし） |
| `WHERE` / `HAVING` の中のウィンドウ | 拒否（`WHERE` は「スカラー値式に集約関数は使用できません」、`HAVING` は「集計関数の引数内に集計関数は使用できません」＝B129 より前段の既存診断で止まる。いずれも実行されない） |

### 2.1 プラグイン画面での目視（v3.82.0 のプラグイン・user・2026-09-16）

`SELECT 会社名, SUM(売上) AS 売上合計, RANK() OVER (ORDER BY SUM(売上) DESC) AS 順位, ROUND(SUM(売上) * 100.0 / SUM(SUM(売上)) OVER (), 1) AS 構成比 FROM APP4149 GROUP BY 会社名 ORDER BY 売上合計 DESC, 会社名` を kintone のプラグイン実行画面で実行し、10 行（サイボウズ商事 順位 1・構成比 25.3、同額 0 円の 2 社が順位 9）・警告なしをスクリーンショットで確認。プラグイン同梱エンジンでも A（集計と同じ SELECT のウィンドウ）と B（式内ウィンドウ）が同じ結果になる。

### 3. 注記

- 同じウィンドウ式の畳み込みは「別名を除いた正規化 AST の `JSON.stringify` 一致」。第 3 回の 1 段版では `SUM(SUM(売上)) OVER ()` が 5 か所あるが 1 回評価
- `LAG` / `LEAD` / `MIN` / `MAX` の隠し列は引数の型が取れないと string にフォールバック（既存の公開ウィンドウと同じ規則）
- リリースは A + B を **v3.81.0（minor・純加法＝既存 SQL の挙動不変・構文の意味が広がる）**。第 0 回の差分早見表「集計とウィンドウは同じ SELECT に書けない」・第 2 回・第 3 回の「段を分ける」記述は版注記が要る（Qiita 側は user）

### 4. 結果

- `npm test`（Claude 実行・最終）: 307 suites / 6,594 tests passed、サブプロセス 2 suites / 26 passed、snapshots 27、`docs:check` 通過
