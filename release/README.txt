ksql 配布パッケージ (v3.36.0)

release 成果物:
- ksql-plugin-v3.36.0.zip
- ksql-mcp.mcpb (manifest version 3.36.0)
- ksql-mcp.js (MCP server version 3.36.0)

修正 (B105) ★本リリースの要点:
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

追加 (B101) (v3.34.1):
- MCP サーバーの instructions の 1 行目に、そのサーバー自身の版数が出るようになりました。
    kSQL MCP server version 3.34.1.
- 常駐している MCP サーバーは npm install では差し替わりません。更新後に再起動しないと、
  古い版が答え続けます。旧版は旧版として正しく動くため、エラーも警告も出ません。
- 測定や検証の前に 1 行目を確認してください。ディスク上の版ではなく、
  いま動いているプロセスの版が分かります。ずれていたら MCP サーバーを再起動してください。
- instructions が文脈に入るのは MCP の接続時ではなく会話の開始時です。進行中の会話は
  繋ぎ直しても古い本文を持ち続けるため、更新後は新しい会話を始めてください。
  古い会話では「古い版」が見えるだけなので、誤って新しいと思い込むことはありません。
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

1. ksql-plugin-v3.36.0.zip を kintone のプラグイン画面で読み込む
2. ksql-app-template-v1.11.0.zip をアプリ作成時にテンプレートとして読み込む
   (アプリテンプレートは v1.11.0 から変更ありません)
3. アプリにプラグインを適用して利用開始する

本リリース (v3.36.0): B105 UNION の枝の COUNT(*) を単発 GET に。

- B105: 上の「修正」を参照してください。

前リリース (v3.35.0): B102 PRIMARY_ORGANIZATION() のサポート。

- B102: 上の「追加」を参照してください。DML では使用できません。

前リリース (v3.34.1): B101 MCP の instructions に版数を載せる。

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
