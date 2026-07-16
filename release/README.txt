ksql 配布パッケージ (v2.11.0)

1. ksql-plugin-v2.11.0.zip を kintone のプラグイン画面で読み込む
2. ksql-app-template-v1.11.0.zip をアプリ作成時にテンプレートとして読み込む
   (アプリテンプレートは v1.11.0 から変更ありません)
3. アプリにプラグインを適用して利用開始する

v2.11.0: 残バグ修正（正しさ・安全性）と LIMIT > 500 の取得打ち切り最適化（性能）。
- 正しさ: 0 行の SELECT * が一時テーブル・CTE 経由で出力列を失う問題を修正。列スキーマも
  保持して実体化し、JOIN なし単一ソースの 0 行 SELECT * に伝播。差分バッチの空日に
  INSERT/UPSERT ... SELECT * FROM #empty_temp が no-op で完走(明示列は v2.1.1 済)。
  混在ワイルドカードは 0 行でも明示列を復元。JOIN 付き 0 行 SELECT */実アプリ bare
  SELECT */_p.* は対象外。
- 安全性: CLI の DML 実行で --on-limit truncate によるソースの暗黙切り捨て(部分書き込み)を
  防止。CLI の DML(単文・バッチ)は onLimit を常に error 固定(MCP・プラグインと同型)。
  read-only SELECT の truncate は従来どおり。
- 性能: SIMPLE SELECT の LIMIT > 500 を安全な範囲で早期停止。ORDER BY なし・KLIKE なしの
  クエリは OFFSET + LIMIT 件を取得した時点で正常終了(GET 回数を削減)。上限の意味論変更=
  maxRecords は取得行数の上限。安全対象では OFFSET + LIMIT <= maxRecords なら一致総数が
  maxRecords 超でも上限エラー/truncate 警告を出さず LIMIT 窓を返す。ORDER BY 付き・KLIKE・
  LIMIT なし・OFFSET + LIMIT > maxRecords は従来どおり。
- 詳細は CHANGELOG.md を参照。

v2.10.1: SIMPLE SELECT の LIMIT > 500 が API エラー(GAIA_QU01)になる不具合を修正。
- 単発 GET/ページング判定を AST の LIMIT 値(<=500)で行うよう修正。LIMIT > 500 は
  fetchAll で 500 件ずつページングし取得後に LIMIT を適用。LIMIT <= 500 は単発 GET 維持。
- 注意: fetchAll は一致を maxRecords まで取得してから LIMIT を適用するため、
  LIMIT > 500 は一致総数が maxRecords 以下である必要がある(取得打ち切り最適化は別課題)。
- 詳細は CHANGELOG.md を参照。

