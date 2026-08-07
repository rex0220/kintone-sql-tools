# B150 結合キー範囲 prefilter 仕様（R1）

- ステータス: **R1**
- 対象: kSQL v3.60.0
- 起票: [B150](ksql_b150_cte_join_date_pushdown_issue.md)
- 関連: [B152 R1](ksql_b152_join_pushdown_phase234_spec_r1.md)
- 初版: 2026-08-07
- 採用方針: **案 D＋案 A**
- SemVer: **patch 候補**
- 構文変更: **なし**

---

## 0. R1 の位置づけ

B150 は、実体化済みソースと物理 APP を `INNER JOIN` するとき、ソース側の結合キー実値から自動生成する records API query が、対象フィールド型の受けない演算子を選ぶ問題を修正する。

再現形:

```sql
WITH s AS (
  GENERATE_SERIES('2025-08-04', '2025-08-06') AS 日付
)
SELECT s.日付, t.個数
FROM s
INNER JOIN APP4228 AS t
  ON s.日付 = t.日付
```

v3.60.0 の結合キー押し下げは、対象フィールド型を確認せず次を生成する。

```text
日付 in ("2025-08-04","2025-08-05","2025-08-06")
```

kintone の `DATE` フィールドは `in` を受けないため、records API が `GAIA_IQ03` を返す。

B150 後は、対象フィールド型が `in` を受けず範囲比較を受ける場合、同じキー集合から最小値と最大値を求め、次の superset prefilter を使用する。

```text
日付 >= "2025-08-04" and 日付 <= "2025-08-06"
```

JOIN 後の既存照合を最終判定として維持するため、範囲内に結合キー集合へ存在しない日付の行が含まれても結果集合は変わらない。

対象型が `in` も範囲比較も受けない場合、結合キーによる押し下げを行わず、JOIN 先 APP を全件取得する。

---

## 1. 目的

B150 の目的は次のとおりである。

1. 結合キー押し下げが `NATIVE_OPERATORS` に反する演算子を生成しないようにする。
2. `DATE` / `TIME` / `DATETIME` / `CREATED_TIME` / `UPDATED_TIME` の結合キーでは、canonical なキー実値の min / max による範囲 prefilter を使用する。
3. 範囲 prefilter は `relation: superset` とし、JOIN 後の照合を削除しない。
4. 空値、非 canonical 値、型メタ不足では、範囲 query を推測で生成せず全件取得へフォールバックする。
5. `in` を受ける型では既存の `in (...)` チャンク取得、300キー上限、重複除去、serializer を維持する。
6. `in` も範囲比較も受けない型では、kintone の生エラーを発生させず全件取得へフォールバックする。
7. 実行と `EXPLAIN` が同じ型別選択規則、relation、serializer 契約を示す。
8. records API 自体が返した認証、権限、検索打ち切り、値受理その他のエラーは握りつぶさない。

---

## 2. 現行実装から確定していること

### 2.1 結合キー押し下げの実装箇所

| 事実 | 根拠 |
|---|---|
| 結合キー実値による JOIN 先取得は `tryFetchJoinRecordsBySourceKeys()` が担当する | `src/execute.ts:5865-5954` |
| 対象は `INNER JOIN`、alias 付き物理 APP、非サブテーブルである | `src/execute.ts:5877-5884` |
| ON の左右から、実体化済みソース alias・source field・物理 JOIN 先 field を決定する | `src/execute.ts:5886-5899` |
| ソース行は `tables.get(sourceAlias)` から取得する | `src/execute.ts:5901-5902` |
| 現行は値を `toScalarText(raw).trim()` し、空文字になった値を捨てる | `src/execute.ts:5904-5909` |
| キー値は `Set<string>` で重複除去する | `src/execute.ts:5904-5910` |
| 非空キーが0件なら JOIN 先を取得せず空配列を返す | `src/execute.ts:5910-5911` |
| 300キーを超える場合は警告を付け、全件取得へフォールバックする | `src/execute.ts:5861-5863,5912-5917` |
| キーは50件ずつ分割される | `src/execute.ts:5925,5861` |
| 各チャンクは常に `joinField in (...)` へ変換される | `src/execute.ts:5929-5930` |
| 既存 field-vs-literal pushdown 等とは括弧付き `and` で合成される | `src/execute.ts:5931-5938` |
| query 文字列はそのまま共通 fetch plan へ渡される | `src/execute.ts:5939-5944` |
| 複数チャンクの取得結果は重複排除して結合される | `src/execute.ts:5945-5951` |
| string quote は `\` と `"` を escape する | `src/execute.ts:5851-5853` |

