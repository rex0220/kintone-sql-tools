# 論理アプリ参照仕様案

- 作成日: 2026-07-12
- 更新履歴:
  - 2026-07-12 R6: 効果評価を追加。安全性はconfig管理と実装ゲートに依存すること、値parameter化との優先関係は技術依存ではなくプロダクト上の順序であることを明記
  - 2026-07-12 R5: token要求導出順、CLI/MCP共通resolver、DELETEのsurface別制約、mapped ID allocator共有、物理・論理同一実体の別binding方針、per-profile mappingのトレードオフを明記
  - 2026-07-12 R4: 既存`APPxxx`の暗黙変換を撤回。物理参照`APPxxx`と論理参照`LAPP_<NAME>`を構文上分離し、`logicalApps`の未定義参照を必ずエラーに変更
  - 2026-07-12 R3: 同一環境内の部門別同型アプリを切替・比較する適用事例と、多数部門時の拡張論点を追加
  - 2026-07-12 R2: 同一kintone環境内の本番アプリ／テストアプリ切替・比較を適用事例として追加
  - 2026-07-12 R1: 初版
- ステータス: **ドラフト（R4で安全モデルを変更）**
- 対象: Node.js runtimeを利用するCLI / MCP
- 関連機能: `APP@profile`、profile config、tokenMap、保存クエリ
- 関連実装: `src/node/config.ts`、`src/node/appProfiles.ts`、`src/node/runtime.ts`、`src/mcp/tools.ts`、`src/cli/index.ts`

## 1. 背景

kSQLの既存テーブル記法`APP899`は、kintoneの**物理アプリID 899**を表す。

```sql
SELECT 顧客コード, 金額
FROM APP899
WHERE 状態 = '受付'
```

同じ用途・同じschemaのアプリでも、開発、本番、テスト、部門などの配置先によって物理IDが異なる場合がある。

| 配置先 | 物理アプリID |
|---|---:|
| 開発 | 899 |
| 本番 | 1234 |
| テスト | 5678 |

現行の`APP899@prod`は接続profileを切り替えるが、参照する物理IDは899のままである。この既存の意味は変更しない。

## 2. 目的

環境や配置先に依存しない明示的な論理参照を追加する。

```sql
SELECT 顧客コード, 金額
FROM LAPP_ORDERS
WHERE 状態 = '受付'
```

```text
LAPP_ORDERS@dev  → 物理APP899@dev
LAPP_ORDERS@prod → 物理APP1234@prod
LAPP_ORDERS@test → 物理APP5678@test
```

SQLを見ただけで論理解決が発生することを判別でき、既存の物理`APPxxx`参照を暗黙に別IDへ変換しないことを安全上の中心原則とする。

## 3. 設計原則

1. `APP899` / `APP899@prod`は常に物理APP899を参照し、`logicalApps`では変換しない
2. 論理解決を要求するSQLだけ`LAPP_<NAME>`を使用する
3. 未定義の論理名はidentity fallbackせず、API呼び出し前に必ずエラーにする
4. configの論理名に`APP899`、`899`、`LAPP_ORDERS`のような物理・SQL表記を受理しない
5. mappingはサーバー起動時のconfigからのみ読み、MCP tool inputや値parameterから変更できない
6. validation / EXPLAIN / DML対象表示で論理名、profile、物理IDを可視化する
7. フィールドコードや型の環境差は吸収しない
8. scanner、profile解決、logical resolver、mapped ID割当、token要求導出、cacheContext生成はCLI/MCPで同じ共通実装を使用し、surface別に複製しない

## 4. 非目的

- `:app`など実行時入力によるidentifier bind
- SQLから任意の物理アプリIDを動的に選択する機能
- profile間・アプリ間のフィールドコード、型、選択肢、権限差の吸収
- アプリの作成・デプロイ・schema同期
- kintoneアプリ表示名からの自動検索
- tokenMapのキー体系変更
- ブラウザ内プラグインruntimeへの適用
- 保存クエリの値パラメータ化

## 5. SQL構文

### 5.1 物理参照

