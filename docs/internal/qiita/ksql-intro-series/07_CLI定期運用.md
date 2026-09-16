<!-- タイトル案: 【kSQL 実践 #7】CLI を導入して定期運用に載せる — ファイル出力・環境切替・自動実行と終了コード -->
<!-- 投稿時タグ案: kintone, SQL, CLI, 自動化, CSV -->
<!--
状態: 草稿 R4（2026-09-12。全体レビュー（計画書 §11）を反映: 3 節の LAPP_ は 5 節の設定を先に・受注 7 件と第 1 回 8 件の差・.bat を call ksql.cmd に・版固定の落とし穴。R3: 2026-09-11。R2 への再レビューを反映: 「3 面で同じ SQL」を LAPP_ の制約で限定・依頼文を LAPP_ と限定監査に・profile 例は認証省略と明記・--dry-run でも --allow-dml が要る（実測 exit 2）・図の指示を .bat 呼び出しに。公開可）。構成は 計画書.md §4 の第 7 回を正とする。
公開前チェック: 第 0〜6 回の URL（冒頭「前回」）／図の差し込み 1 か所（タスクスケジューラの登録画面）／このコメント自体を削除
掲載コマンドと出力は v3.77.0 の dist-cli/ksql.js（dev profile・userpass）で実行。実書き込みは検証用レコード $id 338 のみ（--allow-dml --yes で売上 0 → CLI で '' に復元）。LAPP_ の実演は scratchpad の一時設定（dev/prod とも同じ環境・prod は allowPhysicalAppRefs:false）で実施し、リポジトリの設定は変えていない。ドメインは <domain> に置換
-->
<!-- 計画書へのリンク（docs-check 用・公開時は削除）: [計画書.md](計画書.md) -->

> **結論（3 行）**
>
> - 第 6 回までの SQL はプラグインで足りました。CLI が要るのは **ファイルに書き出す**（`--export-csv`、Shift_JIS 可）、**別環境で同じ SQL を使う**（profile と `LAPP_<NAME>`）、**自動で回す**（`-f`、`--var`、終了コード）の 3 つです
> - CLI は設定の優先順位が **CLI 引数 → 環境変数 → 設定ファイル**。`KSQL_*` がシェルに残っていると設定ファイルより勝ちます（実測）。テストや別プロジェクトで「変えていないのに挙動が変わる」の典型です
> - 無人実行の安全装置は第 5 回の形そのまま。`--dry-run` で計画、`VALIDATE ONLY` で値、本実行は `--allow-dml --yes --dml-max-rows n`、失敗は終了コード 1〜3 で検知します

