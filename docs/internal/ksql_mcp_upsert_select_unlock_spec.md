# DML ガード追加調査と UPSERT_SELECT 解禁 仕様案

- 作成日: 2026-07-10
- ステータス: **レビュー済み・確定(codex R1〜R3)**。実装は実装計画に従う
- 実装計画: [ksql_mcp_upsert_select_implementation_plan.md](ksql_mcp_upsert_select_implementation_plan.md)
- 経緯: v1.5.0 の INSERT_SELECT 解禁(`ksql_mcp_insert_select_app_source_spec.md`)後、「他の DML にも同種の仕様上の制限はないか」の調査で発見した2件への対応
- 提案A: UPSERT の dmlMaxRows / dmlTotalMaxRows に関するドキュメントと実装の食い違い修正(doc-drift)
- 提案B: `UPSERT_SELECT`(APP ソース)の `ksql_mutate` 解禁
- 関連: `docs/ksql_mcp_server_spec.md` §7.6〜§7.6.4、`docs/ksql_batch_temp_table_spec.md` §7.3

---

## 1. 調査結果(DML ごとの仕様上の制限と評価)

| # | 制限 | 層 | 評価 |
| --- | --- | --- | --- |
| 1 | UPDATE / DELETE / REORDER の WHERE 必須(REORDER は明示 `ALL` で全件可) | パーサ(`src/parser/parser.ts:1637, 1729, 1769`) | **現役の設計判断**。全経路(CLI / プラグイン / MCP)に一貫。対応不要 |
| 2 | `UPSERT_SELECT` の MCP 拒否(単文・バッチとも) | MCP(`src/mcp/tools.ts` の2箇所) | **根拠が失効している疑い濃厚**。INSERT_SELECT と同型(→ 提案B) |
| 3 | 「UPSERT の影響行数は `dmlTotalMaxRows` 対象外」というドキュメント記述 | ドキュメント/コメントのみ | **実装と食い違い**(実装が安全側)。INSERT_SELECT の §7.6「confirm が呼ばれない」と同型の doc-drift(→ 提案A) |
| 4 | DML 文中の一時テーブル参照(UPDATE のサブクエリ等)の拒否 | エンジン(`src/execute.ts` executeBatch / executeBatchStatement) | **純粋な未実装**(`not supported yet`)。歴史的失効ではない。将来課題のまま |

### 1.1 調査の根拠(コード)

- `executeUpsert`(VALUES 形式)は既存レコード照合後・書き込み前に `confirm(toInsert.length + toUpdate.length, "UPDATE")` を呼ぶ(`src/execute.ts:1997-2002`)
- `executeUpsertSelect` も同じフローを実装済み: source SELECT → 列数・キー検証 → 既存レコード照合 → **confirm → POST/PUT**(`src/execute.ts:2509-2526`)。これは MCP 仕様書 §7.6.3 が「UPSERT_SELECT 対応時の想定フロー」として挙げた手順そのもの
- この confirm は**公開リポジトリ初回コミット(2026-04-07)から存在**(`git log -S` で確認)。MCP 仕様書(2026-05)の「件数が照合後まで確定しないため拒否」は、confirm がその照合後に呼ばれる実装を考慮していない
- `mutateBatch` の confirm 実装は operation を問わず `totalAffected += count` する(`src/mcp/tools.ts` mutateBatch)ため、UPSERT / UPSERT_SELECT の件数は実際には `dmlMaxRows`(文ごと)と `dmlTotalMaxRows`(合計)の**両方の対象**
- `getInsertValuesCount` は `type !== "INSERT"` で null を返す(`src/core/dmlGuard.ts:56-61`)ため、UPSERT の静的カウントはなく**二重計上もない**
- 照合読み取り(`resolveUpsertTargets`、`src/execute.ts:1342-`)は**第1キーの値のみ**を `in (...)` チャンクで検索し(複合キーの残りは取得後にメモリ照合)、各 fetch は `options.maxRecords` で拘束される。検索するキー値の個数はソース行数以下だが、**取得行数は第1キーの選択性に依存**する(詳細は §3.4-2)

## 2. 提案A: UPSERT ガードの doc-drift 修正

実装は正しい(安全側)ため、**コード変更なし**。ドキュメント・コメント・回帰テストのみ。

### A-1 修正箇所