既存構文は常に物理IDとして扱う。

```sql
APP899
APP899@prod
APP899$明細@prod
```

```text
APP899@prod → 物理APP899@prod（変換なし）
```

### 5.2 論理参照

```text
LogicalAppRef ::= "LAPP_" LogicalName [ "$" SubtableCode ] [ "@" ProfileName ]
LogicalName   ::= [A-Z][A-Z0-9_]{0,63}
```

例:

```sql
LAPP_ORDERS
LAPP_ORDERS@prod
LAPP_ORDERS$明細@prod
```

論理名はASCII大文字へ正規化し、大文字小文字を区別しない。予約接頭辞`LAPP_`だけ、または65文字以上の名前は拒否する。

### 5.3 物理・論理の混在

同一SQLで物理参照と論理参照を混在できる。ただし、意図が分かりにくくなるためvalidation / EXPLAINで両者を区別して表示する。

```sql
SELECT o.顧客コード
FROM LAPP_ORDERS@prod o
JOIN APP200@prod m ON o.顧客コード = m.顧客コード
```

## 6. 設定仕様

### 6.1 `logicalApps`

`KsqlProfileConfig`に次を追加する。

```ts
export interface KsqlProfileConfig {
  // 既存項目...
  logicalApps?: Record<string, number>;
  allowPhysicalAppRefs?: boolean;
}
```

設定例:

```json
{
  "defaultProfile": "dev",
  "profiles": {
    "dev": {
      "baseUrl": "https://dev.example.cybozu.com",
      "logicalApps": {
        "ORDERS": 899,
        "CUSTOMERS": 910
      },
      "tokenMap": {
        "APP899": "env:DEV_ORDERS_TOKEN",
        "APP910": "env:DEV_CUSTOMERS_TOKEN"
      }
    },
    "prod": {
      "baseUrl": "https://prod.example.cybozu.com",
      "allowPhysicalAppRefs": false,
      "logicalApps": {
        "ORDERS": 1234,
        "CUSTOMERS": 1235
      },
      "tokenMap": {
        "APP1234": "env:PROD_ORDERS_TOKEN",
        "APP1235": "env:PROD_CUSTOMERS_TOKEN"
      }
    }
  }
}
```

キーは`LAPP_`を除いた裸の論理名、値はそのprofileにおける物理アプリIDである。

### 6.2 禁止する設定

次はすべてconfig読み込み時にエラーにする。

```json
{ "logicalApps": { "APP899": 1201 } }
{ "logicalApps": { "899": 1201 } }
{ "logicalApps": { "LAPP_ORDERS": 1201 } }
```

エラー例:

```text
ArgumentError: logicalApps key "APP899" is invalid. Use a logical name such as "ORDERS"; physical APP references cannot be mapped.
```

これにより、既存の物理`APP899`を論理名として再解釈する設定を作れないようにする。

### 6.3 解決規則

`LAPP_<NAME>`と実効profile`P`に対して次を行う。

1. logical nameを大文字へ正規化する
2. `profiles[P].logicalApps[NAME]`を検索する
3. 定義があれば、その値を物理IDとしてbindingを作る
4. 未定義なら`ArgumentError`で停止する

未定義時に同名・同番号の物理アプリへfallbackする経路は設けない。

### 6.4 `allowPhysicalAppRefs`

- 省略時または`true`: 従来どおり`APPxxx`を許可する
- `false`: そのprofileに対する物理`APPxxx`参照をvalidation時に拒否し、`LAPP_<NAME>`を要求する

後方互換のため既定値は`true`とする。本番profileでは、configで承認された論理参照だけを許可する目的で`false`を選択できる。

同一SQLで複数profileを使う場合、各テーブル参照の実効profileごとに判定する。

### 6.5 設定検証

- logical nameが`[A-Z][A-Z0-9_]{0,63}`へ正規化可能であること
- `APP` + 数字、数字だけ、`LAPP_`付きのキーを拒否すること
- 物理IDが正のsafe integerであること
- 大文字正規化後の論理名が重複しないこと
- 同一profile内で複数論理名が同じ物理IDを指す設定は初回リリースでは拒否すること
- `allowPhysicalAppRefs`がbooleanであること

