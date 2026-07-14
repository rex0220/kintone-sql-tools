# Changelog

リリースごとの変更点。v1.9.0 以前の詳細は [GitHub Releases](https://github.com/rex0220/kintone-sql-tools/releases) を参照。

## v2.0.0（2026-07-14）

### Breaking

- **すべての`LIKE` / `NOT LIKE`をJavaScript評価へ統一**。ワイルドカードなしのLIKEもkintoneの単語検索へ委譲せず、kSQL独自の部分一致（`includes`）として評価する。同じSQLが実行モードによって異なる結果を返す可能性を解消した。
- LIKEを含むSELECTは常にFULL_SCANになる。LIKE以外の安全な絞り込み条件をANDで併記しても、現時点ではWHERE全体を押し下げず全件取得する。大規模アプリでは一致件数にかかわらず全走査件数が`maxRecords`へ到達し、既定の`onLimitReached = "error"`では明示的に停止する。`truncate`を選ぶと上限以降の一致行を欠落させる可能性がある。
- **通常の親レコードに対する`UPDATE` / `DELETE`では、すべてのLIKEを拒否**。親DMLにはkSQLのLIKEをJavaScript評価する経路がないため、安全上fail-closedとする。上限エラーのないSELECTで対象レコード番号を確認し、`IN`または完全一致条件へ移行する。サブテーブルDMLは従来どおりJavaScriptで評価する。

### 変更

- `whereToKintone`はすべてのLIKE変換を拒否し、JOINのWHERE押し下げからもLIKEを除外する。
- EXPLAINはLIKE起因のFULL_SCANを「LIKEは常にJS評価のため全件取得」と表示する。
- 安全なAND述語だけをプレフィルタとして押し下げる最適化は、包含性を検証してからv2.xで別途追加する。

## v1.14.0（2026-07-14）

### Safety（互換性に影響する安全上の制限）

- **通常の親レコードに対する`UPDATE` / `DELETE`で、`%`または`_`を含む`LIKE` / `NOT LIKE`を拒否**。
  kintoneの`like`はSQLワイルドカードではなく単語検索であり、従来は意図しないレコードを更新・削除する恐れがあったため、安全上エラーに変更した。先に`SELECT`で対象レコード番号を確認し、`IN`または完全一致条件で対象を指定する。サブテーブルDMLはJavaScriptでWHEREを評価するため従来どおり使用できる。

### 修正（バグ）

- **WHERE右辺のフィールド参照・文字列関数が数値化され、文字列比較が誤結果になる問題を修正**。`文字列 = 文字列`、JOIN後の文字列突き合わせ、右辺`REPLACE(...)`を文字列のまま評価する。真の算術式と`=` / `!=`の文字列一致セマンティクスは変更しない。
- **ワイルドカード付きLIKEの結果がSIMPLEとFULL_SCANで異なる問題を修正**。`%` / `_`を含むLIKEはkintoneへ押し下げず、JavaScriptで言語仕様どおり評価する。JOINのWHERE押し下げからも除外する。

### 変更

- ワイルドカード付きLIKEを含むSELECTはFULL_SCANになる。前方一致を含め全件取得が必要になる場合があり、従来より取得量が増える可能性がある。
- EXPLAINのFULL_SCAN理由に、ワイルドカード付きLIKEなど「WHERE句にJS評価が必要な式」を表示する。

## v1.13.2（2026-07-12）

### 修正（バグ）

- **単文 `--dry-run`（EXPLAIN）のプラン出力に内部mapped APP表記が露出していた問題を修正**。
  v1.13.1ではバッチdry-runのみ`restoreSqlDiagnosticValue`で復元しており、単文dry-runは
  SELECT・DMLとも`APP900000000 (900000000)`のような内部mapped IDを表示していた。バッチdry-runと
  同じ復元を単文経路にも適用し、利用者向け出力へ内部mapped IDを露出しない（仕様§8.1）。

### 変更（表示）

- **DMLの実行計画ヘッダを仕様§9.2準拠へ**。書き込み先ラベルを`app:`から`target:`へ変更し、
  論理参照は`target: LAPP_ORDERS -> APP1234@prod`、物理参照は`target: APP1234@prod`と、
  論理名・物理ID・profileを実行前に明示する。SELECTのソース`app:`行・一時テーブルソースの
  `app:`行は従来どおり。対象は INSERT / INSERT SELECT / UPDATE / DELETE / UPSERT /
  UPSERT SELECT / REORDER。ルーティングは従来どおり物理IDへ解決され、変更は表示のみ。
  プラグインもEXPLAINエンジンをバンドルするため、クライアント側EXPLAINのDMLヘッダが
  `app:`から`target:`へ変わる（プラグインは論理アプリ非対応のため矢印形は出さず
  `target: APP<id> (<id>)`表記。挙動はEXPLAIN表示のみの変更）。

## v1.13.1（2026-07-12）

### 修正（バグ）

- **CLIで`LAPP_<NAME>`を含むSQLが失敗した際、parser・実行エラーの位置とテーブル表記を元SQLへ復元**。
  v1.13.0ではMCPだけがoffset mapを適用し、CLI stderrは正規化後SQLの位置や内部mapped APP表記を
  表示する場合があった。診断復元を`src/node/`の共通実装へ移し、CLI/MCPのparse・EXPLAIN・
  実行エラーで共有する。元Errorの型・token等は維持し、利用者向けstderrへ内部mapped IDを露出しない。
- **`runSavedQuery`の2テストをリポジトリ直下の`ksql.config.json`から独立**。
  各テスト専用の一時configを`configPath`で明示し、configが存在しないclean checkout／CIでも
  保存クエリのDML承認・`fetchParallel`転送テストが安定して実行されるようにした。

## v1.13.0（2026-07-12）

### 追加（機能）

- **論理アプリ参照 `LAPP_<NAME>` を CLI / MCP に追加**（Node.js runtime のみ。プラグインは非対象）。
  環境や配置先（開発・本番・テスト・部門）で物理アプリ ID だけが異なる同用途・同スキーマの
  アプリに対し、`FROM LAPP_ORDERS` のような論理名で同じ SQL・保存クエリを再利用できる。
  論理名は実効 profile の config `logicalApps` で物理アプリ ID へ実行前に解決される
  （例: `dev` → `APP899` / `prod` → `APP1234`）。
  - **設定**: `KsqlProfileConfig` に `logicalApps?: Record<string, number>`（キーは `LAPP_` を除いた
    ASCII 論理名 `[A-Za-z][A-Za-z0-9_]{0,63}`、値は物理アプリ ID）と `allowPhysicalAppRefs?: boolean`
    を追加。`APP100`・`100`・`LAPP_ORDERS` のようなキーは読み込み時に拒否する。
  - **構文**: `LAPP_<NAME>[$サブテーブル][@profile]`。`LAPP_` と論理名は ASCII の大小文字を区別せず、
    内部で大文字へ正規化する。既存の `APPxxx` は常に物理 ID のままで、暗黙に論理解決しない。
  - **安全性**: 未定義論理名・未知 profile は API 呼び出し前にエラー（fail closed、誤 route しない）。
    `allowPhysicalAppRefs: false`（既定 `true`）を指定した profile では、その profile を使う
    kSQL SQL 内の物理 `APPxxx` 直接参照を拒否する（他ツールや REST API までは制限しない）。
    token 要求は解決済み binding から物理 ID・profile 経由で導出し、logical binding 欠落時に
    物理 ID や single token へ fallback しない。
  - **可視化**: validation は `source`／`logicalName`／`mappedAppId`／`appId`／`profile` を返し、
    EXPLAIN・利用者向け診断・エラーは論理名・物理 ID・profile を表示して内部 mapped ID を露出しない。
  - **DELETE**: CLI は `DELETE FROM LAPP_ORDERS@prod ...` の明示 `@profile` を従来どおり拒否し、
    profile 省略時は許可する。MCP は既存 runtime の挙動どおり許可する。
  - **保存クエリ**: 論理参照をそのまま保存し、`defaultProfile` と profile override で別の物理アプリへ
    解決する。値パラメータ化とは独立。
  - 既存の `APPxxx` SQL の意味・挙動に回帰はなく、`logicalApps` を追加しただけでは既存 SQL が
    別アプリへ向くことはない（opt-in）。
  - 詳細は `docs/ksql_language_reference.md`・`docs/cli_app_profile_spec.md`・
    `docs/ksql_mcp_server_spec.md` を参照。

### 内部

- `nodeKintoneClient` の fetch タイムアウトを `AbortSignal.timeout()` から
  `AbortController` + `clearTimeout` へ変更し、リクエスト完了時にタイマーを確実に破棄する。
- subprocess を起動する E2E テストを `--runInBand` の別フェーズへ隔離し、`npm test` を
  決定的に green にする（並列プールとの競合による稀な timeout を解消）。

## v1.12.1（2026-07-11）

### 修正（バグ）

- **SQL コメント・文字列リテラル・バッククォート識別子の中に書いた `APPxxxx` を、トークン解決の対象から除外**。
  従来は `extractAppIds` が生 SQL を素の正規表現で走査していたため、
  `-- 通知(APP4206)` のようなコメントや `'APP4206の件'` のような文字列に現れた
  アプリ番号まで「参照アプリ」とみなし、profile の tokenMap に無いと
  `AuthError: token is missing for APPxxxx@profile.` で実行不能になっていた。
  `@profile` 正規化と同じスキャナ（`collectAppProfileTokens`）に統一し、
  コメント・文字列・バッククォートを除外してから APP 参照を拾うようにした。
  本文の `FROM APPxxxx`（`@profile` / `$subtable` 付き含む）は従来どおり解決する。
  誤って要求していたトークンを要求しなくなる方向のみの変更で、後方互換。
  （詳細: `docs/internal/ksql_extract_app_ids_comment_string_issue.md`）

## v1.12.0（2026-07-11）

### 変更（挙動変更）

- **GROUP BY なしの集計 SELECT は対象 0 件でも常に 1 行を返す**（SQL 標準準拠化）。
  COUNT は `0`、SUM / AVG / MAX / MIN も `0`（全値が空のグループと同じ既存規約。標準 SQL の NULL とは異なる）。
  GROUP BY が**ある**場合は従来どおり 0 行。詳細は言語リファレンス §8「0 件時の挙動」
- これにより健全性チェックの定番 `ASSERT (SELECT COUNT(*) ... WHERE 異常条件) = 0` が
  該当 0 件（健全時）に成立するようになった（従来は `AssertError: scalar subquery returned no rows` で失敗）。
  ASSERT の 0 行エラー自体は維持され、非集計プローブの空振り検出は従来どおり機能する
- 波及する挙動変更（いずれも標準準拠化の方向）:
  - `WHERE f = (SELECT COUNT(*) ...)` / SELECT 列 / UPDATE SET のスカラーサブクエリ:
    0 件集計が「値を返しませんでした」エラーではなく `0` に解決される
  - `f IN (SELECT COUNT(*) ...)`: 空集合ではなく `{0}` との照合になる
  - **`EXISTS (SELECT COUNT(*) ...)` は常に真になる**（従来は 0 件で偽 — 標準 SQL でも
    集計サブクエリは 1 行返すため EXISTS は常に真。EXISTS に集計を書くこと自体が誤用）
  - `CREATE TEMP TABLE #t AS SELECT COUNT(*) ...`: 0 件でも 1 行実体化される（列名も導出される）
  - `INSERT INTO app (...) SELECT COUNT(*) ...`: 0 件でも 1 行書き込まれる
    （従来は「SELECT の列数(0)」エラー。`dmlMaxRows` / confirm の件数判定に 1 行として乗る）

## v1.11.0（2026-07-11）

### 追加

- **`tempTableMaxRows` オプション**: 一時テーブル1個の実体化行数上限（従来 10,000 固定）を変更可能に。
  MCP `ksql_query` / `ksql_mutate` のツール引数、CLI `--temp-table-max-rows`、
  env `KSQL_TEMP_TABLE_MAX_ROWS`、profile `query.tempTableMaxRows` で指定できる
  （優先順は引数 → env → profile → 既定 10,000）。console の `:run` 子実行にも伝搬する。
  `ksql_run_saved_query` は単文限定（一時テーブルが出現しない）のため対象外
- **プラグイン: 一時テーブル上限の実行画面指定**: 「⚙ オプション → 取得」に
  「一時テーブル上限(行)」入力を追加（空欄 = 既定 10,000。スピナーは 10,000 刻み）。
  一覧ページは localStorage に永続化、レコード編集画面は保存SQL アプリの
  任意フィールド **`一時テーブル上限行`（数値）** があればレコードに保持
  （「最大取得件数」と同様。フィールドがなければ従来どおり）。
  SQL 履歴にもスナップショット保存。超過は「打ち切って続行」設定でも常にエラー

### 互換性

- 未指定時の挙動は完全に従来どおり（既定 10,000・**超過は `onLimit` 設定によらず常にエラー**。
  truncate は一時テーブルの実体化に適用されない — 暗黙の欠損が後続文を静かに歪めるため）
- 上限を引き上げるとバッチ内最大16テーブル × 指定値がメモリに滞留し得る点に注意
  （一時テーブルの参照は常にインメモリ FULL_SCAN）。まず WHERE での絞り込みを推奨

## v1.10.0（2026-07-10）

### 追加

- **ASSERT 文**: `ASSERT <式> <比較演算子> <式>` / `ASSERT <式> BETWEEN <式> AND <式>`。
  条件が成立しなければ `AssertError` で停止する実行時ゲート（DML 前の件数ガード・CLI ヘルスチェック用途）。
  read-only 扱いで単文・バッチのどちらでも実行可能。バッチ内での失敗は `continueOnError` 指定でも常に停止し、
  以降の文は `skipped`（`skippedReason: "assertion"`）になる。詳細は言語リファレンス §26
- **CLI バッチ JSON 出力**: バッチ入力 + `--format json` で、MCP と同一のエンベロープ
  （`ok` / `batch` / `statementCount` / `statements[]` / `results[]` / `warnings`）を stdout に
  単一 JSON ドキュメントとして出力（`--pretty` / `--output` 対応）。CI からバッチ全体の成否・
  文ごとの状態を機械可読に取得できる
- **requestGate 設定の公開**: 同時リクエスト上限・GET リトライ回数・バックオフを
  CLI フラグ / config / env で調整可能に（詳細は CLI 仕様書）

### 破壊的変更

- **バッチ入力 + `--format json` の CLI 出力形を置き換え**（v1.4.0 で導入した
  「SELECT 結果 JSON の空行区切り連結」を廃止）。複数 JSON ドキュメントの連結は機械可読でないため、
  上記の単一エンベロープに統一した。従来の「結果セットだけ欲しい」用途は
  `ksql -e "..." --format json | jq '.results[].rows'` で代替できる。
  単文入力の `--format json`、および `table` / `csv` / `markdown` / `jsonl` の出力は従来どおり

### 互換性

- 単文入力の既存文タイプの応答形は全ツール・CLI で不変（ASSERT は新規文タイプの追加）
- exit code の割り当ては不変（`AssertError` は 1）
- requestGate の既定値・既存の env / config 解決順は不変（公開が増えるだけ）