### 2.2 型別 native operator の正

型別に kintone が受理する演算子の正は、`NATIVE_OPERATORS` と公開 accessor `nativeWhereOperatorsForType()` である。

根拠:

- `src/core/optimization/whereCapability.ts:66-112`
- `src/core/optimization/whereCapability.ts:139-141`

B150 専用の型一覧を別に複製してはならない。判定は `nativeWhereOperatorsForType(fieldType)` の結果を使用する。

### 2.3 日付系 canonical policy

B152 で次の共有 policy が実装済みである。

| 型 | canonical 形式 | helper |
|---|---|---|
| `DATE` | `YYYY-MM-DD` | `isCanonicalJoinDate()` |
| `TIME` | `HH:mm` | `isCanonicalJoinTime()` |
| `DATETIME` / `CREATED_TIME` / `UPDATED_TIME` | `YYYY-MM-DDTHH:mm:ssZ` | `isCanonicalJoinDateTime()` |

根拠:

- `src/core/optimization/joinDateTimeLiteralPolicy.ts:1-30`
- `src/core/optimization/joinPredicatePushdown.ts:1109-1122`

B150 はこの policy を再利用し、類似の正規表現や日時 parser を追加しない。

### 2.4 min / max に使用できる比較器

実体化列は `MaterializedColumnMeta` に `sortKind`、`fieldType`、`semantics` を保持できる。

根拠:

- `src/execute.ts:403-425`
- `src/execute.ts:4589-4640`

共有比較器 `compareCanonicalValues()` は `ResolvedFieldSemantics` に基づいて、string、number、record number、option の比較を行う。

根拠:

- `src/core/scalarCompare.ts:140-157`
- `src/core/fieldSemantics.ts:1-64`

`GENERATE_SERIES` の日付系列は `fieldType: "DATE"`、`sortKind: "string"`、DATE の `semantics` を実体化メタへ保存する。

根拠:

- `src/execute.ts:5276-5297`

### 2.5 現在の実行経路

`tryFetchJoinRecordsBySourceKeys()` は次の2系統から呼ばれる。

1. 物理 APP だけの FULL_SCAN JOIN  
   `src/execute.ts:4993-5031,5050-5075`
2. CTEまたは一時テーブルを含む FULL_SCAN JOIN  
   `src/execute.ts:5501-5564`

B150 は、これらの既存呼び出しで結合キー押し下げが成立している形だけを変更する。JOIN の評価順、並列取得順、未取得 alias からの新たな押し下げは対象外とする。

---

## 3. 型別選択規則

### 3.1 判定順

物理 JOIN 先フィールドの型を metadata から解決し、次の順で方式を選択する。

1. `in` を受けるか
2. `in` は受けないが `>=` と `<=` の両方を受けるか
3. どちらでもないか

`>=` または `<=` の片方だけを受ける型を範囲対象にしてはならない。

### 3.2 型×選択表

| JOIN 先 field type | `in` | `>=`＋`<=` | 選択 | relation |
|---|:---:|:---:|---|---|
| `RECORD_NUMBER` / `__ID__` | ○ | ○ | 既存 `in` | `exact` |
| `NUMBER` / `CALC` | ○ | ○ | 既存 `in` | `exact` |
| `SINGLE_LINE_TEXT` / `LINK` | ○ | × | 既存 `in` | `exact` |
| `CHECK_BOX` / `RADIO_BUTTON` / `DROP_DOWN` / `MULTI_SELECT` | ○ | × | 既存 `in` | `exact` |
| `CREATOR` / `MODIFIER` | ○ | × | 既存 `in` | `exact` |
| `USER_SELECT` / `ORGANIZATION_SELECT` / `GROUP_SELECT` / `STATUS_ASSIGNEE` | ○ | × | 既存 `in` | `exact` |
| `STATUS` | ○ | × | 既存 `in` | `exact` |
| `DATE` | × | ○ | min / max 範囲 | `superset` |
| `TIME` | × | ○ | min / max 範囲 | `superset` |
| `DATETIME` / `CREATED_TIME` / `UPDATED_TIME` | × | ○ | min / max 範囲 | `superset` |
| `MULTI_LINE_TEXT` / `RICH_TEXT` | × | × | 全件取得 | 適用なし |
| `FILE` | × | × | 全件取得 | 適用なし |
| `CATEGORY`、サブテーブル、未知型、metadata 不足 | × | × | 全件取得 | 適用なし |