環境変数やCLI引数からの`logicalApps`指定は初回リリースでは提供しない。

### 6.6 per-profile定義のトレードオフ

初回リリースでは、物理IDがprofileごとに異なる主用途を優先し、`logicalApps`を各profile内に置く。この方式は解決規則と権限境界が単純な一方、論理アプリ追加時に利用対象の全profileへ同じ論理名を定義する必要があり、同一接続先を共有する多数部門では`baseUrl`・認証・query設定の重複が増える。

初回はper-profile方式に限定し、実需が確認された場合は接続・認証profileと名前付きmapping setを分離する後続仕様を設計する。初回実装へ両モデルを混在させない。

## 7. 適用事例

### 7.1 開発環境と本番環境

```json
{
  "profiles": {
    "dev": {
      "baseUrl": "https://dev.example.cybozu.com",
      "logicalApps": { "ORDERS": 899 }
    },
    "prod": {
      "baseUrl": "https://prod.example.cybozu.com",
      "logicalApps": { "ORDERS": 1234 }
    }
  }
}
```

```sql
SELECT * FROM LAPP_ORDERS
```

```text
profile=dev  → LAPP_ORDERS → APP899
profile=prod → LAPP_ORDERS → APP1234
```

### 7.2 同一環境内の本番アプリとテスト用アプリ

profileを物理環境だけでなくアプリ配置スロットとして利用する。`baseUrl`は同じでよい。

```json
{
  "profiles": {
    "prod": {
      "baseUrl": "https://example.cybozu.com",
      "logicalApps": { "ORDERS": 1234 },
      "tokenMap": { "APP1234": "env:PROD_ORDERS_TOKEN" }
    },
    "test": {
      "baseUrl": "https://example.cybozu.com",
      "logicalApps": { "ORDERS": 5678 },
      "tokenMap": { "APP5678": "env:TEST_ORDERS_TOKEN" }
    }
  }
}
```

```sql
SELECT * FROM LAPP_ORDERS
```

```text
profile=prod → APP1234
profile=test → APP5678
```

比較:

```sql
SELECT p.顧客コード, p.金額 AS 本番金額, t.金額 AS テスト金額
FROM LAPP_ORDERS@prod p
JOIN LAPP_ORDERS@test t ON p.顧客コード = t.顧客コード
WHERE p.金額 != t.金額
```

### 7.3 同一環境内の部門別同型アプリ

```json
{
  "profiles": {
    "sales": {
      "baseUrl": "https://example.cybozu.com",
      "logicalApps": { "CASES": 1201 }
    },
    "support": {
      "baseUrl": "https://example.cybozu.com",
      "logicalApps": { "CASES": 1301 }
    }
  }
}
```

```sql
SELECT 担当者, COUNT(*) AS 未完了件数
FROM LAPP_CASES
WHERE 状態 != '完了'
GROUP BY 担当者
```

```text
profile=sales   → 営業部APP1201
profile=support → サポート部APP1301
```

部門間集計:

```sql
SELECT '営業部' AS 部門, COUNT(*) AS 件数 FROM LAPP_CASES@sales
UNION ALL
SELECT 'サポート部' AS 部門, COUNT(*) AS 件数 FROM LAPP_CASES@support
```

少数部門ではprofile方式で対応する。多数部門では同じ`baseUrl`・認証・query設定が重複するため、接続profileと名前付きmapping setを分離する後続仕様を検討する。

### 7.4 サブテーブル

```sql
SELECT 商品コード, 数量
FROM LAPP_ORDERS$明細@prod
```

`ORDERS`だけを物理アプリIDへ解決し、サブテーブルコード`明細`は変更しない。

## 8. 正規化とruntime

### 8.1 binding

論理参照のbindingは論理名、mapped ID、物理ID、profileを保持する。

```ts
interface AppBinding {
  logicalName?: string; // 物理参照ではundefined
  mappedAppId: number;
  appId: number;        // 物理アプリID
  profile: string;
  source: "logical" | "physical";
}
```

