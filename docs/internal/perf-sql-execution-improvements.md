# SQL 実行パフォーマンス改善提案

コードレビュー（2026-07-03 時点 / v1.2.0）に基づく、SQL 実行時のパフォーマンス改善案。

対象範囲: `src/execute.ts` → `src/api/fetchAll.ts` → `src/engine/process.ts` / `src/engine/evalWhere.ts` / `src/engine/evalFunc.ts` および `src/core/optimization/*`。

## 前提: 既に実装済みの最適化（評価できる点）

- WHERE プッシュダウン（`extractTableCondition`）でメイン・JOIN 先の取得件数を削減
- JOIN の ON キーによる `in (...)` 絞り込み取得（`tryFetchJoinRecordsBySourceKeys`）
- プッシュダウン可能な JOIN テーブルのメインテーブルとの並列フェッチ開始
- 単純 CTE のインライン化による REST API への WHERE 一括委譲
- フィールド定義の Promise キャッシュ（`fieldInfoCache`）による重複 GET 排除
- SIMPLE モードで `LIMIT <= 500` のときの単発 GET（ページング回避）

以下は、この構造の上でさらに効く改善である。実行時間の支配項は **kintone REST API の往復回数** なので、まず A（API 呼び出し削減）が最優先。

---

## A. API 呼び出し回数の削減（効果: 大）

### A-1. UPSERT / UPSERT SELECT の N+1 クエリ解消 【最優先】

