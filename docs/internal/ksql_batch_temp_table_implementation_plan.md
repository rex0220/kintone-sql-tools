# バッチ実行・一時テーブル 実装計画

- 作成日: 2026-07-09
- 更新履歴:
  - 2026-07-09 R1: M4 を同一バッチ内完結に修正 / `#t@dev` 拒否を S1 レキサ担当に整理 / S3・S4 のテスト観点重複を解消
  - 2026-07-09 R2: S3 に単文 CREATE・DROP TEMP TABLE の拒否を追加 / S6 の `results` 対象を明確化
  - 2026-07-09 R3: フェーズ1・2 を v1.4.0 一括リリースに変更、M6 を新設
  - 2026-07-09 R4: S7 に console の5段判定・継続可能エラーの判定基準・テスト観点を追加
  - 2026-07-09 R5: バッチ構築モードの終端を `:run` メタコマンドに変更 / S1 に未終端ブロックコメントの `LexError` 化を追加
  - 2026-07-09 R6: S7 にバッファ非空時のメタコマンド解釈(現行 `buffer.length === 0` ガードの変更)とトークンベースのバッチ構築モード判定を追加
  - 2026-07-09 R7: S1 を `readHashIdent()` 専用分岐方式に変更(`isIdentStart` 拡張の `isIdentContinue` への波及を回避)、`APP#x` / `#a#b` / `#1` の拒否テストを追加。`ksql_cli_console_spec.md` に v1.4.0 更新予定の注記を追加
  - 2026-07-09 R8: S2 に alias 位置の `#` 識別子拒否を追加(`tryParseImplicitAlias` が `APP#x` を alias として受理する抜け道への対策)
  - 2026-07-09 R9: S2 の alias 拒否に列 alias(`parseAliasName`)を追加、テストに `SELECT 顧客名 AS #x` を追加
  - 2026-07-09 R10(S1 実装後): 継続可能判定を位置ベースから `LexError.unterminated` フラグベースに変更(未終端系の `pos` は開始位置を指すため)。S1 実装済み
  - 2026-07-09 R11(S2 実装後): 単文 API `parse()` での一時テーブル参照拒否ガードを追加(`FROM #t` が単文実行経路へ漏れて APP0 読み取り・WITH の無言空結果になる穴の対策)/ `parseSqlStatements` を `core/index.ts` から re-export。S2 実装済み
  - 2026-07-09 R12(S2 実装後): temp マーカー判定を `IDENT` に限定(バッククォートの `` `#field` `` を通常フィールド名として維持)/ `REORDER #t` の拒否テストを追加
  - 2026-07-09 R13(S2 実装後): テーブル alias 専用の `parseTableAliasName()` を新設し明示 AS(4経路)・暗黙 alias を統一(R12 の IDENT 限定化でテーブル alias の BIDENT `#x` が素通りするようになっていた穴の修正)
  - 2026-07-09 R14(S3 実装後): S3 実装済み。分類ヘルパ(dmlGuard)を core へ移動し node は再エクスポートに(core→node 依存を作らないため)。参照収集は AST 汎用ディープウォーク(`cteName` の `#` 判定)。再定義エラーは生存中のみ・DROP 後再 CREATE 許容・上限16は同時数と確定
  - 2026-07-09 R15(S3 実装後): 空バッチ(空入力・`;` のみ)を `analyzeBatch` で `ArgumentError: SQL is empty.` として拒否(`parseStatements()` が空配列を返す設計との噛み合わせ)
  - 2026-07-09 R16(S4 実装後): S4 実装済み。`executeBatch()` は実行時エラーを throw せず文ごと status で返すエンベロープ方式。DML 文内の一時テーブル参照は実行前に一括拒否(フェーズ2 M1/M4 で解禁)。timeout は Promise.race 方式で進行中リクエスト自体は中断されない(AbortSignal 伝播は P0-1 とあわせて対応)。WITH の CTE インライン化は一時テーブル注入時は無効化
  - 2026-07-09 R17(S4 実装後): サブクエリ解決(`resolveSubqueries` / `resolveScalarColumns`)へ `cteCache` を貫通(IN / EXISTS / スカラーサブクエリ内の `FROM #t` が `executeSelect` 直呼びで注入経路を外れる穴の修正。同構造だった「サブクエリ内の CTE 参照」も同時に解決)
  - 2026-07-09 R18(S5 実装後): S5 実装済み。`ValidationResult` は単文/バッチの判別可能ユニオン(バッチ側はスカラーを `undefined` 型で宣言し既存テストの型互換を維持)。`appIds` は文字列正規表現(`extractAppIds`)から AST ディープウォーク(文ごと)に変更。単文 CREATE/DROP TEMP TABLE は validate 段階で ArgumentError に(従来は ok:true で素通り)。query/mutate/saveQuery/runSavedQuery に `requireSingleStatement` ガード(S6/M1 で解除)
  - 2026-07-09 R19(S6 実装後): S6 実装済み。query のガードを解除し read-only バッチを `executeBatch` で実行、§6.2 エンベロープ(`toBatchQueryPayload`)。`maxTotalRecords` 超過は ArgumentError。バッチの `timeout` は合計タイムアウト(executeBatch の timeoutMs)と HTTP per-request の両方に同値を渡す。テスト用に `executeBatchSql` を DI 可能に
  - 2026-07-09 R20(S7 実装後): S7 実装済み。判定ロジックは `cli/consoleInput.ts` の純関数(`decideConsoleInput` / `decideRun`)+ユニットテスト21件。**仕様修正**: 「完結単文の `;` なし即実行」は現行 console の実挙動(`;` 終端)の誤認に基づくため撤回し、`;` ゲート維持の6段判定に変更(spec R20)。`@profile` は判定用パース前に正規化。console e2e は dist-cli を再ビルドして検証
  - 2026-07-09 R21(S8): 公開ドキュメント反映(言語リファレンス §25 新設・制限事項表更新 / MCP server spec 7.2.1・7.5.1 / ksql_mcp_changes 11.5)。実機検証は未実施(ユーザー実施待ち)
  - 2026-07-09 R22(S8): 公開ドキュメントの「v1.4.0 で追加」を「v1.4.0 予定・フェーズ1 実装時点」に統一(v1.4.0 最終仕様との混同防止)。リリース時に確定表記へ変える箇所を M6 のチェックリストに列挙
  - 2026-07-09 R32(実機検証 A-3 で発見): **既存バグ修正** — 集計列に alias を付けると HAVING が常に偽になる(v1.3.0 から存在。HAVING の合成名参照とグループ行の alias キーの不一致。`Number("") = 0` により無言で全滅するため気づきにくかった)。`applyGroupBy` で合成名キーを併記して修正、回帰テスト3件
  - 2026-07-09 R31(実機検証準備で発見): プラグインの `confirmDialog` が M4 の confirm("INSERT") 拡張に未追従で、INSERT_SELECT の確認が「削除します」と誤表示される実バグを修正。型エラーとして検出されていたが「desktop.ts の既存エラー除外」フィルタが新規1件を隠していた(以降は件数比較で運用: 既存10件)
  - 2026-07-09 R30(M2 レビュー反映・High×2): console の**全バッチ実行経路**に REPL 確認を差し込み — ①`:run` 経路(確認なしで子実行に `--yes` が渡っていた)、②`;` 完結の複文経路(`isBatchExec` で確認をスキップしていた)。`:run` キャンセル時はバッファ保持。③確認一覧の `app=` を `appIds`(参照先込み)から `targetAppId`(書き込み先のみ)に変更(`StatementAnalysis.targetAppId` を新設、MCP validate にも公開)。console e2e で :run / 1行複文の両経路の確認・キャンセル・バッファ保持を検証
  - 2026-07-09 R29(M2 実装後): M2 実装済み。`buildBatchDmlConfirmMessage`(バッチ全体で1回の確認一覧)+ 非バッチ確認と同じ TTY 要件。console の `confirmDmlInConsole` をバッチ対応(REPL で一覧確認 → 子実行へ --yes)。バッチサマリ(stderr)に影響件数(inserted/updated/deleted 等)を追加。言語リファレンス §25・§22 / console spec / mcp_changes の「DML バッチ対応予定」表記を解消
  - 2026-07-09 R28(M3 レビュー反映): CLI バッチのガード順を修正 — ①DML 含みバッチは dry-run でも `--allow-dml` を要求(単文と同等)→ ②dry-run はプラン表示(DML 込み可)→ ③DML バッチ実行は M2 まで拒否、の順に。従来は containsDml 拒否が先で DML バッチの dry-run が M3 のプラン生成に到達できなかった。ガード判定は allowDml 解決後に移動(分類ブロック内では未解決だった)
  - 2026-07-09 R27(M3 実装後): M3 実装済み。`buildBatchExplainPlans(sql)` を core に新設(静的検証込み・実行なし)。temp 参照文は temp-aware プラン(`resolveSelectMode` の SIMPLE 誤判定・APP0 表示を回避)。MCP `ksql_explain` バッチ分岐 + CLI `--dry-run` バッチのガード解除
  - 2026-07-09 R26(M4 実装後): M4 実装済み。`StatementAnalysis.tempOnlySource`(SELECT 側の AST 走査で APP 参照なし + temp 参照あり)で判定し、executeBatch の事前拒否と mutateBatch の静的ガードに例外を通す。`executeInsertSelect` に `cteCache` 注入 + 書き込み前の `confirm(count, "INSERT")` を追加(`ExecuteOptions.confirm` の operation に "INSERT" を拡張)。**副次的な挙動変化**: CLI の単文 INSERT_SELECT(--allow-dml)も confirm 経由の件数確認・--dml-max-rows ガードの対象になった(安全側の変化。従来は無ガード)
  - 2026-07-09 R25(M1 レビュー反映): バッチ合計タイムアウトに未解決の `input.timeout` ではなく解決済みの `runtime.timeout`(env / profile / 既定 30000ms)を渡すよう修正(S6 の query バッチ側も同修正。timeout 未指定時に合計 deadline が無効になっていた)
  - 2026-07-09 R24(M1 実装後): M1 実装済み。`mutateBatch` は静的ガード(validate-all-first)→ `executeBatch`(fail-fast 固定、confirm で文ごと dmlMaxRows + 合計 dmlTotalMaxRows を加算検査)。WHERE なし UPDATE/DELETE はパーサ段階で拒否されるため tools 層のガードは防御的併設。影響件数は `statements[]` に展開(`toMutationSummary`)
  - 2026-07-09 R23(P0-1 実装後): P0-1 実装済み。`api/requestGate.ts`(セマフォ + GET 系のみ 408/429/502/503/504・一時ネットワークエラーの指数バックオフリトライ、sleep/random 注入可能)。`withRequestGate` で MCP runtime と CLI(dry-run 除く)の client を包む。素の 500 はリトライ対象外。CB_IL02 フォールバックは統合せず併存。書き込み系はセマフォのみ(二重実行防止)。設定は `KSQL_MAX_CONCURRENT` env > `profile.query.maxConcurrent` > 既定10(プロセス内グローバルで初回固定)