例:

```text
SQL: LAPP_ORDERS@prod
binding: { logicalName: "ORDERS", mappedAppId: 900000000, appId: 1234, profile: "prod", source: "logical" }
```

scannerは文字列、backtick識別子、行コメント、ブロックコメント内の`LAPP_`を無視する。論理参照を既存parserが扱えるmapped`APP<id>`へ正規化し、routing clientがAPI呼び出し直前に物理IDへ変換する。

R5ではscanner-rewrite方式を採用する。例えば次のように、parserへ渡す最終SQLから`LAPP_`と`@profile`の双方を除去し、サブテーブル位置を維持する。

```text
LAPP_ORDERS$明細@prod → APP900000000$明細
```

`allowPhysicalAppRefs`の判定はrewrite後のSQL文字列では行わず、rewrite前にscannerが付与した`source: "logical" | "physical"`を使用する。これにより、mapped`APP<id>`へ変換された正当な論理参照を物理参照と誤判定しない。

### 8.2 mapped ID

論理参照には内部mapped IDを割り当てる。物理IDと衝突しない既存の仮想ID名前空間を利用し、同じ論理名・profileの組み合わせは同一SQL内で同じmapped IDを使う。

既存`APP@profile`用と論理参照用でallocatorを分けない。1回の正規化につき1つの`usedAppIds`集合と1つのallocatorを共有し、物理ID、既存profile混在用仮想ID、論理参照用mapped IDの衝突を防ぐ。

物理`APP899`は899のままとし、論理参照と同じ物理APP899へ解決されてもengine上の参照を混同しない。

同一`physical app + profile`へ解決されても、`LAPP_ORDERS@prod`と`APP1234@prod`はsourceと監査上の意図が異なるためmergeせず、別binding・別mapped IDとして扱う。この場合、同じ物理アプリのレコード取得やmetadata取得が重複し得る。性能より、物理参照bypassと論理参照の境界を保持する安全性を優先する明示的なトレードオフである。

### 8.3 tokenMap

tokenMapは従来どおり物理アプリIDをキーとする。

```text
LAPP_ORDERS@prod → 物理APP1234 → tokenMap.APP1234
```

論理解決は認可・token要求計算より前に完了させる。現行の`extractAppIds(normalizedSql)`に相当する要求集合はmapped IDを収集し、各mapped IDのbindingから物理ID・profileを引いてtokenMapを検索する。物理IDそのものをengine用appIdsへ混在させない。

```text
LAPP_ORDERS@prod
→ normalized APP900000000
→ required mapped ID: 900000000
→ binding: M900000000 = APP1234@prod
→ tokenMap.APP1234
→ tokenByApp[M900000000]
```

runtime作成時に物理IDのtokenをmapped IDへ関連付ける。エラーには論理名、物理ID、profileを含めるがtoken値は含めない。LAPPだけを含むSQLでも、default appやsingle-tokenの偶然のfallbackに依存せず正しいtoken要求が立つことを必須とする。

### 8.4 cacheContext

cacheContextにはsource、論理名、mapped ID、物理ID、profileを安定した順序で含める。少なくとも物理IDまたはprofileが異なるbindingは別scopeにし、フィールドmetadataを混在させない。

SQL結果キャッシュは存在せず、本仕様では扱わない。

## 9. validation・EXPLAIN・エラー

### 9.1 validation出力

```json
{
  "source": "logical",
  "logicalName": "ORDERS",
  "mappedAppId": 900000000,
  "appId": 1234,
  "profile": "prod"
}
```

物理参照では`source: "physical"`とし、`logicalName`を返さない。

### 9.2 EXPLAIN

```text
app source:   logical
logical app:  LAPP_ORDERS
profile:      prod
physical app: APP1234
```

DMLでは書き込み先の論理名と物理IDを実行前に明示する。

```text
UPDATE target: LAPP_ORDERS -> APP1234@prod
```

### 9.3 エラー

