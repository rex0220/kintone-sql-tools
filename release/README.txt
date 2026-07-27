ksql 配布パッケージ (v3.27.0)

release 成果物:
- ksql-plugin-v3.27.0.zip
- ksql-mcp.mcpb (manifest version 3.27.0)
- ksql-mcp.js (MCP server version 3.27.0)

1. ksql-plugin-v3.27.0.zip を kintone のプラグイン画面で読み込む
2. ksql-app-template-v1.11.0.zip をアプリ作成時にテンプレートとして読み込む
   (アプリテンプレートは v1.11.0 から変更ありません)
3. アプリにプラグインを適用して利用開始する

本リリース (v3.27.0): B79+B80。
- 注意: B79 は破壊的変更です。プラグイン / CLI / MCP で LEFT / RIGHT JOIN を含む
  クエリの検索が 10 万件で打ち切られた場合、従来の警告＋部分結果ではなく
  SearchAbortedError で終了します。
- 従来は行が減るだけではなく、結合相手を取得できなかった行が null 拡張され、
  「該当なし」という誤った値を返していました。現在成功して見える該当クエリは
  実際には誤った値を返しているため、エラー化しても正しい結果を失いません。
- プラグイン / CLI / MCP の INNER JOIN と単一表は従来どおり警告＋部分結果です
  (行は欠落し得ますが、返る行の値は正しい)。engine ライブラリは B79 では変更せず、
  元から全クエリ形で SEARCH_ABORTED の hard error です。プログラム API では部分結果が
  黙ってアプリケーションロジックへ流れ込むほうが危険なため、意図的に厳格です。
- 移行方法: WHERE で対象を絞るか、意味を保てる場合は INNER JOIN へ置き換えてください。
- B80: engine ライブラリの KLIKE / NOT KLIKE 静的検証エラーが、一律の
  "SQL statement could not be parsed" ではなく、プラグイン / CLI / MCP と同じ具体的な
  reason (例:「KLIKE / NOT KLIKE は SELECT の WHERE 句でのみ使用できます」) を返します。
  code は PARSE_ERROR のままなので、code で分岐する利用者コードは壊れません (非破壊)。

前リリース (v3.26.0): B76 Phase A（JOIN 述語の APP 別 prefilter）。
- 性能改善であり挙動変更はありません。押し下げ後も元の WHERE を client で再評価するため
  結果は不変で、records API から取得する候補件数だけが減ります。
- INNER JOIN で、型と演算子の対応が確認できる単一 alias の述語が対象です。
  LEFT / RIGHT JOIN、cross-alias OR、NOT、cross-table 述語、KLIKE を含む OR、
  DATE_FORMAT(...) など関数付き述語は押し下げません。
- 相対日付関数と LOGINUSER() などの kintone query 関数は JOIN では引き続き使用できません。

前リリース (v3.25.0): B75+B77+B78。
- 注意: これは minor リリースですが破壊的変更を含み、^3 の利用者にも自動更新で届きます。
  WHERE の TODAY() / NOW() / LOGINUSER() は kintone REST query へ安全に押し下げられる形だけを
  許可し、従来 client 評価へ落ちていた形はレコード取得前に
  WHERE_KINTONE_FUNCTION_REQUIRES_EXACT_PUSHDOWN で拒否します。ユーザー系・複数選択系への
  型に合わない演算子も、silent 0 rows ではなく WHERE_OPERATOR_INVALID_FOR_FIELD_TYPE で
  拒否します。
- 新たにエラーになる例:
    WHERE 作成者 = 'taro'
    WHERE 日付 = NOW()
    WHERE $id >= TODAY()
  このほか、押し下げ不能な OR / NOT / JOIN / 入れ子 SELECT / 実体化文脈の UNION 枝にある
  TODAY() / NOW() / LOGINUSER() も取得前エラーになります。
- 移行方法: ユーザー系・複数選択系は in / not in を使う、WHERE 全体または関数 leaf を
  押し下げ可能な形にする、TODAY() / NOW() を固定の日付・日時リテラルへ置換する。
- 機能追加: 従来 kSQL で表現できなかった WHERE 作成者 in (LOGINUSER()) を追加。
  TODAY() / NOW() は相対日付関数と同じ server-only 計画になり、たとえば
  WHERE 日付 = TODAY() AND LENGTH(件名) > 1 は日付条件を server prefilter へ押し下げて
  client は残余だけを評価します。B75 により whole-WHERE exact なら CTE 本体・WITH の
  最終 SELECT・一時テーブル source でも使えます。

v3.24.0: 相対日付を集計クエリでも使えるように (B72)。
- WHERE 全体が kintone クエリへ押し下げ可能なら、GROUP BY / SELECT DISTINCT / 集計関数 /
  ウィンドウ関数 / 通常の ORDER BY を含む文でも相対日付関数 (THIS_MONTH 等) を使えるように
  した。従来はこれらを含むと取得前に拒否されていた。
  例: SELECT 区分, COUNT(*) FROM APP100 WHERE 日付 = THIS_MONTH() GROUP BY 区分
- 従来は「押し下げ不能な述語を AND で足すと通るのに、純粋に exact な条件だけだと拒否される」
  逆転が起きていた。本修正でこれを解消。WHERE 全体を一度だけサーバーへ送り、取得後の
  クライアント側 WHERE 評価は行わない (相対日付のクライアント評価は従来どおり 0 回)。
- 引き続き取得前に拒否: JOIN、VALIDATE、サブテーブル、一時テーブル・実体化 CTE・派生表、
  OR/NOT に絡んで WHERE 全体が exact にならない場合。KORDER BY と UPDATE/DELETE の対象選択、
  INSERT/UPSERT ... SELECT の source は whole-WHERE exact に限り使用でき、prefilter＋残余や
  FULL_SCAN_EXACT では使えません。
