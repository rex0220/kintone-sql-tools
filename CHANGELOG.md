# Changelog

リリースごとの変更点。v1.9.0 以前の詳細は [GitHub Releases](https://github.com/rex0220/kintone-sql-tools/releases) を参照。

## v2.15.0（2026-07-16）

### 機能追加

- **B14 一時テーブル／CTEへ列型メタを伝播**。素通し列、集約、算術、リテラルおよび `$err_*` 列の確定した型を実体化後も保持し、後段の `MIN` / `MAX` がテキスト・日時を辞書順、数値を数値順で比較できる。型を安全に確定できない列は従来経路を維持する。
- **B16 文字列集約 `GROUP_CONCAT([DISTINCT] 引数 [SEPARATOR '区切り'])` を追加**。空値を除外し、既定はカンマ、`DISTINCT` は初出順、区切り文字には文字列リテラルを指定できる。結果は暗黙に切り捨てず、空グループは空文字を返す。一時テーブル／CTE、文字列関数内、HAVING／ORDER BY の alias、後段 SELECT／UNION に対応する。`GROUP_CONCAT(*)` は `ParseError` とする。
- `GROUP_CONCAT` は新しい予約語。同名フィールドはバッククォートで参照できる。厳密には構文互換性リスクがあるが、`KLIKE` 追加時と同じ方針で minor リリースとする。`SEPARATOR` はソフトキーワードのため同名フィールドを壊さない。

### 修正（バグ）

- **B18 DML事前検証がミリ秒付きDATETIMEを誤って拒否する不具合を修正**。`NOW()` / `SET @now = NOW()` が返す `2026-07-16T11:21:25.174Z` のような小数秒付きISO日時を `VALIDATE ONLY` と `ON ERROR SKIP` で受理し、kintoneへ書き込める正常行の誤隔離を防ぐ。任意桁の小数秒とタイムゾーンオフセット形式に対応し、DATE/TIMEフィールドの判定は変更しない。

## v2.14.1（2026-07-16）

### 修正

- **B15 `IN` / `NOT IN` のリストで負数リテラルが `ParseError` になる不具合を修正**。`WHERE 金額 IN (-1)` が「IN リストには文字列、数値、またはバッチ変数が必要です」で失敗していた。`WHERE 金額 = -1` や `BETWEEN -10 AND 10` は同じ負数を受理するため非対称な制限で、回避策は `OR` 展開しかなかった。単項 `-` / `+` に続く数値を受理し、符号を数値へ畳み込む。`IN (+1)` は `IN (1)` と同値。`IN ('-1')` は従来どおり**文字列**のまま（`-1` は引用符なし、`'-1'` は引用符付きで kintone へ押し下げる）。符号の直後が数値でない場合（`IN (-)` 等）は従来と同じメッセージで `ParseError` とする。受理範囲の拡大のみで、既存の動作するクエリの挙動は変わらない。

## v2.14.0（2026-07-16）

### 機能追加

- **B13 実アプリの文字列・日時フィールドを `MIN` / `MAX` で集約可能にした**。NUMBER と数値形式 CALC は従来の数値比較を維持し、テキスト、選択、正規化済み DATE/TIME/DATETIME と文字列形式 CALC は UTF-16 辞書順で比較する。型はフォーム定義から解決し、同一 `cacheContext` では既存キャッシュを共有する。JOIN の修飾列と一意な非修飾列にも対応し、同名競合、非対応複合型、temp/CTE 経由は後方互換のため従来の数値経路を維持する。文字列集約は `UPPER(MIN(text))` 等へ文字列として渡し、算術式では明示的に数値化する。

## v2.13.0（2026-07-16）

### 機能追加

- **B12-A `VALIDATE ONLY` を追加**。親レコードの `INSERT` / `UPSERT` / `UPDATE`（VALUES、SELECT、`UPDATE ... FROM`を含む）をkintoneへ書き込まず全候補行検証できる。必須、型、範囲、文字列長、選択肢、UPSERTキーを安定エラーコードで収集し、1行複数エラーを返す。複文では `INTO #err` に原子的に作成・追記して後続文から参照できる。
- `VALIDATE ONLY` はread-onlyとしてMCP `ksql_query`、CLI、プラグインからDML承認なしで実行できる一方、完全入力を要求するためtruncate設定を常にerrorへ上書きする。通常DMLのAST・変換・確認・書き込み経路は維持する。
- **B11.1 `UPDATE ... FROM` の業務キー結合を追加**。従来の `$id = source.key` に加えて、更新先とソースの文字列（1行）／数値フィールドを単一等値で結合できる。ソース重複はPUT前エラー、ターゲット重複は同じソース値で全件更新する。数値キーは `Number()` を使わず10進文字列として正規化し、64文字超の文字列キーはkintoneの前方一致による過剰取得をローカル全文一致で除外する。通常実行と `VALIDATE ONLY` は同じ照合処理を共有し、ターゲット取得は全チャンク合計 `maxRecords` を超えるとfail-closedで停止する。
- **B12-B `ON ERROR SKIP INTO #err [REJECT LIMIT n]` を追加**。親レコードの `INSERT` / `UPSERT` / `UPDATE` で、`VALIDATE ONLY` と同一のTier 0検証に失敗した行を一時テーブルへ隔離し、合格行だけを100件チャンクで書き込む。全候補を検証してから隔離後の件数へ `dmlMaxRows` / `dmlTotalMaxRows` を適用し、REJECT LIMIT超過時は書き込みゼロのまま診断結果を返す。UPSERT照合とSELECT/UPDATE対象のmaterializeは1回だけ行い、API書き込みエラーは従来どおりfail-fastとする。

## v2.12.0（2026-07-16）

### 機能追加

- **`UPDATE ... FROM` によるアプリ間・一時テーブルからの転記に対応**。ソースは `APP<n>[@profile]` またはバッチ内 `#temp`、結合は更新先 `$id = source.key` の単一等値に限定する。複数マッチ・不正キー・列欠落・非対応複合型・読み取り上限超過は最初の PUT 前に fail-closed で停止する。対象取得は50件ずつに分割し、MCPではソース読み取りを `dmlMaxRows` ではなく通常の `maxRecords` で制御する。

## v2.11.0（2026-07-16）

### 修正（バグ）

- **0 行の `SELECT *` が一時テーブル・CTE 経由で出力列を失う問題を修正**（正しさ）。一時テーブル・CTE を行だけでなく**列スキーマも保持**して実体化するようにし、`JOIN` なし単一ソースの 0 行 `SELECT *` に保存列を伝播する。これにより**差分バッチの空日**に `INSERT/UPSERT … SELECT * FROM #empty_temp` が `insertedCount=0` の no-op として正常完走する（従来は「SELECT の列数（0）と一致しません」で停止）。明示列は v2.1.1 で対応済み。混在ワイルドカード（`SELECT *, a`）は 0 行でも明示列を復元する（`*` は列に寄与しない＝1 行以上と同じ）。`JOIN` を伴う 0 行 `SELECT *`・実アプリ直参照の bare `SELECT *`・`_p.*` は対象外（現状維持）。

### 安全性

- **CLI の DML 実行で `--on-limit truncate` によるソースの暗黙切り捨てを防止**。SELECT ベース DML（`INSERT/UPSERT … SELECT`）の CLI 実行で、`--on-limit`（/ `KSQL_ON_LIMIT` / profile `query.onLimit`）が `truncate` のとき、ソース SELECT が `maxRecords` で黙って切り捨てられ**部分書き込み**になっていた。CLI の DML 実行（単文・バッチとも）では `onLimitReached` を常に `error` に固定する（MCP・プラグインと同じ扱い）。`truncate` が明示されていたときのみ stderr に注記を出す。read-only SELECT の `truncate` は従来どおり。

### 性能改善

- **SIMPLE SELECT の `LIMIT > 500` を安全な範囲で早期停止**。`ORDER BY` がなく KLIKE を含まないクエリは、`OFFSET + LIMIT` 件を取得した時点で正常終了する。たとえば一致 10,000 件の `LIMIT 1000` は、500 件ずつの GET 20 回相当から 2 回へ削減される。
  - `ORDER BY` 付き、KLIKE、`LIMIT` なし、`OFFSET + LIMIT > maxRecords` は従来どおり全件取得または上限判定を行う。`LIMIT <= 500` の単発 GET も不変。
  - **上限の意味論変更**: `maxRecords` は実際に取得する行数の上限として扱う。安全な早期停止対象では `OFFSET + LIMIT <= maxRecords` なら、一致総数が `maxRecords` を超えていても上限エラーや truncate 警告を出さず、LIMIT 窓を返して正常終了する。

## v2.10.1（2026-07-16）

### 修正（バグ）

- **SIMPLE SELECT の `LIMIT > 500` が kintone API エラー（`GAIA_QU01`）になる不具合を修正**。単発 GET かページングかの判定が「変換後クエリに `limit` を含むか」で行われており、`LIMIT` を明示すると値にかかわらず単発 GET になっていた。kintone の `limit` 上限は 500 のため、`LIMIT 501` 以上が不正なクエリとして送られエラーになっていた。判定を **AST の `LIMIT` 値（`<= 500`）**に修正し、`LIMIT > 500` は `fetchAll` で 500 件ずつページングして取得後に `LIMIT` を適用するようにした。
  - `LIMIT <= 500` は従来どおり単発 GET。`FULL_SCAN`・`ORDER BY`・`OFFSET`・`maxRecords` の挙動は不変。
  - **注意**: `fetchAll` は一致レコードを（`maxRecords` まで）取得してから `LIMIT` を適用するため、`LIMIT > 500` を使う場合は一致総数が `maxRecords` 以下である必要がある（取得打ち切りの最適化は別課題）。

## v2.10.0（2026-07-15）— 検索打ち切り検出と FROM なし SELECT 実体化の修正

### 修正（バグ）

- **`CREATE TEMP TABLE AS <FROM なし SELECT / UNION>` が 0 行で実体化される不具合を修正**。`SELECT 'A' AS v UNION ALL SELECT 'B'` のような `FROM` なしクエリを一時テーブルへ実体化すると常に 0 行になっていた（直接実行は正常）。`executeQueryWithCte` が `__NO_FROM__` センチネルを実 CTE 参照と誤認していたのが原因。`NO_FROM_CTE_NAME` を共通化し判定を修正。**リテラル値リストを一時テーブル化して `IN (SELECT … FROM #t)` で使う**パターンが使えるようになった（レシピ集 R5）。

### 追加（安全性）

- **kintone の検索打ち切り（10 万件）を検出して安全側に倒す**。`like` / `not like`（`KLIKE` 含む）の一致候補が 10 万件に達すると kintone は検索を打ち切りヘッダー `X-Cybozu-Warning` を返すが、従来これを読まず**結果がサイレントに欠落**していた。
  - **SELECT（CLI/MCP）**: 打ち切りを検出すると**警告付き**で返す（結果が欠落し得ることを明示）。
  - **DML・SELECT ベース DML・一時テーブル実体化**: 対象取得（読取）が打ち切りを受けたら、**書き込み前に `SearchAbortedError` で停止**（fail-closed）＝サイレントな一部更新/削除を防ぐ。通常 UPDATE・算術式 UPDATE・DELETE の全読取後書込経路を含む。
  - `KintoneGetResponse.searchAborted` と `fetchAll` の `onSearchAborted` を追加。Node クライアントがヘッダーを判定し、実行エンジンには型付き boolean だけを渡す。先頭・最終・並列取得の全レスポンスを早期 return より先に検査する。
  - **プラグイン経路は検出しない**（`kintone.api()` がレスポンスヘッダーを露出しないため）。将来の課題。
  - 将来、`KLIKE` の親レコード DML 解禁時の安全基盤になる。

### ドキュメント

- レシピ集に **R5「リテラル値リストを一時テーブル化して一括処理」**（`FROM` なし UNION → `ASSERT` ゲート → `UPSERT … SELECT`）と、検索打ち切りの注意（現行の SELECT 警告・DML fail-closed・`LIKE`/`KLIKE` DML の静的拒否・将来用途）を追記。

## v2.9.0（2026-07-15）— KLIKE プレフィルタ押し下げ

### 追加（最適化）

- FULL_SCAN SELECTでも、`KLIKE` / `NOT KLIKE` が安全なANDリーフならkintoneへプレフィルタ押し下げする。`KLIKE`で候補を絞り、`LIKE`・関数・集計・`DISTINCT`などをJavaScriptで精製できる。
  ```sql
  SELECT 件名 FROM APP100
  WHERE 件名 KLIKE '至急' AND 備考 LIKE '%緊急%'
  ```
- 押し下げ計画を検証・取得・JavaScript評価・EXPLAINで共有し、実際に押し下げたKLIKEだけを適用済みとして扱う。集合外のKLIKEはエラーにしてfail-closedを維持する。
- JOINとの併用は全JOINが`INNER JOIN`の場合だけ許可する。`LEFT JOIN` / `RIGHT JOIN`を含むSELECT、OR・`NOT (...)`配下、CTE／一時テーブル上のKLIKEは拒否する。直接の`NOT KLIKE`は使用できる。
- 全DML拒否と、kintone検索の10万件打ち切りによる完全結果非保証は従来どおり。

## v2.8.0（2026-07-15）— KLIKE（kintone キーワード検索）

### 追加

- **`KLIKE` / `NOT KLIKE` 演算子**を追加。SQL `LIKE` の JavaScript 部分一致とは分離し、kintone の `like` / `not like` キーワード検索を明示的に呼び出す。**大規模アプリのテキスト検索を高速化**する（`LIKE` は FULL_SCAN で取得上限に達しがちだが、`KLIKE` は SIMPLE のまま kintone 側で検索）。
  ```sql
  SELECT 件名 FROM APP100 WHERE 件名 KLIKE '至急'
  SELECT 件名 FROM APP100 WHERE 件名 NOT KLIKE '保留'
  ```
  - v1 は **SIMPLE SELECT の WHERE 限定**。JOIN、GROUP BY、DISTINCT、集計、式 ORDER BY、サブテーブル、`LIKE` 等との混在によって対象 SELECT が FULL_SCAN になる場合は、API 呼び出し前に拒否する。CTE・UNION・サブクエリも SELECT スコープごとに検証する。`=` / `IN` / 数値比較などとの AND / OR は SIMPLE のまま結合して kintone へ押し下げる。
  - 右辺は文字列リテラルまたは文字列バッチ変数だけ（バッチ変数は置換後も検証）。`%` はSQLワイルドカードの誤用として拒否し、`_` は許可するがワイルドカードではなくkintoneの単語構成文字として扱われる。
  - v1 は **全 DML で使用不可**。kintone検索の10万件打ち切りを検出できるようになるまで、親レコードDMLも安全上拒否する。
  - **一致挙動は kintone 仕様に準拠し、SQL の部分一致とは異なる**（文字種で挙動が異なる。実機観測では英数字は空白区切りの語単位で語の一部は不一致、日本語は 2 文字以上の部分一致で 1 文字は不一致）。対象フィールド・10万件打ち切りも kintone 仕様準拠。現時点では `X-Cybozu-Warning` を取得しないため、一致候補が10万件に達した場合にSELECT結果の完全性を保証できない。詳細は言語リファレンス § KLIKE を参照。

### 互換性

- `KLIKE` を予約語に追加。既存のフィールドコードが `KLIKE` の場合は、 `` `KLIKE` `` のようにバッククォートで囲む。

## v2.7.0（2026-07-15）— STATUS（ワークフロー状態）の IN 押し下げ

### 追加（最適化）

- **STATUS（プロセス管理の状態）の `IN` / `NOT IN` プレフィルタ押し下げ（述語分割 第2段・フェーズ2b）**。v2.6.0 で対象外としていた STATUS を、**プロセス管理設定 API による状態検証付き**で kintone の事前絞り込みに使う。
  ```sql
  SELECT 件名 FROM APP100 WHERE ステータス IN ('処理中','保留') AND 件名 LIKE '%至急%'
  -- ステータス IN (...) を kintone に押し下げ → 該当状態だけ取得 → LIKE は JS 評価
  ```
  - **安全性（2 条件）**: プロセス管理が **`enable=true`** かつ **全 IN 値が実在状態名**のときだけ押し下げる。プロセス管理無効（`GAIA_ST02`）・非実在状態（`GAIA_IQ10`）・空文字は**押し下げず** JavaScript 評価のみ（kintone のクエリエラー化を回避）。
  - **状態一覧**: `GET /k/v1/app/status.json?lang=user` の `enable` と状態名（`states.*.name`）を実在検証に使う。**実行ユーザーの表示言語**で状態名を取得するため、多言語アプリでも `IN` リテラルと一致する。**フィールドコードに依存せず**、フィールド型が `STATUS` のフィールドを対象にする（`ステータス`／`Status`／任意のカスタムコードで動作）。
  - **API 消費の抑制**: 型メタ確定後の 2 段階判定で、**IN 候補に STATUS フィールドがあるアプリだけ** status.json を取得する（NUMBER 比較・選択系 IN しかないアプリでは呼ばない）。APP/profile 別にキャッシュし、同時実行でも 1 回。論理アプリ参照（`LAPP_`）も物理 APP＋profile へ正しくルーティングする。
  - **対象外**: `STATUS_ASSIGNEE`（作業者・USER 系と同じくディレクトリ照合のため非対象）。フェーズ2a の 4 型（DROP_DOWN/RADIO/CHECK_BOX/MULTI_SELECT）・数値・`$id` の押し下げは不変。
  - `EXPLAIN` は STATUS IN も `pushdown candidate`（実行時の型・実在確認待ち）行に表示する（API 非呼び出し）。

## v2.6.0（2026-07-15）— 選択系 IN 押し下げと空セル評価

### 追加（最適化）

- **選択系 `IN` / `NOT IN` の kintone プレフィルタ押し下げ（述語分割 第2段・フェーズ2a）**。`LIKE` 等で FULL_SCAN になるクエリでも、AND で併記した**選択系フィールドの `IN` / `NOT IN`** を kintone の事前絞り込みに使い、取得件数を削減する（結果は取得後に同じ型付き規則で再評価）。
  ```sql
  SELECT 件名 FROM APP100 WHERE 区分 IN ('対応中','保留') AND 件名 LIKE '%至急%'
  -- 区分 IN (...) を kintone に押し下げ → 該当だけ取得 → LIKE は JS 評価
  ```
  - **対象**: `DROP_DOWN` / `RADIO_BUTTON` / `CHECK_BOX` / `MULTI_SELECT`。フィールド型と**選択肢の実在**（`optionOrder`・追加 API なし）を確認できた、空でない文字列リテラルの `IN` / `NOT IN` のみ押し下げる。
  - **安全性**: 存在しない選択肢・空文字・型/選択肢メタを取得できない場合は**押し下げず** JavaScript 評価だけを行う（kintone は非実在値の `in` をクエリエラーにするため、「0 件」を「エラー」に化けさせない）。バッチ変数は解決後の文字列リテラルとして扱う。
  - **対象外**: **ユーザー／組織／グループ選択**（組織ディレクトリ照合で静的検証不可）・**ステータス**（プロセス管理状態依存）は押し下げず、従来どおり JavaScript が評価する。数値の `=` / strict `<` / `>`（v2.2.0）・`$id` 比較の押し下げは不変。
  - `EXPLAIN` は押し下げ候補を `pushdown candidate`（実行時の型・実在確認待ち）行に表示する。

### 修正（バグ）

- **選択系フィールドの `IN ('')` / `NOT IN ('')` を空／未設定セルに一致させ、SIMPLE / FULL_SCAN の結果不一致を解消**。kintone（SIMPLE）は `選択 in ("")` を空セルに一致させるが、FULL_SCAN の JavaScript 評価では空スカラー選択が `""`（2 文字）・空配列が `[]` で表現され、空文字リテラル `''` と一致していなかった（同じ SQL が実行モードで異なる結果）。
  - `flatten` の **null / undefined を 0 文字の空文字へ正規化**（従来 `""`(2 文字) を生んでいた点を是正）し、サブテーブル側の表現と揃えた。あわせて `typedInContains` で**空配列**（`[]`）を `IN ('')` に一致させる（JSON parse・型別の形検証を通した後にのみ）。`NOT IN` は既存の反転処理で空セルを除外する。
  - **副次**: 空スカラー選択の **SELECT 投影が `""`(2 文字)→空文字** に是正される（サブテーブルと整合）。
  - 影響範囲: `DROP_DOWN` / `RADIO_BUTTON` / `CHECK_BOX` / `MULTI_SELECT` / ユーザー・組織・グループ選択・作業者。WHERE / HAVING / `CASE WHEN` / サブテーブル DML / `IN (SELECT ...)`。**不変**: テキスト・数値の `IN ('')`（空テキストは従来どおり一致）、非空値の IN 評価。ドロップダウン等は `= ''` が使えないため、空の抽出に `IN ('')` を使える。

### ドキュメント

- 言語リファレンス § IN / NOT IN に、IN リストの値構文（単一引用符の文字列・数値・バッチ変数、1 要素以上必須。`IN ("A")` / `IN ()` はエラー）と、空セル `IN ('')` の用例を追記。

## v2.5.0（2026-07-15）

### 修正（バグ）

- **FULL_SCAN の `IN` / `NOT IN` を型メタ付きで評価し、複数値・オブジェクト型フィールドで SIMPLE と結果が食い違っていた問題を修正**（最適化ではなく **SIMPLE / FULL_SCAN 間の結果不一致の修正**）。従来 FULL_SCAN は全フィールドを `flatten` 後の文字列として素朴に比較していたため、チェックボックス・複数選択・ユーザー選択などの複数値／オブジェクト型で `IN` が実質一致せず、**SIMPLE では一致するレコードが FULL_SCAN では 0 件**に化けていた（例: `SELECT $id FROM APP4149 WHERE 主担当 IN ('rex0220')` が SIMPLE=20 件 / FULL_SCAN=0 件）。フィールド型メタを JavaScript 評価まで渡し、**型ごとの単位**で比較するようにした。
  - **型別の比較単位**: チェックボックス・複数選択は**選択値のいずれか**が IN リストに含まれるかで判定。ユーザー／組織／グループ選択・作業者・作成者・更新者は**表示名ではなく `code`** を比較。ドロップダウン・ラジオボタン・ステータス・レコード番号は従来どおりスカラー文字列比較。
  - **型判別は値の見た目ではなくフィールド型メタで行う**（`flatten` 後の文字列だけでは判別不可能なため）。テキストフィールドに文字列 `["A"]` が入っていても**配列とは誤検出せず**スカラー文字列として扱う（`IN ('A')` は非一致・`IN ('["A"]')` で全体一致）。**型情報を取得できない・型と値の形が一致しない場合は従来の文字列比較を維持**（フォールバック）。空配列は `IN`=false / `NOT IN`=true。
  - **サブテーブルの型メタを再帰取得**（`TABLE.fields`）。従来クライアントの `getFields` は properties 直下のみで、サブテーブル子フィールドの型を取得できていなかった。CLI / UI 両クライアントで共通の再帰展開を用いるようにした。
  - **適用範囲**: リテラル／バッチ変数の IN リストと `IN (SELECT ...)` の両方、および WHERE / HAVING / `CASE WHEN` / サブテーブル `UPDATE`・`DELETE`・`REORDER` の対象選定など、**JavaScript 側で評価するすべての `IN` / `NOT IN` 経路**。
  - **不変**: SIMPLE モード（kintone へ押し下げる経路）、スカラー文字列型の `IN`、`=` / `!=`、`LIKE`。**一時テーブル／CTE を経由した値は型来歴を持たないため文字列比較**（別課題）。
  - **本リリースの対象外（後続）**: 選択系 `IN` の kintone プレフィルタ**押し下げ**、`optionOrder` による選択肢実在検証、STATUS 状態一覧 API 連携。これらは述語分割 第2段として別途実装する。プラグインにもバンドル済み。詳細は言語リファレンス §11 と `docs/internal/ksql_fullscan_in_typed_eval_spec.md` を参照。

## v2.4.0（2026-07-15）

### 追加

- **バッチ変数の外部パラメータ注入 `DECLARE @x = 既定値`（Phase 1c）**。同じ定型 SQL を、値だけ外部（MCP パラメータ / CLI フラグ）から差し替えて実行できる。
  ```sql
  DECLARE @since = '2026-01-01';
  SELECT * FROM APP100 WHERE 登録日 >= @since;
  ```
  - **注入経路**: MCP `ksql_query` / `ksql_mutate` の `variables`（例 `{ "since": "2026-07-01" }`）、CLI `--var since=2026-07-01`（繰り返し可）。**未注入なら既定値**を実行時に 1 回だけ評価する（注入があれば既定値式は評価しない）。
  - **キーの正規化**: 注入キーは `@` なしの変数名で、**大文字小文字を区別しない**（`Since` は `@since` を上書き）。`--var` は最初の `=` で分割（`x=a=b` は値 `a=b`）。重複・不正名はエラー。
  - **安全性**: 値としてバインドするため SQL インジェクションは発生しない。**未宣言の名前を注入するとバッチ実行前にエラー**（`DECLARE` していない名前・タイポを、いずれの文も実行する前に拒否）。`DECLARE` と使用文を含む **2 文以上のバッチ**が必要（`DECLARE` 単独は不可）。
  - **プラグイン**: `DECLARE` 文は実行できるが**外部注入の経路はなく常に既定値**を使う。同じ SQL が「プラグイン＝既定値／CLI・MCP＝注入で差し替え」と一貫して動作する。
  - 既定値式は `SET`（1a）と同じスカラー式（リテラル・`NOW()`/`TODAY()`・文字列/数値関数・数値算術）で、スカラーサブクエリ・変数参照・`LOGINUSER()` は不可。`DECLARE_VARIABLE` は read-only 文（`--allow-dml` 不要）。`EXPLAIN` は `DECLARE` を表示するが**値は非公開**。`--var` の値はプロセス一覧・シェル履歴に残り得るため**秘密情報には使わない**。
  - 現時点で非対応（後続）: `NULL` 代入・1 変数の配列展開・`SELECT` 列での変数参照・`DECLARE` 無しの純粋注入。詳細は言語リファレンス §25。

## v2.3.0（2026-07-15）

### 追加

- **バッチ変数のスカラーサブクエリ代入 `SET @x = (SELECT ...)`（Phase 1b）**。`;` 区切りバッチ内で、サブクエリの結果（**1 行 1 列**）を変数へ代入できる。**件数ゲートの DRY 化**が主用途（例: `SET @cnt = (SELECT COUNT(*) FROM APP100 WHERE ...); ASSERT @cnt BETWEEN 0 AND 10000;`）。
  - **SET の実行時に一度だけ評価**し、以後はバッチ内定数（同じ変数を複数文で参照しても再実行しない）。値は文字列で束縛し、比較時に数値/文字列として動的に解釈する。
  - サブクエリは**先行して作成した一時テーブル**と**先行して定義した変数**（`SELECT ... WHERE k < @prev`）を参照できる。未定義・前方参照は実行前に検出する。
  - **スカラー保証**: 1 行 1 列でなければエラー（0 行・複数行・複数列・複数列の `SELECT *` は実行時に検出）。サブクエリ結果に対する後置算術（`(SELECT ...) * 2`）は不可（サブクエリ内で計算する）。
  - **SET の評価失敗は `continueOnError` に関わらずバッチを停止**（fail-fast。`ASSERT` 失敗の停止とは区別される）。
  - `EXPLAIN` はバッチ内 `SET @x = (SELECT ...)` のサブクエリ計画（APP／一時テーブル参照・1 回評価）を表示する。
  - 参照できる位置は従来どおり **WHERE 右辺 / `UPDATE` の SET 値 / `ASSERT` オペランド / `IN` リスト要素**（`SELECT` の列に `@var` は書けない）。現時点で非対応（後続）: サブクエリ結果の算術・`NULL` 代入・`DECLARE` 外部注入（1c）・1 変数の配列展開。詳細は言語リファレンス §25 と CHANGELOG を参照。

## v2.2.0（2026-07-15）— 述語押し下げの安全化と数値対応

### 修正（バグ）

- **FULL_SCAN の数値範囲比較（`> < >= <=`）で、空の数値セルを `0` として扱っていた問題を修正**。kintone（SIMPLE モード）は空の数値セルを **−∞ 相当**（`< /<=` は含む・`> />=` は除外）として扱うが、FULL_SCAN の JavaScript 評価は `Number("")===0` のため `>= 0` などが空セルで真になり、**同じ SQL が実行モードで異なる結果**を返していた。共通比較器へ集約し、**範囲比較で左辺が空・右辺が有限数のとき −∞ 相当**（`< /<=`→真・`> />=`→偽）に統一して SIMPLE と一致させた。
  - 影響範囲: WHERE / HAVING / `CASE WHEN` / サブテーブル `UPDATE`・`DELETE`・`REORDER` の対象選定 / `ASSERT`・`BETWEEN`。
  - **不変**: `=` / `!=`（文字列比較）、右辺が空・非数値・非有限（`Infinity` 等）、文字列フィールドの範囲比較。

### 安全性・性能（述語プレフィルタ）

- **FULL_SCAN の述語プレフィルタを、超集合性を確認できる述語だけに限定（安全化）**。従来は JOIN／エイリアス経路でテキスト等値・`!=`・`IS NULL`・`NOT`・`KINTONE_FUNC` 等も kintone へ押し下げており、kintone と JavaScript の評価差で結果を取りこぼすおそれがあった。これらを停止し、`$id` の肯定比較（`= < > <= >=`）だけを確実な押し下げ対象とした。**これらの条件を使う一部クエリでは取得件数が増え性能が低下する場合がある**が、結果の正しさを優先する。
- **LIKE など JavaScript 評価が必要な条件と AND で併記された安全述語を、kintone へプレフィルタ押し下げして取得件数を削減**（WHERE 全体は取得後に JavaScript で再評価）。単一テーブルの無エイリアス／エイリアス経路と JOIN 経路のいずれでも有効。押し下げ対象:
  - **`$id` の肯定比較**（`= < > <= >=`）。
  - **NUMBER フィールド**（型情報で確定）の **`=` と厳密な `<` / `>`**（右辺が安全整数）。境界の丸めで超集合性が壊れる **`<=` / `>=` は押し下げない**（FULL_SCAN で正しく評価。厳密 10 進比較の導入は別途検討）。
  - `EXPLAIN` は確定分を `kintone query`、型確認待ちの数値候補を `pushdown candidate` 行に分けて表示する。

## v2.1.2（2026-07-15）

### 修正（バグ）

- **集計算術式の末尾（や中間）が集計関数だと `AS alias` が静かに消える問題を修正**。`SUM(x) / COUNT(*) AS 平均` や `SUM(a) - SUM(b) AS diff` の `AS …` が右オペランドを読むパーサに横取りされて捨てられ、出力列名・`HAVING`/`ORDER BY`・CTE/一時テーブル後段参照・`UNION` 結果列が合成名（`SUM(x)/COUNT(*)`）になっていた。集計オペランドを alias 非消費で読む共通処理に統一し、`AS alias` は式全体を読み終えた後にだけ消費するよう修正した。
  - これにより `HAVING 平均` / `ORDER BY 平均` / 後段 `SELECT 平均` が **alias で正しく解決**される（従来は空参照で `HAVING` が常に偽＝全落ち、`ORDER BY` が無並び替え）。
  - 併せて、式の途中に置いた**不正な中間 alias**（`SUM(a) AS x - SUM(b)` / `FORMAT(SUM(a) AS x, '#')` / `SUM(c) + (SUM(a) AS x - SUM(b))`）を **`ParseError` で拒否**する（従来は静かに受理し alias を無視）。
  - **不変**: 末尾が数値リテラルの既存ケース（`SUM(金額) * 1.1 AS x`）、alias 無しの合成名出力、単独集計列（`SUM(a) AS x`）。実行側（`GROUP BY` 集約）は変更なし。
  - alias を付けない集計算術式の合成名を `HAVING`/`ORDER BY` で参照する場合は、記号を含むためバッククォートで囲む（例: `` ORDER BY `SUM(a)-SUM(b)` ``）。詳細は `docs/internal/ksql_agg_arith_alias_dropped_issue.md` / `..._fix_spec.md` を参照。

## v2.1.1（2026-07-14）

### 修正（バグ）

- **0 行の `SELECT` が出力列を失い、空ソースの `INSERT` / `UPSERT … SELECT` が誤メッセージで失敗する問題を修正**。明示列（例: `SELECT a, b`）の SELECT でも結果が 0 行のとき列名リストが空になり、`SELECT の列数（0）と INSERT/UPSERT のフィールド数が一致しません` で停止していた。列名を行データではなく `SelectColumn`（AST）から行ループ前に確定するようにした。
  - これにより**差分バッチの「差分 0 件の日」**でも、空の一時テーブルや空ソースからの `INSERT` / `UPSERT … SELECT` が **`insertedCount=0`（`UPSERT` は `insertedCount=0 / updatedCount=0`）の no-op** として正常に完走する。書き込み API（POST / PUT）も呼ばれない。
  - **左辺が 0 行の `UNION` / `UNION ALL`** も、結果列が左辺由来の列名で確定し、右辺の値が正しく載る（通常 `UNION` の重複排除も左辺列で機能する）。
  - 全 8 列型（`FIELD` / `LITERAL_COL` / `AGGREGATE` / `ARITH_AGG_COL` / `ARITH_COL` / `CASE_COL` / `STRFUNC_COL` / `SCALAR_SUBQUERY_COL`）が対象。**1 行以上の既存結果（列名・列順・値）は不変**。
  - **対象外（別課題）**: 空の `SELECT *`・空 CTE・混在ワイルドカード（`SELECT *, a`）は列がデータ依存のため今回は対象外。空の `SELECT *` を空ソースに使った場合は「結果が 0 行のため列を特定できません（明示列で指定してください）」と案内する。
  - この修正はプラグインの `project()` にもバンドルされ、クライアント側 SELECT の列表示にも反映される。詳細は `docs/internal/ksql_empty_select_columns_issue.md` / `..._fix_spec.md` を参照。

## v2.1.0（2026-07-14）

### 追加

- **バッチ変数 `SET @var`**。`;` 区切りバッチ内で `SET @名前 = <式>` により値を一度定義し、後続の文から `@名前` で参照できる。**時刻の固定**（`SET @now = NOW()` はバッチ内で同じ時刻に固定。`NOW()` 自体の意味は不変）・**バッチ ID**・**条件値の共通化（DRY）** に使える。
  - 式は**リテラル・関数（`NOW()` / `TODAY()` / 文字列・数値関数）・数値算術**。`@名前` は英字か `_` で始まる 64 文字以内、大文字小文字を区別しない。`+` は数値加算で、文字列連結は `CONCAT()`。
  - 参照できる位置: **WHERE 右辺の値 / UPDATE の SET 値 / ASSERT のオペランド / IN リストの要素**（`WHERE k IN (@a, @b)`。チェックボックス等 `in` が必須のフィールドで有効）。
  - `SET` の実行時に一度だけ評価し、以後は定数。値としてバインドするため SQL インジェクションは発生しない。
  - **2 文以上のバッチでのみ使用可**（単文の `SET`・単文での `@参照` はエラー）。未定義参照・前方参照・再代入は実行前に検出（未使用は警告）。`SET` の評価に失敗した場合は `continueOnError` に関わらずバッチを停止。
  - 現時点で非対応（後続フェーズ）: スカラーサブクエリ代入（`SET @x = (SELECT ...)`）・`DECLARE` 外部注入・`NULL` 代入・1 変数が複数値を持つ配列展開（`IN (@list)`。`IN (@a, @b)` のスカラー並べは対応）・`LOGINUSER()`。
  - `@profile`（アプリ指定）と `@変数` は同居できる（CLI / MCP が profile を先に正規化するため混同しない）。詳細は言語リファレンス §25。

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
