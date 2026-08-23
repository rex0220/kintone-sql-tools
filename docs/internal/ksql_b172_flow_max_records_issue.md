# B172 `/flow` の読取上限 `maxRecords` — 依頼は「設定可能化」だが、設定口は既に公開済み（欠けているのは文書・公開面テスト・値検証）

- 状態: 🚧 **対応完了・次の機能リリースへ同梱待ち**（2026-08-23）＝回答送付済み・公開面テスト 6 件追加済み・文書化 3 点済み（README `/flow` 節・言語リファレンス §11 入口別表の `/flow` 行・§27.9 新設）・**値検証は見送りと判断**（§3 ③）。エンジン実装の変更はゼロ。単独リリースは切らない（B116 の運用＝文書・テストのみは次の機能リリースに同梱。GitHub 上はコミットで公開済み）。案 B（逐次集約）は L 段階の実測を見て判断。**依頼の前提「`/flow` の公開オプションに変更手段が見当たらない」は誤り＝`maxRecords` は v3.69.0（Stage 6a）から公開型に存在し配線済み**。②公開面テストは [`b172MaxRecordsPublicSurface.test.ts`](../../src/flow-library/__tests__/b172MaxRecordsPublicSurface.test.ts)（6 ケース・§4 の 1,2,3〔execute/explain 面〕,6 を固定。preview 面の直接固定は残）で「渡したら効く」を実測化し、[回答文書](../../../ksql-flow/docs/kSQLエンジンからの回答-20260823-F3-flow読取上限.md)で「現行版のまま L 段階へ前進可・`tempTableMaxRows` も 25,000 に揃えること」を送付。残るのは①文書化③上限値検証の採否（案 A の新規部分・`tempTableMaxRows` と対称に）と、案 B（単純 GROUP BY の逐次集約）の判断
- 種別: 改善（文書・テスト）＋機能（値検証／案 B）
- 優先: 中（依頼書は「高・スケール検証 L 段階のブロッカー」だが、**依頼元は現行 v3.72.0 のまま `maxRecords` を渡せば即時前進できる**。急ぐのは実装ではなく返信）
- 出典: [ksql-flow の依頼 F-3](../../../ksql-flow/docs/kSQLエンジンへの依頼-20260823-F3-flow読取上限.md)

## 1. 実測（v3.72.0 実装・2026-08-23）

依頼書の事実主張 3 件を測った（[[pro-request-measure-first]] の運用どおり）:

| 依頼書の主張 | 実測 |
|---|---|
| 読取上限は既定 10,000（dist-flow バンドル内 `maxRecords ?? 1e4`） | **正しい**。`src/execute.ts` の全読取経路が `options.maxRecords ?? 10_000` |
| `/flow` の公開オプションにこの上限を変更する手段が見当たらない | **誤り**。`CreateExecutionContextOptions.maxRecords`（`src/flow-library/publicTypes.ts:132`・executeStatement / previewStatement が共有）と `ExplainScriptOptions.maxRecords`（同 `:111`・explainScript）が **v3.69.0（Stage 6a・commit `ff08776`）から存在**し、公開パッケージの `dist-flow/flow-library/publicTypes.d.ts`（`:130` / `:153`）にも出ている |
| 20,000 件の単純 GROUP BY は読取上限で停止する見込み | 既定のままなら正しい（GROUP BY は完全な候補集合が必要・fail-closed）。**`maxRecords: 25000` を渡せば現行版で完走できるはず**（§4 の 1 で固定してから断言する） |

配線の確認:

- `createExecutionContext` は `client` / `script` / `statements` / `meta` / `apps` / `onChunkWritten` を取り除いた**残余オプションをそのまま `BatchExecuteOptions` として `createManagedStatementExecutionContext` へ渡す**（`src/flow-library/index.ts:132-135`）。`maxRecords` は素通しで有効
- `previewStatement` は同じ managed context の options を使うため実行と同値
- `explainScript` は `opts.maxRecords` を `buildBatchExplainPlans` へ渡す（`src/flow-library/index.ts:92`）

→ **依頼の受入基準 1〜4 は v3.69.0 以降で既に成立している可能性が高い**（3 面同値・未指定時 10,000 不変・dialect 0 面に影響なし）。

### 1.5 隣の上限 `tempTableMaxRows`（【オーナー指摘】依頼書が見ていない穴）

- 一時テーブルの実体化は `maxRecords` とは**別の** `tempTableMaxRows`（既定 10,000・`src/execute.ts:1463` `TEMP_TABLE_MAX_ROWS`）が守る。1 テーブルあたり・同時 16 個・超過は `onLimitReached` に関わらず**常にエラー**
- 現実の flow バッチは「SELECT → `#t` 実体化 → 集計・DML」の形が多い。**`maxRecords: 25000` だけ上げても、20,000 行を `#t` に実体化する文（`#before` スナップショット等）は `tempTableMaxRows` 既定 10,000 で止まる＝失敗点が移動するだけ**。GROUP BY を直接実行する形なら temp に入るのは集約後の行数だけなので通る——依頼書の受入基準 1 は temp 経由かどうかを規定していない
- **エンジン側での暗黙連動（`maxRecords` に `tempTableMaxRows` を自動追従）は採らない**: 守る資源が違う（`maxRecords`＝1 文の読取候補行数・API 消費／`tempTableMaxRows`＝バッチ全体で最大 16 テーブルに累積保持されるメモリ）。連動は `maxRecords: 25000` の指定が黙って最大 16×25,000 行の保持を許す形になり fail-closed に反する。言語リファレンスの「`maxRecords` とは独立」も既存契約
- 正しい形＝**呼び出し側で両方を明示設定**。ランナーは既に `tempTableMaxRows` を渡す配線を持つ（F-3 依頼書に自ら明記）ので、`limits.maxReadRows` と同時に揃えるのは設定 1 行。こちらは返信・文書で「`maxRecords` を上げるときは `tempTableMaxRows` も揃える」を明記し、受入テストに temp 実体化経由を含める（§4 の 6）