- ステータス: **フェーズ1・フェーズ2 のコードステップ(S1〜S8, M1〜M4)+ P0-1 完了**。残りは実機検証(未実施)、P0-2(随時)、P0-3・M5(実機必要)、M6(v1.4.0 リリース: 実機検証後に「予定」表記の確定と一括リリース)
- 仕様: [../ksql_batch_temp_table_spec.md](../ksql_batch_temp_table_spec.md)
- 評価資料: [../multi-statement-temp-table-evaluation.md](../multi-statement-temp-table-evaluation.md)

フェーズ0(先行基盤)→ フェーズ1(read-only バッチ + 一時テーブル)→ フェーズ2(DML バッチ)の順に実装する。各ステップは独立にマージ可能な単位で切る。

---

## フェーズ0: 先行基盤(独立改善)

本体機能と独立に価値があるため先行する。P0-1 はフェーズ1 の前提、P0-3 はフェーズ2 の設計入力。

### P0-1: グローバルレートリミッタ + 429/5xx リトライ

現行実装はサブクエリ・JOIN・UNION の `Promise.all` × `fetchParallel` の乗算に無防備(`src/execute.ts:479,560,607` × `src/api/fetchAll.ts:141-145`)。

| 項目 | 内容 |
|---|---|
| 新規 | `src/api/requestGate.ts` — プロセス全体のセマフォ(同時リクエスト上限、既定 10)+ 429/503 と一時的ネットワークエラーの指数バックオフリトライ(既定 3回)。既存の `CB_IL02` リトライ(`src/cli/nodeKintoneClient.ts:85-136`)は**意味論が異なる(クエリ書き換え)ため統合せず併存**させ、requestGate はステータスコード/一時エラーのみを担当する |
| 進め方 | ①`requestGate.ts` を純モジュールとして作る(セマフォ + リトライ判定 + バックオフ。時計・sleep は注入可能にしてテスト容易性を確保)→ ②`KintoneClient` ラッパー関数(`withRequestGate(client, gate)`)として全メソッドに適用 → ③CLI(`nodeKintoneClient` 利用側)と MCP runtime の client 生成箇所に組み込み、設定解決(`KSQL_MAX_CONCURRENT` / `profile.query.maxConcurrent`)を追加 → ④疑似クライアントでの並行数・リトライ・バックオフのユニットテスト |
| 設計メモ | **リトライ分類(GET 系のみ)**: 対象 = `408` / `429` / `502` / `503` / `504` + ネットワーク層の一時エラー(fetch failed・タイムアウト中断)。対象外 = その他の 4xx(400/401/403/404 等 — 認証・バリデーションは再試行しても無駄)、`CB_IL02`(クエリ書き換えの既存フォールバックが担当)。エラー判定は `nodeKintoneClient` のエラーメッセージ形式(`kintone API error <status>: ...`)からステータスを抽出する。バックオフは指数 + ジッタ(500ms → 1s → 2s、上限 8s)。DML(POST/PUT/DELETE)のリトライは**冪等性に注意** — kintone の書き込みはリクエスト成功後の応答喪失で二重実行になり得るため、フェーズ1 時点では **GET 系のみリトライし、書き込み系はセマフォのみ適用**(リトライ解禁は bulkRequest 検証 P0-3 とあわせて判断) |
| 適用単位 | ゲートは**プロセス内グローバル1個**(profile / baseUrl 横断)。目的が `Promise.all` × `fetchParallel` の乗算による過剰同時リクエストの抑制であるため、複数 profile 同時利用でも合計で上限を掛ける安全側に倒す。ドメイン(baseUrl)単位に分けて緩めるのは将来の改善とし P0-1 では行わない。上限はプロセスで最初に解決された値で固定(優先順: `KSQL_MAX_CONCURRENT` env > profile 設定 > 既定 10) |
| 変更 | `nodeKintoneClient` 自体は変更せず、**CLI(`src/cli/index.ts`、dry-run 除く)と MCP runtime(`src/node/runtime.ts`)の合成済み `KintoneClient` に `withRequestGate()` を適用**する(HTTP 層と保護層の責務分離)。設定解決は `KSQL_MAX_CONCURRENT` env > `profile.query.maxConcurrent` > 既定 10 |
| 既知の制約 | `getApps()` は `KintoneClient` 抽象の内側でページングするため、途中ページの 429 で `getApps()` 全体が再実行される(SHOW APPS が巨大な環境では読み直しが発生)。現状の抽象では自然な実装として許容 |
| テスト | 疑似クライアントで同時実行数の上限・リトライ回数・バックオフを検証。既存 `fetchAll.test.ts` の全ケースが無変更で通ること |
| 完了条件 | `fetchParallel: 10` のクエリを複数同時に流しても同時リクエスト数が上限を超えない |

