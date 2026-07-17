# B32: `WHERE` 演算子の押し下げ可否を型メタデータで判定する

- ステータス: **設計承認済み / v3.0.0 公開済み（2026-07-17）**
- 種別: **バグ（EXPLAINと実行の不一致 / 必ず失敗する計画）**
- 関連: B26（型付き比較）、B27（schema-aware planner）、B31（`KORDER BY`）
- 正となる比較意味論: [文字列の扱い](ksql_string_semantics.md)

## 1. 現象

現行plannerは`WHERE`の演算子が対象フィールド型でkintone REST queryに使用できるかを確認せず、構文上変換できればSIMPLEへ押し下げる。

```sql
EXPLAIN SELECT 郵便番号
FROM APP4148
WHERE 郵便番号 > '100'
LIMIT 5
```

観測結果:

```text
EXPLAIN: ok / mode: SIMPLE
kintone query: 郵便番号 > "100" order by $id asc limit 5

実行: 400 GAIA_IQ03
「郵便番号フィールドのフィールドタイプには演算子>を使用できません。」
```

`郵便番号`は`SINGLE_LINE_TEXT`である。kintoneの公式query演算子表では、文字列（1行）は`=` / `!=` / `in` / `not in` / `like` / `not like`を受理するが、`<` / `>` / `<=` / `>=`を受理しない。

## 2. 原因

- `resolveSelectMode`はWHEREの構文形状を中心にSIMPLE/FULL_SCANを決め、フィールド型と演算子の組を検証しない
- `whereToKintone`は`>` / `<` / `>=` / `<=`を型に関係なくそのまま変換する
- EXPLAINと実行は、APIが拒否するまで実行不能性を検出できない

これは「EXPLAIN/validateが成功するが実行は必ず失敗する」既存事例と同じ欠陥族である。APIの400をruntime backstopとして残すだけでは、計画を正しく説明したことにならない。

## 3. v3.0.0の決定

フィールド型と演算子の組について、kintone REST queryへの押し下げ能力を**明示allowlist**で管理する。未知型・未測定型・型解決失敗を、既知の拒否型ではないという理由で押し下げてはならない。

schema-aware plannerは、少なくとも次を分離する。

1. SQLとしてローカル評価できるか
2. kintone REST queryがその型・演算子を受理するか
3. RESTとローカルの意味が同値か
4. REST取得後の残余評価があるか

SELECTでは、ローカル契約がありREST非対応の述語をFULL_SCANの残余WHEREへ落とす。ローカル契約もない型はplanning errorとする。

DMLでは、本課題を理由に暗黙の全件取得・ローカル対象選択を新設しない。REST非対応の型・演算子を実行前に`DmlConvertError`等の明示エラーで拒否する。DMLのローカルWHERE解禁は別設計とする。

### 3.1 native capability matrix