## 2. なぜ「見当たらない」が起きたか（こちらの欠落 3 件）

依頼元の見落としではなく、**公開したのに一度も語っていない**:

1. **文書ゼロ** — README の `/flow` 節・使用例に `maxRecords` が無い。言語リファレンスの「入口ごとの `maxRecords` 既定値」表（エンジン API 直接 / CLI / MCP / プラグインの 4 行）に **`/flow` の行が無い**。§27 にも無い
2. **公開面テストゼロ** — `/flow` の公開面から `maxRecords` を渡すテストが 1 本も無い（`grep maxRecords src/flow-library/__tests__/` = 0 件）。型と配線はあるが「渡したら効く」を固定した検査が無い。[[check-sibling-path-when-fixing]] の教訓形（利用者に勧める形をそのまま実行するテストを 1 本）
3. **値検証ゼロ** — `/flow` 側は `maxRecords` を一切検証しない（engine-library の read-only API は positive safe integer 検証のみ・上限なし）。依頼の「1〜200,000 ハード上限・超過は実行前の設定エラー」は新規実装

## 3. 対応案

- **案 A'（本件の実体・小）**:
  1. 文書化 — README `/flow` 例・入口別 `maxRecords` 表への `/flow` 行追加・§27。**受理範囲と保証範囲を区別して書く**＝読取は `$id` シーク方式で件数に構造的上限は無い（offset 1 万の壁は回避済み・`src/api/fetchAll.ts`）が、fetch-all 方式ゆえ全行がメモリに載る。**200,000 域の実測はエンジン側に存在せず**、「20 万行 / 1GB」「1.5KB/件」は依頼元（ksql-flow 仕様書 11 章）の想定・概算。ハード上限 200,000 は「受付を拒否する線」であって動作保証ではない（依頼書自身もサポート目安 10 万・10 万超〜20 万は保証外・20 万超は分割、の三段）
  2. 公開面テスト — 小さい `maxRecords` → `FetchAllLimitError`／引き上げ → 完走、explain・preview の同値（§4）
  3. 値検証 — 1〜200,000・超過は実行前の設定エラー。**【2026-08-23 判断】見送り（両方とも現状維持）**。理由: ①**200,000 という線は ksql-flow 仕様書 11 章のインメモリ想定であって、エンジンが測った境界ではない**。他プロジェクトの製品仕様の数字を、全利用面（engine API / CLI / MCP / プラグイン / `/flow`）共通のハード上限として課す根拠がない ②**行数はメモリの悪い代理変数**（幅の広い 5 万行は落ち、狭い 50 万行は収まる）。固定行数の上限は安全の保証を装って保証しない ③fail-closed は**既定 10,000 ＋明示エラーで既に提供**されており、上限検証が守るのは「意図的に過大指定した人」だけ。その層はランナー側検証（依頼元が `limits.maxReadRows` で実施予定・回答文書で推奨済み）が正しい置き場 ④受理→拒否は純加法でなく、入れるなら `tempTableMaxRows` 含む全面へ対称に入れる話になり費用と破壊が釣り合わない。**再起票の条件**＝①過大指定による OOM 事故が実際に報告されたとき（そのときは行数でなくメモリ見積りベースの警告を検討する）②依頼元がランナー側検証で守れない実例を示したとき。**対称性の原則は維持**＝将来入れる場合も `maxRecords` と `tempTableMaxRows` の両方へ同じ検証（読取側だけ塞ぐ片手落ちにしない）。回答文書には「検討中」と書いて送付済みのため、同文書 §4 へ見送り確定の追記を入れた
- **案 B（依頼書の本命・別リリース可）**: JOIN・ソート・ウィンドウを伴わない単純 GROUP BY のカーソルページ逐次集約（メモリ一定・読取上限対象外）。規模大。kSQL Flow 公開仕様書 11 章との乖離は依頼書 §補足どおりランナー側で先に記述修正予定
- **即時の申し送り**: 依頼元は現行版のまま `createExecutionContext({ maxRecords: 25000, tempTableMaxRows: 25000, ... })`・`explainScript(source, { maxRecords: 25000, ... })` で L 段階を実施できる（リリース待ち不要）。**`maxRecords` 単独では一時テーブル実体化を伴う文が既定 10,000 で止まるため、`tempTableMaxRows` も揃えて案内する**（§1.5）。ただし公開面テストが無い状態で勧めることになるため、**§4 の 1〜3・6 を固定してから返信するのが筋**

## 4. 受入基準（案 A'）

依頼書の受入基準を流用し、「既に成立」を実測で固定する:

1. `/flow` 公開面から `maxRecords: 25000` を渡した実行で、20,000 件読取の単純 GROUP BY が完走する（モックで固定）
2. 未指定時は 10,000 で明示エラー停止する（既存挙動の固定テスト）
3. `executeStatement`／`previewStatement`／`explainScript` の 3 面で同じ上限が適用される
4. dialect 0 の CLI / MCP / プラグインの既定挙動は不変（それぞれの既存上限解決はそのまま）
5. （③を採る場合）0・負・非整数・200,001 以上は実行前の設定エラーで拒否する
6. **temp 実体化経由でも完走する**＝`maxRecords: 25000` ＋ `tempTableMaxRows: 25000` で「20,000 行を `#t` に実体化 → 集計」のバッチが完走し、`tempTableMaxRows` 未指定（既定 10,000）なら同バッチが実体化時点で明示エラーになる（`maxRecords` 引き上げが temp 上限を暗黙に動かさないことの固定）