### P0-2: フィールド定義キャッシュの TTL

| 項目 | 内容 |
|---|---|
| 変更 | `src/execute.ts:1203-1206` 付近 — キャッシュエントリに取得時刻を持たせ TTL(既定 5分、`KSQL_FIELDS_CACHE_TTL` で変更可)で失効。0 で無効化(毎回取得) |
| テスト | TTL 内はキャッシュヒット / 経過後は再取得、を疑似クライアントで検証 |
| 完了条件 | 長寿命 MCP プロセスでフィールド追加が TTL 経過後に反映される |

### P0-3: bulkRequest 技術検証(スパイク)

実装はせず、フェーズ2 の設計判断材料を作る。

- 検証項目: ①最大20リクエスト/1 bulkRequest のアトミック性(失敗時ロールバック)の実挙動、②100件チャンクとの組み合わせ(20×100=2,000件が原子性の上限)、③エラーレスポンスの構造と現行エラーマッピングへの適合
- 成果物: `docs/internal/bulkrequest-spike-notes.md`(検証ログと採否判断)

---

## フェーズ1: read-only バッチ + バッチスコープ一時テーブル

### S1: レキサ — `#` 識別子

| 項目 | 内容 |
|---|---|
| 変更 | `src/lexer/lexer.ts` — **`isIdentStart` は変更せず**、`nextToken` の分岐に `#` 専用の `readHashIdent()` を追加する。`isIdentStart` に `#` を足すと `isIdentContinue` が `isIdentStart` を呼ぶ構造(`src/lexer/lexer.ts:291-293`)により `#` が識別子の**途中**にも許容され、`APP#x` や `#a#b` が1個の `IDENT` になって仕様 §4.2(`#` は先頭のみ)とズレるため。`readHashIdent()` は `#` を消費 → 直後が `isIdentStart` でなければ `LexError`(`#` 単独・`#1` はここで拒否)→ 以降は既存の `isIdentContinue`(`#` を含まない)で読む。トークン種別は既存 `IDENT`(値に先頭 `#` を含む)。`#` 識別子の直後が `@` の場合は明示メッセージの `LexError`(`@profile is not allowed on temp table #t.`)— `APP@profile` 正規化は `APP<数字>` のみが対象で `#t@dev` はレキサに素通しされるため、ここで拒否する。あわせて**未終端ブロックコメントを `LexError` 化**する(現行は `/*` が閉じずに EOF に達しても無言で受理される)。未終端系のエラー(文字列・バッククォート・ブロックコメント)は **`LexError.unterminated: true` フラグ**を持たせる — これらの `pos` は開始位置を指すため、S7 の継続可能判定は位置ではなくこのフラグで行う |
| テスト | `lexer.test.ts` — `#t` / `#集計` / `#` 単独の `LexError` / `#1` の `LexError` / `APP#x` が単一トークンにならない(`APP` と `#x` に分割)/ `#a#b` が単一トークンにならない(`#a` と `#b` に分割)/ `#t@dev` の明示エラー / 未終端ブロックコメントの `LexError`。既存ケースの無影響確認 |