- 純加法的 minor。従来動いていたクエリの結果は変わらない。

v3.23.0: GROUP BY のエイリアスが黙って誤集計するバグを修正 (B71)。
- GROUP BY に SELECT のエイリアスを指定すると、エラーにならないまま全行が 1 グループへ
  潰れていた不具合を修正。例: SELECT DATE_FORMAT(作成日時, '%Y-%m') AS 年月, COUNT(*)
  ... GROUP BY 年月 が「1 グループ・件数=全件」を返していた。
- 注意: 結果が変わります。従来これらのクエリが返していた値は誤りでした。修正後は
  GROUP BY DATE_FORMAT(...) と同じ正しい集計になります。
- 名前の解決は「同名フィールドが優先 → 無ければ SELECT のエイリアス」(標準 SQL/MySQL と
  同じ)。エイリアスが実フィールド名と衝突していたクエリも正しく集計されるようになります。
- 集計関数のエイリアス (GROUP BY 件数 where COUNT(*) AS 件数) など、グループ化前に値が
  確定しない指定はレコード取得前にエラーになります (従来は黙って誤結果)。
- ORDER BY のエイリアス・HAVING・DISTINCT・ROLLUP/GROUPING SETS の挙動は不変。

v3.22.0: engine ライブラリの QueryColumn 列メタ公開 (B69)。
- engine ライブラリ (npm ./engine / UMD) の runQuery() が返す QueryColumn に、
  fieldType / sortKind / sourceApp の 3 フィールドを後方互換で追加。列の型・ソート種別・
  参照元アプリ ID を取得できる。sourceApp は CTE/一時テーブルを含まない単一物理アプリ文の
  直接フィールド参照列 ($id 等含む) のみで、式・集計・JOIN 曖昧・CTE 経由は付かない。
- kSQL の SQL 方言・パーサ・実行意味論・結果は不変。プラグイン/CLI/MCP の挙動も不変
  (列メタはライブラリ結果の付随情報)。純加法的 minor。

v3.21.0: 相対日付の prefilter ＋残余 client 評価 (B67 Phase2 A)。
- 相対日付 (YESTERDAY / FROM_TODAY 等) の exact leaf が「相対日付を含まない残余」
  (例 LENGTH(都道府県) > 1・通常 LIKE) と AND で結ばれた単一物理アプリの SELECT で、
  相対日付 leaf だけを kintone クエリの prefilter に押し下げ、残余だけを取得後に
  クライアント評価できるようにした (SUPERSET_PREFILTER)。相対日付の client 評価は 0 回。
- v3.20.0 では文全体を fail-closed していたケース。EXPLAIN は where capability:
  SUPERSET_PREFILTER / server prefilter / client residual / relative date client
  evaluations: 0 を表示する。
- OR/NOT 内で whole-WHERE exact にならない相対日付、prefilter＋残余または
  FULL_SCAN_EXACT の KORDER BY・DML の対象選択・INSERT/UPSERT ... SELECT の source、
  JOIN・VALIDATE・派生表は従来どおり fail-closed。whole-WHERE exact な相対日付は
  KORDER / DML source を含め従来どおり許可。
- 純加法的 minor。既存 SQL、plugin、CLI、MCP、MCPB の挙動は不変。

v3.20.0: kintone REST クエリ関数 (相対日付) の押し下げ (B67 Phase1)。
- 相対日付12関数 (YESTERDAY / TOMORROW / FROM_TODAY(n, DAYS|WEEKS|MONTHS|YEARS) /
  THIS_WEEK / LAST_WEEK / NEXT_WEEK / THIS_MONTH / LAST_MONTH / NEXT_MONTH /
  THIS_YEAR / LAST_YEAR / NEXT_YEAR) を WHERE で使えるようにした。
  例: SELECT * FROM APP730 WHERE 作成日時 < FROM_TODAY(5, DAYS)。
- 方針=押し下げネイティブ (server-only)。関数を kintone クエリへ素通しし、時刻・
  タイムゾーン・週境界・月末は kintone サーバが評価する。押し下げできない場合は
  レコード取得前に fail-closed (client 評価へフォールバックしない)。
- 対象は日付系4型 × 比較6演算子の WHERE 右辺と BETWEEN 境界のみ。既存の
  TODAY()/NOW()/LOGINUSER() は挙動・出力とも不変。純加法的 minor。

v3.19.0: B66 read-only kSQL エンジン・ライブラリ公開 Phase1。
- npm の @rex0220/kintone-sql-tools/engine から ESM/CJS、dist-engine の UMD から
  read-only engine を利用できる。公開 API/型、全値 string、BYO client 契約、
  error/options/read-only 拒否範囲は docs/ksql_engine_library.md を参照。
- UMD は window.ksql.get("3.19.0") で版を明示する。npm 取込可能な plugin は
  npm bundle を優先する。
- 純加法的 minor。既存 SQL、plugin、CLI、MCP、MCPB の挙動は不変。

v3.18.0: 小計・総計 (B65) Phase2 — CUBE / HAVING 内 GROUPING() / SELECT DISTINCT 併用。
- GROUP BY CUBE(a, b) で全 2^n 組合せ (各軸の小計と総計) を 1 クエリに出せる。
  展開後の grouping set 数が上限を超える列数 (既定 7 列以上) は取得前に拒否。
- HAVING 内で GROUPING(会社名)=1 (総計・小計だけ)/=0 (明細だけ) を集計条件と
  組み合わせて絞り込める。WHERE/JOIN/集計引数/window では GROUPING() は不可。
- SELECT DISTINCT を B65 と併用できる (Phase1 の一括拒否を解除)。GROUPING() を
  投影しない表示用クエリで、表示値が一致する明細/総計行を 1 行にまとめられる。
  GROUPING() を投影すれば明細(0)と小計・総計(1)は別行のまま残る。
