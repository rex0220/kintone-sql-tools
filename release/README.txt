ksql 配布パッケージ (v3.39.0)

release 成果物:
- ksql-plugin-v3.39.0.zip
- ksql-mcp.mcpb (manifest version 3.39.0)
- ksql-mcp.js (MCP server version 3.39.0)

追加 (B111) ★本リリースの要点:
- DECLARE @period RELATIVE_DATE = THIS_MONTH(); と宣言すると、注入した相対日付関数
  トークンが文字列ではなく関数として kintone へ押し下げられます。
    DECLARE @period RELATIVE_DATE = THIS_MONTH();
    SELECT ... WHERE 受注予定日 = @period;     -- --var period="THIS_YEAR()"
    → kintone query: 受注予定日 = THIS_YEAR()
- 使えるのは日付系 14 関数 (TODAY / NOW / YESTERDAY / TOMORROW / FROM_TODAY /
  THIS_WEEK 系 / THIS_MONTH 系 / THIS_YEAR 系) で、括弧まで含めた完全なトークンです。
- 使える位置は WHERE の比較右辺と BETWEEN の境界だけです。それ以外の位置、
  ホワイトリスト外の値、DML / VALIDATE での使用は、kintone API を呼ぶ前に
  エラーで停止します (DML は注入値で対象範囲が変わるため拒否します)。
- RELATIVE_DATE を付けない DECLARE の挙動は変わりません。既定値に書いた TODAY() は
  従来どおりクライアント側で日付文字列に評価されます (WHERE 右辺の TODAY() とは
  別物です)。この違いと、日時フィールドの境界は RFC3339 で書くことを
  言語リファレンスに明記しました。

修正 (B112):
- EXPLAIN の app: / JOIN: 行で、別名や JOIN のある形のときに括弧内へ内部の仮想 ID が
  残っていたのを直しました (app: LAPP_案件管理@dev AS a)。物理アプリで profile が
  二重に付いていた症状 (APP4149@dev@dev) も同じ原因で、あわせて解消しています。
- 表示のみの修正で、計画の中身・押し下げ判定・結果は変わりません。

追加 (B110) (v3.38.0):
- engine ライブラリの QueryColumn に displayName が加わりました。SELECT 別名に
  書かれた表記 (大文字小文字) をそのまま持ちます。
    SELECT $id AS ランクA ... → columns: { name: "ランクa", displayName: "ランクA" }
- 結果行のキーと columns の name は従来どおり小文字のままで、挙動の変更はありません。
  表の見出しやグラフの凡例に displayName を使えるようになる純追加です。
- 別名の英字 (全角含む) が結果列名で小文字になることを言語リファレンス 1 章に
  明記しました (バッククォートでも保持されません)。

修正 (B109) (v3.37.1):
- engine ライブラリの explainQuery と、runBatch に EXPLAIN 文を流した場合の計画本文で、
  論理アプリが内部の仮想 ID のまま表示されていたのを、論理名の併記
  (LAPP_案件管理 -> APP4149 の形) に直しました。
- v3.37.0 で CLI / MCP は修正済みで、engine ライブラリの経路だけが残っていました。
  公開型・挙動の変更はありません。

追加と破壊的変更の移行案内 (B107) (v3.37.0):
- 論理アプリ名 LAPP_<NAME> に日本語が使えるようになりました。
    SELECT * FROM LAPP_案件管理        (CLI / MCP は config の logicalApps で解決)
- engine ライブラリ (runQuery / runBatch / explainQuery) に logicalApps オプションが
  加わりました。SQL 中の LAPP_<NAME> を呼び出しごとのマッピングで解決します。
    runBatch(sql, { client, logicalApps: { 案件管理: 4149 } })
  未定義名は kintone API を呼ばずに名前入りエラーで停止します。
- 破壊的変更: LAPP_ に日本語が続く識別子は論理アプリ参照として予約されます。
  その名前のフィールドを SQL で使っている場合はエラーになります (fail-closed)。
  移行方法: バッククォートで退避してください。
    誤 WHERE LAPP_案件 = 'x'   →   正 WHERE `LAPP_案件` = 'x'
- 名前の規則: ASCII 英字または日本語で開始・数字と _ を継続可・最大 64 UTF-16 単位・
  NFC 正規化・大小の同一視は ASCII と全角英字のみ。従来の ASCII 名は不変です。