### S2: パーサ — 複文 + AST

| 項目 | 内容 |
|---|---|
| 変更 | `src/types/ast.ts` — `CreateTempTableStatement` / `DropTempTableStatement` を追加。`src/parser/parser.ts` — `parseStatements(): Statement[]` を新設(`;` 区切りループ、空文スキップ、20文上限)。既存 `parse()` は `parseStatements()` の結果が1文であることを検証する形に置き換え(単文 API の互換維持) |
| 変更 | `CREATE TEMP TABLE #name AS <select>` / `DROP TEMP TABLE #name` のパース。`#` 識別子はテーブル参照位置(FROM / JOIN / CREATE / DROP)以外で `ParseError`(`#name@profile` の拒否は S1 のレキサで対応済み)。**エイリアス位置の `#` 識別子は明示的に拒否する** — `tryParseImplicitAlias()`(`src/parser/parser.ts:853-861`)は次の `IDENT` を無条件に alias として消費するため、対策しないと `APP#x`(レキサで `APP` + `#x` に分割)が「`APP` の alias `#x`」として受理されてしまう。`parseIdentifier` / `tryParseImplicitAlias` の alias 経路で値が `#` 始まりなら `ParseError`。**列 alias も同様** — `parseAliasName()`(`src/parser/parser.ts:1724-1734`)も `IDENT` を無条件受理するため、`#` 始まりを `ParseError` にする。**注意: `parseIdentifier` 自体に一律の `#` 拒否を入れないこと** — テーブル参照経路(`parseTableRef` / CREATE / DROP)は `#` を受理する必要があるため、「`#` 可(テーブル名)」と「`#` 不可(alias・その他)」の受理関数を分ける。**temp マーカーの判定はレキサが生成する `IDENT` に限定する** — バッククォート識別子(`BIDENT`)の `` `#field` `` は「# で始まる通常フィールド名」であり、フィールド位置・テーブル参照位置とも temp 扱いしない(alias 位置のみ BIDENT でも `#` 拒否) |
| テスト(alias 拒否) | `FROM APP100 #x`(暗黙 alias)/ `FROM APP100 AS #x`(明示 alias)/ `SELECT 顧客名 AS #x FROM APP100`(列 alias)/ `APP#x`・`#a#b`(レキサ分割後にパーサで拒否されること) |
| 新規 | `src/core/sql.ts` — `parseSqlStatements(sql): Statement[]` を公開し、**`src/core/index.ts` からも re-export** する(CLI/MCP は `../core` 経由で import するため。既存 `parseSqlStatement` は維持) |
| ガード | **単文 API `parse()` は一時テーブル参照を含む文を拒否する**(`temp table #t is not defined in this batch.`)。S4 のバッチ実行器が入るまで、`FROM #t` が既存の単文実行経路に漏れると `executeSelect` が APP0 を読みに行く / `executeWith` が `cteCache.get(...) ?? []` で無言の空結果を返すため。実装は `parseTableRef` の `#` 分岐で参照トークンを記録し、`parse()` の最後で検査(バッチ API `parseStatements()` は通す)。あわせて `execute()` の文タイプ switch に単文 CREATE/DROP の `ArgumentError` ガードを追加(仕様 §4.3) |
| 進め方 | 変更面が広いため次の順で小刻みに入れる: ①**既存単文互換を固定するテストを先に置く**(代表的な単文の `parse()` AST 出力をスナップショット化)→ ②`parseStatements()` 導入と `parse()` の置き換え(①が回帰を検出)→ ③`CREATE/DROP TEMP TABLE` のパース → ④alias の `#` 拒否 |
| テスト | `parser.test.ts` — 複文分割 / 空文 / 文数上限 / CREATE・DROP の構文 / `#` の位置違反 / `@profile` 拒否 |