kintone公式の[クエリの書き方](https://cybozu.dev/ja/kintone/docs/overview/query/#fields-operators-functions)にある「フィールド、システム識別子ごとの利用可能な演算子と関数一覧」をnative能力の正とする。kSQLが扱う演算子について、初期matrixを次に固定する。

| 解決済みフィールド型 | kintone RESTが受理する演算子 |
|---|---|
| `RECORD_NUMBER`, `$id` | `=` `!=` `>` `<` `>=` `<=` `in` `not in` |
| `CREATOR`, `MODIFIER` | `in` `not in` |
| `CREATED_TIME`, `UPDATED_TIME`, `DATE`, `TIME`, `DATETIME` | `=` `!=` `>` `<` `>=` `<=` |
| `SINGLE_LINE_TEXT`, `LINK` | `=` `!=` `in` `not in` `like` `not like` |
| `NUMBER`, `CALC` | `=` `!=` `>` `<` `>=` `<=` `in` `not in` |
| `MULTI_LINE_TEXT` | `like` `not like`（公式の`is empty` / `is not empty`は現行kSQL演算子外） |
| `RICH_TEXT` | `like` `not like` |
| `CHECK_BOX`, `RADIO_BUTTON`, `DROP_DOWN`, `MULTI_SELECT` | `in` `not in` |
| `FILE` | `like` `not like`（公式の`is empty` / `is not empty`は現行kSQL演算子外） |
| `USER_SELECT`, `ORGANIZATION_SELECT`, `GROUP_SELECT` | `in` `not in` |
| `STATUS` | `=` `!=` `in` `not in` |
| `LOOKUP` | 解決済みコピー元型と同じ |
| `REFERENCE_TABLE`内の参照先フィールド | 解決済み参照先型を基礎とする。ただし`=` / `!=`の代わりに`in` / `not in`を使うという公式の構造制約を優先 |
| `SUBTABLE`内フィールド | 解決済みフィールド型を基礎とする。ただし`=` / `!=`は不可で`in` / `not in`を使うという公式の構造制約を優先 |
| `GROUP`, `CATEGORY`, 公式表にない型・将来追加型 | なし |

`STATUS_ASSIGNEE`など公式表に独立行がなく、別型への対応付けをこの仕様で証明していない型は、類似した値形状から推測せず初期matrixでは押し下げ不可とする。既存の個別仕様でREST受理とローカル同値性を独立に証明済みの組を追加する場合は、根拠と回帰試験を同じmatrixへ記録する。

この表は**RESTのnative受理能力**であり、そのまま完全押し下げallowlistではない。たとえば通常`LIKE`はkSQLのローカル意味とkintoneの単語検索が異なるため、RESTが受理しても同値な完全押し下げにはならない。plannerはさらに次を区別する。

- RESTがその組を受理するか
- kSQLのローカル意味と同値なので完全押し下げできるか
- 上位集合プレフィルターとしてだけ使えるか
- ローカル契約があり、SELECTの残余評価へ落とせるか
- SQLとしても拒否すべきか

公式表にない型、将来追加型、型メタデータを解決できない列は拒否側である。`SINGLE_LINE_TEXT`の範囲演算子1例だけから他型を一般化しない。

## 4. B26/B27/B31との境界

- **B26**: local residualへ落ちたtyped stringの`<` / `>`はコードポイント順で評価する
- **B27**: 通常`ORDER BY`のREST top-Nを選ぶには、WHERE全体が型・演算子まで含めてRESTと同値でなければならない
- **B31**: `KORDER BY`はWHERE全体の完全押し下げを必須とするため、REST非対応述語が1つでもあればplanning errorにする
- **B32**: 上記2 plannerが共有する「型 × 演算子」のREST能力判定と、通常SELECTのSIMPLE/FULL_SCAN routingを所有する

B32をv3.0.0から外すと、B27/B31の「WHERE完全押し下げ」判定を正しく実装できない。そのため独立課題として管理するが、v3.0.0の必須範囲に含める。

## 5. 移行影響

typed stringの範囲比較は、現行では経路によって次のどちらかになる。

- SIMPLE: 不正にRESTへ押し下げられ、`GAIA_IQ03`で失敗
- FULL_SCAN: `compareScalarValues`の値ベース数値判定で、数字だけなら数値比較

v3.0.0では常にlocal residualとして実行でき、B26のtyped string契約に従ってコードポイント順になる。

```text
WHERE x > '100'、xはSINGLE_LINE_TEXT

x='20'  : 現行FULL_SCAN false → v3 true
x='30'  : 現行FULL_SCAN false → v3 true
x='99'  : 現行FULL_SCAN false → v3 true
x='9'   : 現行FULL_SCAN false → v3 true
```

返る行、COUNT/SUM等の集計、後段のHAVING/CASE、ローカルWHEREを使う処理結果が変わり得る。公開移行ガイドでは、現行SIMPLEが成功していたとは書かず、SIMPLEはAPIエラー、FULL_SCANだけが旧数値判定で成功していたことを併記する。

## 6. 受入条件

- `SINGLE_LINE_TEXT > '100'`を含むSELECTはSIMPLEへ押し下げず、FULL_SCANの残余WHEREとして実行する
- EXPLAINと実行が同じschema-aware能力判定を使う
- B26適用後、数字だけのtyped stringもコードポイント順で範囲比較する
- NUMBER / CALC / RECORD_NUMBER / 日付時刻系など、公式に範囲演算を受理する型は既存の安全条件内で押し下げを維持する
- `=` / `!=` / `in` / `not in`等は型ごとの公式能力を回帰試験する
- 公式query演算子表から作ったcapability matrixと実装表が一致し、構造制約・未知型のfail-closedを回帰試験する
- 未知型・型メタ欠落は楽観的に押し下げない
- `KORDER BY ... LIMIT 0`でもWHERE能力検査を省略しない
- `KORDER BY`でREST非対応述語があれば、local fallbackせずplanning errorにする
- DMLのREST非対応述語はAPI呼出し前に明示エラーとなり、暗黙に更新対象を広げない
- DMLのEXPLAINも同じ型×演算子能力判定を使い、実行時に拒否する述語をGET→PUT等の実行可能planとして表示しない
- CLI / MCP / プラグイン、通常実行 / EXPLAIN / 保存queryで同じ受理・routingになる

## 7. 非目標

- DMLへ新しいローカルWHERE実行方式を追加すること
- kintoneが受理しない演算子をREST queryへ変換すること
- B26の比較意味論やB31のnative順を本課題側で再定義すること