表は説明用であり、実装の正は `nativeWhereOperatorsForType()` とする。将来 `NATIVE_OPERATORS` が変更された場合、B150 の選択も自動的に追随しなければならない。

---

## 4. キー値の扱い

### 4.1 ソース0行

ソース行が0件の場合、JOIN 先を取得せず空配列を返す。

これは空値キーだけを持つ場合とは区別する。

### 4.2 `in` 選択時

`in` を受ける型では、B150 前の次の契約を維持する。

- `toScalarText(raw).trim()` による文字列化
- 空文字になった値の除外
- `Set<string>` による重複除去
- 50件単位のチャンク
- 最大6チャンク
- 最大300キー
- `sqlQuote()` による escape
- チャンク間の取得結果重複除去
- 300キー超過時の全件取得フォールバックと既存警告

B150 は `in` 可能型の空値意味論を変更しない。空値を含む `in` 可能型の JOIN を包括的に見直す場合は別課題とする。

### 4.3 範囲選択時の空値

範囲候補では、ソース行のキー値を収集するとき、空値が1件でも存在したら範囲 prefilter を使用しない。

空値には次を含む。

- `""`
- `null`
- `undefined`
- `toScalarText(raw).trim()` の結果が `""` になる値

非空キーと空値が混在する場合も全件取得へフォールバックする。

理由は、次の範囲 query が物理 APP の空セル行を除外し、空値同士が既存 JOIN evaluator で一致する可能性を失わせるためである。

```text
日付 >= min and 日付 <= max
```

範囲候補では、ソース行が存在するが全キーが空値の場合も空配列へ短絡せず、全件取得へフォールバックする。

### 4.4 canonical 判定

範囲候補の全非空キーは、JOIN 先 field type に応じて次を満たさなければならない。

| field type | 判定 |
|---|---|
| `DATE` | 全値が `isCanonicalJoinDate()` を通る |
| `TIME` | 全値が `isCanonicalJoinTime()` を通る |
| `DATETIME` / `CREATED_TIME` / `UPDATED_TIME` | 全値が `isCanonicalJoinDateTime()` を通る |

1件でも canonical 外なら範囲 prefilter を使用せず、全件取得へフォールバックする。

例:

| 型 | キー値 | 結果 |
|---|---|---|
| DATE | `2025-08-04` | 範囲候補 |
| DATE | `2025-8-4` | フォールバック |
| DATE | `2025/08/04` | フォールバック |
| TIME | `09:30` | 範囲候補 |
| TIME | `9:30` | フォールバック |
| DATETIME | `2025-08-04T00:00:00Z` | 範囲候補 |
| DATETIME | `2025-08-04T09:00:00+09:00` | フォールバック |
| DATETIME | `2025-08-04T00:00Z` | フォールバック |

canonical 外の値を補正、丸め、TZ変換、padding、trim後再解釈してはならない。

### 4.5 min / max

min / max は JavaScript の既定 `<`、`localeCompare()`、`Array.sort()` の既定比較では求めない。

次を満たす意味型を解決し、`compareCanonicalValues()` を使用する。

1. CTE / 一時テーブルでは、実体化列の `columnMeta.semantics`
2. 物理 APP ソースでは、そのフィールドの metadata から解決した `ResolvedFieldSemantics`
3. 解決した比較モードが対象日付系と整合すること

意味型を解決できない場合は全件取得へフォールバックする。

日付系 canonical 値は固定幅であり、共有 string comparator の順序と暦・時刻順が一致する。min / max のために `Date` オブジェクトへ変換してはならない。