### S3: バッチ静的検証

| 項目 | 内容 |
|---|---|
| 新規 | `src/core/batch.ts` — `analyzeBatch(statements)`: 文ごとの分類(既存 validate ロジックの流用)+ 一時テーブルの静的解決(未定義参照・再定義・DROP 後参照・個数上限 16)+ 依存グラフ(文 index → 依存する一時テーブル)。結果は仕様 §7.1 の `statements[]` 構造。**単文(1文のみの入力)の `CREATE_TEMP_TABLE` / `DROP_TEMP_TABLE` は `ArgumentError` として拒否**(仕様 §4.3) |
| 進め方 | 純追加モジュールのため、①`analyzeBatch()` の入力/出力型(`BatchAnalysis` / `StatementAnalysis`)とエラー分類(どの違反がどのエラー種別・メッセージになるか)を先に小さく固める → ②未定義参照・再定義・DROP 後参照・個数上限16 をテスト先行で1ルールずつ実装 → ③依存グラフ → ④文ごと分類(validate 流用)の順 |
| テスト | 未定義参照 / 再定義 / DROP 後参照 / 個数上限 / 依存グラフの正しさ / 単文 CREATE・DROP TEMP TABLE の拒否 |

### S4: 実行器 — バッチランナー + 一時テーブルストア