前回（[第 6 回: CSV を IMPORT して検証環境を大きくする](https://qiita.com/rex0220/items/XXXXXXXX)）まで、実行はすべてプラグインの画面で行いました。今回は同じ SQL をコマンドラインへ移します。

## 課題

1. 第 1 回の「顧客ランク別の受注額」を、毎週月曜の朝に自動で実行して CSV を共有フォルダに置きたい。取引先の都合で Shift_JIS が要る
2. 同じ SQL を開発環境と本番環境で使いたい。アプリ番号は環境ごとに違う
3. 第 4 回の監査と第 5 回の更新を無人で回し、失敗したら通知したい

## 1. 導入と設定

```bash
npm install -g @rex0220/kintone-sql-tools
ksql --version   # 3.77.0
```

接続設定は `ksql.config.json` に書きます。既定は実行ディレクトリの `./ksql.config.json`、`--config` で場所を指定できます。トークンは環境変数参照（`env:`）にします。

```json
{
  "version": 1,
  "defaultProfile": "dev",
  "profiles": {
    "dev": {
      "baseUrl": "https://dev.example.cybozu.com",
      "auth": "token",
      "tokenMap": {
        "APP4148": "env:KSQL_TOKEN_KOKYAKU",
        "APP4149": "env:KSQL_TOKEN_ANKEN"
      },
      "query": { "maxRecords": 500, "onLimit": "error" }
    }
  }
}
```

認証は `token`（アプリごとの API トークン）、`userpass`（ログイン名とパスワード。`KSQL_USERNAME` / `KSQL_PASSWORD`）、`auto` から選びます。読み取り中心の定期ジョブなら、必要な権限だけを持つトークンを推奨します。

### 優先順位は CLI 引数 → 環境変数 → 設定ファイル

設定は 3 か所から来ます。上が勝ちます。

| 優先 | 例 |
| :--- | :--- |
| CLI 引数 | `--max-records 500` |
| 環境変数 | `KSQL_MAX_RECORDS=5` |
| 設定ファイル | `"query": { "maxRecords": 500 }` |

実測です。設定ファイルの上限は 500 のまま、環境変数だけを 5 にして明細を取ると止まります。

```bash
$ KSQL_MAX_RECORDS=5 ksql -e "SELECT 会社名 FROM APP4148 WHERE 顧客ランク IN ('A')"
取得件数が上限（5 件）を超えました。WHERE 句で絞り込むか、maxRecords を引き上げてください。
$ echo $?
1
$ KSQL_MAX_RECORDS=5 ksql -e "SELECT 会社名 FROM APP4148 WHERE 顧客ランク IN ('A')" --max-records 500
（59 行が返る）
```

実装が読む `KSQL_*` は 32 個あります。開発機で `KSQL_USERNAME` や `KSQL_PROFILE` を設定したまま別プロジェクトのテストを回すと、設定ファイルを変えていないのに落ちたり通ったりします。**変数名だけを一覧して最初に確認する**のが定石です。値まで表示すると、パスワードやトークンが端末や CI のログに残ります。

```bash
env | sed 's/=.*//' | grep '^KSQL_'
```

## 2. 最初の 1 本と出力形式

```bash
ksql -e "SELECT 商談フェーズ, COUNT(*) AS 件数, SUM(売上) AS 売上合計
         FROM APP4149
         WHERE 初回商談日 = THIS_YEAR() AND 商談フェーズ IN ('受注','内示','提案中')
         GROUP BY 商談フェーズ ORDER BY 件数 DESC"
```

```text
商談フェーズ	件数	売上合計
受注	7	37200000
提案中	6	28250000
内示	2	12750000
rowCount=3
```

受注が 7 件なのは、初回商談日が 2025 年の受注 1 件が `THIS_YEAR()` から外れるためです（第 1 回の受注 8 件と 1 件違います）。既定は TSV 風の表です。`--format` で切り替えます。

| `--format` | 用途 |
| :--- | :--- |
| `table`（既定） | 目視。`--no-header` で見出し無し |
| `json` | 後続処理へ。`--pretty` で整形。バッチは全体で 1 つの JSON |
| `jsonl` | 1 行 1 レコード |
| `csv` | 標準出力へ CSV（ファイルに残すなら次節の `--export-csv`） |
| `markdown` / `md` | Slack や Wiki に貼る |

`--quiet` でログ行（`rowCount=` など）を消し、`--output path` で標準出力をファイルに向けられます。

```text
$ ksql -e "..." --format md --quiet
| 商談フェーズ | 件数 | 売上合計 |
| --- | --- | --- |
| 受注 | 7 | 37200000 |
| 提案中 | 6 | 28250000 |
| 内示 | 2 | 12750000 |
```

## 3. SQL をファイルにする — `-f` と `DECLARE` / `--var`

定期実行する SQL はファイルに置きます。git に入り、差分がレビューできます。プラグインの「SQL レコード」や MCP の保存クエリに相当するものが、CLI では `.sql` ファイルです。

`weekly_rank.sql`（アプリは 5 節で扱う論理名 `LAPP_<NAME>` で書いておきます。結果は一時テーブル `#rankA` に入れ、4 節でファイルに書き出します。実行するには 5 節の profile 設定を先に済ませるか、`LAPP_` を `APPn` に読み替えてください）:

```sql
-- 週次: 顧客ランク別の受注額（第 1 回）
DECLARE @phase = '受注';

CREATE TEMP TABLE #rankA AS
SELECT a.顧客ランク, COUNT(*) AS 件数, SUM(b.売上) AS 受注額
FROM LAPP_ANKEN AS b
INNER JOIN LAPP_KOKYAKU AS a ON b.顧客No_ = a.顧客No
WHERE b.商談フェーズ IN (@phase)
GROUP BY a.顧客ランク
ORDER BY 受注額 DESC;

SELECT * FROM #rankA ORDER BY 受注額 DESC
```

```text
$ ksql -f weekly_rank.sql --quiet
顧客ランク	件数	受注額
A	5	22800000
B	3	18000000
```

`DECLARE @phase = '受注'` は既定値です。CLI からは `--var` で差し替えられ、SQL ファイルは触りません。

```bash
ksql -f weekly_rank.sql --var phase=提案中 --format json --quiet --output weekly_rank.json
```

`--var` は秘密情報には使いません（プロセス一覧に見えます）。`DECLARE` による既定値と変数差し替えの仕組みは 3 面で共通です（プラグインは既定値のまま、MCP は `variables` で差し替え）。ただし、このファイルは `LAPP_` を使っているため、そのまま実行できるのは CLI・MCP・engine ライブラリです。プラグインで使う場合は、`LAPP_ANKEN` / `LAPP_KOKYAKU` を対象環境の `APPn` へ置き換えます。

## 4. ファイルに書き出す — `--export-csv`

`--format csv` は標準出力です。ファイルとして安全に書きたいときは `--export-csv` を使います。バッチの一時テーブルを**名前付きシンク**として書き出す形が基本です。

```bash
ksql -e "CREATE TEMP TABLE #rankA AS
           SELECT 会社名, 顧客ランク, 都道府県 FROM APP4148 WHERE 顧客ランク IN ('A');
         SELECT COUNT(*) AS 件数 FROM #rankA" \
     --export-csv rankA=./out/rankA.csv
```

```text
件数
59
```

手元は第 6 回で増量した環境なので 59 件です（ヘッダ込み 60 行の CSV）。3 節の `weekly_rank.sql` なら、`--export-csv rankA=./out/rankA.csv` を付けるだけで `#rankA` の 2 行がファイルになります。

規則は次のとおりです。

- **SQL 全文が成功した後にだけ書く。** 途中の文が失敗すればファイルは作られず、既存のファイルもそのまま残ります
- **1 ファイル単位の atomic write。** 同じディレクトリに一時ファイルを書き、fsync してから rename します。読み手が中途半端なファイルを見ることはありません。複数の `--export-csv` を指定した場合、全体としてはアトミックではなく、途中で止まると更新済みと旧ファイルが混在しえます
- 形式は RFC 4180（CRLF・ヘッダあり・BOM なし）。複数値は LF 連結、ユーザー系は `code`、SUBTABLE / FILE 列はエラー
- 単文 SELECT なら `--export-csv ./out/customers.csv` と path だけでも書けます（`=` を含まない path・1 件だけ）
- `--output` と同じ path、`--dry-run` との併用は実行前に拒否されます

### Shift_JIS — 表現できない文字は黙って `?` にせず失敗する

```bash
ksql -e "..." --export-csv rankA=./out/rankA.csv --export-encoding sjis
```

Shift_JIS で表せない文字（`𠮷` のような CP932 に無い漢字）が 1 文字でもあると、ファイルを作らずに止まります。

```text
ExportSinkEncodingError: Shift_JIS encoder failed to encode the CSV payload.
(ExportSinkEncodingError: character U+20BB7 at offset 4 cannot be represented in Shift_JIS.)
$ echo $?
1
```

多くのライブラリは黙って `?` に置き換えますが、kSQL は**往復検査で失敗させる**設計です。取引先に渡す CSV で氏名が `?` になるより、止まって気づくほうが安全だからです。
回避は `TRANSLATE` で 1 対 1 の字体変換をしてから書き出します。

```sql
SELECT TRANSLATE(会社名, '𠮷', '吉') AS 会社名, ... FROM APP4148
```

CP932 に無い常用外の漢字 40 字の変換表が、リポジトリの[バッチ設計レシピ集 R8](https://github.com/rex0220/kintone-sql-tools/blob/v3.77.0/docs/ksql_batch_recipes.md) にあります。
第 4 回の `LENGTH(x) - LENGTH_CHAR(x) > 0` で、`𠮷` のような補助平面の文字は事前に洗い出せます。ただし CP932 で表現できない文字をすべて検出できるわけではありません（基本多言語面にも CP932 に無い文字はあります）。最終判定は `--export-encoding sjis` の往復検査です。

`--export-timezone Asia/Tokyo` を付けると、DATETIME 列がオフセット付きのローカル時刻になります。付けなければ UTC のままです。

## 5. 環境を切り替える — profile と `LAPP_<NAME>`

開発と本番でアプリ番号が違うとき、SQL に `APP4149` と書くと環境ごとに別ファイルが要ります。論理アプリ名 `LAPP_<NAME>` を使うと、SQL は 1 つで、profile が物理番号へ解決します。

以下は `logicalApps` と物理参照制限に関する profile 部分の抜粋です。`auth` と `tokenMap` は省略しているので、実際の設定では 1 節と同じ認証設定を各 profile へ足してください（無いと終了コード 3 になります）。

```json
{
  "defaultProfile": "dev",
  "profiles": {
    "dev":  { "baseUrl": "https://dev.example.cybozu.com",  "logicalApps": { "ANKEN": 4149, "KOKYAKU": 4148 } },
    "prod": { "baseUrl": "https://prod.example.cybozu.com", "logicalApps": { "ANKEN": 1200, "KOKYAKU": 1100 },
              "allowPhysicalAppRefs": false }
  }
}
```

```bash
ksql --profile dev  -e "SELECT COUNT(*) AS 案件数 FROM LAPP_ANKEN"   # → APP4149
ksql --profile prod -e "SELECT COUNT(*) AS 案件数 FROM LAPP_ANKEN"   # → APP1200
```

`allowPhysicalAppRefs: false` を本番 profile に付けると、`APP4149` のような物理番号の直書きが実行前に拒否されます。開発用の SQL を本番に流す事故を、設定で止められます。

```text
$ ksql --profile prod -e "SELECT COUNT(*) FROM APP4149"
ArgumentError: physical app references are not allowed for profile "prod"; use LAPP_<NAME>.
$ echo $?
2
```

`APP4149` は常に物理番号 4149 のままで、暗黙に論理解決されることはありません。`--dry-run` で `LAPP_ANKEN@prod` がどこへ解決されるかを実行前に確認できます。`LAPP_` はプラグインでは使えません（CLI・MCP・engine ライブラリの拡張です）。

## 6. 書き込みを無人で回す — `--dry-run` と `--allow-dml --yes`

第 5 回の更新バッチを CLI で流します。手順は 3 段です。

**計画を見る。** `--dry-run` は EXPLAIN と同じで、レコードも書き込みも触りません。DML を含むバッチは、書き込みを行わない `--dry-run` でも `--allow-dml` が必要です（無いと `DML is disabled` で終了コード 2。実測）。これは DML を扱う意思を明示する構文ガードで、`--dry-run` 中に書き込みが行われるという意味ではありません。

```text
$ ksql --dry-run --allow-dml -e "CREATE TEMP TABLE #fix AS ...; ASSERT ...; UPDATE APP4149 SET 売上 = f.新売上 FROM #fix AS f WHERE ..."
[1] CREATE_TEMP_TABLE
  fetch summary: EXACT
    kintone query: 売上 = ""
[2] ASSERT
  check:         実行時に条件評価（不成立は AssertError でバッチ停止、以降の文は skipped）
[3] UPDATE
  source:        temp table #fix
  records API:   none
```

**値を検証する。** SQL の末尾に `VALIDATE ONLY` を付けて実行します（第 5 回）。書き込み 0 回です。

**本実行する。** DML は `--allow-dml` が無いと `DML is disabled` で拒否されます。付けると確認プロンプトが出るので、無人実行では `--yes` で飛ばし、代わりに `--dml-max-rows` で件数の上限を明示します。

```text
$ ksql --allow-dml --yes --dml-max-rows 10 -f fix_amount.sql
[1] CREATE_TEMP_TABLE success temp=#fix rows=1
[2] ASSERT success
[3] UPDATE success updated=1
$ echo $?
0
```

`--yes` は「人が確認しない」宣言です。その代わりに `ASSERT` と `--dml-max-rows` を必ず置きます。第 5 回の「書き込み前に止める」を、フラグと SQL の両方で書く形です。

何が kintone に飛ぶかを見たいときは `--debug-url` です。トークンは出ません（ヘッダは `--debug-headers` でマスク表示）。

```text
$ ksql --debug-url -e "SELECT 案件名 FROM APP4149 WHERE 商談フェーズ IN ('受注') LIMIT 2"
[debug] request GET https://<domain>/k/v1/app/form/fields.json?app=4149
[debug] request GET https://<domain>/k/v1/records.json?app=4149&query=商談フェーズ in ("受注") order by $id asc limit 2&fields[]=案件名
```

第 0 回の「押し下げ」が、実際のクエリ文字列として見えます。トークンは出ませんが、WHERE の検索値や会社名のような業務データは URL に含まれます。共有ログや CI のログに残す前提のときは、`--debug-url` を常用しないでください。

## 7. 終了コードで検知する

スケジューラや CI は終了コードしか見ません。実測した値です。

| 終了コード | いつ | 実測した例 |
| --: | :--- | :--- |
| 0 | 成功 | 通常の SELECT、`ASSERT` 成立、DML 成功 |
| 1 | 実行時のエラー | `ASSERT` 不成立、取得上限超過（`FetchAllLimitError`）、Shift_JIS の表現不能文字 |
| 2 | 引数・設定のエラー | `allowPhysicalAppRefs: false` の profile で物理番号を参照、FROM 無しバッチで `--app` 未指定 |
| 3 | 認証設定のエラー | `baseUrl`、API トークン、ユーザー名／パスワードが不足 |

無人運用では 1〜3 をすべて失敗として扱います。

「0 件は異常」にしたいジョブ（必ず 1 件以上あるべきマスタの確認など）は `--exit-on-empty` を付けます。0 行なら終了コード 1 です。

```text
$ ksql -e "SELECT 会社名 FROM APP4148 WHERE 会社名 = '存在しない会社'" --exit-on-empty
会社名
$ echo $?
1
```

第 4 回の監査を「違反 0 件なら 0、あれば 1」にするには、`VALIDATE … INTO #err; ASSERT (SELECT COUNT(*) FROM #err) = 0;` の形で `ASSERT` に判定させます（`--exit-on-empty` は向きが逆です）。

### スケジューラに登録する

Windows のタスクスケジューラなら、次のようなバッチファイルを毎週月曜に実行します。

```bat
@echo off
cd /d C:\jobs\ksql
call ksql.cmd --profile prod -f weekly_rank.sql --export-csv rankA=\\fileserver\share\rankA.csv --export-encoding sjis --quiet
if errorlevel 1 (
  echo ksql weekly_rank failed: %errorlevel% >> C:\jobs\ksql\error.log
  exit /b %errorlevel%
)
```

Linux の cron なら、ラッパースクリプトで終了コードを保存し、通知した後に同じコードを返します。`ksql … || notify.sh` の形は、通知が成功するとジョブ全体が 0 になって元の失敗を隠すので使いません。

```bash
#!/bin/sh
cd /opt/jobs
ksql --profile prod -f weekly_rank.sql --export-csv rankA=/share/rankA.csv --export-encoding sjis --quiet
rc=$?
if [ "$rc" -ne 0 ]; then
  notify.sh "$rc"
fi
exit "$rc"
```

トークンはタスクの実行ユーザーの環境変数に置きます。`--var` にも `.sql` にも書きません。

<!-- 図: タスクスケジューラの登録画面（操作: プログラム cmd.exe、引数 /c C:\jobs\ksql\weekly_rank.bat。上のバッチファイルを呼ぶ構成に合わせる） -->

## 落とし穴

- **`KSQL_*` は設定ファイルより優先される。** 別プロジェクトのテストが落ちたら、まず `env | sed 's/=.*//' | grep '^KSQL_'` で変数名を確認する（値は表示しない）。テスト時は `env -u KSQL_USERNAME -u KSQL_PASSWORD npm test` のように外す
- **CLI の取得上限の既定は 500 件**（プラグインは 3,000、エンジンは 10,000）。第 6 回で増量した環境では `--max-records` か profile の `query.maxRecords` を上げる。一時テーブルの実体化は別枠の `--temp-table-max-rows`（既定 10,000）
- **`--output` と `--export-csv` は別物。** 前者は標準出力の向き先、後者は SQL 成功後に atomic に書くシンク。同じ path は拒否される
- **`--export-csv` は SQL 全文の成功後にだけ書く。** `ASSERT` で止まればファイルは作られず、旧ファイルが残る。「ファイルが更新されていない」がエラーの合図になる
- **Shift_JIS で表せない文字は失敗。** `TRANSLATE` で字体変換するか、UTF-8（BOM なし）で渡せないか先方と調整する
- **`--yes` は確認を飛ばす宣言。** `ASSERT` と `--dml-max-rows` を必ず併用する
- **`DELETE` は `APP@profile` 指定に未対応。** 環境切替は profile で行う
- **Windows で `ksql --help` がエディタを開く。** `ksql` が npm の `.cmd` シムではなく `.js` 本体に解決される環境で、`.js` の関連付けの影響で起きる。`ksql.cmd --help` か `node dist-cli/ksql.js --help`。バッチファイルからも `call ksql.cmd` と明示しておくと確実
- **定期運用では版を固定する。** `npm i -g` は次の更新で版が変わる。第 8 回と同じくプロジェクトローカルに `npm install --save-exact` で入れて `npm ci` で配置し、`node node_modules/@rex0220/kintone-sql-tools/dist-cli/ksql.js` を呼ぶ形にすると、版が lockfile で決まる
- **`--var` に秘密情報を入れない。** プロセス一覧に見える

## 運用に載せる

週次ジョブは 1 つの `.sql` に「監査 → ゲート → 集計 → 書き出し」をまとめられます。

```sql
-- weekly.sql
VALIDATE LAPP_KOKYAKU (会社名, 顧客ランク) INTO #err;   -- この集計が使う列だけを監査（第 4 回）
ASSERT (SELECT COUNT(*) FROM #err) = 0;                 -- 品質ゲート
CREATE TEMP TABLE #rankA AS
SELECT a.顧客ランク, SUM(b.売上) AS 受注額
FROM LAPP_ANKEN AS b INNER JOIN LAPP_KOKYAKU AS a ON b.顧客No_ = a.顧客No
WHERE b.商談フェーズ IN ('受注')
GROUP BY a.顧客ランク;
SELECT * FROM #rankA
```

```bash
ksql --profile prod -f weekly.sql --export-csv rankA=/share/rankA.csv --export-encoding sjis --quiet
```

監査対象を `(会社名, 顧客ランク)` に絞っているのは理由があります。第 4 回で見たとおり、この顧客管理には「業種」に選択肢外の値を持つレコードが 2 件あります。`VALIDATE LAPP_KOKYAKU INTO #err` と全フィールドを監査すると、その 2 件で毎週必ず止まり、CSV は一度も作られません（実測: 終了コード 1）。集計に使う列だけを監査すればゲートは通ります（実測: 終了コード 0）。業種の 2 件は、第 5 回の形で直すか、別の監査ジョブで扱います。

監査に違反があれば `ASSERT` で止まり、終了コード 1、CSV は更新されません。「更新されていない CSV」と「終了コード 1」の両方が、通知の根拠になります。

ここまでで、1 つの `.sql` を 1 回流す形の自動化はできます。**複数の文の途中で止まったときにどこから再開するか、実行履歴をどう残すか、月次の as-of 日付をどう固定するか**は、CLI の外側の話です。それを SQL の方言として持つのが第 8 回の kSQL Flow です。

無償版 [kSQL Dashboard プラグイン](https://qiita.com/rex0220/items/9cc28b6d52913a533360) は一覧画面を開くたびに実行する用途で、CLI の定期実行とは役割が違います。「毎朝見る」はダッシュボード、「毎朝ファイルを作る」は CLI、と分けます。折れ線や KPI カードのような表示が要る場合は有償の Pro 版があります。

次回は第 8 回「kSQL Flow へ載せる」です。`-- @ksql dialect: 1` のヘッダ、`ASSERT` / `EXIT` のゲート、as-of 日付、再実行の契約を扱います。

---

リポジトリ・ドキュメント:

- https://github.com/rex0220/kintone-sql-tools
- npm: `@rex0220/kintone-sql-tools`（CLI / プラグイン / MCP サーバー同梱）