重複値は min / max に影響しないため、範囲候補でも重複除去してよい。

### 4.6 巨大キー集合

`in` 選択時は既存の300キー上限を維持する。

範囲選択時は、出力 query が常に2境界であるため、300キー上限を適用しない。実体化済みの全キーを1回走査して min / max を求める。

範囲選択によって、CTEまたは一時テーブル自体の行数上限を変更してはならない。

---

## 5. query 生成

### 5.1 `in` prefilter

既存 serializer 形を維持する。

```text
製品名 in ("A","B","C")
```

空白、comma、quote、backslash の escape は既存 `sqlQuote()` に従う。

### 5.2 範囲 prefilter

範囲 query は次の順序で生成する。

```text
<joinField> >= <quotedMin> and <joinField> <= <quotedMax>
```

DATE 例:

```text
日付 >= "2025-08-04" and 日付 <= "2025-08-06"
```

TIME 例:

```text
時刻 >= "09:00" and 時刻 <= "17:30"
```

DATETIME 例:

```text
更新日時 >= "2025-08-04T00:00:00Z" and 更新日時 <= "2025-08-06T23:59:59Z"
```

境界値は既存 `sqlQuote()` と同じ kintone query string serializer を使用する。B150 専用の escape 規則を追加しない。

min と max が同じ場合も、`=` や `in` へ変形せず次を生成する。

```text
日付 >= "2025-08-04" and 日付 <= "2025-08-04"
```

これにより、型別選択後に受理未確認の演算子へ戻る経路を作らない。

### 5.3 field-vs-literal prefilter との合成

既存 `pushDownCond` または `additionalPushQuery` がある場合、結合キー prefilter を左側に置き、各条件を括弧で囲んで `and` 合成する。

例:

```text
(日付 >= "2025-08-04" and 日付 <= "2025-08-06") and (個数 > 0)
```

複数の追加 query がある場合も、現行の左結合順を維持する。

```text
((日付 >= "2025-08-04" and 日付 <= "2025-08-06") and (個数 > 0)) and (<additional>)
```

### 5.4 relation 合成

結合キー prefilter の relation は次とする。

| prefilter | relation |
|---|---|
| `in` | `exact` |
| min / max 範囲 | `superset` |
| フォールバック | 適用なし |

同一 APP の field-vs-literal prefilter と合成した plan 全体の relation は次とする。

| 結合キー | 追加条件 | 合成 relation |
|---|---|---|
| exact | exact | exact |
| exact | superset | superset |
| superset | exact | superset |
| superset | superset | superset |

範囲 prefilter と exact 条件を `AND` しても、範囲内に未使用キーが存在し得るため `exact` へ昇格させてはならない。

---

## 6. フォールバック

### 6.1 フォールバック条件

次の場合、結合キー prefilter を送らず、既存の全件取得経路へ進む。

| reason code | 条件 |
|---|---|
| `JOIN_KEY_FIELD_TYPE_UNRESOLVED` | JOIN 先 field type を解決できない |
| `JOIN_KEY_OPERATOR_UNAVAILABLE` | `in` も `>=`＋`<=` も受けない |
| `JOIN_KEY_SEMANTICS_UNRESOLVED` | min / max 用のソース意味型を解決できない |
| `JOIN_KEY_EMPTY_VALUE` | 範囲候補のキー集合に空値が含まれる |
| `JOIN_KEY_NON_CANONICAL_VALUE` | 範囲候補に対象型の canonical 外値が含まれる |
| `JOIN_KEY_LIMIT_EXCEEDED` | `in` 候補が既存300キー上限を超える |
| `JOIN_KEY_SOURCE_UNAVAILABLE` | 既存評価順で source alias の行が未実体化である |
| `JOIN_KEY_SOURCE_KIND_UNSUPPORTED` | outer join、サブテーブル等の既存対象外形 |

reason code は `EXPLAIN` とテストで逐語固定する。

### 6.2 API エラーとの区別

フォールバックは、records API を呼ぶ前に、型、キー集合、canonical policy、既存上限から決定する。

次のような実行を禁止する。

1. 不適切な `in` query を送る
2. `GAIA_IQ03` その他のAPIエラーを捕捉する
3. 空 query で再試行する
4. 成功結果だけを返す