```text
ArgumentError: logical app "ORDERS" is not defined in profile "prod".
ArgumentError: physical APP899@prod is not allowed by profile "prod"; use an LAPP_<NAME> reference.
AuthError: token is missing for LAPP_ORDERS -> APP1234@prod.
```

未定義論理名、未知profile、禁止された物理参照はparse後・API呼び出し前に拒否する。

`allowPhysicalAppRefs`はbindingの`source`に対して評価する。rewrite済みSQLの`APP<id>`だけを再走査して判定してはならない。

## 10. 保存クエリとの関係

保存クエリには論理参照をそのまま保存する。

```json
{
  "name": "monthly_sales",
  "sql": "SELECT DATE_FORMAT(受注日, 'YYYY-MM') AS 月, SUM(金額) AS 合計 FROM LAPP_ORDERS GROUP BY 月",
  "defaultProfile": "dev",
  "allowProfileOverride": true
}
```

```text
defaultProfile=dev → APP899
profile override=prod → APP1234
```

既存の`allowProfileOverride`制約を維持する。mappingはprofile configに属するため保存クエリカタログのversion変更は不要である。

値parameter仕様と併用する場合も、identifierとしての論理参照と値bindを分離する。

```text
profile / logicalApps解決 → template parse → 値bind → validate / execute
```

## 11. DML安全性

- 既存の`allowDml: true`、`confirmText: "yes"`、`dmlMaxRows`、WHEREガードを維持する
- `allowPhysicalAppRefs: false`のprofileでは物理参照をDMLでも拒否する
- validation / EXPLAIN / 確認表示と実API呼び出しが同じbinding snapshotを使う
- DML対象の論理名、物理ID、profileを実行前に表示する

`allowDml`や`confirmText`はAI自身も指定できる実行条件であり、人間承認そのものではない。人間承認になるかはMCPホストまたはCLIの確認運用に依存する。

### 11.1 DELETEと明示profile

現行の`DELETE + @profile`制約はsurfaceごとに異なるため、論理参照でも既存挙動を維持する。

| SQL | CLI | MCP |
|---|---|---|
| `DELETE FROM LAPP_ORDERS WHERE ...` | default profileで許可 | default profileで許可 |
| `DELETE FROM LAPP_ORDERS@prod WHERE ...` | 既存の`DELETE + 明示@profile`制約により拒否 | 既存MCP runtimeに従い許可 |

CLIの拒否判定では、rewrite前tokenが明示`@profile`を持っていた事実を保持する。正規化後に`@profile`が消えたSQLだけを見て制約を回避してはならない。MCPも将来同じ制約へ変更する場合は、独立した挙動変更として仕様化する。

## 12. 後方互換性とダウングレード

### 12.1 既存SQL

`APPxxx`の意味を一切変更しない。`logicalApps`を追加しても既存SQLは暗黙変換されない。`allowPhysicalAppRefs`の既定値も`true`であるため、config未変更の既存環境は従来どおり動く。

### 12.2 新構文を旧バージョンで実行した場合

旧バージョンは`LAPP_<NAME>`を有効なテーブル参照として認識せずparse errorにする。別の物理アプリへ誤routeすることはない。ダウングレード時は論理参照を物理`APPxxx`へ戻すか、新構文を含まない保存クエリへ切り戻す。

これは旧案の「APP899をconfig次第で別IDへ変換する」方式より安全であり、旧バージョンがmappingを無視して誤ったアプリへ接続する問題を避ける。

## 13. セキュリティ

- configの`logicalApps`だけがmappingを定義できる
- MCP tool input、値parameter、SQL literalからmappingを上書きできない
- 未定義論理名にfallbackしない
- 必要なprofileでは`allowPhysicalAppRefs: false`により物理ID bypassを防ぐ
- validationと実行で同じconfig snapshot・resolverを使用する
- token、passwordを結果、ログ、エラーへ含めない

configを書き換えられる主体はmappingを変更できるため、config自体を信頼境界内の運用設定として保護する。

## 14. 効果評価

### 14.1 中核効果: SQLと保存クエリの配置非依存化

物理アプリIDだけが異なる同用途・同schemaのアプリに対し、同じSQLと保存クエリを再利用できる。

