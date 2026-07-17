# kSQL 型付き順序・安全な `ORDER BY` / `KORDER BY` 実行仕様（R8案）

- ステータス: **R8承認済み / v3.0.0 公開済み（2026-07-17）**（R7のv3.0.0統合範囲・B32・WHERE/GREATEST移行影響に加え、R8でB14 `#err`の非数値末尾バンドを追加）
- 想定する改訂: 文字列横断仕様 R9 候補
- 関連課題: B26（型付き比較器）、B27（`ORDER BY` 実行計画）、B30（不完全top-N）、B31（`KORDER BY`）、B32（WHERE押し下げ能力）、B9（厳密10進比較）
- 実装計画: [v3.0.0 比較・ORDER BY 実装計画](ksql_v3_order_by_implementation_plan.md)
- 正となる既存文書: [文字列の扱い](ksql_string_semantics.md)

> 本書はレビュー済みのv3.0.0差分仕様である。文字列一般則は[文字列の扱い](ksql_string_semantics.md)を正とし、本書は`ORDER BY` / `KORDER BY`の実行契約を定める。

### R2で反映した初回レビュー

| 指摘 | R2の対応 |
|---|---|
| 全件local sortで500件超アプリの主要クエリが失敗 | R2では`$id` / `RECORD_NUMBER`を初期REST top-N allowlistへ残したが、`RECORD_NUMBER`はR3で撤回。その他の移行影響を§9の主要変更へ昇格 |
| `$id asc`をページングでは信用し、結果順では一律拒否する矛盾 | allowlist計画とlocal sort計画を分離（§4） |
| SQL順序が`localeCompare`、生の`<`、REORDERの3系統 | 全SQL比較経路を共有leafへ統合する決定を§5本文へ追加 |
| `onLimit: "truncate"`が部分top-Nを返す既存欠陥 | `ORDER BY`では`error`固定。独立課題B30を追加 |

非Blockingの型メタ移行リスク、ordinalの契約範囲、未知optionの位置、回帰例の期待順も反映した。

### R3で反映したR2レビュー

| 指摘 | R3の対応 |
|---|---|
| アプリコード付き`RECORD_NUMBER`は`APPCODE-10 < APPCODE-2`の文字列順へ落ちる | 初期allowlistから撤回。`$id`だけを残す |
| allowlistキーでもWHEREにローカル再評価が残ればREST top-Nは不完全な窓になる | キーだけでなくquery全体の完全同値を必須化。超集合プレフィルターとの併用を禁止 |

非BlockingのREORDER移行影響、未知optionの方向、互換漢字の回帰例、候補件数を事前確認できない点も反映した。

### R4で反映したR3レビューと追加提案

| 指摘・提案 | R4の対応 |
|---|---|
| `LEFT JOIN`非マッチ側の`$id` / `RECORD_NUMBER`は`""`になり、形式エラーにすると既存queryを壊す | 空値を最小側の独立値として規定し、形式エラーを非空値だけに限定。外部結合回帰を追加 |
| 比較器はアプリコードの有無を知らない | 宣言型が`RECORD_NUMBER`の場合の値形式ベース抽出へ書き換え |
| 異なるアプリコードの同一IDがpeerになる | ID一致時は元の非空表示値をコードポイント順で二次比較 |
| 見た目が同じ互換漢字fixtureは打ち直しで意味を失う | テストfixtureを`String.fromCodePoint` / Unicode escapeで構築すると明記 |
| kintone固有順を明示的に選ぶ手段がない | `KLIKE`と同様に意味論を名前で分離する`KORDER BY`を提案。条件外はlocal fallbackせずplanning error |

### R5で反映したR4レビュー

R4はBlockingなしで承認された。次の非Blockingと公式仕様の追加根拠をR5へ反映した。

| 指摘・発見 | R5の対応 |
|---|---|
| `$id`を`order by`でレコード番号の代わりに使える公式記述が存在する | §4.2へ根拠を追加。`RECORD_NUMBER`同値性は有力仮説とするが未測定・未証明を維持 |
| 公式offset上限と`fetchAll.ts`コメントが10000境界で不一致 | 生RESTで9999/10000/10001を測定。すべて200だったが、契約は公式範囲0..10000を維持し、コードコメントを修正対象化 |
| nested SELECTでの`KORDER BY`可否が不明 | 初期版はトップレベルSELECTだけと明記。temp/CTE/DML/subqueryでのtop-N選択は将来段階へ分離 |
| 代表的な利用不能queryが読みにくい | LIKE、KLIKE、JOIN、集約、WINDOW、nested、LIMITなし/501以上を一覧化 |
| 公式limitは0..500 | `LIMIT 0`を受理し、型・キー検証後にRESTを呼ばず空結果とする |
| ORDER BY省略時の生REST既定順はレコードID降順 | §8の既知差へ追加 |

### R6で反映したR5承認時指摘

| 指摘 | R6の対応 |
|---|---|
| `KORDER BY`の型能力判定がallowlistかdenylistか未確定 | 実測で受理済みの型だけを通すallowlistに確定。未知・未測定・将来追加型は拒否 |
| `LIMIT 0`でもruntimeの`GAIA_IS02` backstopが効かない | `LIMIT 0`と`LIMIT 1..500`を同じschema-aware plannerで検証し、allowlist外はREST短絡前にplanning error |
| 単発GETの受入条件が`LIMIT 0`にも読める | 単発GET条件を`LIMIT 1..500`へ限定し、`LIMIT 0`のno-REST条件と分離 |
| 214件アプリのoffset測定範囲が過大に読める | 測定が示したのはHTTP 400にならないことだけで、10,000件境界のデータ窓は未測定と明記 |

---

## 1. 背景

現在の `ORDER BY` は、クエリ形状や `LIMIT` によって最終的なソート主体が変わる。

- SIMPLE の単発 GET: kintone REST API の順序を最終結果として使用する
- FULL_SCAN / JOIN / 集約 / WINDOW / temp / CTE: kSQL のローカル比較器で並べる

この構造では、kintone の型別ソート規則をすべてローカルで再現しなければ、同じ SQL が実行経路によって異なる結果を返す。さらに、直接取得では REST 順、一時テーブルへ実体化した後はローカル順となり得る。

全フィールド型について REST とローカルの同値性を証明し続けることは、次の理由で高コストである。

- kintone の順序規則は型ごとに異なる
- 公式契約が見つかっている型と、実測に依存する型がある
- `CREATOR` / `MODIFIER` のように、レコード値だけでは REST のソートキーを再現できない型がある
- NUMBER は最大30桁で、現行の JavaScript `Number` では厳密比較できない
- 選択肢・STATUS はフォーム／プロセスメタデータを必要とする

そこで、**kSQL の型付き比較規則を意味の正**とし、生の kintone REST API／一覧画面との完全一致を別の互換性問題として切り離す。ただし、証明済みの REST 順まで捨てて常に全件取得するのではなく、正しさを証明できる型だけ top-N 押し下げを許す。

---

## 2. 用語