| 箇所 | 現行 | 修正 |
| --- | --- | --- |
| `docs/ksql_batch_temp_table_spec.md` §7.3 | 「**UPSERT の影響行数は対象外**(単文 ksql_mutate の挙動と同等。将来課題)」 | 「UPSERT / UPSERT_SELECT は confirm(insert + update 合計)経由で実行時加算され、`dmlMaxRows` / `dmlTotalMaxRows` の**対象**」に修正 + 更新履歴 Rn 追記 |
| `src/mcp/tools.ts` mutateBatch のコメント(「INSERT は静的、UPDATE / DELETE は confirm で加算」) | UPSERT / INSERT_SELECT / REORDER が漏れている | 「INSERT(VALUES)は静的、confirm を呼ぶ文種(UPDATE / DELETE / UPSERT / INSERT_SELECT / REORDER)は実行時加算」に修正 |

MCP 仕様書 §7.6.4 の「UPDATE / DELETE / UPSERT / REORDER は confirm を呼ぶ」は実装と一致しており修正不要(v1.5.0 で INSERT_SELECT 追記済み)。

### A-2 回帰テスト(ドキュメント修正の裏付け)

`src/mcp/__tests__/tools.test.ts` に追加:

1. 単文 UPSERT(VALUES): 照合結果の合計件数が `dmlMaxRows` 超過なら書き込み前に `ArgumentError`(POST / PUT 未実行)
2. バッチ: INSERT VALUES(静的)+ UPSERT(confirm)の合計が `dmlTotalMaxRows` 超過で fail-fast(報告値が正しい合計であること = 二重計上なしの証明。INSERT_SELECT の既存テストと同型)

### A-3 搭載先

コード変更なし(テスト追加のみ)のため、**未 push の v1.5.0 ブランチ(`feat/mcp-insert-select-app-source`)への同乗が可能**。独立コミットとして分ける。

## 3. 提案B: UPSERT_SELECT(APP ソース)の解禁

### 3.1 現状の挙動

| ケース | 現状 | 判定箇所 |
| --- | --- | --- |
| 単文 `UPSERT INTO APPx (...) SELECT ... FROM APPy ON DUPLICATE (...)` | 拒否 `UPSERT_SELECT is not supported by ksql_mutate yet.` | `src/mcp/tools.ts` mutate 単文経路 |
| バッチ内・APP ソース | 拒否(同メッセージ + statement 番号) | `src/mcp/tools.ts` mutateBatch 静的ガード |
| 一時テーブルソース(バッチ内) | 拒否 `temp table references in UPSERT_SELECT are not supported yet.` | エンジン層(`src/execute.ts` executeBatch 事前チェック) |
| CLI / プラグイン(単文) | **実行可能**(確認 UI 付き) | 制限は MCP 層のみ |

### 3.2 解禁の根拠(INSERT_SELECT との対比)

MCP 仕様書 §7.6 の拒否理由と現状:

| 拒否理由 | 現状 |
| --- | --- |
| 件数が既存レコード照合後まで確定しない | confirm は**照合後・書き込み前**に呼ばれる(`src/execute.ts:2509-2514`)ため、`dmlMaxRows` ガードは確定件数に対して効く。失効 |
| 照合コスト(大量 API call) | source SELECT は `maxRecords = dmlMaxRows + 1`(`onLimit = "error"`)で拘束される。照合はユニークキー組(≦ source 行数)の**第1キーのみ**の `in (...)` チャンク検索で、各 fetch も同 maxRecords 拘束(超過は安全側エラー。上限なしの読み取りは発生しない)。ただし読み取り**量**の拘束であって「source 行数に比例」ではない点に注意(§3.4) |
| `dmlMaxRows` の意味の曖昧さ(insert / update 混在) | 実装は **insert + update 合計**を confirm に渡す。曖昧さは「未定義」ではなく「明文化されていない」だけ → describe / description / 仕様書で合計と明記して解消(§3.4) |

また、**UPSERT(VALUES 形式)は現在すでに MCP で許可されており、confirm 前に同じ照合読み取りを行う**。UPSERT_SELECT が追加するのは source SELECT(拘束済み)だけであり、「確認前読み取り」の性質は許可済みの UPSERT と同等。

### 3.3 スコープ

1. **単文の APP ソース UPSERT_SELECT を解禁**(tools.ts 単文経路の throw 削除)
2. **バッチ内の APP ソース UPSERT_SELECT を解禁**(mutateBatch 静的ガードの throw 削除)

非スコープ:

| 項目 | 扱い | 理由 |
| --- | --- | --- |
| 一時テーブルソースの UPSERT_SELECT | 従来どおり拒否 | `executeUpsertSelect` が `cteCache` 非対応(**エンジン未実装**)。INSERT_SELECT(M4 で対応済み)とは逆の非対称になる点に注意 — 解禁後は「INSERT_SELECT は両ソース可・UPSERT_SELECT は APP のみ」 |
| confirm operation の `"UPSERT"` 化 | 本提案では現状維持(`"UPDATE"` のまま) | §3.5 の設計判断参照 |
| DML 内の一時テーブル参照全般 | 従来どおり拒否 | エンジン未実装(調査結果 #4) |

### 3.4 安全モデル(すべて既存機構)

単文・バッチとも `mutate()` の既存経路に乗る:

1. `requireDmlApproval`(allowDml / confirmText / dmlMaxRows)
2. ランタイム: `maxRecords = dmlMaxRows + 1`、`onLimit = "error"` → source SELECT と照合 fetch の読み取り拘束
3. `executeUpsertSelect`: source SELECT → 列数・キー検証 → 照合 → `confirm(toInsert + toUpdate, "UPDATE")` → 超過なら **POST / PUT とも未実行**で `ArgumentError`
4. バッチ: confirm 経由で `totalAffected` に加算 → `dmlTotalMaxRows` 判定(提案A で明文化するとおり既存実装で機能)

**既知の制約(重要)**:

1. INSERT_SELECT と異なり一時テーブルソースがエンジン未対応のため、**集計・JOIN で読み取りが `dmlMaxRows + 1` を超えるソースに迂回路がない**。エラーメッセージ・ツール説明文で「一時テーブルに逃がす」案内を**書いてはならない**(UPSERT_SELECT では嘘になる)。回避したい場合の運用は「read-only SELECT で事前確認 → dmlMaxRows を適切に設定」のみ
   > **v1.7.0 注記**: 一時テーブル・混在ソースの UPSERT_SELECT は v1.7.0 で解禁され、この制約は **source / JOIN 側について解消**した(書き込み先 APP への照合読み取りはソース種類に関わらず残る)。`docs/internal/ksql_mcp_insert_select_mixed_source_spec.md` 参照
2. **照合読み取りは第1キーのみで検索する**(`resolveUpsertTargets`、`src/execute.ts:1380-1382`。複合キーの残りは取得後にメモリ上で照合)。そのため **target アプリ側で第1キーの重複が多い(低選択性)場合、source が1行でも照合 fetch が `dmlMaxRows + 1` を超えて読み取り上限エラーになり得る**。書き込み前の安全側の失敗であり解禁のブロッカーではないが、「ソース行数が少ないのに上限エラーになる」ケースとして利用者・MCP クライアントが遭遇し得る。第1キーには選択性の高いフィールド(コード・ID 等)を使うのが前提(UPSERT VALUES 形式でも同じ特性)

**表記上の既知課題**: confirm の operation が `"UPDATE"` のため、超過時のエラーは `UPDATE affected rows (N) exceed dmlMaxRows (M)` となる(UPSERT なのに UPDATE 表記)。VALUES 形式の UPSERT で既に同じ表記であり、本提案では許容する(§3.5)。

### 3.5 設計判断

1. **新フラグなし**(INSERT_SELECT 解禁と同判断。§7.6.2-3 の不採用理由がそのまま適用される)
2. **confirm operation は `"UPDATE"` のまま**(推奨)。`"UPSERT"` を union に追加する案は、`ExecuteOptions.confirm` の型変更が CLI 確認プロンプト・プラグイン確認ダイアログ・バッチ confirm 等の全消費箇所に波及する。許可済みの UPSERT(VALUES)が既に `"UPDATE"` 表記で運用されており、UPSERT_SELECT だけ直す理由が弱い。直すなら §7.6.3 の object 引数化(将来課題)とセットで別対応
3. **`dmlMaxRows` の意味は「insert + update の合計」と明文化**(describe / description / 仕様書)。UPSERT(VALUES)にも同じ意味論が既に適用されているため、新規の意味付けではなく明文化

### 3.6 変更点一覧

| ファイル | 変更 |
| --- | --- |
| `src/mcp/tools.ts` | 単文経路の `UPSERT_SELECT is not supported by ksql_mutate yet.` throw を削除 / mutateBatch 静的ガードの同 throw を削除(計2箇所。v1.5.0 と同型) |
| `src/mcp/index.ts`(ksql_mutate description) | 「UPSERT ... SELECT is rejected.」を「UPSERT INTO app ... SELECT is supported (apps source only; the cap counts inserts + updates).」等に変更。文言はレビューで確定 |
| `src/mcp/schemas.ts` | `dmlMaxRows` describe(mutate / runSavedQuery の両方)の source SELECT read cap 文言を INSERT / UPSERT 共通表現に更新し、UPSERT_SELECT は insert + update 合計と追記 |
| `scripts/mcp-smoke.mjs` | mutateKeys の `"UPSERT ... SELECT is rejected"` を新文言キーに差し替え(**assertion 先行 → 旧バンドルで失敗確認 → 適用**の regression 証明手順。v1.5.0 U5 と同じ) |
| `docs/ksql_mcp_server_spec.md` | §7.6 許可リストに UPSERT_SELECT 追加・拒否リスト整理。§7.6.1〜§7.6.3 の達成状況更新(段階対応 5 を「済」に)。§7.6.3 の「UPSERT_SELECT 対応時の想定フロー」を実装済みフローに書き換え |
| `docs/ksql_batch_temp_table_spec.md` | §7.3・§9 更新(提案A とあわせて) |
| `docs/ksql_mcp_changes.md` | 変更履歴追加(挙動変化: 従来エラーだった呼び出しが書き込みを行う) |
| テスト(`src/mcp/__tests__/tools.test.ts`) | 単文 UPSERT_SELECT: 成功(insertedCount / updatedCount)/ 合計件数 dmlMaxRows 超過で POST・PUT とも未実行 / source 読み取り上限超過 / **照合読み取り上限: source 1行でも target の第1キー一致行が `dmlMaxRows + 1` 超なら POST・PUT 未実行で失敗**(R2)/ バッチ内成功 / dmlTotalMaxRows 合算 / **一時テーブルソースは引き続きエンジン層で拒否**(回帰) |

### 3.7 受け入れ基準

1. 単文・バッチの APP ソース UPSERT_SELECT が実行でき、`insertedCount` / `updatedCount` が返る
2. 照合後の合計件数が `dmlMaxRows` 超過なら **POST / PUT とも1件も実行されず** `ArgumentError`
   2b. source 1行・target の第1キー一致行が `dmlMaxRows + 1` 超の場合も、書き込み前(照合 fetch)に失敗する(安全側エラーの確認。R2)
3. `dmlTotalMaxRows` に insert + update 合計が加算される(二重計上なし)
4. 一時テーブルソースの UPSERT_SELECT は従来どおり実行前拒否(エンジン層メッセージ)
5. INSERT_SELECT(v1.5.0)・UPSERT(VALUES)・WHERE ガードは回帰しない
6. ツール説明文・仕様書に「UPSERT_SELECT 非対応」の記述が残らず、「一時テーブルに逃がす」誤案内も書かれていない

## 4. バージョンと搭載先(R3 ですべて確定)

1. **提案A**: v1.5.0 ブランチ(`feat/mcp-insert-select-app-source`)に**独立コミットで同乗**(確定)
2. **提案B**: **v1.6.0**・別ブランチ(確定。v1.5.0 は INSERT_SELECT 解禁として切り出し、実機確認の焦点を絞る)
3. operation 表記: **現状維持**(確定。`"UPSERT"` 化は将来の confirm object 引数化とセットで扱う)
4. description 文言(確定): `UPSERT INTO app ... SELECT is supported for app sources only; dmlMaxRows counts inserts + updates. Temp-table sources are not supported.`(APP source only と temp 不可を明示)

## 更新履歴

- R4(2026-07-10、codex・Medium): §1.1 の照合読み取りの説明に R2 前の表現(「ユニークキー組を検索」「キー組数はソース行数以下」)が残っていたため、第1キーのみ検索・取得行数は選択性依存の表現に統一(§3.2 / §3.4 と同期)。あわせて実装計画 A2 のコメント修正案に `REORDER` を追加(Low。`executeReorder` も confirm を呼ぶため)
- R3(2026-07-10、codex レビュー完了): 追加指摘なし。未決事項4点を確定(A は v1.5.0 ブランチ同乗 / B は v1.6.0 別ブランチ / operation 表記は現状維持 / description 文言は codex 案を採用)。ステータスを「レビュー済み・確定」に変更し、実装計画ドキュメントを作成
- R2(2026-07-10、codex・Medium): §3.2 / §3.4 の照合読み取り評価を修正 — 「読み取り増幅は書き込み上限に比例拘束」は過大な主張だった。照合は第1キーのみの `in (...)` 検索(`src/execute.ts:1380-1382`。複合キーの残りはメモリ照合)のため、target 側の第1キーが低選択性なら source 1行でも読み取り上限エラーになり得る(安全側の失敗)。§3.4 既知の制約 2 に明記し、受け入れ基準 2b・テスト計画に「source 1行・第1キー低選択性」ケースを追加。あわせて codex が提案A の実装整合(executeUpsert / executeUpsertSelect の confirm)と temp ソース非スコープ判断(AST が SelectStatement 固定・temp 注入経路なし)を確認済み
- R1(2026-07-10): 初版(v1.5.0 実装完了後の追加調査に基づく。調査結果 §1 は codex 未レビュー)