```sql
SELECT * FROM LAPP_ORDERS
```

```text
dev     → APP899
prod    → APP1234
test    → APP5678
sales   → APP1201
support → APP1301
```

JOIN、subquery、batch、DMLなどAPP参照が多いSQLほど、環境ごとのSQL複製、物理IDの置換、変更漏れを減らす効果が大きい。常に単一環境・単一アプリだけを使う運用では効果は小さい。

### 14.2 既存SQLへの効果

`APPxxx`の意味を維持し、論理解決を`LAPP_<NAME>`へ限定するため、configへ`logicalApps`を追加しただけで既存SQLが別アプリへ向くことはない。新機能を使うSQLだけが明示的に構文を変更するopt-in方式であり、導入時の回帰範囲を限定できる。

`allowPhysicalAppRefs: false`を設定したprofileでは、物理参照を意図的に拒否する。これは暗黙の意味変更ではなく、運用者が選択する明示的な制約変更である。

### 14.3 安全性と観測性

次の仕組みにより、論理参照の解決先をAPI呼び出し前に確認できる。

- 未定義論理名をfail closedで拒否
- validation / EXPLAINで論理名・profile・物理IDを表示
- DML対象表示と実行が同じbinding snapshotを使用
- 必要なprofileで`allowPhysicalAppRefs: false`を指定し、物理ID bypassを禁止
- token要求を解決済みbindingから導出

ただし、安全性が無条件に向上するわけではない。失敗モードは次のように移る。

```text
導入前: SQLに記述した物理APP IDが誤っている
導入後: logicalAppsのmappingが誤っている
```

mappingを誤るとSQL自体は正しく見えたまま別の物理アプリへrouteし得る。netで安全性・保守性が向上するのは、configが信頼境界内でレビュー、変更管理、保護されている場合に限る。config変更時には少なくともvalidation / EXPLAINでresolved bindingを確認する運用を要求する。

DML対象を表示できることは観測性の改善である。`allowDml` / `confirmText`はAIも指定できる実行条件であり、人間承認そのものではない。実際の人間確認になるかは、MCPホストのtool confirmationまたはCLIの確認運用に依存する。

### 14.4 AI・環境比較への効果

```sql
FROM LAPP_ORDERS@prod p
JOIN LAPP_ORDERS@test t ON ...
```

物理IDではなく役割名がSQLに現れるため、人間とAIの双方が比較対象を理解しやすい。validation / EXPLAINのstructured bindingにより、AIは実行前に最終的な物理IDを確認できる。

一方、AIがconfigを書き換えられる権限を持つ場合はmappingも変更できるため、configの更新権限をSQL実行権限と分離することが望ましい。

### 14.5 値parameter化との関係

論理アプリ参照と保存クエリの値parameter化は技術的に独立しており、どちらかが他方の実装前提ではない。

```sql
SELECT *
FROM LAPP_ORDERS
WHERE 登録日 >= :since
```

- `LAPP_ORDERS`: 配置先・物理IDの差を解決
- `:since`: 実行ごとの値を解決

環境ごとに物理IDが異なる実需が既にある場合は、論理アプリ参照を先に導入することで、後続の値parameter化と組み合わせた保存クエリを環境・条件値の双方から独立させられる。優先理由は実装範囲が狭いからではなく、顕在化している配置差を直接解決し、既存`APPxxx`の意味を変えずに再利用の土台を作れるためである。

### 14.6 コスト・制約

- 実装範囲は中〜大。scanner、binding型、allocator、認可・token要求、routing、cacheContext、CLI/MCP接続へ横断的に波及する
- 特に認可・token要求経路は誤routeや誤ったtoken不足判定につながるため、変更行数以上に高リスクである
- profileごとの`logicalApps`管理が増え、多数部門では設定重複が増える
- フィールドコード・型のschema差は吸収しない
- configが新たな重要な信頼境界になる
- 同じ物理アプリを物理参照・論理参照の双方で使うと二重fetch・metadata取得が起こり得る
- 旧バージョンはLAPP構文をparseできない