[execute.ts:1381](../src/execute.ts#L1381)（UPSERT）、[execute.ts:1898](../src/execute.ts#L1898)（UPSERT SELECT）

現在は **1 行ごとに** 既存レコード検索の GET を発行している。

```ts
for (const row of stmt.values) {
  ...
  const existing = await fetchAll(client.getRecords, stmt.appId, query, ["$id"], ...);
}
```

1,000 行の UPSERT で 1,000 回の GET（+ ページング）が発生する。

**改善案**: JOIN の ON 最適化と同じ手法で、キー値をまとめて `key in ("v1","v2",...)` で 50 件ずつチャンク取得し、`キー値 → $id` の Map を先に構築してから振り分ける。

- 単一キー: `key in (...)` チャンク（`JOIN_IN_CHUNK_SIZE` と同じ 50 件単位）
- 複合キー: 主キー 1 つで `in (...)` 絞り込み後、残りキーはクライアント側で照合
- 効果: GET 回数 N 回 → ⌈N/50⌉ 回（1,000 行なら 1,000 → 20 回）

また、既存判定は 1 件見つかれば十分なのに `maxRecords: 10_000` の `fetchAll` を使っている。フォールバック時も `limit 1` の単発 GET で足りる。

### A-2. CLI / MCP のページング並列化（`fetchParallel` 未指定）

[cli/index.ts:1598](../src/cli/index.ts#L1598) 付近の `execute()` 呼び出しは `fetchParallel` を渡していないため、`fetchAll` は常に直列ページング（1 ページ 500 件ずつ順番に GET）になる。プラグイン UI は `FETCH_PARALLEL_DEFAULT = 5`（[ui/desktop.ts:114](../src/ui/desktop.ts#L114)）で 5 並列なのに、CLI / MCP だけ遅い。10,000 件（20 ページ）の取得で約 3〜5 倍の短縮が見込める。

**改善案（CLI）**: `--fetch-parallel N` オプションと profile 設定（`query.fetchParallel`、環境変数 `KSQL_FETCH_PARALLEL`）を追加し、`maxRecords` / `onLimit` と同じ優先順位（引数 > 環境変数 > profile > デフォルト）で解決してデフォルト 3〜5 を `execute()` に渡す。

**改善案（MCP）**: MCP は別途対応が必要。

- [mcp/schemas.ts](../src/mcp/schemas.ts#L4): `maxRecords` / `onLimit` / `timeout` と並ぶ共通入力として `fetchParallel`（`z.number().int().min(1).max(10).optional()` 程度の上限付き）を `queryInputSchema` / `mutateInputSchema` / `describeAppInputSchema` / `showAppsInputSchema` / `runSavedQueryInputSchema` に追加。`ksql_mutate`（[mcp/tools.ts:366](../src/mcp/tools.ts#L366)）も UPDATE / DELETE の対象 $id 解決や UPSERT の既存判定で `fetchAll` を通るため対象に含める
- `runSavedQuery`（[mcp/tools.ts:450](../src/mcp/tools.ts#L450)）は入力を**明示的に転送**しているため、schema 追加だけでは反映されない。read-only 経路の `query({...})`（[tools.ts:465-471](../src/mcp/tools.ts#L465-L471)）と DML 経路の `mutate({...})`（[tools.ts:481-488](../src/mcp/tools.ts#L481-L488)）の両方の転送リストに `fetchParallel: input.fetchParallel` を追加する
- [mcp/tools.ts:331](../src/mcp/tools.ts#L331) ほか各 `executeSql()` 呼び出し: `fetchParallel: runtime.fetchParallel` を `ExecuteOptions` に渡す。runtime（[node/runtime.ts:70-81](../src/node/runtime.ts#L70-L81)）の解決順は `maxRecords` / `onLimit` / `timeout` と同じく `input.fetchParallel ?? envInt("KSQL_FETCH_PARALLEL") ?? profile.query?.fetchParallel ?? デフォルト` とし、CLI と優先順位を揃える

### A-3. サブクエリ解決の並列化

[execute.ts:1993](../src/execute.ts#L1993) `resolveSubqueries` は WHERE 木を再帰しながら `await` で直列実行する。`IN (SELECT ...)` が複数、あるいは `EXISTS` と併用されると、その数だけ直列に待つ。

**改善案**: 木を走査して「実行すべきサブクエリのリスト」を先に収集し、`Promise.all` で並列実行してから `resolved` を書き込む。`executeUnion`（[execute.ts:507-511](../src/execute.ts#L507-L511)）の左辺・右辺、`buildOptionOrdersForSelect` / `buildSortKindsForSelect` / `resolveScalarColumns` の直列 `await`（[execute.ts:486-488](../src/execute.ts#L486-L488)）も同様に並列化できる。

### A-4. スカラーサブクエリ列の重複実行（コメントと実装の乖離）

[execute.ts:2061-2078](../src/execute.ts#L2061-L2078) `resolveScalarColumns` の doc コメントは「同一クエリは 1 回だけ実行」とあるが、実装は**列インデックスをキー**にしているだけで、同一サブクエリが複数列にあるとその回数だけ実行される。

**改善案**: `JSON.stringify(col.query)` をキーにした `Map<string, Promise<string>>` で重複排除し、あわせて A-3 の並列化を適用する。

### A-5. フィールド定義取得とレコード取得のオーバーラップ

[execute.ts:486-488](../src/execute.ts#L486-L488)（FULL_SCAN）では、全テーブルのレコード取得が**完了した後**に `resolveScalarColumns` → `buildOptionOrdersForSelect` → `buildSortKindsForSelect` を直列で待つ。これらはレコードに依存しないため、メインフェッチの開始と同時に走らせて最後に await すればレイテンシが隠れる。

SIMPLE モード（[execute.ts:325-327](../src/execute.ts#L325-L327)）では、さらに **`stmt.orderBy` が空なら optionOrders / sortKinds の取得自体が不要**（`applyOrderBy` が即 return するため）。条件付きスキップで GET `/app/form/fields` を丸ごと省ける（キャッシュ未ヒットの初回に効く）。

### A-6. サブテーブル DML / REORDER の全件・全フィールド取得

[execute.ts:1464](../src/execute.ts#L1464)（INSERT）、[execute.ts:1517](../src/execute.ts#L1517)（UPDATE）、[execute.ts:1582](../src/execute.ts#L1582)（DELETE）、[execute.ts:1774](../src/execute.ts#L1774)（REORDER）はいずれも `query: "", fields: []`（全レコード・全フィールド）で親を取得する。

**改善案**:

- サブテーブル INSERT は `_pid` が既知なので `$id in (対象pid...)` で親を絞り込める（50 件チャンク）。
- UPDATE / DELETE / REORDER も、WHERE に `_pid` / `_p.フィールド` の条件があれば `$id = ...` / 親フィールド条件としてプッシュダウン可能（`extractTableCondition` の親フィールド版）。
- `fields` は `$id, $revision, サブテーブルコード, WHERE が参照する親フィールド` に限定できる（PUT はサブテーブル全行を送るのでサブテーブル自体は必要）。
- サブテーブル INSERT（[execute.ts:1464](../src/execute.ts#L1464)）だけは `maxRecords: 10_000, parallel: 1` の**ハードコード**で、`options.maxRecords` / `options.fetchParallel` を参照していない。他のサブテーブル DML と同じく options を尊重するのは、絞り込み実装の前にできる小修正。

また [execute.ts:1553](../src/execute.ts#L1553) / [execute.ts:1605](../src/execute.ts#L1605) / [execute.ts:1794](../src/execute.ts#L1794) の `parents.find(...)` はループ内線形検索で O(親数 × 対象親数)。`Map<pid, parent>` を 1 度作れば O(1) 参照になる（`executeInsertSubtable` は既に `parentMap` を作っており、同じパターンを流用するだけ）。

### A-7. DML バッチの往復削減（bulkRequest）

INSERT / UPDATE / DELETE は 100 件ごとのバッチを直列 `await` している（例: [execute.ts:1162-1165](../src/execute.ts#L1162-L1165)、[execute.ts:1289-1292](../src/execute.ts#L1289-L1292)）。kintone の `POST /k/v1/bulkRequest.json` を使えば 1 往復に 20 リクエスト（= 最大 2,000 レコード）をまとめられ、往復回数が 1/20 になる。

留意点: bulkRequest はトランザクション的に全成功/全失敗となるため、現在の「途中まで成功」挙動と変わる。`KintoneClient` インターフェースに `bulkRequest` を追加し、対応クライアントのみ使うオプトイン設計が安全。

### A-8. SIMPLE モード `LIMIT > 500` 時の全件取得回避

[execute.ts](../src/execute.ts) の `useSingleGet` でない場合、従来は WHERE 一致分を（最大 `maxRecords` まで）**全件**取得してから JS で ORDER BY / LIMIT していた。`LIMIT 1000` でも 10,000 件取得し得る。

**v2.11.0 実装済み**: `ORDER BY` が空、`LIMIT` 明示、`offset + limit <= maxRecords`、KLIKE なしの SIMPLE SELECT に限定し、`fetchAll.stopAfter` へ `offset + limit` を渡す。フェッチ順の `$id` 昇順がそのまま返却順になる安全サブセットだけを必要件数で正常終了する。`ORDER BY` 付きは JS 再ソートが全件に依存し、KLIKE は後続ページの検索打ち切り警告を検査する必要があるため対象外。詳細は [B8 仕様](ksql_limit_over_500_fetch_truncation_spec.md)。

この最適化では `maxRecords` を「実際に取得した行数」の上限として扱うため、`offset + limit <= maxRecords` なら一致総数が上限を超えていてもエラー／truncate 警告なしで成功する。返却行は従来成功時と同一だが、従来は上限エラーだったクエリが成功し得る。

---

## B. JS エンジン（CPU / メモリ）の改善（効果: 中）

取得後の 1 万行 × JOIN のようなケースで効く。API 往復に比べれば小さいが、UI のブロッキング時間（プラグインはメインスレッド実行）に直結する。

### B-1. ORDER BY のソートキー事前計算

[process.ts:390-399](../src/engine/process.ts#L390-L399) `applyOrderBy` は比較のたびに `evalOrderKey`（ARITH / 文字列関数の評価）と `Number()` 変換を実行する。n 行のソートで約 n·log n × キー数 回の式評価が走る。

**改善案**: ソート前に各行のキー値（文字列と数値解釈）を配列に前計算してからソートする（decorate–sort–undecorate）。`ORDER BY DATE_FORMAT(...)` のような式キーで特に効く。

### B-2. LIKE 正規表現のキャッシュ

[evalWhere.ts:237-258](../src/engine/evalWhere.ts#L237-L258) `matchLike` はワイルドカード付きパターンを**行ごとに** `new RegExp` でコンパイルする。10,000 行のフィルタで 10,000 回コンパイル。

**改善案**: `Map<pattern, RegExp>` のモジュールレベルキャッシュ（またはサイズ上限付き）で 1 パターン 1 回にする。

### B-3. LEFT JOIN の空行テンプレートをループ外へ

[process.ts:147-152](../src/engine/process.ts#L147-L152) LEFT JOIN の非マッチ時、`emptyRight` を**左行ごとに** `Object.keys(rightRows[0])` から再構築している。RIGHT JOIN 側（[process.ts:111-112](../src/engine/process.ts#L111-L112)）は既にループ外で作っており、同じ形に揃えるだけの小改修。

### B-4. `flatten` の二重キー保持によるメモリ倍増

[process.ts:65-68](../src/engine/process.ts#L65-L68) JOIN 時は全フィールドを `alias.field` と `field` の 2 キーで保持するため、行オブジェクトのサイズが約 2 倍になる。10,000 行 × 2 テーブル JOIN では無視できない。

**改善案**: 非修飾フォールバックは参照時に解決する（`resolveFieldRef` は既に `field` → `alias 除去` のフォールバックを持つが、逆方向の「非修飾名 → いずれかの alias 付きキー」解決を追加する必要がある）。互換性への影響が広いので、計測してから着手するのが妥当。

### B-5. `Math.max(...nums)` / `Math.min(...nums)` のスプレッド

[process.ts:278-279](../src/engine/process.ts#L278-L279) 集計 MAX / MIN は配列スプレッドで呼んでおり、要素数が数万〜十数万（`maxRecords` 引き上げ時）で `RangeError: Maximum call stack size exceeded` になり得る。**性能だけでなく障害リスク**。ループまたは `reduce` に置き換える。

### B-6. DISTINCT `*` / UNION 重複排除のキー生成

[process.ts:356-359](../src/engine/process.ts#L356-L359) `SELECT DISTINCT *` は行ごとに `JSON.stringify(Object.entries(row).sort())`（ソート込み）を実行する。列名集合は全行で同一なので、**1 回だけ列リストを確定**し、以降は values を `\x00` join する形にすれば行あたりのコストが大きく下がる。[execute.ts:533-541](../src/execute.ts#L533-L541) `deduplicateRows` は既にこの形なので流用できる。

### B-7. GROUP BY 集計の 1 パス化（優先度低）

[process.ts:210-222](../src/engine/process.ts#L210-L222) 集計列ごとに `groupRows` を再走査するため、コストは 行数 × 集計列数。sum / count / min / max を 1 パスで累積する集約器にすれば列数分の走査が 1 回になる。現状の行数規模では効果が小さいため、`maxRecords` を引き上げる計画がある場合のみ。

---

## C. レビューで見つけた correctness 上の懸念（性能改修と併せて対応推奨)

### C-1. `fetchAll` 初回ウィンドウに `order by $id asc` が付かない

[fetchAll.ts:233-238](../src/api/fetchAll.ts#L233-L238) `buildCursorQuery` は `cursorId <= 0` のとき order by を付与しない。つまり **最初の 10,000 件は順序保証なしの offset ページング**になる。kintone の既定順（レコード ID 降順）を前提にすると:

1. `parallel > 1` の offset ページングは、明示ソートがないと取りこぼし・重複のリスクがある
2. 10,000 件超でカーソル切替時、`getLastId` が返すのは降順ページの末尾（= 小さい $id）であり、`$id > cursorId order by $id asc` が**既取得分を再取得**する可能性がある

**改善案**: 初回から常に `order by $id asc` を付与する。`fetchAll` 経路は JS 側で再ソートするか順序不問の DML $id 取得であり、SQL の意味論上は順序保証がないため妥当だが、以下の互換性に注意:

- `ORDER BY` なし SELECT の**観測上の表示順は変わる**（従来: kintone 既定の ID 降順 → 変更後: ID 昇順）。既存ユーザーへの影響を CHANGELOG に明記する
- 既存テストは `cursorId=0` のとき order なしを期待している（[fetchAll.test.ts:34](../src/api/__tests__/fetchAll.test.ts#L34) 付近）ため、`buildCursorQuery` の修正とあわせてテスト更新が必要

### C-2. ON 最適化の重複排除キー

[execute.ts:947](../src/execute.ts#L947) チャンク取得結果の dedup キーが `$id + JSON.stringify(rec)` で、レコード全体のシリアライズは不要に重い。`$id` があれば `$id` のみで一意（同一アプリ内）。`$id` が fields に含まれない場合のみフォールバックすればよい。

---

## 優先度マトリクス

| # | 改善項目 | 効果 | 工数 | 備考 |
|---|---------|------|------|------|
| A-1 | UPSERT の N+1 解消 | ◎（行数に比例して短縮） | 中 | 最優先 |
| A-2 | CLI/MCP の fetchParallel | ◎（大量取得で 3〜5 倍） | 小〜中 | CLI はオプション追加のみ、MCP は schema（mutate 含む 5 つ）/ runtime / tools の各所 |
| C-1 | fetchAll の order by 常時付与 | ○（安定性） | 小 | correctness 兼。表示順の互換性注意 + テスト更新 |
| A-3/A-4 | サブクエリ並列化・重複排除 | ○ | 小〜中 | |
| A-5 | フィールド定義取得のオーバーラップ / スキップ | ○（初回クエリ） | 小 | |
| A-6 | サブテーブル DML の絞り込み取得 | ○（大規模アプリで大） | 中 | `parents.find` の Map 化は小 |
| B-2/B-3/B-5 | RegExp キャッシュ / LEFT JOIN / スプレッド | ○（数行の修正） | 小 | まとめて 1 PR 向き |
| B-6 | DISTINCT キー生成 | ○ | 小〜中 | キー同一性（delimiter 衝突・列集合）のテスト追加とセット |
| B-1 | ORDER BY キー前計算 | ○（式ソート時） | 小 | |
| A-8 | SIMPLE LIMIT>500 の取得打ち切り | ○ | 中 | ソート補正条件の判定が必要 |
| A-7 | bulkRequest | ○（DML 大量時） | 大 | 挙動変更を伴うためオプトイン |
| B-4 | flatten 二重キー削減 | △（メモリ） | 大 | 計測してから |
| B-7 | GROUP BY 1 パス化 | △ | 中 | maxRecords 引き上げ時のみ |

## 効果予想

実時間は kintone 環境・ネットワーク・フィールド数に左右されるため、以下は **API 往復回数と JS 処理量から見た概算**。特に GET/POST/PUT の 1 往復が 200〜500ms 程度かかる環境では、API 呼び出し削減系の効果がそのまま体感差になりやすい。

| 改善項目 | 想定ケース | 現状 | 改善後 | 期待効果 |
|---|---:|---:|---:|---|
| A-1 UPSERT N+1 解消 | UPSERT 1,000 行・単一キー | 既存判定 GET 1,000 回 | 50 件チャンクで GET 20 回 | GET 往復 98% 削減。既存判定部分は数十倍短縮 |
| A-2 fetchParallel | 10,000 件取得（20 ページ） | GET 20 回を直列 | 3〜5 並列 | 取得待ち時間 3〜5 倍短縮。ただし kintone 側のレート制限に注意 |
| C-1 初回 order by `$id` | 10,000 件超 / parallel 取得 | 重複・再取得リスクあり | 安定した `$id asc` ページング | 主効果は正確性。重複再取得が起きるケースでは余分な GET と後処理も削減 |
| A-3/A-4 サブクエリ並列化・重複排除 | 同一/独立サブクエリ 3 個 | 3 回を直列、重複も実行 | 重複 1 回 + 独立分は並列 | サブクエリ待ち時間は最大 1/3 程度、重複分は API 回数も削減 |
| A-5 フィールド定義取得のオーバーラップ / スキップ | 初回 FULL_SCAN / ORDER BY なし SIMPLE | レコード取得後に field GET | 並列化、不要時は 0 回 | 初回クエリの待ちを field GET 1〜2 回分短縮 |
| A-6 サブテーブル DML 絞り込み | 親 10,000 件中、対象 10 親 | 親全件・全フィールド取得 | 対象親のみ + 必要フィールド | 取得行数 99% 以上削減し得る。大規模アプリほど効果大 |
| B-2/B-3/B-5 JS 小改善 | 10,000 行級の FULL_SCAN | 行ごと正規表現生成・空行テンプレート再構築等 | キャッシュ / 事前生成 / ループ化 | CPU 時間と一時メモリを削減。UI ブロッキング低減 |
| B-6 DISTINCT キー生成最適化 | 10,000 行の `SELECT DISTINCT *` | 行ごと JSON.stringify + ソート | 列リスト確定 + values join | 行あたりのキー生成コストを大幅削減。キー同一性のテスト追加前提 |
| B-1 ORDER BY キー事前計算 | 10,000 行を式 ORDER BY | 比較ごとに式評価 | 行ごとに 1 回評価 | 式評価回数を約 `n log n` 回 → `n` 回へ削減 |
| A-8 LIMIT>500 打ち切り | WHERE 一致 10,000 件、LIMIT 1,000 | 10,000 件取得後に LIMIT | 1,000 件前後で停止 | GET 20 回 → 2 回程度。取得量 90% 削減 |
| A-7 bulkRequest | DML 2,000 件 | 100 件 batch 20 往復 | bulkRequest 1 往復 | 書き込み往復 95% 削減。ただし全成功/全失敗の挙動差あり |

総合的には、まず A-1 / A-2 / A-8 のような **API 往復を直接減らす対策** が最も効く。B 系は API が速い環境、プラグイン UI、JOIN / GROUP BY / DISTINCT を多用するクエリで効きやすい。

## 実装推奨ロードマップ

効果予想 × 工数 × リスクから、以下の順で実装することを推奨する。

### フェーズ 1: 即実装（効果大 or 数行修正・低リスク）

| 順 | 項目 | 推奨理由 |
|---|------|---------|
| 1 | **A-2 CLI/MCP の fetchParallel** | 効果◎（大量取得 3〜5 倍）に対して既存機構（`fetchAll` の parallel 実装済み）へオプションを配線するだけ。効くのは `fetchAll` 経由で複数ページ取得になる経路（`LIMIT <= 500` の単発 GET や書き込み API 自体は対象外）だが、**大量取得系の全経路が恩恵を受ける**費用対効果の高い項目 |
| 2 | **A-1 UPSERT の N+1 解消** | 単一項目として最大の削減幅（GET 98% 減）。`tryFetchJoinRecordsBySourceKeys` のチャンク取得パターンを流用できるが、DML 特有の注意点がある: 既存レコード複数ヒット時の `$id` 選択（現行は先頭 1 件）、同一 UPSERT 入力内の重複キー、複合キー時の主キー候補選定、値の変換・quote。**現行挙動をテストで固定してから**着手する |
| 3 | **B-2/B-3/B-5 まとめ PR** | 各数行の修正で低リスク。特に **B-5 は `RangeError` の障害リスク回避**を含むため、性能以前に入れるべき。**B-6 は `SELECT DISTINCT *` のキー同一性（delimiter 衝突・列集合の前提）に関わる**ため、テストを足した上で分けて入れる |
| 4 | **C-1 fetchAll の order by 常時付与** | correctness 兼。修正自体は小さいが、表示順の互換性注意 + テスト更新 + CHANGELOG 明記をセットで |
| 5 | **A-4 スカラーサブクエリ重複排除** | コメントと実装の乖離（実質バグ）の修正。工数小 |

あわせて「計測の提案」（API call 数の metrics 化）をこのフェーズで先に入れると、以降の項目の効果を数値で検証できる。

### フェーズ 2: 次点（効果中・工数小〜中）

| 順 | 項目 | 推奨理由 |
|---|------|---------|
| 6 | **A-3 サブクエリ / UNION の並列化** | サブクエリ多用クエリで最大 1/N。A-4 と同じ箇所を触るため連続実装が効率的 |
| 7 | **A-5 フィールド定義取得のオーバーラップ / スキップ** | 初回クエリのレイテンシ改善。ORDER BY なし時のスキップは特に安全（フィールド定義系の並列化はこちらに集約） |
| 8 | **A-6 の小修正部分**（`parents.find` の Map 化、サブテーブル INSERT のハードコード解消） | 絞り込み本体（中工数）の前にできる低リスク修正 |
| 9 | **B-1 ORDER BY キー事前計算** | 式 ORDER BY 利用時に効く。実装は局所的 |

### フェーズ 3: 計測後に判断（工数大 or 挙動変更あり）

- **A-8 LIMIT>500 打ち切り** — ソート補正の適用可否判定ロジックが必要。フェーズ 1 の計測で LIMIT 付き大量取得の頻度を見てから
- **A-6 の絞り込み本体** — 親フィールドプッシュダウンの実装。サブテーブル DML の利用規模次第
- **A-7 bulkRequest** — 全成功/全失敗への挙動変更を伴うためオプトイン設計の検討が先
- **B-4 flatten 二重キー削減 / B-7 GROUP BY 1 パス化** — メモリ・CPU 計測で必要性を確認してから

## 計測の提案

[sharedPlanner.ts:11](../src/core/optimization/sharedPlanner.ts#L11) の `SharedFetchMetrics` には既に `fetchedRows` があるが、現状は**呼び出し側で捨てられており**どこにも露出していない。改善前後の比較のため:

1. `SharedFetchMetrics` に API call 数（GET 発行回数）を追加する
2. `execute()` 内で各フェッチの metrics を集約し、`ExecuteResult`（または warnings 相当のメタ情報）として呼び出し元へ伝搬する
3. EXPLAIN には「予想 GET 回数」を、実行結果には「実際の API 呼び出し回数・取得行数・JS 処理時間」を出す

とすれば、以後の最適化の効果検証が容易になる。