範囲 query を選択した後に records API が返したエラーは、そのまま利用者へ返す。

対象には次を含む。

- 認証・権限エラー
- APP・field 不存在
- query 値の不受理
- 検索打ち切り
- network error
- mock client が注入した任意のエラー

「利用者が指定または生成した値を kintone が拒否した場合に、そのエラーを表面化する」という v3.60.0 の原則は維持する。

B150 が防ぐのは、値の不正ではなく、エンジン自身が `NATIVE_OPERATORS` に反する演算子を選択することである。

---

## 7. 対象となる JOIN 形

### 7.1 対象

既存 `tryFetchJoinRecordsBySourceKeys()` が source rows を取得できる次の形を対象とする。

#### CTEから物理 APP

```sql
WITH s AS (
  GENERATE_SERIES('2025-08-04', '2025-08-06') AS 日付
)
SELECT s.日付, t.個数
FROM s
INNER JOIN APP4228 AS t
  ON s.日付 = t.日付
```

#### 一時テーブルから物理 APP

```sql
CREATE TEMP TABLE #s AS
SELECT 日付
FROM APP4227;

SELECT s.日付, t.個数
FROM #s AS s
INNER JOIN APP4228 AS t
  ON s.日付 = t.日付;
```

#### 物理 APPから物理 APP

```sql
SELECT s.日付, t.個数
FROM APP4227 AS s
INNER JOIN APP4228 AS t
  ON s.日付 = t.日付
```

ただし、物理 APP→物理 APP は、v3.60.0 で ON キー最適化が選択される既存 fetch plan に限る。B150 を理由に、独立した WHERE pushdown と並列 fetch の優先順位を変更しない。

### 7.2 対象外

次はB150の対象外とする。

- `LEFT JOIN`
- `RIGHT JOIN`
- サブテーブル仮想表
- field-to-field ON 以外の JOIN 条件
- 複合 ON 条件
- 式、関数、CASE、集計、window 結果を直接 ON の物理側 field にする形
- `UPDATE ... FROM`
- UPSERT対象検索
- `IN (SELECT ...)`
- JOIN の評価順変更
- 未実体化の中間 JOIN alias から後続 APP を新たに絞り込む最適化
- JOIN 後の突合削除
- CTE inline policy の変更
- B152 の field-vs-literal classifier の変更

---

## 8. 静的判定と動的判定

### 8.1 metadata 解決時に確定するもの

次は source row の値に依存せず確定する。

- JOIN 先 field type
- `in` の受理可否
- `>=` と `<=` の受理可否
- 型別の候補方式
- outer join、subtable、alias 等の既存 gate
- relation の上限  
  `in` 候補は exact、範囲候補は superset

### 8.2 実体化後に確定するもの

次は source rows の実体化後に確定する。

- ソース0行
- 空値の有無
- 重複除去後のキー数
- 300キー上限
- canonical 判定
- min / max
- 実際に送る query
- 最終的な適用またはフォールバック reason

静的な「範囲候補」を、値未確認のまま「範囲適用済み」と表示または実行してはならない。

---

## 9. `EXPLAIN` 契約

### 9.1 基本方針

`EXPLAIN` は次を区別して表示する。

1. 型から決まる候補方式
2. キー実値まで確定した適用結果
3. 実値未解決
4. フォールバック

`EXPLAIN` は records API を呼ばない既存契約を維持する。

### 9.2 B150 再現形

次を使用する。

```sql
EXPLAIN
WITH s AS (
  GENERATE_SERIES('2025-08-04', '2025-08-06') AS 日付
)
SELECT s.日付, t.個数
FROM s
INNER JOIN APP4228 AS t
  ON s.日付 = t.日付
```

`GENERATE_SERIES` は既存 EXPLAIN が型、境界、step、行数を静的に解決できるため、APP4228 の表示は次を逐語固定する。

```text
kintone query: 日付 >= "2025-08-04" and 日付 <= "2025-08-06"
fetch: PREFILTERED
join key prefilter: range
pushdown applied: 日付 >= "2025-08-04" and 日付 <= "2025-08-06"
relation: superset
```

`in`、`IN`、`日付 =` を表示してはならない。