### 14.7 効果を成立させる実装ゲート

本節の安全性・再利用性の効果は、少なくとも次の3点を満たした場合にのみ成立する。

1. **binding起点のtoken要求導出**: mapped IDを収集し、bindingから物理ID・profileを取得してtokenをmapped IDへ関連付ける。物理IDをengine appIdsへ混ぜない
2. **CLI/MCPの共通resolver**: scanner、resolver、allocator、binding生成、token要求導出、cacheContext生成を共通実装とし、片方だけ異なるroute・認可結果になることを防ぐ
3. **source-awareな物理参照制限**: `allowPhysicalAppRefs`をrewrite後SQLではなくscannerが保持するsource情報で判定する

加えて、configのレビュー・変更管理、validation / EXPLAINによるresolved target確認を運用上の着手条件とする。

### 14.8 投資対効果と推奨判断

| 運用状況 | 効果 |
|---|---|
| 開発・本番で物理アプリIDが異なる | 非常に高い |
| 同一環境に本番・テスト用の同型アプリがある | 高い |
| 部門別に同型アプリがある | 高い。ただし部門数とprofile増加に注意 |
| 常に単一環境・単一アプリ | 低い |
| 環境間でschemaも異なる | 限定的 |

環境・配置先ごとに物理IDが異なる具体的な実需があり、§14.7の実装ゲートとconfig管理を満たせる場合は実装を推奨する。実需がなく将来利用の可能性だけであれば、認可・token経路を含む横断変更のコストが先行するため保留とする。

推奨するプロダクト上の順序は次のとおり。ただし1と2に技術的な依存関係はない。

1. 論理アプリ参照（物理ID差の実需がある場合）
2. 保存クエリの値parameter化
3. 多数部門向けmapping set

## 15. 実装変更点

### 15.1 `src/node/config.ts`

- `logicalApps?: Record<string, number>`
- `allowPhysicalAppRefs?: boolean`
- logical nameと物理IDのruntime validation

### 15.2 `src/node/appProfiles.ts`

- `LAPP_<NAME>[$subtable][@profile]`を認識するscanner拡張
- 物理APP scannerの既存挙動を維持
- bindingに`source`と`logicalName`を追加
- logical resolverとmapped ID割当
- 既存profile仮想IDと論理mapped IDで共有するallocator
- bindingからtoken要求を導出する共通helper
- cacheContext / formatterの拡張

### 15.3 `src/node/runtime.ts`

- logical bindingから物理ID・profileへのrouting
- tokenMapの物理ID解決
- 全KintoneClientメソッドで共通bindingを使用

### 15.4 `src/mcp/tools.ts` / CLI

- scanner、resolver、allocator、binding、token要求導出、cacheContext生成を`src/node/`の純粋な共通実装へ統一する
- validate / explain / query / mutate / saved queryで同じresolverを使用
- structured bindingとDML resolved targetを返す
- CLI診断表示にも論理名→物理IDを追加
- CLI固有のDELETE制約は共通bindingの`hasExplicitProfile`相当情報を使い、resolver自体を複製しない

### 15.5 ドキュメント

- `docs/cli_app_profile_spec.md`
- `docs/ksql_language_reference.md`
- `docs/ksql_cli_tutorial.md`
- `docs/ksql_mcp_server_spec.md`
- `README.md`
- config sample

## 16. テスト計画

### 16.1 config

1. `ORDERS: 1234`を受理
2. `APP899`、`899`、`LAPP_ORDERS`キーを拒否
3. 無効名、重複名、0・負数・非整数・safe integer外の物理IDを拒否
4. 同一profile内の物理ID重複を拒否
5. `allowPhysicalAppRefs`型検証

### 16.2 SQL・resolver