- ksql_validate が DISTINCT+ROLLUP を受理 (v3.17.0 の validate ok/実行拒否を解消)。
- 通常 GROUP BY・ROLLUP・GROUPING SETS・非 B65 の SQL 挙動は不変 (純加法的 minor)。

v3.17.1: B65 の解説・レシピをドキュメントへ反映 (ドキュメントのみ)。
- バッチレシピ集に R13「明細＋小計・総計を 1 クエリで作る (ROLLUP / GROUPING)」を追加。
- 言語リファレンス §8/§10 の B65 例を APP4149 から汎用の APP100 に統一。
- MCP の ksql_docs が返すレシピ・言語リファレンスに反映。SQL 挙動は v3.17.0 から不変。

v3.17.0: 小計・総計 (ROLLUP / GROUPING SETS / GROUPING) 対応 (B65)。
- GROUP BY ROLLUP(会社名) や GROUP BY GROUPING SETS ((...),()) で、明細に加えて
  小計・総計行を同じ結果に 1 クエリで出せる。GROUPING(会社名) で合計行を判別し
  (CASE で '合計' ラベル)、ORDER BY GROUPING(会社名) で末尾へ寄せられる。
  B64 の条件付き集計 SUM(CASE WHEN ...) と併用可。
- Phase1 は grouping item・GROUPING 引数が物理フィールドのみ。小計/総計は
  完全入力が必要で onLimit=truncate 不可。安全上限を超えると fail-closed。
  CUBE / HAVING 内 GROUPING / SELECT DISTINCT 併用は対象外 (Phase2 以降)。

v3.16.1: 言語リファレンスに B64 (集計内 CASE) を反映 (ドキュメントのみ)。
- MCP の ksql_docs が返す言語リファレンス §4/§8/§9 に、集計関数の引数で
  CASE 式・|| 連結・スカラー変数を使える旨と条件付き集計・横持ちピボット・
  HAVING の例を追加。SQL の挙動は v3.16.0 から変更なし (SemVer=patch)。

v3.16.0: 集計関数引数のスカラー値式対応 (B64)。
- SUM / COUNT など全集計関数の引数に CASE 式・|| 連結・スカラー変数 @var を
  指定できるようにした。条件付き集計 SUM(CASE WHEN 区分='受注' THEN 売上 END) を
  直接書けるようになった (従来は CTE 経由の回避が必要)。
- 比較式 (SUM(売上 > 0) など) は引き続き非対応で、CASE で値を明示するよう
  案内する。既存の算術式引数の挙動は不変。

v3.15.0: AI 可視性の注記強化 (B62)。
- AI 行動検証 (計30シナリオ) で観測した「AI がつまずく箇所」への注記を追加。
  MCP server instructions に「UPDATE の CHECK は更新前値を参照 (新値の検査は
  SET 式を CHECK に再掲)」と変数名規則の誘導を追加 (計529語)。
- 言語リファレンス §16 に CHECK 評価行の相互参照 (文種別)、§25 に @変数の
  配置詳細表 (使える位置 A01-A13 / 使えない位置 R01-R05) と回避レシピを追加。
  配置表はパーサの特性化テストと ID で一対一対応。
- 効果実証済み: 同一依頼の再検証で意味論誤り 1→0 件・構文の試行錯誤 5→1 回。
- プラグイン・CLI の SQL 挙動に変更なし (MCP とドキュメントのみ)。

v3.14.0: MCP の構文ヒント (B60)。
- MCP server instructions に全文型の構文カタログ (Statement templates) を追加。
  AI クライアントが INSERT の ON ERROR SKIP INTO #err などの kSQL 固有構文を
  発明せず、正しい骨格で組み立てられるようにする。ksql_query / ksql_mutate の
  説明にも構文テンプレートを追記。
- カタログの全構文例はパーサ受理テストで固定 (載っている構文は必ず通る)。
- 言語リファレンス §24 の EXPLAIN 対応一覧に VALIDATE / IMPORT を追記 (記載漏れ修正)。
- プラグイン・CLI の SQL 挙動に変更なし (MCP のみの追加)。

v3.13.0: 関数拡充 3 件とバグ修正 1 件。
- B56: 統計集約 STDDEV_POP / STDDEV_SAMP / VAR_POP / VAR_SAMP / MEDIAN を追加。
  分散・標準偏差は Welford 法、中央値は数値昇順。統計集約は完全入力必須で、
  onLimit=truncate でも上限到達時はエラーになり部分集合の値を返さない。
  未定義の統計量 (0 件・_SAMP の 1 件) は空文字、非数値の入力は ArgumentError。
  無印 STDDEV / VARIANCE は方言間で意味が異なるため非対応 (明示形のみ)。
- B57: 日付集計軸 DAYOFWEEK (1=日曜)・QUARTER・WEEK (ISO-8601 固定) と、
  DATE_FORMAT の %w (0=日曜)・%a (日本語曜日)・%v (ISO 週番号)・
  %G (ISO week-year) を追加。週次ラベルは %G-%v を推奨 (%Y-%v は年跨ぎ週で誤る)。
  新 3 関数は実在する日付のみ受理し、不正日付は空文字。
- B58: MODE (最頻値) を追加。カテゴリデータ (ドロップダウン・ステータス等) 向けの
  文字列頻度カウント。同数タイは canonical 比較順の最小値を返す決定的規則。
- B59: SELECT 列の別名 (AS alias) を ORDER BY に指定すると黙って無視され
  元の行順のまま返る不具合を修正。従来並ばなかったクエリの結果順が変わる。
- 新しい予約語: STDDEV_POP STDDEV_SAMP VAR_POP VAR_SAMP MEDIAN MODE
  DAYOFWEEK QUARTER WEEK (同名フィールドはバッククォートで参照)。