| 用語 | 本書での意味 |
|---|---|
| 生 REST 順 | kintone REST API の `query` に利用者の `order by` を渡した結果順 |
| ローカル評価 | `src/core` / `src/engine` の共有比較器を使う kSQL 側の評価。Node だけを意味せず、CLI / MCP / プラグインを含む |
| 利用者キー | SQL の `ORDER BY` に利用者が明示したキー |
| peer 比較 | `RANK` / `DENSE_RANK` が同順位かを判定する、利用者キーだけの比較 |
| canonical tie | 利用者キーがすべて同値の行を決定的に並べる、結果順専用の二次キー |
| 完全な候補集合 | WHERE 適用後、ORDER BY / OFFSET / LIMIT 適用前に必要な全行 |
| `KORDER BY` | kSQL canonical順ではなく、kintone REST APIの生の`order by`意味論を利用者が明示的に選ぶ節 |

仕様では「JS 順」という語を使わない。`localeCompare`、Node、ブラウザという別の意味と混同するため、**kSQL ローカル順**と呼ぶ。

---

## 3. 基本決定案

### 決定案 1: kSQL の順序の正は共有の型付き比較規則とする

物理アプリ、JOIN、集約、WINDOW、temp、CTE の別を問わず、利用者が指定した順序の意味は §5 の共有比較規則で決める。

kintone REST API の順序は、§4.2 の allowlist で共有比較規則との完全同値を証明した場合だけ、同じ結果を高速に得る実行手段として利用できる。REST が受理するだけでは allowlist に入れない。

### 決定案 2: 生 REST との完全一致を kSQL の保証にしない

kSQL は型付きの canonical 順を定義する。生 REST／kintone 一覧画面と異なる型があることは制限事項として明記する。

ただし、同じ kSQL が次の違いによって結果を変えることは許さない。

- CLI / MCP / プラグイン
- Node / ブラウザ
- 物理アプリの直接参照 / temp / CTE
- `LIMIT 500` / `LIMIT 501` / `LIMIT` なし
- SIMPLE 相当の形 / FULL_SCAN / JOIN / WINDOW

### 決定案 3: `localeCompare` と `Intl.Collator` を仕様・実装から除外する

ローカル評価へ統一することは、現行の `localeCompare("ja")` へ統一することではない。文字列比較は §5 のホスト非依存比較器へ置き換える。

### 決定案 4: 完全な候補集合を得られない場合は fail-closed とする

ローカルsort計画では、REST 側で先に `LIMIT` / `OFFSET` を適用した部分集合を並べ直して成功させてはならない。正しい上位 N 行に必要な行が取得済み集合の外にある可能性があるためである。

取得上限、検索打ち切り、タイムアウトその他の理由で完全な候補集合を確認できない場合、既存の完全性契約に従って明示的に失敗する。部分集合を top-N として返さない。

完全同値を証明済みのREST top-N計画は例外である。この計画では、サーバが返した窓自体がcanonical順の正しい窓であることをallowlistの根拠と受入試験で保証する。

### 決定案 5: local `ORDER BY` は不完全な入力と併用しない

local sort計画が取得上限へ到達した場合、`onLimit: "truncate"`を指定していてもfail-closedとする。警告付きで部分集合をsortして返すことを禁止する。証明済みREST top-Nと`KORDER_NATIVE`は、部分候補をlocal sortしないため対象外である。

これは本仕様の将来設計だけでなく、現行FULL_SCANでも誤った最小値・最大値を返せる既存欠陥であるため、**B30** として独立管理する（[課題文書](ksql_order_by_truncate_completeness_issue.md)）。

### 決定案 6: kintone固有順は `KORDER BY` で明示的に選ぶ

`ORDER BY`の意味を実行計画によって変えない。`ORDER BY`は常に§5のkSQL canonical順を意味する。

kintone REST APIの型別順序とtop-N性能を必要とする利用者には、別構文`KORDER BY`を提供する。これは最適化ヒントではなく、`LIKE`と`KLIKE`の関係と同様に、**意味論が異なる操作を名前で分離する言語機能**である。

`KORDER BY`を実行できないqueryを`ORDER BY`のlocal sortへ黙ってフォールバックしてはならない。生REST順を再現できないため、planning時に明示的に失敗する。

---

## 4. 実行契約

利用者が `ORDER BY` を指定した SELECT は、schema-aware planner が次のどちらかを選ぶ。

| 計画 | 適用条件 | 完全性の根拠 |
|---|---|---|
| REST top-N | 全キーが `supported + equivalent` allowlistにあり、**WHERE全体を同値に押し下げられてローカル再評価が残らず**、query全体の窓を同値に押し下げられる | 候補集合とサーバの順序・方向・空値・tie・LIMIT/OFFSETがcanonical契約と同値 |
| local sort | 上記以外で、全キーにローカル比較契約がある | 完全な候補集合を取得してからcanonical比較器でsort |

ローカルsort計画は、論理的に次の順で評価する。

1. スキーマと式の戻り型を解決する
2. 安全な WHERE 押し下げを適用して候補を取得する
3. 利用者の `ORDER BY` / `OFFSET` / `LIMIT` を適用せず、完全な候補集合を取得する
4. 型メタデータから各キーの比較規則を確定する
5. ローカルで利用者キーを比較する
6. peer を壊さない別レイヤーで canonical tie を適用する
7. `OFFSET` を適用する
8. `LIMIT` を適用する

### 4.1 REST へ送る取得順

物理アプリのページングには、内部取得順として `$id asc` を使用できる。この `$id asc` は利用者の `ORDER BY` を押し下げたものではなく、全候補を重複・欠落なく決定的に取得するための内部順である。

local sort計画では、利用者の `ORDER BY` を REST query から除く。

この仕様は `$id asc` を信用しないという意味ではない。現行の `fetchAll` は `$id > cursorId order by $id asc` による完全取得そのものを `$id` の一貫した数値順へ依存している。したがって `$id` は初期allowlistに含める。

### 4.2 top-N 押し下げallowlist

初期allowlistは次とする。

- `$id`