| 項目 | 内容 |
|---|---|
| 変更 | `src/execute.ts` — `executeBatch(statements, client, options)` を新設。`tempTables: Map<string, ProcessRow[]>` を全文に引き回す。`CREATE_TEMP_TABLE` は AS 句の SELECT を実行して格納(行数上限 10,000、`onLimit` 不適用で常に error)、`DROP_TEMP_TABLE` は削除。SELECT 実行時は `cteCache` と同様に `tempTables` を `executeQueryWithCte` 系へ合流させる(名前に `#` を含むため CTE と衝突しない) |
| 変更 | fail-fast / continueOnError / 依存スキップ(S3 の依存グラフ使用)、文ごとの `success` / `error` / `skipped` 記録、バッチ合計 `timeout` |
| 進め方 | ①`executeBatch` の結果エンベロープ型(`BatchExecuteResult` / 文ごとの `BatchStatementResult`)を先に固める → ②tempTables を `executeQueryWithCte` 系へ注入する最小経路(CREATE → 素の SELECT 参照)を通す → ③fail-fast → ④continueOnError + 依存スキップ → ⑤バッチ合計 timeout、の順で1機能ずつテストを付けて積む(実行面はテスト粒度を細かく保つ) |
| テスト | `execute.test.ts`(モッククライアント注入)— CREATE→参照→JOIN / fail-fast / continueOnError + 依存スキップ / 行数上限 / DROP がストアを解放すること(DROP 後参照の拒否は S3 の静的検証でテスト済み)/ タイムアウト時の文状態(中断文 = `error` + `TimeoutError`、未実行文 = `skipped: "timeout"`) |

### S5: MCP — validate 拡張

| 項目 | 内容 |
|---|---|
| 変更 | `src/mcp/tools.ts` — `ValidationResult` に `statements[]` + バッチサマリ(`batch` / `statementCount` / `isReadOnlyBatch` / `containsDml` / `tempTables`)を追加。単文入力では既存スカラーフィールドを従来どおり返す(後方互換) |
| テスト | `mcp/__tests__/tools.test.ts` — 単文の後方互換 / バッチの新形 / DML 混在バッチの分類 |

### S6: MCP — query のバッチ受理

| 項目 | 内容 |
|---|---|
| 変更 | `src/mcp/schemas.ts` — `queryInputSchema` に `continueOnError` / `maxTotalRecords` を追加。`src/mcp/tools.ts` — validate-all-first → `executeBatch` → 仕様 §6.2 のエンベロープ組み立て(`toSelectPayload` のバッチ版)。`results` の対象は結果セットを返す read-only 文すべて(SELECT / SHOW 系 / DESCRIBE / EXPLAIN — 既存実装ではいずれも `SelectResult`)で、`CREATE TEMP TABLE` の実体化結果のみ除外。DML 混在は `ArgumentError: batch contains DML statements. Use ksql_mutate.` |
| テスト | read-only バッチ実行 / `EXPLAIN`・`SHOW` を含むバッチの `results` 対応付け / 一時テーブル結果の非返却(`rowCount` のみ)/ `maxRecords` 文ごと適用 / `maxTotalRecords` / DML 混在拒否 |

### S7: CLI