### 9.3 追加条件との合成

```sql
EXPLAIN
WITH s AS (
  GENERATE_SERIES('2025-08-04', '2025-08-06') AS 日付
)
SELECT s.日付, t.個数
FROM s
INNER JOIN APP4228 AS t
  ON s.日付 = t.日付
WHERE t.個数 > 0
```

APP4228 の表示は実 serializer 形で次とする。

```text
kintone query: (日付 >= "2025-08-04" and 日付 <= "2025-08-06") and (個数 > 0)
fetch: PREFILTERED
join key prefilter: range
pushdown applied: (日付 >= "2025-08-04" and 日付 <= "2025-08-06") and (個数 > 0)
relation: superset
```

### 9.4 `in` 可能型

キー値を静的に確定できる `SINGLE_LINE_TEXT` の例では次とする。

```text
kintone query: 製品名 in ("A","B")
fetch: EXACT
join key prefilter: in
pushdown applied: 製品名 in ("A","B")
relation: exact
```

値の順序、comma前後の空白、quote escape は実 serializer 出力と一致させる。

### 9.5 フォールバック

空値混在の場合は次を逐語固定する。

```text
kintone query: (全件取得)
fetch: ALL
join key prefilter: not applied
join key prefilter reason: JOIN_KEY_EMPTY_VALUE
```

非 canonical 値の場合:

```text
kintone query: (全件取得)
fetch: ALL
join key prefilter: not applied
join key prefilter reason: JOIN_KEY_NON_CANONICAL_VALUE
```

範囲を受けない型の場合:

```text
kintone query: (全件取得)
fetch: ALL
join key prefilter: not applied
join key prefilter reason: JOIN_KEY_OPERATOR_UNAVAILABLE
```

フォールバック時に `relation: exact` または `relation: superset` を表示してはならない。

### 9.6 実値未解決

records API を読まなければ source key を確定できない CTE または物理 APP では、架空の min / max を表示しない。

```text
kintone query: (runtime source keys)
fetch: PREFILTERED
join key prefilter: range candidate
relation: superset
join key prefilter reason: JOIN_KEY_VALUES_RUNTIME
```

これはフォールバックではない。実行時に空値、canonical、意味型を確認した後、範囲適用または全件取得のどちらかへ確定する。

---

## 10. 実装境界

### 10.1 主な変更候補

| ファイル | 役割 |
|---|---|
| `src/execute.ts:5861-5954` | 結合キー収集、方式選択、範囲生成、フォールバック、query 合成 |
| `src/core/optimization/whereCapability.ts:66-112,139-141` | `NATIVE_OPERATORS` の参照元。型一覧の複製はしない |
| `src/core/optimization/joinDateTimeLiteralPolicy.ts:1-30` | canonical DATE / TIME / DATETIME 判定の再利用 |
| `src/core/scalarCompare.ts:140-157` | 型メタ付き min / max 比較 |
| `src/execute.ts:11457-11607` | EXPLAIN の query、fetch、relation 表示 |
| `src/__tests__/execute.test.ts` またはB150専用test | 実行経路の回帰 |
| `src/__tests__/explain.test.ts` | EXPLAIN逐語固定 |

純粋な型別選択とキー集合分類を runtime と EXPLAIN で共有するため、必要なら `src/core/optimization/` 配下にB150専用の純粋 plannerを追加してよい。

### 10.2 変更しないもの

- SQL grammar
- parser AST
- JOIN evaluator
- `applyJoin()` の一致判定
- field-vs-literal residual
- B152 の exact classifier
- `NATIVE_OPERATORS` の内容
- `JOIN_IN_CHUNK_SIZE = 50`
- `JOIN_IN_MAX_CHUNKS = 6`
- `JOIN_IN_MAX_KEYS = 300`
- CTE / temp table の行数上限
- outer join の安全性契約
- records API error の表面化

---

## 11. 受入条件

### 11.1 B150 再現形

次が `GAIA_IQ03` その他の演算子エラーなく完了する。

```sql
WITH s AS (
  GENERATE_SERIES('2025-08-04', '2025-08-06') AS 日付
)
SELECT s.日付, t.個数
FROM s
INNER JOIN APP4228 AS t
  ON s.日付 = t.日付
ORDER BY s.日付
```