v2.10.0: 検索打ち切り検出と FROM なし SELECT 実体化の修正(後方互換)。
- FROM なし SELECT/UNION(SELECT 'A' UNION ALL SELECT 'B' 等)を CREATE TEMP TABLE AS で
  実体化すると 0 行になる不具合を修正。リテラル値リストを一時テーブル化して
  IN (SELECT ... FROM #t) で使えるように(レシピ集 R5)。
- kintone の検索打ち切り(10万件・like/not like/KLIKE)を検出。SELECT は警告付き、
  DML・SELECT ベース DML・一時テーブル実体化は書き込み前に SearchAbortedError で停止
  (サイレントな一部更新/削除を防止)。X-Cybozu-Warning を Node/CLI/MCP で判定
  (プラグインは非検出)。将来 KLIKE 親 DML 解禁の安全基盤。
- レシピ集に R5 と検索打ち切りの注意を追記。
- 詳細は CHANGELOG.md を参照。

v2.9.0: KLIKE プレフィルタ押し下げ(最適化・後方互換)。
- FULL_SCAN の SELECT でも、KLIKE / NOT KLIKE が安全な AND リーフなら kintone へ
  プレフィルタ押し下げ。KLIKE で候補を絞り、LIKE・関数・集計・DISTINCT を JS で精製できる
  (例: 件名 KLIKE '至急' AND 備考 LIKE '%緊急%')。v1 で拒否だった併用が可能に。
- 押し下げ計画を検証・取得・JS 評価・EXPLAIN で共有し、実際に押し下げた KLIKE だけを
  適用済み扱い。集合外 KLIKE はエラー(fail-closed)。
- JOIN 併用は全 JOIN が INNER のときだけ許可。LEFT/RIGHT JOIN・OR/NOT(...)配下・
  CTE/一時テーブル上の KLIKE は拒否(外部結合の未一致行による誤結果を防止)。直接 NOT KLIKE は可。
- 全 DML 拒否・10万件打ち切りによる完全結果非保証は従来どおり。
- 詳細は CHANGELOG.md と言語リファレンス § KLIKE を参照。

v2.8.0: KLIKE(kintone キーワード検索)演算子を追加(後方互換)。
- KLIKE / NOT KLIKE は SQL LIKE(JS 部分一致)とは別演算子で、kintone の like/
  not like キーワード検索を明示的に呼び出す。大規模アプリのテキスト検索を高速化
  (LIKE は FULL_SCAN で取得上限に達しがち・KLIKE は SIMPLE で kintone 側検索)。
- v1 は SIMPLE SELECT の WHERE 限定(FULL_SCAN になる SELECT は実行前拒否・CTE/UNION/
  サブクエリも検証)。=/IN/数値比較等との AND/OR は SIMPLE で結合押し下げ。
- 右辺は文字列/文字列バッチ変数のみ(置換後も検証)。% は拒否・_ は kintone の単語
  構成文字。全 DML で使用不可(10万件打ち切り検出まで親 DML も拒否)。
- 一致挙動は kintone 仕様準拠で SQL 部分一致とは異なる(文字種で挙動が異なる。観測では
  英数字=語単位・日本語=2文字以上の部分一致)。10万件打ち切りは検出せず完全性非保証。
- KLIKE は予約語。同名フィールドはバッククォート(`KLIKE`)で参照。
- 詳細は CHANGELOG.md と言語リファレンス § KLIKE を参照。

v2.7.0: STATUS(ワークフロー状態)の IN 押し下げ(最適化・後方互換)。
- v2.6.0 で対象外とした STATUS の IN/NOT IN を、プロセス管理設定 API による
  状態検証付きで kintone の事前絞り込みに使う(取得後に同じ規則で再評価)。
- 安全性: プロセス管理が有効(enable=true)かつ全 IN 値が実在状態名のときだけ押下。
  無効(GAIA_ST02)・非実在(GAIA_IQ10)・空文字は非押下で JS 評価のみ。
- 状態一覧は status.json?lang=user の状態名を実在検証に使用(実行ユーザーの表示言語・
  多言語対応)。フィールド型が STATUS のフィールドを対象にし、フィールドコードに
  依存しない(ステータス/Status/任意のカスタムコードで動作)。
- 型メタ確定後の 2 段階判定で、IN 候補に STATUS があるアプリだけ status.json を取得
  (NUMBER/選択系のみのアプリでは呼ばない)。APP/profile 別キャッシュ・同時1回・
  LAPP 論理参照も物理 APP へ正しく route。
- 対象外: STATUS_ASSIGNEE(作業者)。フェーズ2a の 4 型・数値・$id 押下は不変。
- 詳細は CHANGELOG.md と言語リファレンス § IN / NOT IN を参照。

v2.6.0: 選択系 IN 押し下げと空セル評価(最適化＋バグ修正・後方互換)。
- 選択系 IN/NOT IN の押し下げ(述語分割 第2段): LIKE 等で FULL_SCAN になる
  クエリでも、AND 併記した選択系フィールドの IN/NOT IN を kintone の事前絞り込みに
  使い取得件数を削減(取得後に同じ型付き規則で再評価)。対象は DROP_DOWN/
  RADIO_BUTTON/CHECK_BOX/MULTI_SELECT で、型と選択肢の実在(optionOrder・追加
  API なし)を確認できた空でない文字列リテラルのみ。非実在値・空文字・メタ未取得は
  非押し下げ(kintone のクエリエラー化を回避)。ユーザー/組織/グループ選択・ステータスは
  対象外(従来どおり JS 評価)。EXPLAIN は pushdown candidate 行に表示。
- 選択系 IN('')/NOT IN('') の空セル評価を修正(バグ): kintone は 選択 in ("") を
  空/未設定セルに一致させるが、FULL_SCAN の JS は空スカラー=""(2文字)・空配列=[]
  のため一致していなかった。flatten の null/undefined を 0 文字の空文字へ正規化し
  (サブテーブルと整合)、空配列を IN('') に一致させて SIMPLE/FULL_SCAN を揃えた。
  副次で空スカラー選択の投影も ""(2文字)→空 に是正。テキスト/数値/非空は不変。
- 詳細は CHANGELOG.md と言語リファレンス § IN / NOT IN を参照。

v2.5.0: FULL_SCAN の IN / NOT IN を型メタ付きで評価(バグ修正・後方互換)。
        最適化ではなく SIMPLE / FULL_SCAN 間の結果不一致の修正。
- チェックボックス・複数選択・ユーザー選択などの複数値/オブジェクト型で、
  FULL_SCAN の IN が実質一致せず SIMPLE で一致するレコードが 0 件に化けて
  いた問題を修正(例: 主担当 IN ('rex0220') が SIMPLE=20/FULL_SCAN=0)。
  フィールド型メタを JS 評価まで渡し、型ごとの単位で比較。
- チェックボックス/複数選択は選択値のいずれか、ユーザー/組織/グループ選択・
  作業者・作成者・更新者は表示名でなく code を比較。型判別は値の見た目でなく
  型メタで行い、テキストの文字列 ["A"] は配列と誤検出しない。型不明・形不一致は
  従来の文字列比較を維持。サブテーブルの型メタも TABLE.fields で再帰取得。
- 適用範囲は WHERE / HAVING / CASE WHEN / サブテーブル DML / IN (SELECT ...)。
  SIMPLE・= / != ・LIKE は不変。一時テーブル/CTE 経由は文字列比較(別課題)。
- 本リリースの対象外(後続): 選択系 IN の押し下げ・選択肢実在検証・STATUS 状態
  一覧 API。詳細は CHANGELOG.md と言語リファレンス §11 を参照。

v2.4.0: バッチ変数の外部パラメータ注入 DECLARE @x = 既定値 を追加
        (Phase 1c・後方互換)。
- 同じ定型 SQL を、値だけ外部(MCP パラメータ / CLI フラグ)から差し替えて
  実行できる。DECLARE @since = '2026-01-01'; SELECT ... >= @since を、
  MCP variables:{"since":"..."} / CLI --var since=... で上書き。未注入なら
  既定値を実行時に1回評価(注入時は既定値式を評価しない)。
- 注入キーは @ なし・大小区別なし。未宣言名の注入はバッチ実行前にエラー。
  DECLARE と使用文を含む2文以上のバッチが必要。値バインドで SQL インジェク
  ションは発生しない。
- プラグインは DECLARE を実行できるが注入経路はなく常に既定値。CLI --var は
  プロセス一覧/シェル履歴に残り得るため秘密情報には使わない。
- 詳細は CHANGELOG.md を参照。

v2.3.0: バッチ変数のスカラーサブクエリ代入 SET @x = (SELECT ...) を追加
        (Phase 1b・後方互換)。
- ; 区切りバッチ内で、サブクエリの結果(1 行 1 列)を変数へ代入できる。件数
  ゲートの DRY 化が主用途(例: SET @cnt = (SELECT COUNT(*) FROM APP100 WHERE
  ...); ASSERT @cnt BETWEEN 0 AND 10000;)。
- SET 時に一度だけ評価しバッチ内定数に。先行の一時テーブル・変数を参照可。
  1 行 1 列でなければエラー。後置算術は不可(サブクエリ内で計算)。
- SET の評価失敗は continueOnError に関わらずバッチ停止(fail-fast)。EXPLAIN は
  SET サブクエリの計画を表示。参照位置は WHERE / UPDATE SET / ASSERT / IN。
- 詳細は CHANGELOG.md を参照。

v2.2.0: 述語押し下げの安全化と数値対応。
- FULL_SCAN の数値範囲比較で空の数値セルを 0 扱いしていた問題を修正。kintone
  (SIMPLE)は空を -infinity 相当(< /<= は含む・> />= は除外)として扱うため、
  同じ SQL が実行モードで異なる結果を返していた。JavaScript 評価も同じ規則へ
  統一(範囲比較で左辺が空・右辺が有限数のとき < /<= は真・> />= は偽)。
  WHERE / HAVING / CASE WHEN / サブテーブル UPDATE・DELETE・REORDER / ASSERT・
  BETWEEN に反映。= / != ・右辺空・非数値・非有限・文字列範囲は不変。
- FULL_SCAN のプレフィルタ押し下げを、超集合性を確認できる述語だけに限定
  (安全化)。従来 JOIN/エイリアス経路で押し下げていたテキスト等値・!=・IS NULL・
  NOT・KINTONE_FUNC 等を停止(結果取りこぼしの回避。一部クエリで取得件数増)。
- LIKE 等 JS 評価が必要な条件と AND 併記された安全述語を kintone へプレフィルタ
  押し下げして取得件数を削減(WHERE 全体は取得後 JS で再評価)。対象は $id の肯定
  比較と、NUMBER フィールド(型情報で確定)の = と厳密な < / >(右辺が安全整数)。
  境界丸めで壊れる <= / >= は押し下げず FULL_SCAN で評価。EXPLAIN は確定分を
  kintone query、型確認待ちの数値候補を pushdown candidate 行に分けて表示。
- 詳細は CHANGELOG.md を参照。

v2.1.2: 集計算術式の alias 消失を修正(バグ修正)。
- SUM(x) / COUNT(*) AS 平均 のように、集計算術式の末尾(や中間)が集計関数だと
  AS alias が静かに捨てられ、出力列名・HAVING / ORDER BY・後段参照・UNION 結果列が
  合成名(SUM(x)/COUNT(*))になっていた問題を修正。alias を式全体に保持します。
- これにより HAVING 平均 / ORDER BY 平均 / CTE・一時テーブル後段の SELECT 平均 が
  意図どおり alias で解決されます(従来は空参照で HAVING が全落ち・ORDER BY が無並び)。
- 併せて、式の途中に置いた不正な alias(SUM(x) AS y - COUNT(*))を ParseError で
  拒否します(従来は静かに受理し alias を無視)。
- 末尾が数値リテラルの既存ケース(SUM(金額) * 1.1 AS x)・alias 無しの合成名出力・
  単独集計列(SUM(a) AS x)は不変です。プラグインのクライアント側 SELECT にも反映。
  詳細は CHANGELOG.md を参照。

v2.1.1: 0 行 SELECT の列欠落を修正(バグ修正・後方互換)。
- 明示列(例: SELECT a, b)の SELECT が結果 0 行のとき出力列を失い、空ソースの
  INSERT / UPSERT ... SELECT が「SELECT の列数(0)と一致しません」で停止していた
  問題を修正。列名を行データではなく AST から確定するようにしました。
- これにより差分バッチの「差分 0 件の日」も、空の一時テーブル・空ソースからの
  INSERT / UPSERT ... SELECT が inserted=0(UPSERT は inserted=0 / updated=0)の
  no-op として正常に完走します。左辺が 0 行の UNION / UNION ALL も右辺の値を
  正しく保持します。
- SELECT * / 空 CTE / 混在ワイルドカード(SELECT *, a)は対象外(別課題)。空の
  SELECT * を空ソースに使った場合は「0 行のため列を特定できません」と案内します。
- 1 行以上の既存結果(列名・列順・値)は不変です。プラグインのクライアント側
  SELECT にも反映されます。詳細は CHANGELOG.md を参照。

v2.1.0: バッチ変数 SET @var を追加(後方互換)。
- ; 区切りのバッチ内で SET @名前 = <式> により値を一度定義し、後続の文から
  @名前 で参照できます。時刻の固定(SET @now = NOW())・バッチ ID・条件値の
  共通化(DRY)に使えます。
- 式はリテラル・関数(NOW() / TODAY() / 文字列・数値関数)・数値算術。参照位置は
  WHERE 右辺 / UPDATE の SET 値 / ASSERT オペランド。2 文以上のバッチでのみ使用可。
- 現時点で非対応(後続): サブクエリ代入・DECLARE 外部注入・NULL 代入・LOGINUSER()。
- 詳細は言語リファレンス §25 と CHANGELOG.md を参照。

v2.0.0: LIKE を JavaScript 評価のみに統一(Breaking)。
- LIKE / NOT LIKE はワイルドカードの有無にかかわらず kintone へ送らず、
  JavaScript で評価します。ワイルドカードなしは kSQL 独自の部分一致です。
- LIKE を含む SELECT は FULL_SCAN です。一致件数にかかわらず全走査件数が
  maxRecords に到達し得ます。既定は上限エラーで、truncate を選ぶと上限以降の
  一致行を欠落させる可能性があります。
- 通常の親 UPDATE / DELETE では全 LIKE を拒否します。上限エラーのない SELECT で
  対象レコード番号を確認し、IN / 完全一致で対象を指定してください。
  サブテーブル DML は従来どおり JavaScript で評価します。

v1.14.0: WHERE 右辺フィールド比較の誤結果と LIKE のモード依存を修正(挙動変更・安全上の制限)。
- WHERE 右辺のフィールド参照・文字列関数が数値化されて文字列比較が
  誤っていた問題を修正(例: 文字列 = 文字列 が一致しない、JOIN の
  != 突き合わせで完全一致行が残る)。右辺も文字列のまま比較します。
  数値フィールド同士・算術式(税込 = 金額 * 1.1)は従来どおりです。
- ワイルドカード(% / _)付き LIKE / NOT LIKE を kintone へ送らず
  JavaScript で言語仕様どおり(田% は「田で始まる」等)評価するよう
  統一。従来は実行モード(SIMPLE / FULL_SCAN)で同じ SQL の結果が
  食い違うことがありました。該当 SELECT は FULL_SCAN(全件取得)に
  なります。部分一致が必要な場合は %会社% のように明示してください。
- 安全上の制限: 通常の親レコードへの UPDATE / DELETE で
  ワイルドカード付き LIKE を拒否(誤更新・誤削除防止)。先に SELECT で
  対象レコード番号を確認し、IN / 完全一致で対象を指定してください。
  サブテーブル DML は JavaScript 評価のため従来どおり使用できます。
- これらの修正はプラグインにもバンドルされており、クライアント側の
  WHERE 評価・EXPLAIN に反映されます。
- 詳細は CHANGELOG.md と
  docs/internal/ksql_where_rhs_field_and_like_mode_divergence_issue.md を参照。

v1.13.2: CLI / MCP の表示修正(プラグインは EXPLAIN 表示のみ変更)。
- 単文 --dry-run(EXPLAIN)のプラン出力に内部 mapped アプリ表記が
  露出していた問題を修正。v1.13.1 ではバッチ dry-run のみ復元しており、
  単文では SELECT / DML とも内部 mapped ID を表示する場合がありました。
- DML の実行計画ヘッダを仕様 §9.2 準拠にし、書き込み先ラベルを app: から
  target: へ変更。CLI / MCP の論理参照は target: LAPP_ORDERS -> APP1234@prod
  のように論理名と物理 ID・profile を明示します(物理参照は target: APP1234@prod)。
- プラグインも EXPLAIN エンジンをバンドルするため、クライアント側 EXPLAIN の
  DML ヘッダが app: から target: へ変わります(プラグインは論理アプリ非対応の
  ため矢印形は出さず target: APP<id> (<id>) 表記。EXPLAIN 表示のみの変更で
  ルーティング等の挙動は変わりません)。
- 詳細は CHANGELOG.md を参照。

v1.13.1: CLI / MCP のバグ修正(プラグインの挙動変更なし)。
- CLI で LAPP_<NAME> を含む SQL が失敗した際、parser / 実行エラーの
  位置とテーブル表記を元 SQL へ復元するようにしました。v1.13.0 では
  CLI stderr が正規化後 SQL の位置や内部 mapped アプリ表記を表示する
  場合がありました(MCP は当初から復元済み)。
- 保存クエリの一部テストがリポジトリ直下の config へ暗黙依存していた
  問題を解消(利用者の挙動には影響しません)。
- プラグインの内容は v1.13.0 から変更ありません(バージョン番号のみ同期)。
- 詳細は CHANGELOG.md を参照。

v1.13.0: CLI / MCP に論理アプリ参照 LAPP_<NAME> を追加(プラグインの挙動変更なし)。
- 環境や配置先で物理アプリ ID が異なる同用途アプリに対し、
  FROM LAPP_ORDERS のような論理名で SQL / 保存クエリを再利用できます。
  論理名は profile ごとの config logicalApps で物理 ID へ解決されます
  (例: dev→APP899 / prod→APP1234)。
- 既存の APPxxx は常に物理 ID のままで、暗黙に論理解決されません。
  未定義論理名は API 呼び出し前にエラーとなり、誤 route しません。
- profile 単位で allowPhysicalAppRefs: false を指定すると、その profile の
  kSQL SQL 内で物理 APPxxx 直接参照を拒否できます(既定 true・後方互換)。
- validation / EXPLAIN が論理名・物理 ID・profile を表示します。
- 論理アプリ参照は CLI / MCP のみの機能で、プラグインの挙動は変わりません。
- 詳細は CHANGELOG.md と docs/ksql_language_reference.md を参照。

v1.12.1: CLI / MCP のトークン解決バグを修正(プラグインの挙動変更なし)。
- SQL コメント・文字列リテラル・バッククォート識別子の中に書いた
  APPxxxx を、トークン解決の対象から除外しました。
- 従来は生 SQL を素の正規表現で走査していたため、
  "-- 通知(APP4206)" のようなコメントや 'APP4206の件' のような
  文字列に現れたアプリ番号まで参照アプリとみなし、profile の
  tokenMap に無いと token is missing で実行不能になっていました。
- 本文の FROM APPxxxx(@profile / $subtable 付き含む)は
  従来どおり解決します。誤って要求していたトークンを要求しなく
  なる方向のみの変更で、後方互換です。
- 詳細は CHANGELOG.md と
  docs/internal/ksql_extract_app_ids_comment_string_issue.md を参照。

v1.12.0: GROUP BY なし集計の 0 件時挙動を SQL 標準に準拠(挙動変更)。
- GROUP BY のない集計 SELECT は対象 0 件でも常に 1 行を返します
  (COUNT は 0、SUM / AVG / MAX / MIN も 0。GROUP BY がある場合は
  従来どおり 0 行)。
- これにより健全性チェックの定番
  ASSERT (SELECT COUNT(*) FROM ... WHERE 異常条件) = 0
  が該当 0 件(健全時)に成立するようになりました(従来は
  「scalar subquery returned no rows」エラーで失敗)。
- 波及する挙動変更(いずれも標準準拠化):
  WHERE / SELECT 列 / UPDATE SET のスカラーサブクエリが 0 に解決、
  IN (SELECT COUNT(*)...) は {0} との照合、
  EXISTS (SELECT COUNT(*)...) は常に真、
  CREATE TEMP TABLE ... AS SELECT COUNT(*) は 0 件でも 1 行実体化、
  INSERT ... SELECT COUNT(*) は 0 件でも 1 行書き込み。
- 詳細は docs/ksql_language_reference.md §8「0 件時の挙動」と
  CHANGELOG.md を参照してください。