`$id`の主根拠は、現行`fetchAll`のカーソルページングが`$id > cursorId order by $id asc`を使い、完全候補取得そのものを一貫した数値順へ依存していることである。加えて、[公式クエリ記法](https://cybozu.dev/ja/kintone/docs/overview/query/)は、絞り込み条件と`order by`でレコード番号フィールドの代わりに`$id`を指定できると明記する。ASC / DESC、LIMIT / OFFSET、境界値を受入試験で固定する。

`ORDER BY $id [ASC|DESC] LIMIT N`は、§4.2.1のquery全体条件も満たす場合にREST top-Nを維持できる。これにより、500件を超えるアプリでも基本的な最新／最古N件取得を既定`maxRecords`で失敗させない。

#### 4.2.1 allowlistはキーだけで判定しない

REST top-Nを選べるのは、少なくとも次をすべて満たす場合に限る。

1. 単一の物理アプリに対するSELECTである
2. すべてのORDER BYキーがallowlistにある
3. WHERE全体をRESTへ**同値**に変換できる
4. REST取得後に再評価するWHEREノードが1つも残らない
5. JOIN、temp / CTE、集約、WINDOWその他、RESTが返した窓から行を除去・追加・統合する処理がない
6. ORDER BY、OFFSET、LIMITを含む最終窓全体がcanonical契約と同値である

`extractSafePushdownLeaves`やKLIKEプレフィルターが作る**安全な上位集合フィルター**は、全件取得後にローカル再評価する限り安全である。しかし、その上位集合へ先にLIMITを適用すると、窓の外にある真の該当行を失う。したがって残余WHEREがあるqueryでは、キーが`$id`だけでもREST top-Nを選ばない。

#### 4.2.2 `RECORD_NUMBER`は初期allowlistへ入れない

[公式フィールド形式](https://cybozu.dev/ja/kintone/docs/overview/field-types/)では、アプリコードなしの`RECORD_NUMBER`はレコードIDと同じだが、アプリコードありでは`APPCODE-1`のような文字列になる。

現行kSQLは`RECORD_NUMBER`を`sortKind="number"`と宣言する一方、`Number("APPCODE-1")`が`NaN`になると文字列比較へフォールバックする。したがって`APPCODE-10 < APPCODE-2`となり、数値レコードID順を再現しない。

kintone側のアプリコード付きORDER BYは未測定であり、両側の同値性は証明されていない。条件付きallowlistには通常SELECT経路で`apps.json`からアプリコードを取得する追加API・キャッシュ設計も必要になる。初期実装では追加せず、`RECORD_NUMBER`はlocal sortへ倒す。将来追加する場合は、アプリコードなし／ありを分けて設計・測定する。

公式が`order by`でレコード番号の代わりに`$id`を指定できるとするため、kintoneの`RECORD_NUMBER`も表示文字列ではなくunderlying record ID順であり、§5.2.1と一致する可能性は高い。これは測定優先度を上げる**仮説**であって、アプリコード付き値のraw REST同値性を証明するものではない。実測完了までallowlist外を維持する。

その他の型は、RESTが受理することだけを理由にallowlistへ入れない。公式契約またはraw REST実測で、値順、空値、ASC/DESC、複数キー、canonical tie、LIMIT/OFFSETの窓まで共有契約と同値であることを証明してから追加する。

allowlist機構を維持する決定と、残りの型を測定してallowlistを広げる作業は別である。未測定型をlocal sortへ倒せば正しさは成立するため、残り7型の測定完了を初回release gateにはしない。

### 4.3 `KORDER BY` の実行契約

構文は次とする。

```sql
SELECT 会社名, 金額
FROM APP4148
WHERE 顧客ランク = 'A'
KORDER BY 会社名 ASC, $id ASC
LIMIT 20
```

`KORDER BY`は、指定キー、方向、空値、型別rankをkintone REST APIの`order by`へ委ねる。§5のcanonical比較規則、canonical tie、REST top-N allowlistは適用しない。生RESTの同値群順は一般契約にしないため、決定的なtieが必要な利用者は例のように`$id`を最後のキーとして明示する。

本節の**KORDER native型allowlist**は「kintoneが`order by`を受理する型」を表し、§4.2の**canonical top-N allowlist**は「kSQLのcanonical結果とRESTの窓全体が同値と証明済みの型」を表す。基準が異なるため、B31の広いallowlistをB27へコピーしてはならない。

`ORDER BY`と`KORDER BY`は同じ節位置を占める相互排他的な構文とし、1つのSELECTに両方を書けない。`KORDER`は予約語になるため、同名フィールドはバッククォートで参照する。

初期実装では、次の条件をすべて満たす場合だけ受理する。

1. 単一の物理アプリを直接読む、利用者へ結果を返すトップレベルSELECTである
2. JOIN、サブテーブル展開、temp / CTE、UNION、DISTINCT、GROUP BY、HAVING、集約、WINDOWがない
3. すべてのキーが対象物理アプリの**非修飾フィールドコード**または`$id`を直接参照し、SELECT alias、`t.金額`のような表修飾、算術式、関数を含まない。初期版で表修飾を拒否するのは、kintone queryへ修飾子をそのまま送れず、安全な除去変換を別途設計する必要があるためである
4. すべてのキーの解決済み型が、次の**明示allowlist**に含まれる。未知・未測定・将来追加型を、既知の拒否型ではないという理由で許可してはならない
5. WHERE全体をkintoneへ同値に変換でき、REST取得後の再評価や上位集合プレフィルターが残らない
6. `LIMIT`を明示し、値が0以上500以下かつ実行時`maxRecords`以下である
7. `OFFSET`は省略または0以上10,000以下である
8. `LIMIT 1..500`ではquery全体を1回のレコード取得REST APIへ押し下げられる。`LIMIT 0`はキー・型・query形状を同じ規則で検証した後、RESTを呼ばず空結果を返す
9. `KLIKE` / `NOT KLIKE`を含まない。10万件検索打ち切りを全実行面でfail-closedに検知できないB7が解消された後に再検討する

初期allowlistは次とする。

- システム識別子: `$id`
- フィールド型: `RECORD_NUMBER`, `SINGLE_LINE_TEXT`, `NUMBER`, `CALC`, `DATE`, `DATETIME`, `TIME`, `CREATED_TIME`, `UPDATED_TIME`, `DROP_DOWN`, `RADIO_BUTTON`, `STATUS`, `LINK`, `CREATOR`, `MODIFIER`

LOOKUPはkSQLの型メタデータ上では独立型にせず、コピー元の解決済み基底型で判定する。NUMBER基底・SINGLE_LINE_TEXT基底・LINK基底はallowlistに含まれる。`RICH_TEXT`、`$revision`、未知型、型メタデータを解決できないキーは拒否する。既知の`GAIA_IS02`型を列挙してそれ以外を通すdenylist実装は禁止する。

`LIMIT 0`もこのallowlist、物理フィールド解決、WHERE完全押し下げ可能性、query形状の全検査を通す。検査後にだけno-RESTで空結果へ短絡するため、同じqueryの`LIMIT 0`が成功し`LIMIT 1`が型能力不足で失敗する差を作らない。

条件を満たさない場合は、理由を含むplanning errorとし、`ORDER BY`への書き換え、WHEREの単純化、または生REST APIの直接利用を案内する。APIが返した`GAIA_IS02`等のソート不受理もそのまま失敗として伝え、local sortへ切り替えない。

初期版の「トップレベル」は、`CREATE TEMP TABLE ... AS SELECT`、CTE本体、`INSERT` / `UPSERT ... SELECT`、`IN (SELECT ...)`、スカラーサブクエリ、UNION分岐内のSELECTを含まない。これらで「kintone順の上位N件を選んでから加工する」ことには正当な意味があるが、親queryが子の窓より前へ変換を押し込まないこと、実体化後の行順を保証しないこと、DML安全上限との関係を別途設計する必要がある。初期版ではplanning errorとし、B31の将来段階として扱う。

代表的に、次は初期版の`KORDER BY`を使用できない。

- `LIKE` / `NOT LIKE`を含み、JavaScript再評価が残るWHERE
- `KLIKE` / `NOT KLIKE`を含むWHERE
- JOIN、集約、DISTINCT、WINDOWを含むSELECT
- temp / CTEを参照するSELECT、またはtemp / CTE / DML / subquery / UNION内のnested SELECT
- `LIMIT`を省略したSELECT、`LIMIT 501`以上のSELECT
- SELECT alias、表修飾付きキー、関数、算術式を`KORDER BY`キーにしたSELECT

`KORDER BY`ではORDER BY / LIMIT / OFFSETを含むqueryを単発GETへそのまま送るため、完全な候補集合をローカルへ取得する必要はない。`LIMIT 0`だけは検証後に空結果へ短絡する。指定窓が`maxRecords`を超える場合に`onLimit: "truncate"`で縮めず、planning errorとする。

`EXPLAIN`は計画名を`KORDER_NATIVE`として、送信するkintone query、単発GETであること、kSQL canonical順ではないことを表示する。

[公式の複数レコード取得API](https://cybozu.dev/ja/kintone/docs/rest-api/records/get-records/)と[クエリ記法](https://cybozu.dev/ja/kintone/docs/overview/query/)は、limitを0から500、offsetを0から10,000と規定する。初期実装をこの範囲の単発GETへ限定することで、複数ページ取得中の順序保持や不安定なtieという別問題を持ち込まない。

2026-07-17にAPP4148へ認証付きGETを直接送り、`order by $id asc limit 1 offset 9999 / 10000 / 10001`を各1回測定したところ、3件ともHTTP 200、records 0件、totalCount 214だった。APP4148は214件なので、この測定が示すのは各offsetがHTTP 400で拒否されなかったことだけである。offset 10000が10,000件超のデータに対して正しい窓を返すかは未測定であり、本測定から主張しない。

10001以上を指定した状態でアプリをブラウザー表示すると警告メッセージが表示されることを確認した。したがって、HTTP 200は利用可能契約の根拠にならない。公式上限とブラウザー上の利用者影響の両方に基づき、**`OFFSET >= 10001`は常にplanning errorとして禁止する**。実行面、APIの一時的な寛容さ、対象レコード件数によって許可へ切り替えてはならない。

`src/api/fetchAll.ts`冒頭と`KINTONE_MAX_OFFSET`の「offset >= 10000はAPIエラー」というコメントは実測および公式記述と一致しないため、B31実装時に「10000到達前後で保守的にカーソルへ切り替える内部閾値」へ訂正する。ページング動作自体を本仕様で変更する必要はない。

### 4.4 WHERE 押し下げとの境界

本書は WHERE 押し下げの安全性契約を変更しない。候補集合を狭める WHERE 押し下げは、ローカル WHERE と同値、またはローカルで再評価する安全な上位集合フィルターでなければならない。

ただし、**全件取得に対して安全な上位集合フィルターであることは、REST top-Nと組み合わせても安全であることを意味しない。** WHEREにローカル再評価が残る場合は、REST側へORDER BY / OFFSET / LIMITを押し下げず、上位集合の全候補を取得してからWHERE再評価とlocal sortを行う。

`KLIKE` のように kintone の検索自体を言語契約とする操作は別契約とする。ただし、検索打ち切りで候補集合が不完全な場合に ORDER BY の部分結果を成功として返してよいことにはならない。

---

## 5. canonical 比較規則

本節の比較規則は `ORDER BY` 専用ではない。SQLが同じ型の大小を問う次の全経路で、同じ共有leaf比較器を使用する。

- `ORDER BY` / WINDOW内の`ORDER BY`
- `MIN` / `MAX`
- `WHERE` / `HAVING` / `CASE WHEN` / `ASSERT` の `<` / `>` / `<=` / `>=`
- `GREATEST` / `LEAST` の文字列モードと文字列tie-break
- `REORDER ... BY`
- option rank一致時の二次比較

現行コードには少なくとも3種類の順序が併存する。

- `compareSortKeys`: `localeCompare("ja")`
- `MIN` / `MAX`、範囲比較、`GREATEST` / `LEAST`: JavaScriptの生の`<` / `>`（UTF-16コードユニット順）
- `REORDER`: `localeCompare("ja")`

B26ではこれらを§5.1の共有文字列比較器へ統合する。ORDER BYだけを変更し、`MAX()`や範囲比較と異なる最大値を返す状態を残さない。

保存クエリ名の一覧表示や、プラグイン結果表の列ヘッダークリックによるUI上の並べ替えはSQLの順序契約の対象外とする。UIソートがSQLの`ORDER BY`結果を再現するとは保証しない。利用者向け文書では、このUI操作をSQL再実行と混同しないよう明記する。

### 5.1 文字列

文字列を ECMAScript の文字列イテレーターで列挙し、得られるコードポイント値を先頭から数値比較する辞書式順序とする。

1. 最初に異なるコードポイントの数値が小さい列を先とする
2. すべての比較済みコードポイントが同じで一方だけが終了した場合、短い列を先とする
3. 正規化、大小文字変換、ロケール照合を行わない
4. `localeCompare`、`Intl.Collator`、JavaScript の UTF-16 コードユニット順の `<` を使用しない
5. 比較器は必ず `-1` / `0` / `1` のいずれかを返す
6. コードポイント列が同一の場合だけ `0` を返す

孤立サロゲートを入力として許す場合、ECMAScript イテレーターが返す単独サロゲート値を数値のまま比較する。暗黙に置換・削除しない。

### 5.2 数値

typed number は数値順とする。ただし、最大30桁の厳密比較は B9 の責務である。

B9 完了前に JavaScript `Number` で区別できない値を正しく並べたとは表現しない。B9 未実装で出荷する場合は、精度制限を独立した既知制限として残す。

値が数値らしく見えることを理由に typed string を数値比較しない。型不明の既定も文字列とする。

ただし、`GREATEST` / `LEAST`はv2.17.0で確定した**関数固有の集合モード契約**を維持する。空文字を先に処理し、空文字以外の全引数が数値化可能なら集合全体を数値モード、それ以外を文字列モードとして一度だけ確定する。B26はこのモード判定を廃止せず、文字列モードと数値同値時のtie-breakを§5.1のコードポイント比較へ置き換える。

したがって`GREATEST('20','100')`はv2.17.0と同じ`'100'`であり、typed stringの一般則から`'20'`へ変えない。この関数は物理列の宣言型ではなく引数集合についてモードを決める既存契約を持つためである。共有leafはcallerが一度確定した`number` / `string` modeを受け取り、ペアごとに再判定しない。これによりB19で排除した`2 < 10 < 1a < 2`の循環を再導入しない。MySQL互換へ変更することより、直前に公開したB19契約と引数順非依存性を優先する。

#### 5.2.1 `$id` と `RECORD_NUMBER`

`$id`は符号なし10進のレコードIDとして数値順に比較する。ただし、外部結合の非マッチ側などで生じる空値`""`または不在値は、非空のレコードIDより小さい独立値とする。ASCでは既知IDの前、DESCでは利用者キーの反転に従って既知IDの後に置く。

`RECORD_NUMBER`は表示文字列全体を`Number()`へ渡さない。比較器はアプリ設定やアプリコードを取得せず、宣言型が`RECORD_NUMBER`である場合に限って、非空の値形式から次の規則でunderlying record IDを得る。

- 値全体が10進数字列なら、その全体をIDとする
- それ以外は、最後の`-`より後ろが10進数字列なら、その接尾辞をIDとする（例: `APPCODE-10` → `10`）
- 抽出した数字列は先頭ゼロを正規化し、binary64へ変換せず桁数と辞書式比較で厳密な非負整数順にする
- 抽出IDが同じ非空値どうしは、元の表示値全体を§5.1のコードポイント順で二次比較する。これにより`AAA-2`と`BBB-2`をpeerにしない
- 空値`""`または不在値は非空値より小さい独立値とし、ASCでは非空値の前、DESCでは利用者キーの反転に従って非空値の後に置く
- 非空のtyped `RECORD_NUMBER`が上記形式に一致しない場合だけ、文字列比較へフォールバックせず明示的に失敗する

これは値から型を推測する規則ではない。型メタデータが`RECORD_NUMBER`と確定した列へ、その型固有の保存・表示形式を解釈する規則である。typed stringや型不明の`"APPCODE-10"`へ適用してはならない。

この専用規則はkSQLローカル契約を決めるものであり、raw RESTとの同値性を証明しない。アプリコード付きREST順の測定が完了するまで`RECORD_NUMBER`をtop-N allowlistへ入れない。

### 5.3 選択肢と STATUS

- DROP_DOWN / RADIO_BUTTON: option index の数値 rank
- STATUS: 有効なプロセス設定の `states.*.index` を数値化した rank
- rank が同じ場合: 元の値表現を §5.1 の文字列順で比較
- 未知・削除済み値: rankを正の無限大とし、ASCでは既知値の後ろ、DESCでは利用者キーの反転により既知値の前に置く
- 未知・削除済み値どうし: 元の値表現を §5.1 で比較する

`states.*.index` は文字列で返るため、辞書順のまま使用せず整数へ変換する。`enable: false` と `states: null` を同一視しない。

### 5.4 日付・時刻

kSQL が保持する正規化済み保存表現についてコードポイント順を適用する。保存表現と時系列順が一致しない型や、表示値しか得られない型を推測で対応済みにしない。

### 5.5 複合型

canonical key を定義していない配列・オブジェクト型の `ORDER BY` は planning 時に明示的エラーとする。`String(value)` や JSON 文字列化による暗黙順序を作らない。

---

## 6. temp / CTE / UNION の契約

### 6.1 型メタデータを値と一緒に実体化する

物理列を temp / CTE へ素通しした場合、少なくとも次を伝播する。

- string / number / date-time / option / complex の意味型
- `sortKind`
- 元のフィールド型
- option / STATUS の rank 情報を解決するために必要な来歴
- 式由来列の戻り型

同じ意味型・同じ値・同じ明示的 `ORDER BY` は、物理アプリを直接参照しても temp / CTE を経由しても同じ順序を返す。

型メタデータが失われたために並びが変わる場合、それを恒久的な制限として正当化せず B26 の不具合として扱う。

### 6.2 型の統合

- 同型の UNION: 型を維持する
- 異なる型の UNION / CASE: 既存の型統合規則に従う
- 安全に統合できない型: 型不明＝文字列、または複合型なら明示的エラー
- 実データを走査して「全値が数値らしい」などのモード判定をしない

### 6.3 `ORDER BY` がない場合

temp / CTE を含め、`ORDER BY` を明示しない SELECT の結果順は保証しない。入力時の並びを保存することと、SQL の順序契約を持つことを混同しない。

後述の非公開ordinalは、外部へ「何番の行が先か」という順序を保証するものではない。**同一の実体化結果へ同じ明示的ORDER BYを適用したとき、同値行を再現可能に並べるための内部識別子**に限る。別実行間でordinal値そのものが一致することは契約にしない。

---

## 7. peer と canonical tie の分離

値比較器へ `$id` や実体化順を混ぜない。同じ比較器を `RANK` / `DENSE_RANK` の peer 判定に使うためである。

- peer 比較: 利用者キーだけを比較する
- トップレベル結果順: peer 比較が `0` の場合だけ canonical tie を適用する

canonical tie の候補は次とする。

| 行の由来 | canonical tie |
|---|---|
| 物理レコードを一意に追跡できる | `$id asc` |
| temp / CTE の派生行で物理IDがない | 同一実体化内で付与する非公開 ordinal の昇順 |

ASC / DESC は利用者キーへだけ適用し、canonical tie の向きは変えない。これにより非同値グループだけが反転し、同値グループ内の順序は不変になる。

非公開ordinalの目的は同一実体化内の決定性であり、`ORDER BY`なしの外部順序を規定することではない。UNION、JOIN、GROUP BY、WINDOWを経由した行へ、どの段階でordinalを付け直すかは追加設計が必要である。ここは次回レビューの重点未決事項とする。

---

## 8. kintone REST API／一覧画面との差

### 制限案: kSQL の `ORDER BY` は生 REST／一覧画面との完全一致を保証しない

- 影響する面: kintone REST API / kintone 一覧画面 / CLI / MCP / プラグイン
- なぜ揃えないか: kintone の型別順序には、未公開の規則、追加メタデータを要する規則、現行のレコード値だけでは再現できない規則があるため
- 利用者から見た現れ方: 同じデータでも、生 REST または一覧画面と kSQL の `ORDER BY` 結果が異なる場合がある
- kSQL 内部の保証: 同じ型・同じ値・同じ SQL は、実行面・実行モード・temp / CTE の有無によらず同じ kSQL 順を返す
- 検知できるか: 両者とも各契約上は正しいため、一般には自動検知できない
- 回避策: 初期契約の範囲内なら`KORDER BY`でkintone固有順を明示的に選ぶ。範囲外なら生 REST API を直接使う。kSQL canonical順では必要な二次キーまで`ORDER BY`に明示する

既知例:

- ORDER BY省略時: 生RESTは公式にレコードID降順を既定とする一方、kSQLの内部完全取得は`order by $id asc`を注入する。どちらもORDER BY省略時の利用者向け結果順を保証しないため不具合ではない
- `CREATOR` / `MODIFIER`: kintone はユーザーID順、現行 kSQL 契約は code 順
- typed number: B9 完了までは大精度値で REST と一致しない可能性がある
- kintone が `ORDER BY` を拒否する型でも、kSQL が canonical key を定義済みならローカルで並べられる

---

## 9. 主要な互換性変更・移行

### 9.1 500件を超える候補の `ORDER BY` は既定設定で失敗し得る

MCPの既定`maxRecords`は500である。allowlist外の型をローカルsortする場合、`ORDER BY ... LIMIT 10`でも完全な候補集合が500件を超えれば`FetchAllLimitError`になる。これは副次的な性能差ではなく、現行SIMPLEで成功する主要クエリが失敗へ変わる互換性変更である。

Claudeレビュー時の実測では、APP4148に対する次の差を確認した。

- `ORDER BY 会社名 ASC LIMIT 10`, `maxRecords=100`: 現行SIMPLEは10行成功
- 同じ候補をFULL_SCANへ落とす: 候補が100件を超えて`FetchAllLimitError`

`$id`は初期allowlistへ残すため、WHERE全体も同値押し下げ可能な`ORDER BY $id DESC LIMIT 10`まで全件取得へ退化させない。`RECORD_NUMBER`を含むその他の型ではこの変更を受容する。

移行時は次を行う。

1. `EXPLAIN`でREST top-Nかlocal sortかを表示する
2. local sort計画では、候補件数を安価に事前確認できるとは表現しない。現行`EXPLAIN`は件数を推定せず、別の`COUNT(*)`も全候補取得を要する
3. まずWHEREを十分に狭める。実行が`FetchAllLimitError`になった場合、必要性と資源上限を確認して`maxRecords`を引き上げる
4. `maxRecords`を上げるとAPI回数、メモリ、タイムアウトも増えるため、候補件数を知らないまま無制限に引き上げない
5. 引き上げられない場合はWHEREをさらに狭めるか、query全体が証明済みREST top-N条件を満たす形を使用する

kintone固有順でよく、§4.3の単発GET条件を満たす場合は、`KORDER BY ... LIMIT N`を明示的に選べる。ただし、これは同じ`ORDER BY`の高速版ではなく、結果順の意味をkintoneへ切り替える移行である。

### 9.2 `onLimit: "truncate"` の挙動変更

local sort計画では、取得上限到達時に`truncate`を指定していてもfail-closedとする。部分集合をsortして得た誤った最小／最大候補を、単なる件数省略の警告付きで返さない。証明済みREST top-Nと`KORDER_NATIVE`は対象外とする。詳細はB30で扱う。

### 9.3 型メタデータ欠落による移行リスク

現行比較器は型メタが無くても、比較する両値が数値に見えれば数値比較する。値ベース自動判定を廃止した後、型メタが伝播しない列は文字列順へ変わる。`REORDER ... BY`の`compareByOrder`も独立に`Number()`で値ベース判定しているため、共有型付き比較器への移行対象である。

例: `2, 10, 100, 214` は、numberメタを保持すればこの数値順、メタを失って型不明になると `10, 100, 2, 214` の文字列順になる。

これは意図した型変更ではない。素通し列、alias、`*`、UNION、CASE、集約、算術、文字列関数、WINDOWについて型メタ伝播試験をrelease gateとし、メタ欠落を既知のまま静かに出荷しない。

REORDERについても、数値らしい文字列が従来の数値順からtyped stringのコードポイント順へ変わる。REORDERの入力列へ型メタを渡せるかを確認し、型不明なら文字列という契約と移行例を公開リファレンスへ記載する。

### 9.4 型メタが正しいtyped stringでも結果集合が変わる

§9.3は型メタデータ欠落による意図しない変化を扱う。それとは別に、型メタデータが正しく`string`と確定した列も、B26が値ベース数値判定を廃止するため意図的に変わる。

#### WHERE / HAVING / CASE / ASSERTの範囲比較

数字だけを格納した`SINGLE_LINE_TEXT`でもコードポイント順になる。

```text
WHERE x > '100'

x='20'  : 現行FULL_SCAN false → v3.0.0 true
x='30'  : 現行FULL_SCAN false → v3.0.0 true
x='99'  : 現行FULL_SCAN false → v3.0.0 true
x='9'   : 現行FULL_SCAN false → v3.0.0 true
```

これは表示順だけでなく返却行、集計値、HAVING、CASE、ASSERT、ローカルWHEREを消費する処理結果を変える。公開移行ガイドでは「数値らしいテキストのORDER BYが変わる」だけでなく、範囲条件の行集合が変わることを独立したmajor変更として記載する。

現行SIMPLEは文字列型の`>`を不正にRESTへ押し下げ、`GAIA_IQ03`で失敗する。旧数値判定で成功していたのはFULL_SCAN経路である。v3.0.0ではB32によりSELECTをFULL_SCAN残余WHEREへ正しくroutingしたうえで、B26のコードポイント契約を適用する。「従来の全SELECTが数値比較で成功していた」とは説明しない。

#### `GREATEST` / `LEAST`

v2.17.0の集合モードは維持するため、全引数が数値化可能な`GREATEST('20','100')`は`'100'`のままである。B26による変更は文字列モード内部と数値同値時のtie-breakをコードポイント比較へ統一する部分に限る。typed stringの一般則を理由に集合モード自体を廃止しない。

### 9.5 その他のコスト

- REST top-Nを利用する現行SIMPLEよりAPI呼出しが増える
- tempの上限、タイムアウト、メモリ使用量の影響を受ける
- プラグイン固有の検索打ち切り検知不能（B7）は本書だけでは解消しない
- `KORDER`が予約語になるため、既存の同名フィールド参照はバッククォートが必要になる

以上は利用者互換性に影響するため、B26/B27のリリースはSemVer majorとする。B30だけのv2.18.0先行リリースは行わず、現在判明している比較・routing・完全性の問題をv3.0.0でまとめて解消する。

将来のallowlist拡張は、canonical結果を変えないことを証明したうえで導入する。

---

## 10. B26 / B27 / B9 の境界案

| 課題 | 責務 |
|---|---|
| B26 | ホスト非依存の型付き比較器、コードポイント比較、`RECORD_NUMBER`の末尾ID比較、型メタ伝播、option / STATUS rank、peer比較。ORDER BYだけでなくMIN/MAX、範囲比較、GREATEST/LEAST、REORDERへ共有leafを適用 |
| B27 | schema-awareなREST top-N allowlist、allowlist外の完全候補取得、ローカル sort 後の OFFSET / LIMIT、canonical tie |
| B9 | 最大30桁を含む typed number の厳密10進比較 |
| B30 | local `ORDER BY`で不完全な候補集合の部分top-Nを禁止。証明済みREST top-Nと`KORDER_NATIVE`は対象外 |
| B31 | `KORDER BY`構文、schema-awareなnative実行可否判定、`LIMIT 1..500`の単発GET／`LIMIT 0`短絡、nested SELECT初期拒否、planning error、EXPLAIN / 公開リファレンス |
| B32 | WHEREの型×演算子REST能力allowlist、通常SELECTのSIMPLE/FULL_SCAN routing、B27/B31のWHERE完全押し下げ判定。DMLは暗黙local化せず事前エラー |

### 10.1 リリース範囲

- **v3.0.0**: B26 / B27 / B30 / B31 / B32
- **v3.1.0候補**: B9
- B21〜B24、B28、B29、B20はv3.0.0へ含めない

B30は最初の実装コミットとして早期に修正・回帰試験するが、公開リリースはv3.0.0へ統合する。複数の既知問題を抱えた状態でB30だけのv2.18.0を挟まず、比較意味論、routing、native escape hatch、完全性を1つのmajor移行として説明する。

これは見落としではなくリリース判断である。Phaseを独立コミットにする目的は、before-fail/after-passの証明、レビュー容易性、問題発生時の切り分けであり、各コミットを個別リリースすることではない。B30の誤答を単独で早く止める利点は認めるが、現時点で複数の比較・routing欠陥を同時に抱えているため、v2.18.0を追加せずv3.0.0の一回にまとめる。

#### typed number内の正当な域外値

算術・集約算術は正規の出力値として`"NaN"`を生成し、その列はtemp/CTEへ数値メタ付きで伝播し得る。さらにB14の`#err`は、DML対象アプリのNUMBER型メタを保持したまま検証失敗入力`"x"`等を意図的に保存する。これらは型破損ではなく設計どおりの域外値である。

canonical数値順は`空セル < -Infinity < 有限数 < +Infinity < "NaN" sentinel < その他の非数値`とし、最後のバンド内は§5.1のコードポイント順にする。同じ域外値どうしはpeerである。typed stringの`"NaN"`や`"x"`は通常のコードポイント文字列であり、このバンド規則を適用しない。禁止するのはペア単位の値ベースモード切替であって、固定バンドではない。

この変更により、B14リリース時の受入証拠`MIN(数値T1)=NaN`はv3の結果契約ではなくなる。NUMBER宣言列に数値と非数値が混在する場合、MINは最小数値、MAXは末尾バンドの最大値を返す。数値が無い場合は、存在する最初／最後のバンド値を返す。garbage 1件で集約全体を`NaN`へ汚染する現行挙動から、ORDER BYと同じ大小関係へ変わることを移行ガイドへ記載する。

B9をB26より先に実装しない。現状は数値比較が`compareSortKeys`、MIN/MAX、`compareScalarValues`、`selectScalarExtreme`、REORDER等へ分散している。B26でcallerの意味型／集合モード判定と共有leafを先に集約すれば、B9はその共有数値primitiveを厳密10進へ置き換え、各consumerの回帰試験へ集中できる。これはB9を除外する消極的理由だけでなく、**B26→B9の順序を選ぶ積極的理由**である。

R8.2で残っている型別REST実測は、B27の正しさを成立させるrelease gateから外す。これは**allowlist機構を廃止する決定ではない**。未測定型をallowlistへ入れずlocal sortへ倒すことで正しさを成立させ、測定は将来allowlistを拡張する性能・互換性調査として残す。

ただし、STATUS rank、temp 型メタ、canonical tie など、**ローカル評価同士を一致させるための実装項目**は release gate のままとする。

---

## 11. 受入条件案

### 11.1 比較器の性質

- 文字列比較器が `-1 / 0 / 1` 以外を返さない
- 反対称性、推移性、全域性を性質テストする
- BMP / 補助平面 / 共通接頭辞 / NFC・NFD / IVS / 結合文字列を含む
- 孤立サロゲートの契約をテストする
- Node と対象ブラウザで同じ結果になる
- option rank 一致時も共有コードポイント比較器を使う
- ORDER BY / MIN / MAX / 範囲比較 / GREATEST / LEAST / REORDERが、同じtyped string集合について同じ大小関係を返す
- `'😀'`（U+1F600）と`'切'`（U+FA00）のようにコードポイント順とUTF-16コードユニット順が逆になる組を含める

### 11.2 実行経路

同じデータと SQL について次を比較する。

- 物理アプリ直接 / temp / CTE
- LIMIT 500 / 501 / なし
- CLI / MCP / プラグイン
- 単一キー / 複数キー
- ASC / DESC
- 同値群あり / なし
- WINDOW の `RANK` / `DENSE_RANK` / `ROW_NUMBER`
- REST top-N allowlist (`$id`) / local sort計画
- LEFT JOIN非マッチ側の`$id` / `RECORD_NUMBER`が空値になる場合

非同値グループは ASC / DESC で反転し、同値グループの canonical tie は不変であることを確認する。`RANK` / `DENSE_RANK` の peer が canonical tie によって分割されないことを確認する。

### 11.3 完全性

- local sort計画ではREST queryに利用者のORDER BY / OFFSET / LIMITが残らない
- REST top-N計画ではallowlist外のキーを1つでも含めたらlocal sortへ落ちる
- ORDER BYキーがallowlist内でも、WHEREにローカル再評価が1つでも残ればREST top-Nを選ばない
- KLIKEプレフィルター、`extractSafePushdownLeaves`の安全ANDリーフ、`$id`プレフィルターなど、上位集合だけをRESTへ送るqueryではORDER BY / OFFSET / LIMITを押し下げない
- local sort前に完全な候補集合を取得する
- 取得上限超過、検索打ち切り、タイムアウトで部分 top-N を返さない
- local sort計画では`onLimit: "truncate"`でも取得上限到達時にfail-closedとなる。REST top-Nと`KORDER_NATIVE`では不要な上書きを行わない
- sort 後に OFFSET、最後に LIMIT を適用する

### 11.4 回帰例

- typed string ASC: `"1", "10", "2", "9"`
- BMP / 補助平面 ASC: `"亜", "ｱ", "😀", "𠮟"`
- 共通接頭辞 ASC: `"ab", "abc"`
- 正規化なし ASC: `"が"`（U+304B U+3099・NFD）, `"か゛"`（U+304B U+309B・スペーシング濁点）, `"が"`（U+304C・NFC）
- IVS ASC: `"葛"`, `"葛󠄀"`（共通接頭辞なので短い列が先）
- UTF-16反例 ASC: `"切"`（U+FA00）, `"😀"`（U+1F600）
- 互換漢字 ASC: `"葛"`（U+845B）, `"艹"`（U+FA5D）。字形の類似や正規化を使わずコードポイント値で決める
- typed number: `-1, 0, 2, 10`（大精度は B9）
- typed number拡張値: `空セル, -Infinity, 有限数, +Infinity, "NaN", "1a", "x"`の固定バンド順。その他非数値バンド内はコードポイント順、同一値はpeer
- `#err`のNUMBER宣言列に数値・`"NaN"`・複数の非数値を混在させ、ORDER BY / MIN / MAX / 範囲比較が同じバンド関係を使う
- `$id` / `RECORD_NUMBER`の空値: LEFT JOIN非マッチ行の`""`がASCでは非空値より前、DESCでは後。非空の不正形式だけがerror
- アプリコード付きRECORD_NUMBER: local契約は `APPCODE-2`, `APPCODE-10`（末尾IDの数値順）。`AAA-2`と`BBB-2`は表示値の二次比較でpeerにしない。raw REST順を独立に測り、測定完了までallowlistへ入れない
- option: 定義順とコードポイント順が逆になる値
- 未知option: 既知optionの後、未知値どうしは§5.1順
- STATUS: 2桁 index を含む、または合成 fixture で `"10" < "2"` 誤実装を検出
- 同値群 + LIMIT / OFFSET
- typed string の範囲比較: FULL_SCAN で `WHERE x > '100'` が `20` / `30` / `99` / `9` を含み、ORDER BY と同じコードポイント関係になる
- `GREATEST('20','100') = '100'`（集合数値モードを維持）と、補助平面を含む文字列モードがコードポイント順になることを別々に固定する

外部結合の非マッチ側を明示的に含める。

```sql
SELECT a.顧客No, b.$id, b.担当者No_
FROM APP4148 a
LEFT JOIN APP4150 b ON a.顧客No = b.顧客No_
ORDER BY b.$id ASC, b.担当者No_ ASC
```

非マッチ行の`b.$id` / `b.担当者No_`が`""`でもerrorにせず、ASCでは非空値より前に並ぶ。DESCでは各利用者キーの反転に従って非空値より後に並ぶ。非空の不正形式を注入した合成fixtureだけがerrorになる。

REST top-N禁止の回帰例:

```sql
SELECT 会社名
FROM APP4148
WHERE 会社名 KLIKE '株式会社' AND 郵便番号 LIKE '1%'
ORDER BY $id ASC
LIMIT 5
```

`会社名 KLIKE '株式会社'`だけが上位集合プレフィルターとしてRESTへ送られても、`郵便番号 LIKE '1%'`のローカル再評価が残るためREST top-Nを選ばない。上位集合の先頭5件から行を落として終わらず、上位集合を完全取得してWHERE全体を再評価した後にlocal sort / LIMITする。

### 11.5 `KORDER BY`

- 単一物理アプリ、直接フィールド、完全押し下げWHERE、`LIMIT 0..500`、`OFFSET 0..10000`だけが`KORDER_NATIVE`になる
- `LIMIT 0`はキー・解決済み型のallowlist・WHERE・query形状を`LIMIT 1..500`と同じplannerで検証し、検証後にRESTを呼ばず0行を返す
- `LIMIT 1..500`では、指定したORDER BY / LIMIT / OFFSETが1回のREST queryへそのまま載る
- `$id`と受理済み15型だけを許可し、`RICH_TEXT`、`$revision`、未知・未測定・将来追加型をplanning時に拒否する。LOOKUPは解決済み基底型で判定する
- REST順と§5のcanonical順が異なるfixtureで、`ORDER BY`と`KORDER BY`が意図的に異なる結果を返す
- JOIN / temp / CTE / UNION / DISTINCT / GROUP / WINDOW / SELECT alias / 表修飾付きキー / 式キー / 残余WHERE / LIKE / KLIKE / LIMITなし / LIMIT 501以上をplanning時に拒否する
- `CREATE TEMP TABLE ... AS SELECT`、CTE、SELECT-based DML、IN/scalar subquery、UNION分岐内のnested `KORDER BY`を初期版では拒否する
- `KORDER BY`を実行不能なとき、`ORDER BY`へ黙ってフォールバックしない
- 同値群の決定性が必要な例では、利用者が`$id`を最後のキーに明示し、その方向が独立に効く
- `LIMIT > maxRecords`で`truncate`せずplanning errorになる
- offset 9999 / 10000を受理し、10001以上をplanning errorにする。生RESTが10001をHTTP 200で受理しても、ブラウザーでは警告が表示されるため契約を拡張しない
- EXPLAIN、保存クエリ、CLI、MCP、プラグインで同じ受理・拒否判定になる

### 11.6 WHERE の型×演算子能力（B32）

- `SINGLE_LINE_TEXT > '100'`をRESTへ押し下げず、通常SELECTはFULL_SCANの残余WHEREとして評価する
- `NUMBER > 100`など、公式allowlist上で受理される型×演算子は既存の安全条件を満たす場合に押し下げられる
- 未知型・型メタ欠落・未登録演算子は押し下げ不可とし、楽観的にSIMPLEへしない
- `EXPLAIN`と実行が同じ能力判定を使い、「EXPLAIN ok・実行時GAIA_IQ03」を残さない
- DMLはSELECTと同じ理由で暗黙FULL_SCANへ拡張せず、実行前に明示エラーにする
- B27のREST top-NおよびB31の`KORDER BY`は、WHERE全体の各述語が同じ能力表で完全押し下げ可能な場合だけ成立する

互換漢字のfixtureは見た目の文字をコピーせず、`String.fromCodePoint(0xFA00)` / `"\uFA00"`、`String.fromCodePoint(0xFA5D)` / `"\uFA5D"`で構築する。U+FA00は統合漢字U+5207と見た目では区別できず、打ち直すと反例でなくなるためである。

---

## 12. 非目標

- 日本語として自然な辞書順を提供すること
- 生 REST／kintone 一覧の全型の順序を再現すること
- `ORDER BY` のない結果に順序を保証すること
- canonical key 未定義の複合型を暗黙に文字列化して並べること
- 不完全な候補集合から推測した top-N を返すこと

上記の「生REST順を再現しない」は通常の`ORDER BY`に対する非目標である。明示的な`KORDER BY`は§4.3の狭い範囲で生RESTへ実行を委譲するが、JOINやtemp上に生REST順を再構成する機能ではない。

---

## 13. 実装前確認事項

次の主張を信用せず、コードと反例で確認してほしい。

1. **REST top-N allowlist計画とlocal sort計画の間に、部分集合をlocal sortする第三の経路がまだ残らないか**
2. **初期allowlistを`$id`だけに狭めた根拠は十分か**。ASC/DESC、LIMIT/OFFSET、境界値を確認すること
3. **WHERE全体の同値押し下げと「ローカル再評価なし」をplannerで判定できるか**。KLIKE、safe AND leaves、`$id`プレフィルター、変数束縛後の再計画を横断すること
4. **local sort計画でRESTのORDER BY / LIMIT / OFFSETが別経路に残らないか**。単発GET、ページング、JOIN前処理、サブクエリを横断すること
5. **temp / CTE の型メタ伝播は十分か**。素通し列だけでなく、alias、`*`、UNION、CASE、集約、算術、文字列関数、WINDOWを確認すること
6. **canonical tieの非公開ordinalは、同一実体化内の決定性という狭い契約で十分か**。JOIN / UNION / GROUP BY / WINDOWでpeer判定と両立できるか
7. **B30の`truncate`→`error`固定に漏れがないか**。単文、batch、保存クエリ、temp/CTE/WITH/UNION、CLI/MCP/プラグインを横断すること
8. **プラグインの検索打ち切り検知不能とfail-closed契約が矛盾しないか**
9. **ORDER BY / MIN/MAX / 範囲比較 / GREATEST/LEAST / REORDERを共有leafへ統合できるか**。REORDERの値ベース数値判定廃止と、SQL外UI列ソートの境界は明瞭か
10. **allowlist外の500件超回帰と型メタ欠落リスクをmajor移行事項として十分に説明しているか**
11. **B27の残り7型実測をrelease gateから外しつつallowlist機構を維持する分離が妥当か**
12. **この案が既存の保存クエリ、EXPLAIN、MCP schema、CLIヘルプ、公開リファレンスへ与える差を洗い出すこと**
13. **R4で承認された`KORDER BY`の別意味論が、R5の境界変更後も維持されているか**。高速化ヒントや暗黙fallbackへ戻っていないか
14. **§4.3の初期制限で生RESTの正しい単発窓を保証できるか**。残余WHERE、KLIKE検索打ち切り、LIMIT/maxRecords、offset上限、APIソート不受理を反例で確認すること
15. **R4で承認された同値群契約が維持されているか**。`$id`明示を利用者へ委ね、暗黙tieを推測で契約化していないか
16. **公式上限を契約、APP4148での9999/10000/10001直接GETを観測として分離できているか**。10001の受理を一般化していないか
17. **nested `KORDER BY`を初期拒否し、将来段階へ分ける判断は妥当か**。トップレベル制限がparser/planner/EXPLAIN/保存queryで一貫してfail-closedになるか
18. **`LIMIT 0`を完全検証後のno-REST短絡とする契約に穴がないか**。不正キーや非対応型まで空結果として黙認しないか
19. **B32の型×演算子allowlistをB27/B31と共有できるか**。EXPLAINと実行、SELECTとDML、未知型、AND/OR/NOT、変数束縛後の再計画でfail-closedになるか
20. **typed stringの範囲比較変更をORDER BYだけの変更として過少告知していないか**。件数・集約・サブクエリ・DML候補への波及と、現行SIMPLEがGAIA_IQ03で失敗する事実を分離して説明すること
21. **GREATEST/LEASTの集合モードを誤って廃止していないか**。`GREATEST('20','100')`を固定し、文字列モード／数値tieのleafだけをコードポイント比較へ変えること

実装レビューでは、各項目についてコード行・テスト・必要な実測を根拠にし、未確認項目を成功扱いにしない。
