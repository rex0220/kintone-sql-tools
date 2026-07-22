# Changelog

リリースごとの変更点。v1.9.0 以前の詳細は [GitHub Releases](https://github.com/rex0220/kintone-sql-tools/releases) を参照。

## 未リリース

### 機能追加（B56 統計集約関数）

- `STDDEV_POP` / `STDDEV_SAMP` / `VAR_POP` / `VAR_SAMP` / `MEDIAN` を追加した。分散・標準偏差は Welford 法、中央値は数値昇順で計算し、未定義の統計量は空文字を返す。統計集約は完全入力を必須とし、上限到達時に部分集合の値を返さない。
- MCP server instructions の全量関数カタログを aggregate 6 件から 11 件へ更新し、無印 `STDDEV` / `VARIANCE` は非対応であることを明記した（instructions 272 語、240〜280 語 guard 内）。`ksql_docs` の埋め込み言語リファレンスと smoke guard も同期した。
- 上記 5 語は新しい予約語。同名フィールドはバッククォートで囲んで参照できる。無印の `STDDEV` / `VARIANCE` は意味が方言間で異なるため非対応。

### 機能追加（B58 MODE 集約関数）

- `MODE(引数)` を追加した。空セルを除く文字列の完全一致単位で最頻値を返し、同頻度では引数型の canonical 順、その同値では raw コードポイント順で最小の値を選ぶため、取得順に依存しない。空集合・全空セルは空文字を返す。
- `MODE` は統計集約の完全入力契約を共有し、`onLimit=truncate` の上限到達時は部分集合の値を返さずエラーにする。`MODE(*)` と `MODE(DISTINCT x)` は非対応。
- MCP server instructions の全量関数カタログを aggregate 11 件から 12 件へ更新し、言語リファレンス、fixtures、drift guard、smoke guard を同期した（instructions 274 語、240〜280 語 guard 内）。
- `MODE` は新しい予約語。同名フィールドは `` `MODE` `` のようにバッククォートで囲んで参照できる。`MODEL` など長い識別子は影響を受けない。

### 機能追加（B57 日付集計軸関数）

- `DAYOFWEEK(日付)`（1=日曜〜7=土曜）、`QUARTER(日付)`、ISO-8601 固定の `WEEK(日付)` を追加した。新3関数は実在する `YYYY-MM-DD` のみを受理し、不正日付では空文字を返す。
- `DATE_FORMAT` に `%w`（0=日曜〜6=土曜）、`%a`（kSQL 定義の日本語短縮曜日）、`%v`（2桁ISO週番号）、`%G`（ISO week-year）を追加した。週次ラベルは `%G-%v` を推奨する。不正日付では新4指定子だけを空文字へ置換し、既存9指定子の挙動は変更しない。
- MCP server instructions の全量関数カタログを scalar 43 件から 46 件へ更新し、言語リファレンス、fixtures、drift guard、smoke guard を同期した（instructions 277 語）。
- `DAYOFWEEK` / `QUARTER` / `WEEK` は新しい予約語。同名フィールドはバッククォートで囲んで参照できる。`WEEKLY` など前方一致する長い識別子は影響を受けない。

## v3.12.0（2026-07-21）

### 機能追加（B55 MCP read-only ドキュメントツール `ksql_docs`＋全量関数カタログ instructions）

- **MCP に read-only ツール `ksql_docs` を追加した**。MCP resources / prompts はクライアント任意機能であり、Claude Desktop のデバイスブリッジ（リモート接続のプロキシ）のように **tools だけ中継し resources を通さない経路**では、B50（v3.9.0）で公開した言語リファレンス resource（`ksql://language-reference`）に到達できない（実測: AI が `ksql_validate` 総当たりで不完全な関数一覧を推定する事態が発生）。`ksql_docs` はどのクライアントでも届く tool 経由で同じ embed 済みドキュメントへ到達する導線を提供する。
  - **引数なし**＝言語リファレンス・レシピ両索引＋全 40 有効キーの統合インデックスを返す。**`section` 指定**＝B50 resource と同一のキー語彙（`language-reference/<26 章キー>`・`recipes/r1..r12`・`ksql://` URI 形も受理）で 1 章の markdown を返す。曖昧マッチ・部分一致はしない（fail-closed）。
  - **二層エラー契約**: 未知プロパティ・非文字列・128 文字超は schema 層で拒否（`-32602`）。文字列として妥当だがキーとして無効（未知キー・空文字）は、有効キー族と「引数なしで全キー一覧」への誘導を含む `ArgumentError`（既存エラー envelope とバイト互換・`isError: true`）。
  - **安全性**: 固定 map lookup のみで kintone API・資格情報・ネットワーク・（配布 bundle runtime では）ファイルシステムに一切触れない。資格情報や有効な config がなくても応答する。`annotations: { readOnlyHint: true, openWorldHint: false }` 付き。成功応答は markdown テキストのみ（structuredContent なし）。
- **server instructions を再構成し、kSQL の全量関数カタログを掲載した**（scalar 43・aggregate 6・window 3・contextual 3（`TODAY`/`NOW`/`LOGINUSER`）・alias 5（`SUBSTR`→`SUBSTRING`・`CONVERT`→`CAST`・`CEILING`→`CEIL`・`TRUNC`→`TRUNCATE`・`POW`→`POWER`）・syntax（`IF(...)`・`||` ほか））。「この一覧が全量・他方言関数（`IFNULL`/`STDDEV`/`MEDIAN` 等）は存在しない・関数の有無を validate の試行錯誤で推定しない」を明示し、`ksql_validate` / `ksql_query` / `ksql_mutate` の description にも `ksql_docs` への導線を追記した。
  - カタログはパーサの実受理集合（token map・IDENT 先読み・集計/ウィンドウ/文脈関数）と**双方向のドリフトガードテスト**で固定し、関数追加時のカタログ更新漏れをテストで検出する。
- 言語リファレンス §5 に `SUBSTR`（`SUBSTRING` の別名）とエイリアスの canonical 対応注記を追記した。
- **プラグイン・CLI の SQL 実行挙動に変更はない**（パーサは受理表の内部定数化のみで AST・エラー文言不変・全 2,729 テスト green）。SemVer=minor。

## v3.11.0（2026-07-21）

### 修正（B51 複数 CTE の CTE 間 JOIN が誤結果を返す・silent wrong results）

- **2つ以上の CTE を定義し CTE 同士を JOIN すると、左 CTE の投影列が空になり行が重複し、LEFT JOIN の未一致行が欠落する不具合を修正した**。エラーにならず誤った行・列を返す silent wrong results で、誤ったデータでの判断や書き戻しにつながり得た。
  - 原因: CTE / 一時テーブル参照が**明示 alias を持たないと `alias: null`** になり（物理アプリはテーブル名を既定 alias にするが CTE/temp はしない）、最終 JOIN で実体化テーブルを格納する `Map` が `null` キーで衝突して片方を上書きし、さらに修飾キー（`a.aid`）が生成されず JOIN キーが空文字として全行一致し直積になっていた。
  - 修正: `effectiveTableAlias = table.alias ?? table.cteName` を導入し、テーブル識別・JOIN の修飾解決・WHERE / SELECT / ORDER BY / GROUP BY / 集計メタデータ解決に一貫して適用（明示 alias があればそれを優先）。パーサは変更せず「テーブル識別用 alias」と「出力列の見せ方」を分離したため `SELECT * FROM c` の出力列名は従来どおり非修飾のまま。あわせて **effective alias の衝突を実行前に拒否**し、実体化キャッシュの miss を明示エラー化、`applyJoin` は「空文字の値」と「JOIN キー列が構造的に存在しない」を区別して後者を明確なエラーにした（silent wrong results の増幅を停止）。
  - 実機（APP730）で確認: `WITH a AS(...), b AS(...) SELECT a.aid,b.bid FROM a INNER JOIN b ON a.aid=b.bid` が正しく2行（左列も正しい値）・LEFT JOIN で未一致行が NULL 埋めで保持・`SELECT * FROM c` は非回帰。一時テーブルの JOIN・物理アプリ JOIN・window / GROUP BY / UNION の CTE も非回帰。SemVer=minor。

### 修正（B52 単一 CTE の列別名がインライン化で解決されず unknown field）

- **単一 CTE 本体で列に `AS 別名`（や式・リテラル）を付けて外側で参照すると `unknown field code(s)` エラーになる不具合を修正した**（`WITH a AS (SELECT レコード番号 AS aid FROM APPx) SELECT a.aid FROM a`）。
  - 原因: 単一 CTE のインライン化判定 `canInlineSingleCte` が CTE 出力別名を考慮せず、`buildInlinedQuery` が別名（`aid`）を物理フィールドへ写像しないまま物理アプリへ問い合わせていた。
  - 修正: インライン化するのを **`SELECT *`・別名なしの単純フィールド・物理名と同名の別名のみ**に限定し、**名前が変わる列別名・式・リテラル・関数・CASE を含む CTE はインライン化せず実体化経路へ回す**（B51 の effective alias 修正により実体化経路は別名を正しく解決する）。`SELECT *` や同名フィールドだけの CTE は従来どおりインライン化＋WHERE の kintone 押し下げ（SIMPLE 化）を維持する。実行・事前検証・EXPLAIN は同じ判定を共有する。
  - 実機で確認: 別名 CTE の参照・算術式 CTE が正しく実体化・`SELECT *` CTE はインライン化＋WHERE 押し下げ維持。SemVer=minor。

## v3.10.0（2026-07-21）

### 機能追加（B47 APPLY 複数親 UPDATE の親 WHERE で LIKE / KLIKE を解禁）

- **`UPDATE ... APPLY`（複数親）の親 WHERE に `LIKE` / `NOT LIKE` と `KLIKE` / `NOT KLIKE` を使えるようにした**。従来はどちらも実行前に拒否され、対象親は完全一致・`IN`・`$id IN (...)` でしか指定できなかった。
  - **親選択を「安全プレフィルタ → 元 WHERE の JS 残余評価 → 一致した親だけを更新」に再構成**。`LIKE` は kintone へ押し下げず JS（`matchLike`）で評価し、安全に押し下げられる述語（数値比較・`KLIKE` など）だけを kintone プレフィルタにする。取得した候補は元 WHERE 全体で再評価し、**一致した親（target）だけ**を検証・確認・書き込みへ渡す（候補数 ≠ 対象数）。
  - **完全性のための取得契約**: 候補は `maxRecords`（既定 10,000）まで `onLimit=error` で**最後まで**取得し、上限超過や取得未完了は書き込み前に fail-closed。`dmlMaxRows` は残余評価後の target 数にだけ適用する。
  - **`KLIKE` は kintone ネイティブ検索**のため、`OR` / `NOT` 配下など native query に完全適用できない `KLIKE`（unapplied）は**レコード API 呼び出し前に専用エラーで拒否**する（一部だけ適用しない）。10 万件検索打ち切り時は既存の DML fail-closed（`SearchAbortedError`・書き込み 0）で保護（B7 によりプラグインでも検出）。
  - **スコープは APPLY 複数親 UPDATE の親 WHERE 限定**。通常の `UPDATE` / `DELETE`（APPLY なし）・単一 `$id` APPLY・`INSERT` / `UPSERT` / サブテーブル DML では `LIKE` / `KLIKE` を引き続き拒否する（fail-closed 契約は不変）。`EXPLAIN` は親選択計画（プレフィルタ・残余・applied/unapplied・上限・fail-closed）をレコード API 0 回で表示する。
  - 実機（APP4223）で確認: LIKE `'UPS-01%'` が候補 223 件→対象 10 件だけを更新し非対象（UPS-001〜009・UPS-020・BULK-MULTI）は不変・`KLIKE` の native 選択・`OR` 配下 KLIKE の API 前拒否・通常 DML の KLIKE 拒否（非回帰）。SemVer=minor。

### 機能追加（B5 通常の親 UPDATE / DELETE の WHERE で KLIKE を解禁）

- **APPLY を持たない通常のトップレベル `UPDATE` / `DELETE` の WHERE で `KLIKE` / `NOT KLIKE` を使えるようにした**。従来はどちらも実行前に拒否されていた。
  - kSQL は WHERE 全体を kintone クエリへ変換して対象を解決する（返った集合がそのまま更新/削除対象）。`KLIKE` は kintone ネイティブの `like` / `not like` へ変換できるため、この既存経路にそのまま乗る（新しい対象選択エンジンは追加しない）。B47（APPLY）と異なり **JS 残余評価は不要**で、`OR` / `NOT` 配下の `KLIKE` も WHERE 全体を exact に変換できれば使用できる。
  - **`LIKE` / `NOT LIKE` は通常 DML で引き続き拒否**（JS 評価が必要で、通常 DML の対象解決に残余評価の段がないため）。WHERE 全体を kintone クエリで表現できない述語（`LIKE`・関数・算術・CASE・EXISTS・ネイティブ `like` 非対応の型など）は既存の EXACT_PUSHDOWN ガードで実行前に拒否する。
  - **サブテーブル `UPDATE` / `DELETE` / `REORDER` の `KLIKE` は引き続き非対応**（親を全取得して JS で評価する経路のため）。`INSERT` / `UPSERT` / 独立した `VALIDATE` の `KLIKE` も拒否のまま。
  - **10 万件検索打ち切り時は既存の DML fail-closed（`SearchAbortedError`・書き込み 0）で保護**する（B7 によりプラグインでも検出）。対象が一部だけ欠落したまま更新/削除する事故を防ぐ。`EXPLAIN` はネイティブ `like`・`exact native pushdown; JS residual none`・`search abort: DML fail-closed` を表示する。
  - 実機（APP730・618,525 件）で確認: `都道府県K KLIKE 'ケン'`（10 万件超一致）が `SearchAbortedError` で書き込み 0（B47-P4 で未確認だった KLIKE DML の打ち切り fail-closed を補完）・一県のみに絞った `KLIKE` UPDATE が対象だけを更新し非対象は不変・サブテーブル KLIKE と通常 DML の LIKE は拒否。SemVer=minor。

### 機能追加（B7 プラグインでの検索打ち切り検出）

- **プラグインでも `like` / `not like` の 10 万件検索打ち切り（`X-Cybozu-Warning`）を検出できるようにした**。従来 Node / CLI / MCP だけがヘッダーで打ち切りを検出でき、プラグインは `kintone.api()` がレスポンスヘッダーを露出しないため未検出だった（＝結果の静かな欠落・KLIKE を親 DML で使う際の安全前提が崩れる）。
  - プラグインの `getRecords` **だけ**を、`kintone.api()` から same-origin の raw `fetch` へ変更してレスポンスヘッダーを読めるようにした。**GET クエリの直列化は自前実装せず kintone に委譲**する（短い GET は `kintone.api.urlForGet()` が生成した URL、URL が 4KB を超える場合は kintone.api() と同じく POST + `X-HTTP-Method-Override: GET` へ自動切替し body は標準 JSON）。どちらの経路でも `X-Cybozu-Warning` を共通判定して `searchAborted` を返す。
  - 効果: **DML の fail-closed（`SearchAbortedError`）がプラグインでも一様に効く**（B47 の KLIKE 全 surface 解禁の前提）。プラグインの SELECT が打ち切りで静かに切り詰められた場合に警告が付く。エラー契約（`toDetailedApiError`）維持・`getRecords` 以外の API は `kintone.api()` のまま。
  - 実機（APP730・618,525 レコード・通常 space）で確認: `都道府県K KLIKE 'ケン'` で打ち切り警告表示・`=` では警告なし・`レコード番号 IN (1..500)`（URL >4KB）が 414 なく 500 件返却（POST override）。SemVer=minor。

## v3.9.0（2026-07-21）

### 修正（B43 DML 事前検証が既存サブテーブル違反を検出しない false pass の解消）

- **`UPDATE` / `UPSERT`（update 分岐）の `VALIDATE ONLY` / `ON ERROR SKIP` が、更新対象レコードの「post-image（レコード全体）」を検証するようにした**。従来は送信ペイロード（SET 対象列）だけを検証していたため、SET 対象外のトップレベル項目や**サブテーブル子行に残る既存違反**（必須・文字列長・数値範囲・選択肢・数値精度）を見逃し、`VALIDATE ONLY` が合格と誤報告（false pass）していた。kintone は PUT 時にレコード全体を再検証するため、この違反は本実行時に `CB_VA01` を引き起こし、`ON ERROR SKIP` でも隔離できずチャンク全体が失敗していた。
  - B44 で新設した complete-record validator（`validatePostImage`）を再利用し、取得スナップショットに SET を適用した post-image を検証する。検証はトップレベル＋全サブテーブル子行を対象とする（full record）。
  - **エラー診断列を10列へ統一**（`$err_statement` / `$err_operation` / `$err_row` / `$err_field` / `$err_code` / `$err_message` / `$err_value` / `$err_subtable` / `$err_subrow` / `$err_subrow_id`）。子違反は所有テーブルコード・1-based 行序数・永続行 ID（≡仮想テーブルの `_rid`）で位置を示す。INSERT / UPSERT-create / トップレベルのみの違反では末尾4列は空文字。
  - **`ON ERROR SKIP` は既存サブテーブル違反を持つ親を隔離**するようになり、既存違反1件による同一チャンクの巻き添え失敗を防ぐ（true isolation）。`REJECT LIMIT` も post-image 違反を含めて書き込み前に判定する。
  - 取得: `UPDATE` は既存 GET の取得列を complete snapshot へ拡張、`UPSERT` は照合後に更新対象 ID を100件ずつ追加取得（対象1件ごとの追加 GET はしない）。**プレーンな `UPDATE` / `UPSERT` 実行（`VALIDATE ONLY` / `ON ERROR SKIP` なし）の取得・書き込み挙動は変わらない**。権限・競合・一意制約・ユーザー実在性などの API 実行時エラーは従来どおり fail-fast。
  - CLI 実機で確認: APP4221 `$id=7` の false pass 反転（`validRows=1/errorCount=0` → `validRows=0/errorCount=2`・`$err_subrow_id`≡`_rid`）・既存違反なしレコードの no-false-positive・`ON ERROR SKIP` の true isolation（書き込み0）。全2,515 テスト green。SemVer=minor。

### 機能追加（B49 MCP の読み取り専用 kintone メタデータ API `ksql_app_metadata`）

- **MCP に新ツール `ksql_app_metadata` を追加**し、Claude が SQL/DML を組み立てる際、kintone REST を直接呼ばずにアプリのメタデータを生 JSON で取得できるようにした。従来 `ksql_describe_app`（`DESCRIBE`）はフィールドコード/ラベル/タイプの3列だけで、必須・文字数・数値範囲・選択肢・数値精度などの制約が得られなかった。
  - 取得できる resource（**固定 allowlist・8種**）: `app`・`fields`（**制約付き**）・`layout`・`settings`（数値精度含む）・`status`（プロセス）・`views`・`reports`・`customize`。フォーム fields API 等の生応答を欠落なく `structuredContent.data` へ passthrough する（`resource:"fields"` が制約 JSON の取得経路）。
  - **読み取り専用（GET）を二層で強制**: MCP schema に URL/path/method/body を持たせず（`.strict()` discriminated union）、Node 層の resource mapper も固定 GET・固定 path のみ。`records.json`（大量業務データ・SELECT のガバナンス迂回）・ACL（権限メタデータ）・`apps.json` は allowlist から除外。任意 URL/エンドポイントは受け付けない。
  - preview は明示 opt-in・応答は 2 MiB 上限・`RequestGate.runReadOnly` で retry・LAPP/プロファイル/トークン/`allowPhysicalAppRefs` は既存 resolver を踏襲。**core `KintoneClient` interface・SQL・`DESCRIBE`・プラグインは一切変更しない**（Node 専用の metadata reader へ隔離）。`customize` は userpass プロファイル限定。
  - SemVer=minor。

### 機能追加（B50 MCP の能力・方言 discoverability）

- **Claude が kSQL の独自機能・方言を認識できるよう、MCP の発見性を強化**した。従来は各ツールの description とモデル学習知識だけが手がかりで、`APPLY`/`KLIKE`/`KORDER`/ウィンドウ関数/`UPDATE…FROM`/サブテーブル仮想テーブル/`IMPORT`/`VALIDATE`/バッチ変数/`LAPP_` 等や、LIKE=JS 評価・JOIN 単一等値・派生テーブル非対応・空セル=0 といった方言が伝わりにくかった。
  - **MCP server `instructions` を追加**（能力索引＋方言の要注意点＋行動導線）。「まず `ksql_validate`、DML のデータ/フォーム事前検証は `VALIDATE ONLY`、フォーム制約は `ksql_app_metadata`、詳細は言語リファレンス resource」を案内。APPLY は validate/explain/VALIDATE ONLY で使えるが **APPLY mutation は本 MCP で無効**であることを明記。
  - **言語リファレンスとバッチレシピを MCP resource として公開**: 固定 index（`ksql://language-reference`・`ksql://recipes`）と章別テンプレート（`ksql://language-reference/{section}`・`ksql://recipes/{recipe}`）。本文は build 時に bundle へ embed し（実行時ファイル依存なし）、章はオンデマンド取得。未知 key は fail-closed。
  - **tool description を用途起点へ改善**: `ksql_app_metadata`（制約取得の主経路・安全語は保持）・`ksql_describe_app`（3列と `ksql_app_metadata` への誘導）・`ksql_query`/`ksql_mutate`（言語リファレンスへの導線）・**`ksql_show_apps`（全アプリ列挙で大規模ドメインでは肥大化しうるため、id 判明時は `ksql_app_metadata`（`resource:"app"`＝`GET /k/v1/app.json` 等）で単一アプリ取得へ誘導）**。MCPB manifest の `ksql_app_metadata` 欠落も是正。
  - 純加法・非破壊（既存ツール schema/動作・SQL/core/プラグイン不変）。SemVer=minor。

## v3.8.0（2026-07-21）

### 機能追加（B44 APPLY ブロック＝テーブル外項目とテーブル内項目を1文=1 PUT で同時更新）

- **`UPDATE/INSERT/UPSERT` に `APPLY` ブロックを新設**し、親（テーブル外）項目とサブテーブル（テーブル内）行を1文＝1 PUT record で同時に更新できるようにした。従来はテーブル内に既存違反があるとテーブル外項目だけの `UPDATE` も kintone の全体再検証（CB_VA01）で失敗し、DML だけでは修復できなかった問題を解消する。
  - 構文: `UPDATE APPxxx SET … WHERE 親条件 APPLY <テーブル> ( PATCH SET … {WHERE 行条件 | ALL ROWS | _idx=… | _rid=…} [EXPECT ROWS …] ; APPEND (子…) VALUES (…) ; REMOVE … )`。1文に複数テーブルの `APPLY` ブロックを併記可。
  - **PATCH**（既存行のセル更新・行 id/行順/未指定セルを保持）・**APPEND**（行追加・未指定子は既定値で明示補完）・**REMOVE**（行削除・存続行を全列列挙して保持）。多値フィールド（`CHECK_BOX`/`MULTI_SELECT`/`USER_SELECT` 等）は `APPLY <多値> (ADD …; REMOVE …)`。
  - **スナップショット意味論**: セレクタ・右辺は更新前スナップショットで評価し、同一文内の `APPEND` 行は同文の `PATCH`/`REMOVE` から不可視。
  - **post-image 検証**: 変異後のレコード全体を書き込み前に検証し、違反行を行ロケータ付きで報告（B43 相当のエンジンを新設）。
  - **行アドレッシング**: `ALL ROWS`（明示必須）・`WHERE 行条件`・`_idx`（0-based・既存システム列）・`_rid`（行 id）。`EXPECT ROWS n | BETWEEN | AT LEAST | AT MOST` で対象行数を表明し、不一致は書き込み前に `ArgumentError`。
  - **複数親**: 親 `WHERE` が複数レコードに一致する `UPDATE APPLY` に対応（1対象親=1 PUT record・100件/チャンク・非トランザクション・自動リトライなし・部分成功あり）。`INSERT APPLY`（親作成＋初期テーブル行）・`UPSERT APPLY`（`ON INSERT`/`ON UPDATE` 分岐）も対応。
  - **安全ガード**: revision ガード必須・二重ガード（`dmlMaxRows`＝親件数／`dmlMaxSubtableRows`＝変更子行数・既定500）。**MCP は全 APPLY mutation を実行前に fail-closed**（`allowDml`/`dmlMaxSubtableRows` でも解禁されない・VALIDATE ONLY / EXPLAIN は許可）。
  - CLI 実機・プラグイン実機で全機能を確認（複数親200件・INSERT/UPSERT 分岐・多値 ADD/REMOVE・`_idx`/`EXPECT ROWS`）。

### 機能追加（B48 プラグインの APPLY 親/子ガードを「最大取得件数」から兼用）

- **プラグインの複数親 APPLY で 100 親超を実行可能に**。新設定 UI を増やさず、既存の「最大取得件数」設定（既定3000）を親/子ガードへ兼用する: `dmlMaxRows = max(100, 最大取得件数)`・`dmlMaxSubtableRows = max(500, 最大取得件数)`。floor 付きで従来より厳しくならず後方互換（非正整数はフォールバック）。CLI（`--dml-max-rows` 等で明示）・MCP（fail-closed）・core 既定は不変。実機で親200件/子600件の APPLY 更新が success。

### 修正（B45 サブテーブル SELECT の WHERE でシステム列 `_pid`/`_rid`/`_idx`）

- **サブテーブル仮想テーブルの SELECT で `WHERE`/`ORDER BY` にシステム列を使えるようにした**。従来は `SELECT … FROM APPxxx$テーブル WHERE _pid = 7` が `WHERE_FIELD_UNRESOLVED` で実行前に失敗し、言語リファレンス §19 の記載例そのものが動かなかった（WHERE 述語分類器がシステム列のセマンティクスを持たなかったのが原因）。
  - 比較型を確定: `_pid`/`_idx`＝数値・`_rid`＝文字列（不透明識別子）。全比較演算子・`BETWEEN`/`IN`/`IS NULL`/`LIKE` に対応（`KLIKE` は局所評価不能で対象外）。サブテーブル SELECT は常にローカル全件評価のため kintone へは押し下げない。
  - 親項目ショートカット経由の `_p._pid` 等は無効（`WHERE_FIELD_UNRESOLVED` を維持）。`REORDER`/集計 `MIN`,`MAX`/DML は別経路のためスコープ外（非変更）。
  - CLI 実機 全10項目 pass（`_idx > 8` の数値比較・`ORDER BY _idx DESC` の数値順を決定的に確認）。SemVer は patch 相当だが本版に同梱。

## v3.7.0（2026-07-20）

### 機能追加（B42 VALIDATE のサブテーブル子フィールド監査）

- **`VALIDATE` の監査対象にサブテーブル子フィールドを追加**。`(fields)` 省略時の既定対象に、制約を持つ子フィールドと全子 `NUMBER` を含める（従来はトップレベルのみ＝テーブル内の必須/上下限/文字数/選択肢/数値精度違反が `#err` に一切出なかった監査の抜けを修正）。
- **詳細出力を固定9列へ拡張し、同一メッセージを集約**: 既存5列＋`$err_subtable`（テーブルコード）・`$err_subrow`（該当する全1-based表示序数のカンマ区切りリスト）・`$err_subrow_id`（同順の全永続行 ID＝仮想テーブルの `_rid`）・`$err_count`（件数）。装飾前の元 message を含む `($id, $err_subtable, $err_field, $err_code, $err_message)` ごとに1行とし、`$err_value` は先頭違反行、ロケータリストは全該当行を先頭出現順・切り捨てなしで保持する。サブテーブル違反が2件以上なら集約後の message 末尾へ `（2行: 1,2）` の形式で件数と `$err_subrow` リストを付加し、`INTO #err` にも装飾済み message を格納する。count=1の子違反とトップレベル/`CHECK` の message は不変。異なる元 message は別行。トップレベル/`CHECK` のロケータ3列は空で通常 count=1。`$err_subrow` の型メタは string、`$err_count` は number。`tempTableMaxRows` は集約後行数へ適用する。0行テーブルでは子の必須違反は発火しない。
- **scoped target 構文**: `VALIDATE APP100 (テーブル)` でテーブルの監査可能な子すべて、`VALIDATE APP100 (テーブル(子1, 子2))` で指定子だけを監査。裸の子コードは所有テーブル形式へ誘導して拒否。`VALIDATE APP100$テーブル` は親形式への案内付きで拒否。
- **生成時集約 `SUMMARY` モード**: `(fields)` 後・`WHERE` 前の soft keyword。詳細行を生成せず固定5列（`$id`, `$err_subtable`, `$err_field`, `$err_code`, `$err_count`）へ直接集約する。レコード横断の規模把握を担い、全該当行ロケータリスト付きの詳細9列とは別スキーマ。同名一時表への混在追記は解析時に拒否。
- **VALIDATE 結果へ集約前エラー統計を追加**: 詳細／SUMMARY とも `validateStats.errorRecords`（違反を持つ distinct `$id` 数）と `validateStats.errorCount`（集約前違反総数＝`$err_count` 合計）を返し、0件でも0/0を保持する。プラグインの結果ヘッダーは `エラー n レコード / m 件（表示 r 行）`、CLI サマリは `errorRecords=n errorCount=m` を表示。JSON／MCP／バッチ結果にも含めるが、`INTO #err` 後の汎用 SELECT へは引き継がない。
- **安全ガード**: `WHERE`/`CHECK` のサブテーブル子フィールド参照は records 取得前に `ArgumentError` で拒否（従来は存在チェックを素通りし得た潜在ギャップの封鎖）。NUMBER 子フィールドには数値精度（整数部桁数）検証を適用。
- **`EXPLAIN VALIDATE`** に mode（DETAIL/SUMMARY）・subtable audit・output schema・row locator を表示（records/mutation API は従来どおり 0 回）。
- 実機確認: 全9項目 pass（従来 0 行だった監査で子違反4件を検出＝実書き込み CB_VA01 の原因と一致・`$err_subrow_id`≡`_rid` 突合・SUMMARY 集約）。

### 修正（B46 選択肢検証の空値 false positive）

- **空（未選択）の選択系フィールドを `ERR_CHOICE_INVALID` と誤判定していた問題を修正**。選択肢照合に空値ガードが無く、空文字が `[""]` として定義済み選択肢と照合されていた（NUMBER・日時の検証には同ガードが既存）。実機パリティ裏付け＝kintone は空 `DROP_DOWN` の書き込みを受理し、`RADIO_BUTTON` への空指定もエラーにしない（黙って無視）。影響範囲＝`VALIDATE` 監査（トップレベル=v3.5.0 以降・サブテーブル子=本版）と DML 事前検証（`''` によるクリア書き込みの誤拒否）。必須チェック（`ERR_REQUIRED`）は従来どおり。83 suites / 2,107 テスト green。

## v3.6.1（2026-07-19）

### 改善・修正（B39 IMPORT の面 UX）

- **プラグイン: IMPORT のファイル選択 UI をヘッダー上部へ移動**（下部ボタン行の横スクロールを解消）。
- **既定ソース名を拡張子除去＋識別子化**（`plugin_import_10.csv` → `plugin_import_10`）。従来は `FROM CSV <ファイル名>` がドットで parse できなかった。日本語は保持・記号は `_`。
- **ファイル未選択の IMPORT エラーを面別の案内に**（従来は共通の「capability is disabled」）。plugin=「ファイルを選択してください」／CLI=「--import-csv/--import-json でソースを指定」／MCP=「importSources を指定」。gate エラーかつ当該面ソース未供給のときだけ差し替え、他エラーは不変。
- **DML 成功メッセージの「隔離 0 件（undefined）」を修正**。ON ERROR SKIP 無し（error table 未指定）のときは隔離句を出さない。
- **プラグイン: サブテーブル全置換の確認ダイアログをサマリ表示に**。親を1件ずつ全列挙して画面をはみ出していたのを、テーブル別合計＋削除がある親のみ（上限付き）へ集約。レコード数が増えても行数が一定。

## v3.6.0（2026-07-19）

### 機能追加

- **B39 IMPORT 文（ファイル → アプリ取込の自己完結ステートメント）**。`IMPORT INTO app (fields) FROM CSV|JSON <source> [射影/BY NAME] [ON DUPLICATE] [CHECK] [VALIDATE ONLY | ON ERROR SKIP INTO #err [REJECT LIMIT]]` を追加。ソースは**面が名前付きで供給**（CLI `--import-csv`/`--import-json <name=path>`・MCP inline `importSources`・plugin file picker）でパスを SQL に埋めない。10 MiB/source・off-by-default（source 供給時のみ有効）。
  - **CSV**: RFC4180（UTF-8/SJIS・BOM・セル内改行）・位置対応/`SELECT` 射影（`CAST`/関数/`||`/`@var`）・源内キー重複拒否。
  - **JSON**: 厳密10進 decoder（元字句保持・safe-int のみ数値・精度対象は string 必須）・全階層 duplicate key 拒否・欠落/null/presence を区別。
  - **cli-kintone 互換（BY NAME）**: ヘッダ＝フィールドコード名対応・既知非書込み/未知列の監査付き無視（`IGNORE UNKNOWN COLUMNS`）・複数値セル内 LF 分割。
  - **レコード番号純 UPDATE**: `IMPORT UPDATE … MATCH RECORD NUMBER SOURCE <header>`（照合専用・INSERT 0・source 重複 global 拒否）。
  - **サブテーブル**: JSON ネスト＋cli-kintone CSV `*` 形式。JSON は ID なし全置換（全子行新採番）、CSV は行 ID 維持更新・空/未知 ID 追加・欠落 ID 削除。破壊的全置換は `REPLACE SUBTABLES` 必須＋confirm で削除件数明示、内訳を表示できない面（MCP 等）は fail-closed。4層エラー位置（`$err_subtable/$err_subrow/$err_source_row`）・親単位隔離・`REJECT LIMIT` は invalid 親数。
  - CLI/MCP/plugin 全面・cli-kintone v1.21.0 実 export で round-trip 実証。**添付ファイル（FILE）は対象外**。

### 修正（正しさ）

- **USER/ORGANIZATION/GROUP 選択フィールドの `INSERT / UPSERT … SELECT` payload を修正**。選択値の `[{code}]` を共通 DML 検証後も保持する。従来は `INSERT … SELECT` で検証正規化が `string[]` へ平坦化し、`UPSERT … SELECT` の更新側では JSON 文字列のままとなり、どちらも kintone REST の書込み形式と不一致だった。`INSERT … VALUES ('u1')` の従来変換（`[{code:'u1'}]`）は不変。

## v3.5.0（2026-07-19）

### 機能追加

- **B41 既存レコードの制約チェック（`VALIDATE` 文）**。`VALIDATE <app> [(fields)] [WHERE …] [CHECK WHEN … THEN …] [INTO #err]` の read-only 監査文を追加。既存レコードを組み込み制約（必須・数値上下限・文字数・選択肢・B29 桁）とカスタムチェック（B37 構文）で検査し、違反を `$id / $err_field / $err_code / $err_message / $err_value` の 5 列で返す（`INTO #err` で複文再利用）。組み込み検証は生値（USER/ORG/GROUP 等の空配列を必須違反として検出）、WHERE・CHECK は flatten 値で評価する。read-only（書込み API 0 回・`--allow-dml` 不要・全 surface で `onLimit=truncate` を無効化）。WHERE は KLIKE・サブクエリ・修飾参照を静的拒否し、取得は `fetchAll`（offset＋`$id` keyset）＋安全 prefilter＋取得後ローカル再評価。`EXPLAIN VALIDATE` は取得フィールド・完全入力要否・metadata 利用を表示し、レコード/mutation API は呼ばず違反件数も出さない。単文 `VALIDATE … INTO #err` は temp スコープが無いため拒否。
- **B3＋B10-B バッチ変数の参照拡張**。スカラー変数を `SELECT @x AS alias` の定数列として使用でき、文字列配列 `SET @list=['A','B']` をカッコ無し `IN @list` / `NOT IN @list` で通常の literal IN へ展開できる。空配列は親条件を含めて真偽簡約し、恒偽 SELECT はレコード API を省略、更新系の恒真 WHERE は実行前拒否、恒偽 WHERE は 0 件 no-op とする。scalar/array の誤用は validate-all-first で全件静的拒否し、EXPLAIN も実行時と同じ展開・簡約を表示する。`IN (@a,@b)` と `@x || field` の既存動作は維持。

## v3.4.0（2026-07-18）

### 機能追加

- **B38 文字列連結演算子 `||` と再利用スカラー値式を追加**。`a || b` は既存 `CONCAT(a, b)` と同義（両辺を文字列化して連結・NULL/空は空文字＝kSQL 一貫）。左結合、優先順位は加減算（`+`/`-`）と同レベル。`CONCAT` などの**関数引数にバッチ変数 `@var` を渡せる**ようになった（`CONCAT('x=', @v)`）。SELECT 列・`UPDATE SET`・`CASE` 結果・下記 CHECK メッセージで使える。既存 `ArithNode`・集約入り関数（`FORMAT(SUM(...))`）は非破壊で維持。**`||` は WHERE の比較オペランドでは未対応**（`CONCAT` を使う）。
- **B37 DML カスタムチェック `CHECK WHEN <条件> THEN <メッセージ>` を追加**。INSERT / UPSERT / UPDATE に行レベルの業務ルールを付与し、条件に該当した行をカスタムメッセージ付きで `#err`（`ERR_CHECK`）へ隔離する。`ON ERROR SKIP` で不良行を隔離して残りを書き込み、`VALIDATE ONLY` で書かずに報告、処分節なしの素 DML では書き込み前に停止する。
  - **`CHECK` ブロック＝グループ**：ブロック内は最初に該当した `WHEN` だけを採用（先勝ち）、`CHECK` ブロックを複数並べると互いに独立。「関連するチェックは最初のエラーのみ／関連しないチェックはそれぞれ」を表現できる。
  - **参照は読み取り行**：INSERT/UPSERT … SELECT は元 SELECT 出力行（先頭 N 列＝書込み・残りの末尾列は CHECK 専用・出力名は一意）、VALUES は挿入列、UPDATE は更新前の既存値（書込む新値は SET 式を書く）、UPDATE … FROM は `APP<n>.列`＝更新前ターゲット・`<source_alias>.列`＝ソース新値で識別する（減額チェック等）。
  - メッセージは `||` / `CONCAT` でフィールド・`@var` を補間できる。条件では `||` 不可（`CONCAT` を使う）。組み込み検証（必須・型・範囲・桁）とは独立に評価し、`#err` は組み込みエラー → カスタムエラー（グループ順）の順。評価器例外（比較非対応型など）は行隔離せず文全体を fail-closed。`CHECK` は新しいソフトキーワード（`CHECK WHEN` の並びのときだけ）で新規予約語なし。サブテーブル DML には非対応。

## v3.3.0（2026-07-18）

### 機能追加

- **B20 正規表現関数 `REGEXP_LIKE` / `REGEXP_REPLACE` / `REGEXP_SUBSTR` を追加**。ECMAScript 方言、`i` / `m` / `s` のみ受理、Unicode モード `u` を常時有効化する。パターンとフラグは式・フィールドを含めて実行時評価し、SELECT / WHERE / HAVING / ORDER BY / 一時テーブル / CTE / 通常の `UPDATE SET` で使用できる。3語は新しい予約語で、同名フィールドはバッククォートで参照する。
- 正規表現は opt-in ゲートを設けないユーザー責任の機能として提供する。ReDoS の中断不能、プラグイン・CLI・MCP ごとの復旧手段、ホストと Unicode 版による結果差、DML 書き戻しで保存データ差になり得る点を言語リファレンスへ明記した。
- **B36 `REGEXP_REPLACE` に第 5 引数 `occurrence` を追加**。`REGEXP_REPLACE(x, pattern, replacement [, flags [, occurrence]])`。`occurrence` を省略または `0` にすると従来どおり全置換、`1` で先頭の一致だけ、`N` で N 番目の一致だけを置換する（一致数を超える `N` は無変化）。`occurrence` は実行時評価で、非負整数以外は `ArgumentError`。N 番目置換でも後方参照（`$1` 等）は当該一致に展開する。kSQL の第 4 引数は `flags` のため、MySQL/Oracle と引数位置が異なる（`occurrence` 指定時は `flags` を明示、不要なら空文字）。

### 修正（正しさ）

- **B29 kintone の数値精度設定と整数部の桁超過を Tier-0 で検出**。書き込み先に NUMBER 列がある INSERT / UPSERT / UPDATE では運用環境の `app/settings.json` から `numberPrecision`（`digits` / `decimalPlaces` / `roundingMode`）を取得し、整数部が予算 `I = digits − decimalPlaces` を超える値を `ERR_NUMBER_INTEGER_DIGITS` で API 呼び出し前に検出する。通常書き込み・`VALIDATE ONLY`・`ON ERROR SKIP` の全経路で同じ厳密10進 primitive を使う。取得は同一実行コンテキスト・アプリごとに最大1回で、失敗・不正レスポンス・未知モードでは既定値を補わず fail-closed する。CALC の直接指定は従来どおり書き込み不可で、ソース側 CALC だけを理由に設定は取得しない。
- **小数部は kSQL では検証しない**。`decimalPlaces` を超える小数はそのまま kintone へ渡し、kintone が `roundingMode` で自動丸めする（REST API・CSV 読み込み・編集画面と同じ挙動＝プラットフォーム一貫性）。したがって `1/3` などの算術結果や小数の多い入力に `ROUND` を強制しない。`+ - * / %`、集計、数値関数、CASE、CALC 由来値の計算は引き続き binary64。
- **互換性注意（minor）**: 整数部超過は従来 kintone が `CB_VA01` で拒否していた挙動を、書き込み前のローカル診断・`ON ERROR SKIP` の行隔離へ前倒しする（従来 `VALIDATE ONLY` で valid だった整数桁超過行が invalid へ変わり得る）。小数の扱いは従来から変更なし。NUMBER を書き込む credential には一般設定取得 API を利用できるレコード閲覧権限または追加権限が必要で、設定を取得できない場合は文全体が失敗する。証跡: docs/internal/evidence/b29_number_precision_smoke.md
- **B9 最大30桁の有限10進比較を厳密化**。NUMBER/CALC の WHERE・HAVING・CASE・BETWEEN・ASSERT・IN、通常/サブテーブル DML、REORDER、ORDER BY/ウィンドウ、MIN/MAX、GREATEST/LEASTを単一の文字列ベース比較primitiveへ統一し、`9007199254740992` と `9007199254740993` を区別する。SQL数値リテラルは元字句を保持し、`digits[.digits][e±digits]` の指数表記も受理する。SIMPLE RESTと単純INSERT/UPSERT VALUESにも丸め前の字句を渡す。
- typed number の固定バンドは維持するが、空白のみの値は `Number(' ')=0` とせず「その他非数値」の末尾バンドへ移す。JS算術・SUM/AVG・数値関数は引き続きbinary64であり、演算前の10進値は復元しない。
- **互換性注意（重要）**: 16 有効桁を超える NUMBER の比較結果が変わる。実機で公開 v3.2.0 と比較したところ、binary64 で同値扱いされていた値（例 999999999999.9991 と .9992）が B9 では区別され、**MIN/MAX・ORDER BY・WHERE = の結果が正しくなる**（v3.2.0 は MIN が誤り・ORDER BY が逆順だった）。厳密には後方非互換だが、変わるのは 16 桁超という稀な領域で、かつ従来が誤りだった値のみのため、**ユーザー判断で v3.3.0（minor）に含める**。移行ガイドに明記。証跡: docs/internal/evidence/b9_exact_decimal_semver_probe.md

## v3.2.0（2026-07-18）

### 機能追加

- **B23 `LENGTH_CHAR(x)` を追加**。既存の `LENGTH`（UTF-16 コードユニット数）を変更せず、Unicode コードポイント数を返す別関数を追加する。`LENGTH(x) - LENGTH_CHAR(x)` でサロゲートペア数を求められ、戻り値は B26 の型メタで numeric として temp/CTE/ORDER BY/比較へ伝播する。
- **B24 `TRANSLATE(x, from, to)` を追加**。入力と変換表をコードポイント単位で整列し、1 文字から 1 文字へ写像する。変換表の長さ不一致はコードポイント数を示す `ArgumentError`、重複文字は最初の対応を優先し、非対象文字と既存の孤立サロゲートは保持する。Shift_JIS CSV 出力向けの 40 字変換表をバッチレシピ R8 に追加した。
- `LENGTH_CHAR` と `TRANSLATE` は新しい予約語。同名フィールドはバッククォートで参照できる。純加法的な機能追加として B34/B22 と同じ v3.2.0 minor リリースに含める。

### 修正（正しさ・安全性）

- **B21 `UPDATE SET` が文字列関数を直接受け付けない不整合を修正**。親レコードの通常 `UPDATE` で `SET t = UPPER(t)`、`SET code = LPAD(code, 5, '0')` などを受理し、参照フィールドを取得してレコードごとに評価する。関数の戻り型契約を維持したまま `VALIDATE ONLY` / `ON ERROR SKIP` の検証経路へ渡し、B34 の書き込み先検査は対象取得より前に行う。算術式内の文字列関数、フィールド参照単独、`UPDATE ... FROM` / サブテーブル UPDATE での直接関数は引き続き明示エラーとする。
- **B28 DML 値の単項符号の受理不整合を修正**。親・サブテーブルの `INSERT ... VALUES` と `UPSERT ... VALUES` で `-5` / `+5` / `-0.5` / `+0.5` などを数値リテラルとして受理する。`UPDATE SET` の単項 `+` は数値リテラル直前だけに限定し、既存の単項 `-` が式・フィールドへ掛かる範囲は維持する。符号のネスト、VALUES 内の算術式・フィールド参照・関数は引き続き拒否する。
- **B35 プラグインの message なしネットワークエラー表示を修正**。kintone API が message なし・空文字列・undefined で reject した場合、元の値を `cause` に保持した Error と判別可能なネットワーク fallback 文言へ正規化する。表示層にも汎用文言の最終防衛を置き、「⚠」だけ、または `[object Object]` だけが表示される状態を防ぐ。kintone 正規エラーの code/message/errors 詳細と Cursor 系 Error の表示は変更しない。
- **B34 DML の書き込み先フィールド検査を追加**。親レコードの INSERT VALUES/SELECT、UPDATE（通常・算術・CASE・UPDATE FROM）、UPSERT VALUES/SELECT で、不存在フィールド、サブテーブル子フィールド、書き込み不可フィールドを文単位の `ArgumentError` とする。`VALIDATE ONLY` / `ON ERROR SKIP` にも同じ検査を適用し、サブテーブル子のエラーは `APPxxxx$テーブル` 構文を案内する。
- 検査をソース SELECT、更新・UPSERT対象取得、確認、POST / PUT より前へ固定。不正な書き込み先ではフォーム定義以外のレコード取得・確認・書き込みを行わない。正規のサブテーブル DML（INSERT VALUES / UPDATE / DELETE / REORDER）は従来どおり動作する。
- **B22 `LEFT` / `RIGHT` / `SUBSTRING` / `LPAD` / `RPAD` がサロゲートペアを分割する不具合を修正**。長さ引数を UTF-16 コードユニット予算として維持しつつ、入力中で対になっていたペアを割る境界では安全な側へ縮め、結果を必ず指定予算以下にする。`LPAD` / `RPAD` は入力の切り詰めと埋め文字列の切り詰めの両方に適用する。`LENGTH` / `LIKE '_'` / `INSTR` の単位は変更しない。

## v3.1.0（2026-07-18）

### 機能追加

- **B33 `KORDER BY` 大規模窓の Cursor API 対応**。単発 Records API で完結しない窓（`LIMIT > 500` / `OFFSET > 10000`）を、kintone Cursor API（作成・取得・削除）で kintone 固有順のまま実行する計画 `KORDER_CURSOR` を追加。走査件数 `OFFSET + LIMIT <= maxRecords` を満たす場合だけ実行し、超過は理由コード付き planning error（通常 `ORDER BY` へフォールバックしない）。単発 GET で完結する窓は従来どおり `KORDER_NATIVE` を優先する。
- カーソルは 500 件ずつ逐次取得し、必要窓へ到達した時点で即時削除する。結果順は kintone が返した順のまま（ローカル再ソート・暗黙 `$id` 追補なし）。対象集合は作成時点で固定だが、値は各取得時点（完全スナップショットではない）。
- 新設定 **`cursorMaxActive`**（host 単位の同時カーソル上限。既定 2・最大 5）: CLI `--cursor-max-active` / env `KSQL_CURSOR_MAX_ACTIVE` / profile `query.cursorMaxActive` / MCP ツール入力 / プラグイン「⚙ オプション」。同一 host では最後に実行した面の設定を反映し、縮小時は既存カーソルの自然減を待つ。
- Create / Get Cursor は自動再試行しない（応答喪失時の孤児カーソル・ページ欠落を防ぐ）。既解放判定は実測に基づき `HTTP 404` + `GAIA_CN01` のみ。解放を確認できない場合は最大 10 分+30 秒の間カーソル枠を隔離し、成功結果には `CursorCleanupWarning` を付けて返す。プラグインはページ離脱時に best-effort で削除を試みる。
- EXPLAIN に `KORDER_CURSOR` 計画（fetch API / cursor page size / cursor concurrency / scan rows）と cursor 系メトリクス 9 種を追加。
- MCP `ksql_explain` に `maxRecords` 入力を追加（`ksql_query` で実行できる `KORDER_CURSOR` クエリの計画を確認できない非対称を解消）。

既存クエリの挙動変更はない（従来 planning error だった窓が成功可能になる純加法的変更）。詳細は [v3.1.0 移行ガイド](docs/ksql_v3_1_migration_guide.md) を参照。

## v3.0.0（2026-07-17）

### Breaking changes

- **B26 型付きcanonical比較へ統一**。通常`ORDER BY`、ウィンドウORDER、MIN/MAX、WHERE範囲比較、REORDERが共有leafを使う。文字列と型不明列はUnicodeコードポイント順で、`localeCompare`・Unicode正規化・数字らしい文字列のペア単位自動数値化を行わない。typed numberは`空セル < -Infinity < 有限数 < +Infinity < "NaN" < その他非数値`の固定バンドを使う。
- 数字だけのtyped stringのWHERE範囲比較は返る行が変わり得る。たとえば文字列列では`'20' > '100'`が真になる。SELECTでkintone RESTが受理しない文字列`<` / `>`はB32の型×演算子能力判定によりFULL_SCANへ切り替え、DMLは実行前に拒否する。
- B14 `#err`のNUMBER宣言列にある検証失敗値を型破損エラーにせず固定末尾バンドで扱う。これに伴い、v2.15.0の履歴上の受入証拠`MIN(数値T1)=NaN`はv3の結果契約ではなくなる。
- JOIN両側に同名列がある非修飾ORDERキーは、行数や入力順に依存して処理せず`ambiguous column`としてplanning時に拒否する。
- `KORDER`を予約語に追加。同名フィールドはバッククォートで参照する。
- schema-aware plannerとの一致のため、`EXPLAIN`はフォーム定義と必要時のプロセス状態metadataを読む。レコード取得・書き込みは行わないが、対象アプリのmetadataを読めない認証では失敗する。

### 機能追加

- **B31 `KORDER BY`を追加**。kSQL canonical順ではなくkintone REST固有順を明示的に選ぶ別構文。初期版はトップレベル単一物理アプリ、非修飾直接フィールド、完全押し下げWHERE、明示15型＋`$id`、`LIMIT 0..500`かつ実行時`maxRecords`以下、`OFFSET 0..10000`に限定する。条件外は通常ORDERへfallbackせずplanning error。
- **B27 schema-aware ORDER plannerを追加**。通常ORDERのREST top-N初期allowlistは`$id`だけ。WHERE・型・query形状・LIMIT/OFFSET窓全体がcanonical結果と同値な場合だけ単発GETへ押し下げ、それ以外は完全候補取得後にlocal canonical sortする。
- EXPLAINに`CANONICAL_LOCAL` / `CANONICAL_REST_TOP_N` / `KORDER_NATIVE`、metadata API依存、完全入力要否を表示する。

### 修正（正しさ・安全性）

- **B30 部分候補の誤ったtop-Nを禁止**。local ORDER BYで`maxRecords`へ到達した場合、`onLimit=truncate`でも部分候補を並べ替えて成功せずfail-closedで停止する。REST top-NとKORDER_NATIVEは単発窓のため対象外。
- STATUSのローカル順で`states.*.index`を保持・条件付き取得し、プロセス定義順を再現する。RANK/DENSE_RANKのpeer比較へ結果表示用tieを混ぜない。
- `Infinity - Infinity`等で比較器がNaNを返す仕様外依存を避け、strict weak orderを性質テストで固定した。

詳細と移行手順は[v3.0.0 移行ガイド](docs/ksql_v3_migration_guide.md)を参照。

## v2.17.0（2026-07-16）

### 機能追加

- **B19 スカラー関数を追加**。`TRUNCATE`（`TRUNC`）／`LEFT`／`RIGHT`／`INSTR`／`GREATEST`／`LEAST`／`LPAD`／`RPAD`／`LAST_DAY` に対応する。`TRUNCATE` は `FLOOR` と異なり 0 方向へ丸めるため、負数で結果が変わる。`RIGHT` は `SUBSTRING` では代替できない（`SUBSTRING` は引数に算術式を取れず、負数の開始位置は全文を返すため）。
- `GREATEST` / `LEAST` は列方向の集約 `MAX` / `MIN` と異なり、同じ行の引数同士を比較する。空文字を常に最小として先に確定し、残りが全て数値なら数値比較、1 つでも非数値なら集合全体を文字列比較する。数値が同値のときは元の文字列表記を二次キーにするため、引数の順序で結果は変わらず、`LPAD` による 0 埋めなどの表記も保持する。
- `TRUNCATE` / `TRUNC` / `INSTR` / `GREATEST` / `LEAST` / `LPAD` / `RPAD` / `LAST_DAY` は新しい予約語。同名フィールドはバッククォートで参照できる。厳密には構文互換性リスクがあるが、`KLIKE` / `GROUP_CONCAT` 追加時と同じ方針で minor リリースとする。`LEFT` / `RIGHT` は `LEFT JOIN` / `RIGHT JOIN` で既に予約語のため、新規追加はない（直後に `(` がある場合のみ関数として扱う）。
- 追加した関数は引数の個数を検証し、不正な場合は `ArgumentError` とする。既存関数の引数個数の扱いは変更しない。

### 修正

- **`DATE_ADD` の構文が言語リファレンスと実装で食い違っていた問題を修正**。リファレンスに記載していた MySQL 互換の `DATE_ADD(フィールド, INTERVAL n UNIT)` は `INTERVAL` がトークンとして存在せず、記載どおりに書くと必ず `ParseError` になっていた。実装が受け付ける `DATE_ADD(日付, 加算値, 単位)` へ文書を修正した。
- **`DATE_ADD` に `YEAR` / `MONTH` / `DAY` 以外の単位を渡すと、黙って `DAY` として加算していた問題を修正**。`'HOUR'` / `'WEEK'` や単位の誤記が、エラーにならず日単位の加算として成功していた。実行時に `ArgumentError` とする。従来「成功していた」呼び出しが失敗へ変わるが、その結果は元々誤っていたため、誤った成功を失敗へ変える方向の修正となる。
- `SUBSTRING` の開始位置に負数を指定した場合、MySQL と異なり全文を返すことをリファレンスへ明記した（挙動は変更しない）。末尾からの切り出しには新設の `RIGHT` を使う。

## v2.16.0（2026-07-16）

### 機能追加

- **B17 順位系ウィンドウ関数を追加**。`ROW_NUMBER()` / `RANK()` / `DENSE_RANK()` と `OVER ([PARTITION BY ...] [ORDER BY ...]) AS alias` に対応する。ウィンドウ関数はFULL_SCANでHAVING後・DISTINCT前に評価し、CTEを使って「各グループの最新1件を全列付きで取得」を1文で記述できる。
- ウィンドウ内のORDER BYはトップレベルORDER BYと比較器を共有し、物理アプリの数値型と選択肢定義順を反映する。CTE／一時テーブル由来のソートメタ制限は既存ORDER BYと同じ。
- `ROW_NUMBER` / `RANK` / `DENSE_RANK` は新しい予約語。同名フィールドはバッククォートで参照できる。`OVER` / `PARTITION` はソフトキーワードで、ウィンドウ列の `AS alias` は必須。

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
  - 詳細は `docs/ksql_language_reference.md`・`docs/internal/cli_app_profile_spec.md`・
    `docs/internal/ksql_mcp_server_spec.md` を参照。

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
