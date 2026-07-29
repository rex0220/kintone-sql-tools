ksql 配布パッケージ (v3.34.1)

release 成果物:
- ksql-plugin-v3.34.1.zip
- ksql-mcp.mcpb (manifest version 3.34.1)
- ksql-mcp.js (MCP server version 3.34.1)

追加 (B101) ★本リリースの要点:
- MCP サーバーの instructions の 1 行目に、そのサーバー自身の版数が出るようになりました。
    kSQL MCP server version 3.34.1.
- 常駐している MCP サーバーは npm install では差し替わりません。更新後に再起動しないと、
  古い版が答え続けます。旧版は旧版として正しく動くため、エラーも警告も出ません。
- 測定や検証の前に 1 行目を確認してください。ディスク上の版ではなく、
  いま動いているプロセスの版が分かります。ずれていたら MCP サーバーを再起動してください。
- 接続時に 1 回渡されるものなので、セッションの途中で再起動した場合は繋ぎ直してください。
- 挙動・公開型・ツールの面はいずれも変わりません。

実行環境の要件の変更 (B99) (v3.34.0):
- MCP サーバーの実行に Node.js 20 以上が必要になりました。
  プロトコル改訂 2026-07-28 に対応した MCP SDK が Node.js 20 以上を要求するためです。
- 影響するのは MCP サーバーの面だけです。
    CLI            従来どおり Node.js 18 以上
    engine ライブラリ 変更なし
    プラグイン        変更なし (ブラウザで動作)
- MCPB 版は Claude Desktop が提供する Node.js 実行環境で起動するため、
  利用者が Node.js を別途インストールする必要は通常ありません。
  Claude Desktop 側の実行環境が Node.js 20 以上である必要があります。
- 公開型・SQL の挙動・ツールの面はいずれも変わりません。
  13 のツールと 4 のリソースは、名前も順序もスキーマも従来と同一です。
- tools/list が返す inputSchema の JSON Schema 方言のみ、
  draft-07 から 2020-12 へ変わります。方言 URI ($schema) だけの違いで、
  プロパティ・必須項目・制約は同一です。方言 URI を見て分岐している
  MCP クライアントがある場合のみ影響します。

挙動の変更の移行案内 (B98) (v3.34.0):
- LEFT JOIN / RIGHT JOIN の保持されない側が取得上限に達した場合、
  onLimit=truncate を選んでいてもエラーになります。従来は部分結果を返していました。
- 結合相手が打ち切られると、上限の外へ落ちた一致行と、本当に相手がいない行を
  結果から区別できません。実測では APP4226 LEFT JOIN APP4225 を
  maxRecords=20 / truncate で実行すると、真の値が b01 である B の行が空になり、
  本当に相手がいない C の行とバイト単位で同一に見えました。
- 対象外 (従来どおり):
    保持側だけが打ち切られた場合  行が減るだけなので警告付きで返します
    INNER JOIN                   変更ありません
- 移行方法: WHERE で候補を絞るか、maxRecords を引き上げてください。
  onLimit=error を選んでいる場合、挙動は変わりません。

挙動の変更の移行案内 (B97) (v3.33.0):
- 取得上限に達したとき、集計・GROUP BY・DISTINCT・UNION (ALL なし) は
  onLimit=truncate を選んでいてもエラーになります。従来は部分集合を畳んだ値を
  返していました。
- 現在成功して見えるクエリも、返しているのは正しい結果ではありません。
  実測では、真の件数が 3 のクエリが 0 を返していました。
    SELECT COUNT(*) FROM APP4147 WHERE 顧客No LIKE '%6%'   maxRecords=3 / truncate
    → 0        (該当は 4 件目以降にあり、先頭 3 件だけを数えた)
  0 は「該当なし」という完結した答えに読めるため、小さすぎる値より気づけません。
  したがって、エラー化によって正しい結果が失われることはありません。
- 対象外 (従来どおり取得できた行と警告を返します):
    素の明細   SELECT 案件名 FROM APPn
    UNION ALL
  行そのものは本物なので、件数が足りないだけです。
- 対象外 (そもそも取得上限を使いません):
    完全に押し下がる COUNT(*) の単発取得 (v3.32.0 の B94)