修正 (B108) (v3.37.0):
- EXPLAIN を文として実行したときの論理アプリ表示が、内部の仮想 ID ではなく
  論理名の併記 (LAPP_名前@profile) になりました。--dry-run と MCP の ksql_explain は
  従来から正しく、挙動の変更はありません。

修正 (B105) (v3.36.0):
- UNION / UNION ALL の各枝の SELECT COUNT(*) が、単体と同じく totalCount の
  単発 GET になりました。'ラベル' AS 列名 のようなリテラル列との併用も対象です。
    SELECT '顧客管理' AS アプリ, COUNT(*) AS 件数 FROM APP100
    UNION ALL SELECT '案件管理', COUNT(*) FROM APP200
- 従来は UNION の枝に入れると全件取得に落ち、既定の maxRecords を超えるアプリでは
  「完全な候補集合が必要です」のエラーで停止していました。
- 挙動の変更: 従来エラーだった形が成功するようになります。失われる正しい結果は
  ありません。リテラル以外の列が混ざる形は従来どおり全件取得です。

追加 (B102) (v3.35.0):
- kintone のクエリ関数 PRIMARY_ORGANIZATION() を WHERE で使えるようになりました。
  ダッシュボードから自組織のデータを抽出する用途で、LOGINUSER() と同じ位置づけです。
    SELECT 案件名 FROM APP100 WHERE 担当組織 IN (PRIMARY_ORGANIZATION())
- 組織選択フィールドに対する IN / NOT IN の単独要素としてのみ使えます。
- DML の WHERE では使用できません。kintone は優先組織が設定されていない実行ユーザーに
  対してこの条件を無視し、他の条件を満たす全レコードを返します (kintone 公式の記述)。
  条件が消えると DELETE や UPDATE の対象が全件になるため、拒否します。
- 同じ理由で、SELECT でも優先組織が未設定の利用者では絞り込みが効きません。
  エンジンからは判別できないためそのまま返します。kintone の一覧の絞り込みと同じです。

1. ksql-plugin-v3.39.0.zip を kintone のプラグイン画面で読み込む
2. ksql-app-template-v1.11.0.zip をアプリ作成時にテンプレートとして読み込む
   (アプリテンプレートは v1.11.0 から変更ありません)
3. アプリにプラグインを適用して利用開始する

本リリース (v3.39.0): B111 相対日付関数を値に持つ変数／B112 EXPLAIN の表示修正。

- B111: 上の「追加」を参照してください。既存 SQL の意味は変わりません。
- B112: 上の「修正」を参照してください。表示のみです。

前リリース (v3.38.0): B110 SELECT 別名の表示表記を displayName で保持。

- B110: 上の「追加」を参照してください。公開型は純加法で、挙動の変更はありません。

前リリース (v3.37.1): B109 engine ライブラリの EXPLAIN 計画本文の論理名併記。

- B109: 上の「修正」を参照してください。

前リリース (v3.37.0): B107 論理アプリ名の日本語対応と engine ライブラリの logicalApps／B108。

- B107: 上の「追加と破壊的変更の移行案内」を参照してください。
- B108: EXPLAIN 文の論理アプリ表示の修正です。

前リリース (v3.36.0): B105 UNION の枝の COUNT(*) を単発 GET に。

- B105: 上の「修正」を参照してください。

前リリース (v3.35.0): B102 PRIMARY_ORGANIZATION() のサポート。

- B102: 上の「追加」を参照してください。DML では使用できません。

前リリース (v3.34.0): B98 外部結合の打ち切りを fail-closed 化／B99 MCP を SDK v2 へ移行。

- B98: 上の「挙動の変更の移行案内」を参照してください。
- B99: 上の「実行環境の要件の変更」を参照してください。MCP サーバーの実行に
  Node.js 20 以上が必要になります。CLI・engine ライブラリ・プラグインは変わりません。

過去バージョンのプラグイン zip:
- 本ディレクトリには最新版だけを置いています。
- 過去版は GitHub Releases の各タグに添付しています。
  https://github.com/rex0220/kintone-sql-tools/releases

v3.31.0 以前の変更履歴:
- CHANGELOG.md に全版を記載しています。
- GitHub Releases でも版ごとに参照できます。
  https://github.com/rex0220/kintone-sql-tools/releases
- 古い版から一気に上げる場合は、間の版の破壊的変更に移行案内が付いています。
  CHANGELOG.md を版順に確認してください。