1. `APP899@prod`はmappingに関係なく物理899のまま
2. `LAPP_ORDERS@prod`は定義された物理1234へ解決
3. 未定義`LAPP_UNKNOWN`はAPI呼び出し前にエラー
4. `allowPhysicalAppRefs: false`で物理参照を拒否
5. 同一論理名の`@dev` / `@prod`混在
6. JOIN、UNION、subquery、CTE、batch、DML、DESCRIBE
7. `LAPP_ORDERS$明細@prod`
8. 文字列、backtick、コメント内の`LAPP_`を無視
9. 物理・論理参照混在時のbinding分離
10. 既存`APP@profile`用とLAPP用のmapped IDが同一SQLで衝突しない
11. `LAPP_ORDERS$明細@prod`をparser互換の`APP<mapped>$明細`へrewriteする
12. rewrite後もbindingのsourceと明示profile情報が保持される

### 16.3 runtime・表示

1. 全clientメソッドが物理IDをAPIへ渡す
2. tokenMapの物理IDキーを使う
3. cacheContextが物理ID・profile差を分離
4. validate / EXPLAINがsource・論理名・物理ID・profileを表示
5. DML表示と実際のroute先が一致
6. CLI / MCP / 保存クエリで解決結果が一致
7. LAPPだけを含むSQLでbinding経由の物理ID token要求が立ち、正しいtokenをmapped IDへ関連付ける
8. LAPPだけを含むSQLでtoken不足をAPI呼び出し前に検出する
9. LAPPと物理APPが同じphysical+profileを指しても別bindingを維持し、重複取得を許容する
10. CLIは`DELETE FROM LAPP_ORDERS@prod`を拒否し、明示profileなしを許可する
11. MCPは既存挙動どおり明示profile付きLAPP DELETEを処理できる

### 16.4 回帰

- config未設定の既存テスト
- `APP@profile`の全既存テスト
- tokenMap / userpass / single token
- SELECT / JOIN / batch / DML / subtable
- 文字列・コメント中のAPP抽出

## 17. 受け入れ条件

1. `APP899@prod`が`logicalApps`の有無にかかわらず物理APP899を指す
2. 論理解決は`LAPP_<NAME>`でのみ発生する
3. configキー`APP899`、`899`、`LAPP_ORDERS`を明示的に拒否する
4. 未定義論理名をfallbackせずエラーにする
5. validation / EXPLAIN / DML確認で解決先を確認できる
6. 同じ`LAPP_ORDERS`をprofileだけ変えて開発・本番・テストで共有できる
7. `allowPhysicalAppRefs: false`で物理参照をfail closedにできる
8. token・cache・routingが物理IDとprofileに対して正しく分離される
9. 既存`APPxxx` SQLの意味と挙動に回帰がない
10. 旧バージョンが新構文を別アプリへ誤routeせずparse errorにする
11. token要求は解決済みbindingから導出され、LAPPのみのSQLでも認可漏れ・誤ったtoken不足判定がない
12. CLI/MCPが同一のscanner・resolver・allocator・binding生成・token要求導出を使用する
13. DELETEの明示profile制約がsurfaceごとの既存挙動を維持する

## 18. 実装前の未決事項

1. SQL構文を`LAPP_ORDERS`で確定するか、別の明示記法を採用するか
2. logical nameをASCII大文字に限定するか、小文字・日本語を許可するか
3. `allowPhysicalAppRefs`をprofile単位とするか、server全体にも既定を設けるか
4. 同一profileで複数論理名から同一物理IDへのaliasを将来許可するか
5. scanner-rewrite方式で必要なエラー位置精度を確保できるか（不足する場合のみ位置metadataをbindingへ追加する。AST node方式へ戻す未決ではない）
6. EXPLAINとMCP structured payloadの正式なフィールド名
7. 多数部門向けmapping setを将来どの層で選択するか

## 19. 推奨実装順序

1. `logicalApps` schema・検証とCLI/MCP共通の純粋resolver
2. scanner、共有allocator、binding拡張（物理APP回帰テストを先に固定）
3. binding由来のtoken要求導出、runtime routing、token、cacheContext
4. validation / EXPLAINの可視化
5. MCP query / mutate / saved query
6. CLIを共通resolverへ接続し、DELETE固有ガードだけsurface側に維持
7. 公開ドキュメント・sample・回帰テスト

保存クエリの値parameter化とは同時実装せず、論理アプリ参照を独立して完成させる。