| 項目 | 内容 |
|---|---|
| 変更 | `src/cli/index.ts` — `-f` の複文実行(結果セットごとの区切り表示)、`--continue-on-error` フラグ(console の子実行 argv にも伝播)。`--console` は仕様 §8.2 の**6段判定**に変更(R20 で「完結1文の `;` なし即実行」を撤回し `;` ゲート維持): ①メタコマンドはバッファ状態問わず解釈、②バッチ構築モードは `:run` まで蓄積→バッチ実行(バッファ内空行は保持)、③行末 `;` までは蓄積(従来互換)、④`;` 終端で完結したら単文/複文を実行、⑤継続可能な失敗は蓄積、⑥それ以外は即エラー + バッファ破棄。メタコマンド `:run` を既存体系に追加。破棄は既存 `:clear` を流用 |
| 進め方 | ①console の入力判定(6段)を**純関数として切り出す**(入力: バッファ + 新規行 → 出力: 実行/蓄積/エラー/メタコマンドの判定結果)— console の状態機械が最も事故りやすいためユニットテストで固める → ②`:run` とバッファ非空メタコマンド解釈を小さく確定 → ③`-f` の複文実行は `executeBatch` の既存 payload を CLI 表示へ落とすだけに寄せる |
| 実装メモ1 | **メタコマンドはバッファ非空でも解釈する**。現行はバッファ空のときのみ解釈(`src/cli/index.ts:1020` の `buffer.length === 0` ガード)のため、`:` 始まりの行はバッファ状態に関わらず `parseConsoleMetaCommand` に通す構造へ変更する。`:run` / `:clear` / `:buffer` / `:edit` が SQL としてバッファに混入してはならない |
| 実装メモ2 | バッチ構築モードの判定は文字列前方一致ではなく、①レキサでバッファ先頭をトークン化し(空白・コメントは自動スキップされる)先頭3トークンが `CREATE TEMP TABLE` か、②`parseStatements()` 成功時に `CREATE_TEMP_TABLE` 文を含むか、の**いずれか**。先頭コメント付きの貼り付けは①で、先頭以外の `CREATE TEMP TABLE` は②で拾う |
| 実装メモ3 | 「継続可能な失敗」の判定は2系統: ①`LexError` は **`unterminated` フラグ**(S1 で導入済み。未終端の文字列・バッククォート・ブロックコメントで true。これらの `pos` は開始位置を指すため**位置では判定しない**)、②`ParseError` は**エラートークンが EOF を指すこと**(句の途中・閉じ括弧待ちなど)。それ以外の `LexError` / `ParseError` は即エラー |
| ドキュメント | `docs/ksql_cli_console_spec.md` に入力方式の変更と `:run`(およびバッファ非空時のメタコマンド解釈)を追記 |
| テスト | 判定ロジックのユニットテスト — 未完入力(`SELECT * FROM`)は継続 / typo(`SELEC * FROM APP1`)は即エラー + バッファ破棄 / 単一行複文は即バッチ実行 / `CREATE TEMP TABLE` 開始は完結後も蓄積され `:run` でバッチ実行 / **先頭にコメント行を付けた貼り付けでもバッチ構築モードに入る** / **バッファ非空時の `:run`・`:clear` がメタコマンドとして処理され SQL に混入しない** / バッチ構築モード中の空行がバッファに保持される / 未閉じ文字列・括弧は継続。+ 手動確認手順 |

### S8: ドキュメント・フェーズ1 検証

- `docs/ksql_language_reference.md` — バッチ・一時テーブルの章を追加、制限事項表を更新(一時テーブルスコープ / FULL_SCAN / 非トランザクション)
- `docs/ksql_mcp_server_spec.md` / `docs/ksql_mcp_changes.md` — ツール入出力の変更を反映
- `ksql_mcp_verification_setup.md` の手順で実機検証
- **この時点ではリリースしない**(フェーズ1・2 を v1.4.0 として一括リリースするため。main へのマージまで)

### フェーズ1 完了条件

- 付録の「相関サブクエリの回避」例が MCP(`ksql_query`)と CLI(`-f` / `--console`)で動作する
- 単文入力の既存テスト(404ケース)が全件無変更で通る

---

## フェーズ2: DML を含むバッチ

### M1: ksql_mutate のバッチ受理

- `mutateInputSchema` に `dmlTotalMaxRows` を追加(`continueOnError` は追加しない — DML バッチは常に fail-fast)
- validate-all-first → `executeBatch`。`dmlMaxRows` を文ごと適用、`dmlTotalMaxRows` 指定時は合計影響行数もガード
- 結果エンベロープに文ごとの反映状態を明示(途中失敗時に「どこまで反映されたか」が読み取れること)