v3.12.0: MCP に read-only ドキュメントツール ksql_docs を追加 (B55)。
- MCP resources を中継しないクライアント (リモート接続のプロキシ等) でも、
  ksql_docs ツールだけで言語リファレンス・レシピの索引と各章本文を読める。
  引数なしで全章キーの索引、section 指定 (resource と同じキー語彙・
  ksql:// URI 形も可) で 1 章を返す。kintone API 呼び出しゼロ。
- server instructions に全量の関数カタログ (scalar/aggregate/window/
  contextual/alias/syntax) を掲載し、AI が validate 試行錯誤で関数の有無を
  推定する行動を抑止。ksql_validate/ksql_query/ksql_mutate の説明にも
  ksql_docs への導線を追記。
- プラグイン・CLI の SQL 挙動に変更なし (MCP のみの追加)。

v3.11.0: CTE 関連の 2 バグ修正。
- B51: 複数の CTE を CTE 同士で JOIN すると、左 CTE の列が空になり行が重複し
  LEFT JOIN の未一致行が消える不具合を修正 (誤った結果を返す silent wrong
  results)。CTE/一時テーブル参照の暗黙 alias (CTE 名) を実行経路で一貫して使う
  ようにした。
- B52: 単一 CTE の列に AS 別名 (や式) を付けて外側で参照すると unknown field に
  なる不具合を修正。別名/式ありの CTE はインライン化せず実体化する。
  SELECT * や同名フィールドの CTE は従来どおりインライン化 (WHERE 押し下げ) を維持。

v3.10.0: プラグインの検索打ち切り検出 (B7)
         ＋ APPLY 複数親 UPDATE の親 WHERE で LIKE/KLIKE (B47)
         ＋ 通常の親 UPDATE/DELETE の WHERE で KLIKE (B5)。
- B7: プラグインでも like/not like の 10 万件検索打ち切り (X-Cybozu-Warning) を
  検出できるようにした (getRecords のみ raw fetch 化・URL 4KB 超は POST override)。
  DML の fail-closed がプラグインでも効き、SELECT では打ち切り警告が付く。
- B47: APPLY 複数親 UPDATE の親 WHERE で LIKE / KLIKE を使えるようにした。
  安全プレフィルタで取得後に元の WHERE を JS 再評価し、一致した親だけを更新する。
- B5: 通常 (APPLY なし) の親 UPDATE / DELETE の WHERE で KLIKE を使えるようにした
  (kintone ネイティブ like へ変換・exact pushdown)。LIKE は通常 DML では引き続き
  不可、サブテーブル DML の KLIKE も不可。10 万件打ち切り時は fail-closed。

v3.9.0: DML 事前検証の complete post-image (B43)
        ＋ MCP 読み取り専用メタデータ API (B49)
        ＋ MCP の能力・方言 discoverability (B50)。
- B43: UPDATE/UPSERT の VALIDATE ONLY / ON ERROR SKIP が、更新対象レコードの
  post-image (レコード全体・サブテーブル子行を含む) を検証。SET 対象外の
  既存違反による false pass を解消し、ON ERROR SKIP は違反親を隔離 (true
  isolation)。通常の UPDATE/UPSERT 実行の挙動は不変。
- B49: MCP 新ツール ksql_app_metadata。app/fields(制約付き)/layout/settings/
  status/views/reports/customize を生 JSON で取得 (固定 GET allowlist・
  読み取り専用)。SQL/DML 構築前の制約確認に使える。
- B50: MCP server instructions で kSQL の能力・方言を案内。言語リファレンスと
  レシピを MCP resource (ksql://language-reference / ksql://recipes) で公開。
  ※ MCP の変更は MCP クライアント (Claude 等) から利用する機能です。

v3.8.0: APPLY ブロック (B44) ＋ プラグイン親/子ガード兼用 (B48)
        ＋ サブテーブル SELECT のシステム列 WHERE (B45)。
- APPLY ブロック (B44): UPDATE/INSERT/UPSERT に APPLY を付けて、
  テーブル外項目とテーブル内 (サブテーブル) 行を1文=1 PUT で同時更新。
  テーブル内に既存違反があるレコードの修復書き込みが可能になる。
    UPDATE APP100 SET ステータス='確定' WHERE $id=5
    APPLY 明細 (
      PATCH SET 数量=0 WHERE 数量<0;
      APPEND (商品コード, 数量) VALUES ('A-001', 1);
      REMOVE WHERE 廃番='true'
    )
  - PATCH (既存行更新)/APPEND (行追加)/REMOVE (行削除)、多値 ADD/REMOVE。
  - 行アドレッシング: ALL ROWS / WHERE 行条件 / _idx (0-based) / _rid。
    EXPECT ROWS n | BETWEEN | AT LEAST | AT MOST で対象行数を表明。
  - スナップショット意味論・post-image 検証 (書き込み前にレコード全体を検証)。
  - 複数親 UPDATE / INSERT / UPSERT に対応 (非トランザクション・部分成功あり)。
  - revision 必須＋二重ガード (dmlMaxRows 親件数 / dmlMaxSubtableRows 子行)。
- プラグイン親/子ガード兼用 (B48): 「最大取得件数」設定 (既定3000) を
  APPLY の親/子ガードへ兼用し、100 親超の一括更新を可能に (新設定 UI なし)。
- サブテーブル SELECT のシステム列 WHERE (B45): _pid/_rid/_idx を
  SELECT の WHERE/ORDER BY で使えるように修正 (_pid/_idx=数値・_rid=文字列)。

v3.7.0: VALIDATE のサブテーブル子フィールド監査 (B42)。
- VALIDATE の既定対象にサブテーブル子フィールドを追加 (監査の抜けを修正)。
- 詳細出力を固定9列へ拡張 ($err_subtable / $err_subrow 1-based /
  $err_subrow_id = 仮想テーブルの _rid / $err_count)。同一レコードの
  field + code + message を1行へ集約し、値は先頭違反行を保持。
  $err_subrow / $err_subrow_id は全該当行を先頭出現順のカンマ区切り
  リストで保持 (切り捨てなし)。子違反が2件以上なら、集約後の message
  末尾にも「（2行: 1,2）」形式で件数と同じ $err_subrow リストを付加。
  count=1 の子違反とトップレベル/CHECK の message は従来どおり。
  INTO #err にも装飾済み message を格納。$err_subrow の型メタは string。
- scoped target: VALIDATE APP100 (テーブル) / (テーブル(子1, 子2))。
  裸の子コード・APP100$テーブル 形式は案内付きで拒否。
- SUMMARY モード: 固定5列 ($id, $err_subtable, $err_field, $err_code,
  $err_count) へ生成時集約し、レコード横断の規模を把握。
  tempTableMaxRows は詳細/SUMMARY とも集約後行数に適用。
- 詳細/SUMMARY の結果に validateStats (errorRecords=違反レコード数、
  errorCount=集約前違反総数) を付与。0件でも0/0。プラグインは
  「エラー n レコード / m 件（表示 r 行）」、CLI はサマリへ両値を表示。
  JSON/MCP/バッチ結果にも含め、INTO #err 後の汎用 SELECT には付けない。
- WHERE / CHECK のサブテーブル子参照は取得前に ArgumentError で拒否。
  NUMBER 子フィールドに数値精度検証を適用。
- B46: 空 (未選択) の選択系フィールドを ERR_CHOICE_INVALID と誤判定する
  false positive を修正 (kintone は空 DROP_DOWN を受理・RADIO の空指定も
  エラーにしない実機パリティ)。

v3.6.1: IMPORT の面 UX 改善・修正。
- プラグイン: IMPORT のファイル選択 UI をヘッダー上部へ移動 (横スクロール解消)。
- 既定ソース名を拡張子除去+識別子化 (plugin_import_10.csv → plugin_import_10)。
  FROM CSV <名前> で参照可能に。
- ファイル未選択の IMPORT エラーを面別案内に (plugin=ファイル選択 /
  CLI=--import-csv/--import-json / MCP=importSources)。
- DML 成功メッセージの「隔離 0 件 (undefined)」を修正。
- プラグイン: サブテーブル全置換の確認ダイアログをサマリ表示に
  (レコード数が増えても画面をはみ出さない)。

v3.6.0: ファイル取込ステートメント IMPORT (B39)。
- IMPORT INTO app (fields) FROM CSV|JSON <source> [射影/BY NAME]
  [ON DUPLICATE] [CHECK] [VALIDATE ONLY | ON ERROR SKIP INTO #err] を追加。
  ソースは面が名前付きで供給 (CLI --import-csv/--import-json・MCP inline
  importSources・plugin file picker)。パスを SQL に埋めない・10 MiB/source・
  source 供給時のみ有効。
- CSV: RFC4180 (UTF-8/SJIS・BOM・セル内改行)・位置対応/SELECT 射影・源内キー重複拒否。
- JSON: 厳密10進 (元字句保持・safe-int のみ数値・精度対象は string)・
  全階層 duplicate key 拒否・欠落/null/presence 区別。
- cli-kintone 互換 BY NAME: ヘッダ=フィールドコード名対応・非書込み/未知列の
  監査付き無視 (IGNORE UNKNOWN COLUMNS)・複数値セル内 LF。
- レコード番号純 UPDATE: IMPORT UPDATE ... MATCH RECORD NUMBER SOURCE。
- サブテーブル: JSON ネスト＋cli-kintone CSV * 形式。破壊的全置換は
  REPLACE SUBTABLES 必須＋削除件数 confirm、内訳表示不能面 (MCP) は fail-closed。
- CLI/MCP/plugin 全面。添付ファイル (FILE) は対象外。
- USER/組織/グループ選択の INSERT/UPSERT ... SELECT payload を [{code}] に修正。
- 既存の正しいクエリの挙動変更なし (minor)。

v3.5.0: 既存レコードの制約チェックとバッチ変数の参照拡張 (B41/B3/B10-B)。
- B41: 既存レコードの制約チェック文 VALIDATE <app> [(fields)] [WHERE]
  [CHECK WHEN ... THEN ...] [INTO #err] を追加。既存レコードを組み込み制約
  (必須/数値上下限/文字数/選択肢/数値桁) とカスタムチェック (B37 構文) で
  監査し、違反を $id/$err_field/$err_code/$err_message/$err_value の 5 列で
  返す (INTO #err で複文再利用)。read-only (書き込み API 0 回・--allow-dml 不要)。
  組み込み検証は生値 (USER/組織/グループ選択・複数選択の空も必須違反として検出)。
  WHERE は KLIKE・サブクエリ・修飾参照を禁止。EXPLAIN VALIDATE は取得計画のみで
  違反件数は出さない。
- B3: 文字列配列のバッチ変数 SET @list=['A','B'] とカッコ無し IN @list /
  NOT IN @list を追加 (通常の literal IN へ展開・IN (@a,@b) は従来どおり)。
  空配列は真偽簡約し in () を送らない。更新系の恒真 WHERE は全件更新防止で
  実行前エラー。
- B10-B: SELECT 定数列 @x AS alias を追加 (文字列/数値の型を保持)。
- 既存の正しいクエリの挙動変更なし (minor)。

v3.4.0: DML カスタムチェックと文字列連結演算子 (B37/B38)。
- B38: 文字列連結演算子 || を追加 (CONCAT と同義・NULL/空は空文字・加減算と
  同じ優先順位で左結合)。CONCAT 等の関数引数に @var を渡せるように。SELECT 列・
  UPDATE SET・CASE・CHECK メッセージで利用可 (WHERE の比較オペランドは未対応)。
- B37: DML カスタムチェック CHECK WHEN <条件> THEN <メッセージ> を追加。
  INSERT/UPSERT/UPDATE に行レベル業務ルールを付与し、該当行をカスタムメッセージ
  付きで #err (ERR_CHECK) へ隔離。CHECK ブロック=グループ (ブロック内先勝ち・
  ブロック間独立)。参照は読み取り行 (SELECT 出力行/挿入値/UPDATE 更新前値/
  UPDATE FROM は APP<n>.列=旧値・ソース別名.列=新値)。ON ERROR SKIP で隔離、
  VALIDATE ONLY で報告。新ソフトキーワード CHECK (予約語増なし)。
- 既存の正しいクエリの挙動変更なし (minor)。

v3.3.0: 厳密10進比較・数値精度整合・正規表現の 4 件バンドル (B9/B29/B20/B36)。
- B9: 最大30桁の有限10進比較を厳密化。16 有効桁を超える NUMBER/CALC 値を
  binary64 で丸めず区別 (WHERE=・MIN/MAX・ORDER BY 等が正しくなる)。数値
  リテラルは元字句を保持し指数表記 digits[.digits][e±digits] も受理。
- B29: 書き込み先アプリの numberPrecision 設定から整数部の桁超過を書き込み
  前に検出 (ERR_NUMBER_INTEGER_DIGITS・ON ERROR SKIP で行隔離)。小数は
  kSQL で検証せず kintone の自動丸めに委ねる (REST/CSV/編集画面と一貫)。
- B20: 正規表現関数 REGEXP_LIKE/REGEXP_REPLACE/REGEXP_SUBSTR を追加
  (ECMAScript・フラグ i/m/s・u 常時有効)。ユーザー責任 (ReDoS 中断不能・
  ホストや Unicode 版で結果差)。予約語 3 語。
- B36: REGEXP_REPLACE に第 5 引数 occurrence を追加。省略/0=全置換 (従来)・
  1=先頭のみ・N=N 番目のみ (一致数超は無変化)。第 4 引数は flags のため
  MySQL/Oracle と引数位置が異なる。
- 大半の既存クエリは無影響 (minor)。16 桁超の比較のみ結果が正しく変わる。
  詳細: docs/ksql_v3_3_migration_guide.md

v3.2.0: 正しさ・関数の 7 件バンドル (B21/B22/B23/B24/B28/B34/B35)。
- B34: DML の書き込み先フィールド検査。不存在・サブテーブル子・書込不可
  フィールドへの INSERT/UPDATE/UPSERT が黙って成功せず文単位エラーに。
  検査はソース SELECT・確認・書き込みより前。
- B22: LEFT/RIGHT/SUBSTRING/LPAD/RPAD がサロゲートペアを分割しない
  (コードユニット予算内の最大安全部分列)。
- B21: UPDATE SET で文字列関数を直接受理 (SET code = LPAD(code,5,'0') 等)。
- B23/B24: LENGTH_CHAR (コードポイント計数)・TRANSLATE (1対1文字写像) を追加。
  予約語 2 語。Shift_JIS 変換レシピ R8 を同梱。
- B28: INSERT/UPSERT VALUES で符号付き数値リテラル (-5/+0.5) を受理。
- B35: ネットワーク断時にプラグインが「⚠」のみ表示になる問題を修正。
- 既存の正しいクエリの挙動変更なし (minor)。

v3.1.0: KORDER BY 大規模窓の Cursor API 対応 (B33)。
- 単発GETに収まらない KORDER BY 窓 (LIMIT>500 / OFFSET>10000) を、
  kintone Cursor API で kintone 固有順のまま実行 (KORDER_CURSOR)。
  条件は走査件数 OFFSET+LIMIT <= maxRecords。超過は planning error。
- カーソルは 500 件ずつ取得し必要窓到達で即時削除。同時カーソルは
  host 単位で既定 2・最大 5 (新設定 cursorMaxActive・プラグインは
  「⚙ オプション」の Cursor 上限)。
- 既存クエリの挙動変更なし (純加法的 minor)。
  詳細: docs/ksql_v3_1_migration_guide.md

v3.0.0: 比較・ORDER BY・WHERE押し下げ・top-N安全性を統合するmajor release
          (B26 / B27 / B30 / B31 / B32)。
- 通常ORDER BY、ウィンドウORDER、MIN/MAX、WHERE範囲比較、REORDERを
  型付きcanonical比較へ統一。文字列と型不明列はUnicodeコードポイント順。
  数字らしい文字列をペアごとに数値比較する旧挙動は廃止。
- typed numberは 空セル < -Infinity < 有限数 < +Infinity < "NaN" < その他非数値
  の固定バンド。#err NUMBER列の検証失敗値はエラーにせず同じ順序で扱う。
- local ORDER BYがmaxRecordsへ達した場合、onLimit=truncateでも部分候補の誤った
  top-Nを返さずエラー。schema-aware REST top-Nの初期allowlistは$idのみ。
- kintone REST固有順を明示するKORDER BYを追加。トップレベル単一物理アプリ、
  非修飾直接フィールド、完全押し下げWHERE、LIMIT 0..500等の条件外はplanning error。
  KORDERは新しい予約語。同名フィールドはバッククォートで参照する。
- WHEREの型×演算子能力をフォーム定義で判定。文字列型の範囲比較はSELECTでは
  FULL_SCANへ切り替え、DMLでは実行前に拒否する。
- EXPLAINはschema-aware化し、フォーム定義と必要時のプロセス状態metadataを読む。
  レコード取得・書き込みは行わない。
- JOINの曖昧な非修飾ORDERキーはambiguous columnとしてplanning時に拒否。
- 互換性の詳細は docs/ksql_v3_migration_guide.md を参照。

v2.17.0: スカラー関数の拡充(B19・機能追加)と DATE_ADD の不具合修正(B19・バグ修正)。
- TRUNCATE(TRUNC) / LEFT / RIGHT / INSTR / GREATEST / LEAST / LPAD / RPAD /
  LAST_DAY を追加。
- TRUNCATE は FLOOR と違い 0 方向へ丸めるため負数で結果が変わる
  (FLOOR(-1.5)=-2 に対し TRUNCATE(-1.5)=-1)。
- RIGHT は SUBSTRING では代替できない。SUBSTRING は引数に算術式を書けず
  (SUBSTRING(s, LENGTH(s)-3) は ParseError)、負数の開始位置は MySQL と異なり
  全文を返すため。末尾の切り出しには RIGHT を使う。
- GREATEST / LEAST は列方向の集約 MAX / MIN と違い、同じ行の引数同士を比較する。
  空文字は常に最小。空文字を除いた集合がすべて数値なら数値比較、1 つでも非数値
  なら集合全体を文字列比較する。数値が同値なら元の文字列表記を二次キーにするため
  引数の順序で結果は変わらず、LPAD による 0 埋め等の表記も保持する
  (GREATEST('007','008') は '008')。
- TRUNCATE / TRUNC / INSTR / GREATEST / LEAST / LPAD / RPAD / LAST_DAY は新しい
  予約語。同名フィールドはバッククォート(`LEAST`)で参照。LEFT / RIGHT は
  LEFT JOIN / RIGHT JOIN で既に予約語のため新規追加はなく、直後に ( がある
  場合のみ関数として扱う。
- 追加した関数は引数の個数を検証し ArgumentError を返す(既存関数は不変)。
- 修正: DATE_ADD の構文が言語リファレンスと実装で食い違っていた。記載していた
  DATE_ADD(フィールド, INTERVAL n UNIT) は INTERVAL がトークンとして存在せず、
  記載どおりに書くと必ず ParseError になっていた。正しくは
  DATE_ADD(日付, 加算値, 単位) で、減算は DATE_ADD(期限日, -1, 'MONTH') のように
  負数を渡す(DATE_SUB は無い)。
- 修正(挙動変更): DATE_ADD に YEAR / MONTH / DAY 以外の単位を渡すと、黙って DAY
  として加算していた。'HOUR' や単位の誤記がエラーにならず日単位で成功していた
  ため、実行時に ArgumentError とする。従来「成功していた」呼び出しが失敗へ
  変わるが、その結果は元々誤っていた。
- SUBSTRING の開始位置に負数を指定すると MySQL と異なり全文を返すことを
  言語リファレンスへ明記(挙動は変更なし)。
- 詳細は CHANGELOG.md と言語リファレンスを参照。

v2.16.0: 順位系ウィンドウ関数に対応(B17・機能追加)。
- ROW_NUMBER() / RANK() / DENSE_RANK() と
  OVER ([PARTITION BY ...] [ORDER BY ...]) AS alias を追加。
- これまで書けなかった「各グループの最新1件を、その行の全列とともに取得する」が
  CTE を使って 1 文で書ける(MAX() では最大値しか取れず、その行の他の列を得るには
  複合キー結合が必要だが JOIN は単一等値のみのため表現できなかった)。
    WITH ranked AS (
      SELECT 顧客ID, 受注日, 金額,
             ROW_NUMBER() OVER (PARTITION BY 顧客ID ORDER BY 受注日 DESC) AS rn
      FROM APP300
    )
    SELECT 顧客ID, 受注日, 金額 FROM ranked WHERE rn IN (1);
- ROW_NUMBER は同値でも連番、RANK は同順位で次を飛ばし、DENSE_RANK は飛ばさない。
- ウィンドウ関数を含む SELECT は FULL_SCAN。評価は HAVING の後・DISTINCT の前
  (SQL 標準)。同じ SELECT の WHERE では絞り込めないため、CTE か一時テーブルを挟む。
- ウィンドウ内の ORDER BY はトップレベル ORDER BY と同じ比較規則(数値順・選択肢の
  定義順)で並ぶ。一時テーブル / CTE 由来の列の制限も既存 ORDER BY と同じ。
- ROW_NUMBER / RANK / DENSE_RANK は新しい予約語。同名フィールドはバッククォート
  (`ROW_NUMBER`)で参照。OVER / PARTITION はソフトキーワードのため同名フィールドを
  壊さない。ウィンドウ列の AS alias は必須。
- GROUP BY / 集計関数との同一 SELECT 併用は v1 では非対応(CTE で分ければ可)。
- 詳細は CHANGELOG.md と言語リファレンスを参照。

v2.15.0: 文字列集約 GROUP_CONCAT と一時テーブル列の型伝播(B16/B14・機能追加)、
         事前検証のミリ秒日時 誤判定を修正(B18・バグ修正)。
- GROUP_CONCAT([DISTINCT] 引数 [SEPARATOR '区切り']) を追加。1 対多の値を 1 行へ
  連結できる(例: 顧客ごとの担当者一覧、検証エラーメッセージの集約)。既定の区切りは
  カンマ、空値はスキップ、空グループは空文字。DISTINCT は初出順。
  結果を長さで暗黙に切り捨てない(長すぎる値は書き込み時の検証で捕捉)。
  GROUP_CONCAT は新しい予約語。同名フィールドはバッククォート(`GROUP_CONCAT`)で参照。
  SEPARATOR はソフトキーワードのため同名フィールドを壊さない。
- 一時テーブル / CTE の列に型メタを伝播。素通し列・集約・算術・リテラルと #err の
  列は実体化後も型を保持し、後段の MIN / MAX がテキスト・日時を辞書順、数値を
  数値順で比較する(従来は temp を挟むと NaN になっていた)。型を安全に確定できない
  列(文字列関数・CASE・同名衝突する JOIN など)は従来の数値経路を維持。
- 事前検証(VALIDATE ONLY / ON ERROR SKIP)が NOW() の返すミリ秒付き ISO 日時を
  誤って不正と判定していた不具合を修正。kintone は受理して分精度へ丸めるため、
  ON ERROR SKIP が書き込める正常行を #err へ誤って隔離していた。任意桁の小数秒と
  タイムゾーンオフセットに対応。DATE / TIME フィールドの判定は不変。
- バッチ設計レシピ集に R6「不良データを隔離して残りを流す」を追加し、R2 に
  VALIDATE ONLY を追記。UPDATE ... FROM(v2.12.0)と ON ERROR SKIP(v2.13.0)を
  公開レシピへ反映。
- 詳細は CHANGELOG.md と言語リファレンスを参照。

v2.14.1: IN / NOT IN の負数リテラルを受理(B15・バグ修正)。
- WHERE 金額 IN (-1) が ParseError になっていた不具合を修正。= -1 や
  BETWEEN -10 AND 10 は同じ負数を受理するため非対称な制限で、回避策は
  OR 展開しかなかった。
- 単項 - / + に続く数値を受理する。IN (+1) は IN (1) と同値。
- IN ('-1') は従来どおり文字列(-1 は引用符なし、'-1' は引用符付きで
  kintone へ押し下げ)。符号の直後が数値でない場合(IN (-) 等)は従来と
  同じメッセージで ParseError。
- 受理範囲の拡大のみで、既存の動作するクエリの挙動は変わらない。
- 詳細は CHANGELOG.md を参照。

v2.14.0: 文字列・日時フィールドの MIN / MAX に対応(B13・機能追加)。
- 実アプリのテキスト・選択・日時フィールドを MIN / MAX で集約できる。従来は値を
  数値化していたため NaN になっていた(例: MIN(会社名)、MAX(受注日))。
- 比較規則はフィールド型で決まる。NUMBER と数値形式 CALC は従来どおり数値順。
  テキスト・選択・文字列形式 CALC と、正規化済み DATE / TIME / DATETIME /
  作成日時 / 更新日時 は UTF-16 辞書順。日時の辞書順が時系列順と一致するのは
  kintone が返す正規化形式(DATE=YYYY-MM-DD、TIME=HH:mm、DATETIME=...Z)が前提。
- 数値フィールドの挙動は不変(回帰なし)。郵便番号のような「数値に見えるテキスト」は
  テキスト型のため辞書順になる。
- 型はフォーム定義から解決し、同一 cacheContext では既存キャッシュを共有する
  (MIN / MAX 対象があるアプリのみ初回1回取得)。JOIN の修飾列と一意な非修飾列にも
  対応する。
- 従来の数値経路を維持する(=非数値は NaN)ケース: 複数選択・ユーザー選択・
  作成者/更新者などの対象外型、同名列が競合する JOIN、一時テーブル / CTE 経由の列。
- 文字列集約は UPPER(MIN(text)) 等へ文字列として渡し、集計算術式では明示的に
  数値化する(MIN(text) + 1 は NaN)。SUM / AVG / COUNT は不変。
- 詳細は CHANGELOG.md と言語リファレンスを参照。

v2.13.0: バッチのエラー行隔離と事前検証(B12 バンドル・機能追加)。
- VALIDATE ONLY: 親 INSERT / UPSERT / UPDATE(VALUES / SELECT / UPDATE ... FROM)を
  kintone へ書き込まずに全候補行を検証。必須・型・範囲・文字列長・選択肢・UPSERT
  キーを安定エラーコードで収集し、1 行に複数エラーを返す。複文では INTO #err に
  原子的に作成・追記して後続文から参照できる。書き込みゼロのため DML 承認不要
  (read-only 扱い)だが、完全入力を要求するため truncate 設定は常に error へ上書き。
- UPDATE ... FROM 業務キー結合(B11.1): 従来の $id = source.key に加え、更新先と
  ソースの文字列(1 行)/数値フィールドを単一等値で結合できる。ソース重複は PUT 前
  エラー、ターゲット重複は同じソース値で全件更新。数値キーは Number() を使わず
  10 進文字列として正規化し、64 文字超の文字列キーは kintone の前方一致による
  過剰取得をローカル全文一致で除外する。
- ON ERROR SKIP INTO #err [REJECT LIMIT n]: VALIDATE ONLY と同一の検証に失敗した
  行を一時テーブルへ隔離し、合格行だけを 100 件チャンクで書き込む。隔離後の件数へ
  dmlMaxRows / dmlTotalMaxRows を適用し、REJECT LIMIT 超過時は書き込みゼロのまま
  診断結果を返す。API 書き込みエラーは従来どおり fail-fast。
- 注意: MIN / MAX はテキスト・日時列を数値化するため NaN になります(数値列専用)。
  #err のメッセージ集約等は当面 SELECT DISTINCT キー, '定数' を使ってください。
- 詳細は CHANGELOG.md と言語リファレンスを参照。

v2.12.0: UPDATE ... FROM によるアプリ間・一時テーブルからの転記に対応（機能追加）。
- SET 値に他テーブル(実アプリ APP<n> / バッチ内 #temp)のフィールドを参照し 1 文で転記。
  結合は更新先 $id = source.key の単一等値・親レコード限定。
- 複数マッチ・不正キー・列欠落・非対応複合型・読み取り上限超過は最初の PUT 前に
  fail-closed で停止(部分書き込みなし)。対象取得は 50 件ずつ分割。
- MCP はソース読み取りを dmlMaxRows ではなく通常の maxRecords で制御。
- 詳細は CHANGELOG.md と言語リファレンスを参照。

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