結果は、APP4228を先に全件取得して同じ JOIN を評価した結果と一致する。

実際の records API query に次を含む。

```text
日付 >= "2025-08-04" and 日付 <= "2025-08-06"
```

次を含まない。

```text
日付 in (
```

### 11.2 3経路一致

同じ日付キー集合と同じ物理 JOIN 先データについて、次の3経路の最終結果が一致する。

1. `GENERATE_SERIES` CTE → APP 直接 JOIN
2. 一時テーブル → APP 直接 JOIN
3. APP → APP 直接 JOIN

比較基準として全件取得後の JOIN 結果も一致する。

### 11.3 範囲が superset であること

ソースキーが次の場合:

```text
2025-08-04
2025-08-06
```

JOIN 先に `2025-08-05` の行が存在しても、最終結果へは含まれない。

records API の候補取得には含まれてよい。JOIN 後の突合が除外する。

### 11.4 空値混在

ソースキーに次が混在する場合:

```text
""
"2025-08-04"
"2025-08-06"
```

範囲 queryを送らず、JOIN 先を全件取得する。

最終結果は全件取得基準と一致し、空値同士の JOIN 結果を失わない。

`EXPLAIN` で実値を解決できる経路では次を表示する。

```text
join key prefilter: not applied
join key prefilter reason: JOIN_KEY_EMPTY_VALUE
```

### 11.5 非 canonical 値

DATE ソースキーに次のいずれかが混ざる場合、全件取得へフォールバックする。

```text
2025-8-4
2025/08/04
2025-02-29
```

値を補正した範囲 queryを送らない。

### 11.6 TIME / DATETIME 系

次の型でも、canonical 値についてエラーなく範囲 prefilter が動作し、全件取得基準と結果が一致する。

- `TIME`
- `DATETIME`
- `CREATED_TIME`
- `UPDATED_TIME`

各型の query はB152 canonical policyの形式をそのまま保持する。

### 11.7 `in` 可能型の回帰

少なくとも次を確認する。

- `SINGLE_LINE_TEXT`
- `LINK`
- `NUMBER`
- `DROP_DOWN`

これらでは従来どおり `in (...)` を使用する。

次も維持する。

- 50キーで1 query
- 51キーで2 query
- 300キーまで `in`
- 301キーで全件取得フォールバック
- quoteとbackslashのescape
- 重複キーの除去
- 複数チャンク結果の重複除去

### 11.8 範囲非対応型

`in` も `>=`＋`<=` も受けない型では、型に反する query を送らず全件取得する。

最終結果は全件取得基準と一致する。

### 11.9 追加 prefilter との合成

結合キー範囲と field-vs-literal 条件が同時に適用される場合、実際の query は次の serializer 形になる。

```text
(日付 >= "2025-08-04" and 日付 <= "2025-08-06") and (個数 > 0)
```

最終 relation は `superset` である。

### 11.10 EXPLAIN逐語固定

§9.2、§9.3、§9.4、§9.5の表示をテストで固定する。

少なくとも次を確認する。

- range query の境界順
- quote
- `and`
- 括弧
- `fetch: PREFILTERED`
- `relation: superset`
- `join key prefilter: range`
- フォールバック reason code
- `in` 経路の `fetch: EXACT`
- `in` 経路の `relation: exact`

期待値をSQL風に整形し直さず、実 serializer が生成する文字列を固定する。

### 11.11 mock errorを握りつぶさない

有効な範囲 query に対して mock `getRecords` が任意のエラーを返した場合、そのエラーが呼び出し元へ伝播する。

次を行ってはならない。

- 空 queryで再試行
- 全件取得で再試行
- warningへ変換
- 空結果へ変換

### 11.12 EXPLAINはrecords APIを呼ばない

B150の表示追加後も、`EXPLAIN` はrecords APIとmutation APIを呼ばない。

`GENERATE_SERIES` の既知境界は静的に表示してよい。APP読取が必要なsource keysをEXPLAINのために取得してはならない。

---

## 12. テスト方針

### 12.1 unit

純粋な方式選択について次を表形式でテストする。