- 移行方法: WHERE で候補を絞るか、maxRecords を引き上げてください。
  onLimit=error を選んでいる場合、挙動は変わりません。
- ローカル ORDER BY・window・統計集計 (STDDEV など)・小計総計は、
  従来から同じ理由でエラーになっていました。今回その対象が集計全般へ広がります。

破壊的変更の移行案内 (B89 / B90) (v3.31.0):
- engine ライブラリの runBatch と explainQuery が EXPLAIN UPDATE / DELETE / INSERT /
  UPSERT を READ_ONLY_VIOLATION で拒否します。read-only ライブラリで DML の計画を出す
  用途は元から想定しておらず、explainQuery は従来も拒否していました。EXPLAIN は計画
  だけで書き込まないため、誤った結果を得ていた利用者はいません。EXPLAIN SELECT は
  従来どおり通ります。
- 算術式に非数値の変数を使うと ArgumentError で停止します。新しい直接算術だけでなく、
  従来から動いていた ROUND(算術式, ...) などの関数経路も対象です。従来はエラーも警告も
  なく NaN を返していました。数値変数の結果は変わりません。
    修正前: DECLARE @phase = '受注'; SELECT ROUND(売上 * 100 / @phase, 1) FROM APPn
    → NaN
    修正後: 同じ SQL が variable @phase is not numeric ... で停止

1. ksql-plugin-v3.34.1.zip を kintone のプラグイン画面で読み込む
2. ksql-app-template-v1.11.0.zip をアプリ作成時にテンプレートとして読み込む
   (アプリテンプレートは v1.11.0 から変更ありません)
3. アプリにプラグインを適用して利用開始する

本リリース (v3.34.1): B101 MCP の instructions に版数を載せる。

- B101: 上の「追加」を参照してください。挙動の変更はありません。

前リリース (v3.34.0): B98 外部結合の打ち切りを fail-closed 化／B99 MCP を SDK v2 へ移行。

- B98: 上の「挙動の変更の移行案内」を参照してください。
- B99: 上の「実行環境の要件の変更」を参照してください。MCP サーバーの実行に
  Node.js 20 以上が必要になります。CLI・engine ライブラリ・プラグインは変わりません。

前リリース (v3.33.0): B97 打ち切られた入力の集計を fail-closed 化／B96。

- B97: 上の「挙動の変更の移行案内」を参照してください。
- B97: 集計・GROUP BY・DISTINCT を含むクエリの EXPLAIN に、完全な入力が必要である
  ことと、その理由が表示されるようになります。
- B96: getRecords() の応答契約をライブラリ文書へ明記しました。応答をそのまま返し、
  records 以外の項目を落とさないでください。とくに searchAborted を落とすと、
  10 万件の検索打ち切りに対する fail-closed が無効になり、打ち切られた結果を
  完全な結果として扱います。totalCount の欠落は性能だけの影響です
  (エンジンが全件取得へ落とします)。キャッシュや計測のために client を包む場合も
  同じで、createReadonlyKintoneClient を使っていても踏みます。

前リリース (v3.32.0): B95 打ち切りの構造化／B94 COUNT(*) の単発取得／B93。

- B94: 単一アプリの SELECT COUNT(*) だけのクエリは、WHERE が完全に押し下がる場合、
  kintone REST の totalCount で 1 回の GET で件数を返します。この経路では
  maxRecords / onLimitReached を適用しません。MCP の既定 maxRecords は 500 なので、
  500 件を超えるアプリの件数取得は従来失敗していましたが、正しい総件数を返します。
- B95: 取得上限で打ち切られたかどうかを QueryMetrics.limitReached で判別できます。
    if (result.metrics.limitReached) { ... }
  どのアプリかは limitReachedApps に入ります。判定には limitReached を使ってください。
  両方とも任意プロパティなので、既存の利用者コードは変更不要です。
- B93: BYO クライアントの getFields() が未知の fieldType を返したときのエラーが、
  クライアント契約の違反として読める文面になります。fields.json のフィールドだけを
  返し、$id と $revision は足さないでください（エンジンが合成します）。

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
