ksql 配布パッケージ (v3.42.0)

release 成果物:
- ksql-plugin-v3.42.0.zip
- ksql-mcp.mcpb (manifest version 3.42.0)
- ksql-mcp.js (MCP server version 3.42.0)

修正と移行案内 (B117) ★本リリースの要点:
- DATE_ADD の月・年加算が、月末で翌月へ繰り上がっていたのを直しました。
    修正前  DATE_ADD('2026-01-31', 1, 'MONTH') → 2026-03-03
    修正後  DATE_ADD('2026-01-31', 1, 'MONTH') → 2026-02-28
- 存在しない「2 月 31 日」がそのまま繰り上がっていたためで、3/31 の -1 か月も
  同じ日になり、往復しても戻らない状態でした。エラーにならないため気づけません。
- 結果の日が対象月に無い場合は月末へ丸めます (MySQL / PostgreSQL / Oracle と同じ)。
- 移行案内: 月末の日付を DATE_ADD に通していた結果が変わります (今までが誤りです)。
  変わるのは月末だけで、丸めが起きないケースと DAY 単位の結果は完全に不変です。
  締め日が月末の集計は、これまで 2〜3 日ずれていた可能性があります。
- 丸めが起きた場合、往復は元へ戻りません (1/31 → 2/28 → 1/28)。MySQL も同じです。

文書:
- 言語リファレンス §6 に「押し下がる形への書き換え」表を追加しました
  (選択系の = → IN、YEAR(列) = 2026 → 列 = THIS_YEAR()、LIKE → KLIKE など)。
- 日時フィールドの境界は半開区間 (>= 開始日 AND < 終了日の翌日) を推奨へ改めました。
- CURRENT_DATE() が実行環境のローカルタイムゾーンで評価される旨を追記しました。

修正 (B114) (v3.41.0):
- v3.40.0 は COUNT(*) の取得範囲を NONE (取得しない) と表示していましたが、実際は
  limit 1 の単発 GET で $id だけの 1 件が転送されます。「取得しない」ではなく
  「走査しない」が正しいため、COUNT_ONLY へ改めました。
    修正前  fetch: NONE (limit 1)
    修正後  fetch: COUNT_ONLY (limit 1)
- NONE は残し、意味を限定しました。kintone から取得するソースが 1 つも無い文
  (一時テーブル参照のみ) でだけ現れます。
- 押し下げ判定・取得動作は変わりません (表示と型のみ)。

追加 (B114) (v3.40.0):
- EXPLAIN が「kintone から何件取りに行くか」を自ら名乗るようになりました。
    mode:          FULL_SCAN
    kintone query: 確度 in ("A")
    fetch:         PREFILTERED (未確定)      ← 追加
- 値は COUNT_ONLY (件数のみ) / EXACT (全条件を絞り込み) / PREFILTERED (一部を絞り込み) /
  ALL (全件取得) / NONE (取得ソース無し) の 5 つで、最悪値の順序は
  NONE < COUNT_ONLY < EXACT < PREFILTERED < ALL です。文の先頭には最悪値の
  fetch summary: が出ます。
- mode: FULL_SCAN は「取得後に JS で全行評価する」という内部名で、取得量の話では
  ありません。GROUP BY や集計を含むクエリは、押し下げが効いていても FULL_SCAN と
  表示されます。取得量は fetch: の行で判断してください。
- JOIN や UNION では取得のされ方がソースごとに違うため、ソース単位で表示します。
- engine ライブラリでは ExplainResult.plan に同じ内容が構造で入ります (純加法)。
  表示文言を文字列解析せずに扱えます。
- mode 行・既存の計画表示・押し下げ判定・MCP / CLI の応答形は変わりません。

追加 (B111) (v3.39.0):
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

修正 (B112) (v3.39.0):
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

修正 (B108) (v3.37.0):
- EXPLAIN を文として実行したときの論理アプリ表示が、内部の仮想 ID ではなく
  論理名の併記 (LAPP_名前@profile) になりました。--dry-run と MCP の ksql_explain は
  従来から正しく、挙動の変更はありません。

1. ksql-plugin-v3.42.0.zip を kintone のプラグイン画面で読み込む
2. ksql-app-template-v1.11.0.zip をアプリ作成時にテンプレートとして読み込む
   (アプリテンプレートは v1.11.0 から変更ありません)
3. アプリにプラグインを適用して利用開始する

本リリース (v3.42.0): B117 DATE_ADD の月末繰り上がりを修正 (結果が変わります)。

- B117: 上の「修正と移行案内」を参照してください。

前リリース (v3.41.0): B114 fetch の NONE を COUNT_ONLY へ改める。

- B114: 上の「修正」を参照してください。押し下げ判定・取得動作は不変です。

前リリース (v3.40.0): B114 EXPLAIN が取得範囲を名乗る。

- B114: 上の「追加」を参照してください。表示の追加と公開型の純加法のみです。

前リリース (v3.39.0): B111 相対日付関数を値に持つ変数／B112 EXPLAIN の表示修正。

- B111: 上の「追加」を参照してください。既存 SQL の意味は変わりません。
- B112: 上の「修正」を参照してください。表示のみです。

前リリース (v3.38.0): B110 SELECT 別名の表示表記を displayName で保持。

- B110: 上の「追加」を参照してください。公開型は純加法で、挙動の変更はありません。

前リリース (v3.37.1): B109 engine ライブラリの EXPLAIN 計画本文の論理名併記。

- B109: 上の「修正」を参照してください。

前リリース (v3.37.0): B107 論理アプリ名の日本語対応と engine ライブラリの logicalApps／B108。

- B107: 上の「追加と破壊的変更の移行案内」を参照してください。
- B108: EXPLAIN 文の論理アプリ表示の修正です。

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