- `in` 優先
- range選択
- operator不足
- field type不明
- source semantics不明
- 空値
- canonical外
- min=max
- 昇順・降順・重複を含むキー集合
- 300キー境界
- rangeでは300キーを超えても2境界になること

### 12.2 execute mock

次を records API call と結果の両方で確認する。

- DATE CTE→APP
- DATE temp→APP
- DATE APP→APP
- TIME
- DATETIME
- 空値混在
- canonical外
- range非対応型
- `in` 可能型
- 独立条件とのAND合成
- API error伝播

### 12.3 EXPLAIN

次を逐語比較する。

- B150再現形
- min=max
- 追加条件との合成
- `in` 型
- 空値フォールバック
- 非 canonicalフォールバック
- operator不足
- runtime keys未解決

### 12.4 実機

APP4228または同等の検証 APP で次を確認する。

1. DATE系列→APP直接JOIN
2. TIME系列相当の実体化キー→APP直接JOIN
3. DATETIME実体化キー→APP直接JOIN
4. 範囲内に未使用キーを持つ行があっても最終結果へ混入しない
5. 空セルを含むキー集合では全件取得へフォールバックする
6. DATEに`in`を送らない
7. kintoneが受理した範囲 queryとlocal JOIN結果が一致する

---

## 13. Phase 線引き

### Phase 1 — B150

本仕様で実装する。

- `NATIVE_OPERATORS` に基づく方式選択
- 日付・時刻・日時系の min / max 範囲 prefilter
- 空値・非 canonical・型メタ不足のフォールバック
- range非対応型の全件取得
- relation合成
- EXPLAIN可視化
- mock、unit、実機確認

### 将来課題

B150には含めない。

- `in` 可能型の空値除外契約の再検討
- 複合JOINキーの動的prefilter
- 複数段JOINで未実体化aliasを順次取得する実行順最適化
- outer joinへの適用
- key集合の複数range分割
- 連続区間検出
- histograms等による`in`対rangeのコスト選択
- JOIN後residual elimination
- UPDATE FROM / UPSERT検索への共通化
- server側の空セル意味論を利用した範囲＋空値query

---

## 14. 文書同期

実装時は少なくとも次を確認し、B150の契約と矛盾する説明を更新する。

- `docs/ksql_issue_tracker.md`
- `docs/internal/ksql_b150_cte_join_date_pushdown_issue.md`
- `docs/internal/perf-where-pushdown-join.md`
- `docs/internal/perf-sql-execution-improvements.md`
- `docs/ksql_language_reference.md`
- `CHANGELOG.md`
- `README.md`
- MCP / CLI / plugin の EXPLAIN smoke期待文字列

公開文書では次を明記する。

- 日付系JOINキーは範囲prefilterになる
- 範囲は候補集合を広めに取得するだけで、結果はJOIN後の照合が決める
- 空値または非 canonical値を含む場合は全件取得へフォールバックする
- kintoneが受けない演算子を自動生成しない
- API errorをsilent retryしない

---

## 15. Claude 実測項目・未確認事項

リリース前に次を実機で確認する。

1. `DATE >= min and DATE <= max` がB150再現 APPで受理されること
2. `TIME >= min and TIME <= max` が受理されること
3. `DATETIME >= min and DATETIME <= max` が受理されること
4. `CREATED_TIME` / `UPDATED_TIME` の同じ範囲形が受理されること
5. min=maxの二境界形が全対象型で受理されること
6. DATE空セルが`>= min`で除外されること
7. 空値混在時にrecords API queryが空、または独立条件だけになり、結合キー範囲が送られないこと
8. 非 canonical値混在時に値補正せずフォールバックすること
9. 範囲内の未使用日付がrecords API候補へ入っても、最終JOIN結果へ入らないこと
10. B150再現形、temp経路、APP→APP経路の結果が一致すること
11. `SINGLE_LINE_TEXT` / `LINK` / `NUMBER` / 選択系が従来どおり`in`を使用すること
12. mockではなく実kintoneが返した範囲queryのエラーもsilent retryされないこと
13. EXPLAIN表示と実際のrecords API queryのserializer形が一致すること
14. CLI、MCP、pluginの3 surfaceで結果とEXPLAINが一致すること