### M2: CLI の DML バッチ確認

- 確認プロンプトをバッチ全体で1回に。全 DML 文の一覧(タイプ / 対象アプリ / WHERE 有無)を表示

### M3: バッチ EXPLAIN

- `ksql_explain` のバッチ対応(全文プランの配列)。一時テーブル参照文には「FULL_SCAN(インメモリ)/ 実体化前のため行数不明」を明示

### M4: 一時テーブル経由の INSERT_SELECT 解禁

- `ksql_mutate` で `INSERT INTO APPxxx SELECT ... FROM #t` を、SELECT ソースが一時テーブルのみの場合に受理
- 一時テーブルはバッチスコープのため、**`CREATE TEMP TABLE` と `INSERT_SELECT` は同一の `ksql_mutate` バッチ内に含める**(呼び出しをまたぐ参照は不可)。事前プレビューは `ksql_query` で同等バッチを実行する運用(仕様 §7.3・付録)
- 実体化済み行数に対して `dmlMaxRows` を適用(書き込み前に件数確定)
- kintone アプリ直接ソースの `INSERT_SELECT` は引き続き拒否(既存エラー維持)

### M5: bulkRequest 適用判断

- P0-3 の検証結果を受けて、DML 書き込みチャンクへの bulkRequest 採用可否を決定
- 採用時: `src/converter/dmlToKintone.ts` の書き込み層を差し替え、2,000件以下の単一 DML 文に原子性を提供。結果エンベロープに `atomic: true/false` を追加

### M6: ドキュメント・リリース(v1.4.0)

- フェーズ2 分のドキュメント反映(`ksql_language_reference.md` / `ksql_mcp_server_spec.md` / `ksql_mcp_changes.md`)
- **フェーズ1 時点の「フェーズ2で対応予定」文言の更新**: `ksql_language_reference.md` §25 冒頭注記と §22 制限事項表の「DML を含むバッチ」行 / `ksql_mcp_changes.md` 11.5 の見出しと `ksql_mutate` 行 / `ksql_mcp_server_spec.md` 7.2.1・7.5.1 見出し / `ksql_cli_console_spec.md` §5.2 注記(いずれも「予定」表記を確定に変える)
- `ksql_mcp_verification_setup.md` の手順で実機検証(DML バッチを含む)
- **フェーズ1・2 を合わせて v1.4.0 として一括リリース**

### フェーズ2 完了条件

- 付録の「2段階 DML フロー」例が、`ksql_query` のプレビューバッチ(CREATE + COUNT)→ `ksql_mutate` の本実行バッチ(**CREATE + INSERT_SELECT を同一バッチに含む**)の2呼び出しで動作する
- DML バッチの途中失敗テストで、反映済み / 未実行の文が結果から正しく読み取れる

---

## テスト戦略

- 既存 404 ケース / 17 ファイルの無変更通過を各ステップのマージ条件とする(後方互換の担保)
- バッチ実行のテストは `execute.test.ts` と同じモッククライアント注入方式でネットワーク無しに行う
- フェーズ完了時に `ksql_mcp_verification_setup.md` の実機検証を実施

## リスクと緩和

| リスク | 緩和 |
|---|---|
| `#` 識別子の追加が既存レキサ挙動に影響 | S1 を独立 PR にし、既存レキサテスト全件 + `#` を含む既存エラーメッセージ系のケースを確認 |
| `parse()` → `parseStatements()` 置き換えの回帰 | 単文経路は「1文であることの検証」に限定し、既存 AST 出力をスナップショット比較 |
| バッチのペイロード肥大(LLM コンテキスト圧迫) | 一時テーブル結果の非返却(仕様 §6.2)+ `maxTotalRecords`。実測はフェーズ1 の実機検証で確認 |
| DML バッチの途中失敗の運用混乱 | fail-fast 固定 + 文ごと状態の明示 + ドキュメントの制限事項(仕様 §10)。bulkRequest(M5)で部分的に緩和 |

## ステップ依存関係

```
P0-1 ──────────────┐
P0-2(独立)        │
P0-3 ──────→ M5    │
                   ▼
S1 → S2 → S3 → S4 → S6 → S7 → S8   (フェーズ1)
              └──→ S5 ─┘
                        ▼
              M1 → M2 / M3 / M4 / M5 → M6(v1.4.0 一括リリース)
```

リリースは M6 の1回のみ(フェーズ1・2 同時)。フェーズ1 完了時点(S8)では main へのマージまでとする。フェーズ0 は独立して随時リリース可。
