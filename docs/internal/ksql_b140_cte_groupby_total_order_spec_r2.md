# B140 CTE の `GROUP BY` キーを全順序として証明する 仕様 R2

- 対象: `kintone-sql-tools` v3.57.0
- 起票: B140
- 仕様版: R2
- 前提: B148 実装済み
- R1: 破棄済み。本仕様の設計根拠には使用しない
- 種別: 警告精度改善
- 値・行順・出力 schema の変更: なし

---

## 1. 結論

CTE の plain `GROUP BY` から、実体化 relation の出力列で表現された複合候補キーを生成する。

consumer のウィンドウ `ORDER BY` が候補キーの全列を直接包含すると静的に証明できた場合に限り、その `ORDER BY` を全順序とみなし、次の警告を抑止する。

- B127: 既定フレーム `RANGE` の警告
- B128: `LAG` / `LEAD` の非全順序警告

Phase 1 は B148 が生成する次の3種類の grouping identity を対象とする。

| plain plan | Phase 1 |
|---|---|
| `PHYSICAL` | 対象 |
| `ALIAS_SAFE` | 対象 |
| `EXPRESSION` | 対象 |
| `ALIAS_REJECT` / `UNKNOWN` / `DEFERRED` | 候補キーを生成しない |

ただし、identity が存在するだけでは候補キーにしない。

> plain `GROUP BY` のすべての grouping identity が、値を変えず、重複名による上書きもなく、実体化 relation の参照可能な出力列へ対応した場合だけ、その出力列の組を候補キーとする。

候補キーは列単位のフラグではなく、relation-level の列 identity の組として保持する。

既存の direct APP に対する `$id` / `RECORD_NUMBER` 証明は変更せず、CTE 候補キーによる証明を独立した加法的経路として追加する。

---

## 2. 背景

### 2.1 解決する偽陽性

```sql
WITH 月次 AS (
  SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月,
         SUM(個数) AS 出庫数
  FROM APP4228
  WHERE 入出庫区分 = '出庫'
  GROUP BY 年月
)
SELECT 年月,
       出庫数,
       LAG(出庫数) OVER (ORDER BY 年月) AS 前月
FROM 月次
```

v3.57.0 の実測結果は次のとおりである。

- 13行
- 値は正しい
- `年月` は plain `GROUP BY` の全キーであり、各出力行の `年月` は一意
- B128 の警告が出る

```text
前月 の ORDER BY は全順序でないため、同順内の前後関係は未規定です。…
```

同じ CTE に対する次の B127 形でも、偽陽性の警告が出ることが実測済みである。

```sql
WITH 月次 AS (
  SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月,
         SUM(個数) AS 出庫数
  FROM APP4228
  WHERE 入出庫区分 = '出庫'
  GROUP BY 年月
)
SELECT 年月,
       出庫数,
       SUM(出庫数) OVER (ORDER BY 年月) AS 累計
FROM 月次
```

B127 と B128 は同じ全順序判定を共有しているため、証明経路を1か所追加すれば両方へ適用できる。

### 2.2 被害

本件で値が誤るわけではない。

被害は、依頼元の主用途で毎回偽陽性が出ることで警告の信用が落ち、実害を伴う B127 の警告まで読み飛ばされることである。

---

## 3. v3.57.0 で確定しているコード上の事実

| 事実 | 根拠 |
|---|---|
| ordinary dependency policy は grouping identity の集合を返す | `src/core/aggregateDependencyValidation.ts:16-23,341-403` |
| `PHYSICAL` は `FIELD:source:<index>:<fieldCode>` を identity にする | `src/core/aggregateDependencyValidation.ts:351-363` |
| `ALIAS_SAFE` は `columnIndex` の SELECT 式を canonicalize する | `src/core/aggregateDependencyValidation.ts:365-368` |
| `EXPRESSION` は対応する `GroupByKey` の式を canonicalize する | `src/core/aggregateDependencyValidation.ts:336-338,370-373` |
| canonicalizer は wrapper・alias・空白・数値の raw 等を identity から除外する | `src/core/aggregateDependencyValidation.ts:25-39,87-140` |
| plain plan は物理列を SELECT alias より先に解決する | `src/core/optimization/plainGroupByPlan.ts:217-245` |
| `ALIAS_SAFE` は SELECT 列位置を保持する | `src/core/optimization/plainGroupByPlan.ts:247-260` |
| 式 `GROUP BY` は `EXPRESSION` になる | `src/core/optimization/plainGroupByPlan.ts:276-286` |
| `MaterializedTable` は relation-level の候補キーをまだ持たない | `src/execute.ts:402-422` |
| `SelectResult` に関連付ける内部メタは現在、列メタだけである | `src/execute.ts:424-429` |
| 現行の全順序判定は `DERIVED`、CTE、JOIN、サブテーブルを拒否する | `src/execute.ts:2548-2577` |
| B127 と B128 は同じ全順序判定を使用する | `src/execute.ts:2605-2635` |
| warning merge による clone は列メタだけを引き継ぐ | `src/execute.ts:2638-2643` |
| CTE キャッシュには現在 `rows` / `columns` / `columnMeta` だけを保存する | `src/execute.ts:5199-5245` |
| CTE consumer の警告判定地点から CTE キャッシュを参照できる | `src/execute.ts:5292-5313,5321-5381` |
| `UNION` は左右の結果から新しい結果を再構築する | `src/execute.ts:5264-5289` |
| 一時テーブルも `MaterializedTable` へ保存されるが、別 batch lifecycle を持つ | `src/execute.ts:1828-1847,1868-1915` |
| `DISTINCT` は `SelectStatement` の独立した属性である | `src/types/ast.ts:207-221` |

B148 R3 は、ordinary `GROUP BY` の identity を `PHYSICAL` / `ALIAS_SAFE` / `EXPRESSION` から構築し、同じ source identity と canonical expression identity を使うことを規定している。

根拠: `docs/internal/ksql_b148_bare_column_group_by_spec_r3.md:220-228,245-348`

---

## 4. 全順序を証明する規則

### 4.1 基本命題

plain `GROUP BY` の評価後は、完全な grouping tuple ごとに最大1行が出力される。

したがって、次の条件をすべて満たす出力列組は候補キーである。

1. plain `GROUP BY` のすべての distinct grouping identity に対応する
2. 各出力列の値が、対応する grouping identity の値と同一である
3. 非単射変換を経ていない
4. 同名出力による上書きがない
5. wildcard 展開に依存しない
6. grouping sets の小計・総計行を含まない

consumer のウィンドウ `ORDER BY` が、ある候補キーの全メンバーを直接参照していれば、2行がすべての `ORDER BY` 値で同順になることはない。そのため全順序と証明する。

### 4.2 包含規則

候補キーを `K`、ウィンドウの `ORDER BY` で直接参照される列 identity 集合を `O` とする。

```text
∃K: K ⊆ O
```

の場合だけ、CTE 候補キーによる全順序証明を成功させる。

次は証明結果へ影響しない。

- 候補キー列を並べる順序
- `ASC` / `DESC`
- 候補キー以外の追加 `ORDER BY` 項目

次は証明に使用しない。

- 候補キーの一部だけ
- 出力 alias の文字列だけが一致するもの
- `ORDER BY` の算術式または関数式
- 別 relation の同名列
- 実行時データで偶然タイがなかったこと

### 4.3 既存証明との関係

全順序判定は次の論理和とする。

```text
既存の direct APP 一意キー証明
OR
単一 materialized CTE source の候補キー包含証明
```

`DERIVED` を一般解禁してはならない。

CTE 候補キー証明は、consumer が実際に参照する単一の materialized relation に候補キーが存在する場合だけ使用する。

---

## 5. 候補キーの生成

### 5.1 保持単位

候補キーは relation-level metadata とする。

概念上は次の形である。

```ts
type MaterializedColumnIdentity = {
  readonly ordinal: number;
  readonly name: string;
};

type CandidateKey = readonly MaterializedColumnIdentity[];

interface MaterializedRelationMeta {
  readonly candidateKeys: readonly CandidateKey[];
}
```

`ordinal` は producer の SELECT 列位置と結び付けるために使う。

`name` は実体化後に consumer の解決済み列参照と対応させるために使う。

列名だけを producer identity の証明に使用してはならない。

### 5.2 共通前提

候補キーを生成する producer は次をすべて満たすこと。

- `SelectStatement`
- ordinary plain `GROUP BY`
- `GROUP BY` 項目が1個以上ある
- JOIN なし
- サブテーブル source なし
- wildcard なし
- `DISTINCT` なし
- 重複した実体化出力名なし
- B148 の schema-aware dependency validation が成功している
- plain plan の全項目が `PHYSICAL` / `ALIAS_SAFE` / `EXPRESSION` のいずれか
- 全 grouping item について canonical identity を確定できる

1項目でも証明できなければ、その relation に候補キーを付けない。クエリ自体を B140 独自のエラーにはしない。

### 5.3 `ALIAS_SAFE`

`ALIAS_SAFE` は plan が保持する `columnIndex` を使用する。

次をすべて満たした場合、その SELECT 列を grouping identity の出力列とする。

- `columnIndex` が実体化出力列へ1対1で対応する
- その出力名が relation 内で一意
- 同名の後続列で値を上書きされない
- B148 の canonical identity 集合に、その SELECT 式の identity が存在する

主用途はこの規則に該当する。

```sql
SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月,
       SUM(個数) AS 出庫数
FROM APP4228
GROUP BY 年月
```

### 5.4 `PHYSICAL`

`PHYSICAL` は `(sourceIndex, fieldCode)` の identity と、SELECT 式を同じ B148 canonicalizer で比較する。

次は対応する。

```sql
SELECT 製品名 AS 品名,
       SUM(個数) AS 合計
FROM APP4228
GROUP BY 製品名
```

`製品名 AS 品名` の SELECT 式は、grouping identity と同じ物理 source identity を持つためである。

次は対応しない。

```sql
SELECT UPPER(製品名) AS 製品名,
       SUM(個数) AS 合計
FROM APP4228
GROUP BY 製品名
```

`GROUP BY 製品名` は物理列へ解決される一方、出力は `UPPER(製品名)` であり、異なる物理値が同じ出力値になる可能性がある。

### 5.5 `EXPRESSION`

`EXPRESSION` は、対応する `GroupByKey` の canonical identity と SELECT 式の canonical identity を比較する。

次は対応する。

```sql
SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月,
       SUM(個数) AS 出庫数
FROM APP4228
GROUP BY DATE_FORMAT(日付, '%Y-%m')
```

出力式と grouping expression が canonical 一致するためである。

次のような派生式は、grouping expression へ依存していても候補キーへの対応とはしない。

```sql
SELECT YEAR(日付) + 1 AS 翌年,
       SUM(個数) AS 合計
FROM APP4228
GROUP BY YEAR(日付)
```

`YEAR(日付) + 1` は `YEAR(日付)` と同一 identity ではない。一般の関数について単射性を推論しない。

### 5.6 複合キー

plain `GROUP BY k1, k2` では、`k1` と `k2` の両方が出力列へ対応した場合だけ、組 `{k1, k2}` を1個の候補キーとして生成する。

列ごとに独立した `groupKey=true` を持たせてはならない。

```text
candidateKeys = [
  [出力列k1, 出力列k2]
]
```

`k1` または `k2` の一方だけを単独の候補キーとして登録してはならない。

同じ grouping identity に複数の SELECT 出力列が canonical 一致する場合は、Phase 1 では対応を一意とみなさず、その producer の候補キーを生成しない。

### 5.7 canonicalizer

B140 専用の文字列比較器を新設してはならない。

B148 と同じ canonicalization を再利用し、少なくとも次を同じ identity として扱う。

- `1` / `1.0`
- 修飾参照 / 非修飾参照が同じ source へ一意解決される形
- 余分な括弧
- parser が正規化する関数別名
- wrapper の違い
- SQL 上の空白
- alias の表示情報
- 数値 literal の `raw`

canonical identity を確定できない場合は不一致とし、候補キーを生成しない。

---

## 6. 候補キーの保持と伝播

### 6.1 producer の実行結果

候補キーは公開 `SelectResult` のプロパティとして追加しない。

`SelectResult` に対する内部 relation metadata として関連付け、CTE 実体化時に取り出せるようにする。

既存の列メタと同様に内部 `WeakMap` を使ってよい。

### 6.2 warning merge

warning merge が新しい `SelectResult` を clone した場合、次を両方とも引き継ぐ。

- 既存の列メタ
- relation-level の候補キー

追加 warning がないため元の `SelectResult` を返す場合も、候補キーが失われてはならない。

### 6.3 CTE キャッシュ

CTE 実体化時に、次を同じ `MaterializedTable` へ保存する。

- `rows`
- `columns`
- `columnMeta`
- relation-level の候補キー

候補キーを CTE 名とは別の sidecar map だけで管理してはならない。実体化 relation と provenance の lifecycle が分離し、別 relation のキーを誤利用する危険があるためである。

既存の exported `MaterializedTable` を拡張する場合は、候補キープロパティを optional とし、既存 caller との互換性を保つ。

### 6.4 consumer

consumer が次をすべて満たす場合だけ、CTE 候補キーを全順序証明へ渡す。

- `FROM` が候補キーを持つ単一 CTE
- JOIN なし
- サブテーブル参照なし
- consumer 自身に ordinary `GROUP BY`、拡張 grouping、`DISTINCT` がない
- ウィンドウ `ORDER BY` の対象列が、その CTE の列として一意に解決される
- 候補キーの全メンバーが `FIELD_NAME` として直接含まれる

consumer の `WHERE`、トップレベル `ORDER BY`、`LIMIT`、通常の列射影は、参照元 relation の一意性を壊さない。ただし Phase 1 では consumer の出力へ候補キーを再伝播しない。

### 6.5 失効規則

次の演算で新しい結果を作る場合、Phase 1 では入力 relation の候補キーを引き継がない。

- 通常の pass-through CTE
- rename を行う中間 CTE
- 式変換を行う中間 CTE
- `DISTINCT`
- `UNION`
- `UNION ALL`
- JOIN
- ordinary `GROUP BY` 以外の集約
- `ROLLUP`
- `CUBE`
- `GROUPING SETS`
- wildcard 展開
- 一時テーブル化

ただし、後続 CTE 自身が Phase 1 の条件を満たす plain `GROUP BY` を持つ場合は、その CTE の grouping identity から新しい候補キーを独立に生成してよい。入力 CTE の候補キーを継承したものとして扱ってはならない。

---

## 7. Phase 1 の線引き

### 7.1 Phase 1 に入れるもの

| 対象 | 判断 |
|---|---|
| 直接 CTE の plain `GROUP BY` | 入れる |
| `PHYSICAL` identity | 入れる |
| `ALIAS_SAFE` identity | 入れる |
| `EXPRESSION` identity | 入れる |
| 複合 `GROUP BY` | 全キーを出力へ対応できる場合に入れる |
| qualified / unqualified の同一 source 参照 | B148 canonical 解決で一致する場合に入れる |
| 候補キー列の順序変更 | 入れる |
| 候補キー全列＋追加 `ORDER BY` | 入れる |
| producer の `WHERE` / `HAVING` / `LIMIT` / top-level `ORDER BY` | 候補キー生成条件を満たす限り許可する |

### 7.2 Phase 1 に入れないもの

| 対象外 | 理由 |
|---|---|
| `DISTINCT` だけからの候補キー生成 | 全出力列を複合キーにできるが、重複名・wildcard・出力再構築を含む別の証明規則になる |
| qualifying `GROUP BY` に重ねた `DISTINCT` | Phase 1 では伝播規則を増やさず fail-closed にする |
| 一時テーブル | batch statement 間の保存・上書き・DROP・seed 合流を含む lifecycle の受入が必要 |
| pass-through の多段 CTE への伝播 | rename・非単射変換・重複出力名を越える一般的な投影伝播規則が必要 |
| `UNION ALL` | 各 arm の候補キーが同じでも、arm 間で重複し得る |
| `UNION` | 全行 `DISTINCT` による一意性は証明可能だが、`DISTINCT` と同じ別規則になる |
| producer JOIN | grouping 後の一意性自体は成立し得るが、複数 source identity と出力対応の受入範囲が増える |
| consumer JOIN | JOIN により候補キー側の1行が複製され得る |
| `ROLLUP` / `CUBE` / `GROUPING SETS` | 小計・総計行を含み、plain grouping tuple の証明をそのまま適用できない |
| サブテーブル source | 子列・親仮想列・`_pid` / `_rid` / `_idx` の identity 対応を別途検証する必要がある |
| wildcard | SELECT 列位置と最終出力 identity の1対1対応を静的に保証しない |
| 重複出力名 | 後続列による値の上書きがあり得る |
| `ORDER BY` の算術・関数式 | 一般の単射性を証明しない |
| 実行時タイ検査 | 警告は現在のデータではなくクエリ構造の非決定性を通知する契約である |
| `$id` / レコード番号による他列への関数従属 | B148 R3 §12.1 と同じく、一般の候補キー伝播を要する別機能 |
| 一般の関数従属推論 | schema と canonical identity だけでは証明できない |

### 7.3 `$id` / `RECORD_NUMBER` との関係

次は合流させない。

```text
$id が一意
→ 同じ行の任意の列組も $id に関数従属する
→ その列だけの ORDER BY も全順序
```

最後の含意は成立しない。任意の列は複数レコードで同じ値を取り得るためである。

既存の direct APP 証明は、`ORDER BY` 自体に `$id` または `RECORD_NUMBER` が含まれる場合だけ維持する。

CTE についても、grouping identity と同一の出力列だけを候補キーにする。grouping key に関数従属する別の出力列へ証明を広げない。

---

## 8. 警告文言

Phase 1 では警告文言を変更しない。

理由は次のとおりである。

- B140 の目的は主用途の偽陽性を減らすことであり、文言変更だけでは警告疲れを解決しない
- 文言変更は公開文字列と既存テストへ影響する
- 本仕様で証明できない経路は引き続き fail-closed で警告する
- 文言を「証明できませんでした」へ一般化する変更は、別の公開契約変更として扱える

対象 CTE で証明が成功した場合は警告そのものを出さない。証明に失敗した場合は現行文言を維持する。

---

## 9. 非機能要件

### 9.1 実行結果を変更しない

本実装は警告判定用 metadata の追加だけとする。

次を一切変更しない。

- `rows` の値
- `rowCount`
- 行順
- `columns`
- 列名
- 列順
- 列型・列 semantics
- ウィンドウ関数の評価
- `GROUP BY` の評価
- top-level `ORDER BY` の評価
- CTE の実体化行
- API 取得条件
- API 呼び出し順
- レコード取得件数上限

### 9.2 暗黙タイブレーク禁止

ウィンドウ `ORDER BY`、top-level `ORDER BY`、内部 comparator のいずれにも、次を暗黙追加してはならない。

- `$id`
- `レコード番号`
- CTE 行 index
- 元レコードの取得順
- grouping bucket の生成順
- その他の hidden column

本仕様は「既存の並びを変更する」のではなく、「既存の `ORDER BY` が全順序であることを証明する」仕様である。

### 9.3 fail-closed

metadata が欠落、破損、曖昧、または未対応である場合は、従来どおり警告を出す。

metadata 不足を理由にクエリを失敗させてはならない。

---

## 10. 受入条件

### 10.1 観測方法

受入は内部関数名、内部型名、ファイル配置を条件にしない。

公開される次の結果で判定する。

- `SelectResult.rows`
- `SelectResult.columns`
- `SelectResult.rowCount`
- `SelectResult.warnings`

B127 の対象警告は、対象 alias に対する次の警告で識別する。

```text
<alias> は既定フレーム（RANGE）で評価されます。
```

B128 の対象警告は、対象 alias に対する次の警告で識別する。

```text
<alias> の ORDER BY は全順序でないため、同順内の前後関係は未規定です。
```

無関係な警告の有無を、B140 の成功・失敗判定へ混ぜない。

### 10.2 通り続けるもの

#### A. direct APP の B128 証明

```sql
SELECT レコード番号,
       個数,
       LAG(個数) OVER (ORDER BY レコード番号) AS 前行
FROM APP4228
ORDER BY レコード番号
```

受入結果:

- `前行` の B128 警告なし
- 値、行順、`columns`、`rowCount` は変更前と同一

#### B. direct APP の B127 証明

```sql
SELECT レコード番号,
       個数,
       SUM(個数) OVER (ORDER BY レコード番号) AS 累計
FROM APP4228
ORDER BY レコード番号
```

受入結果:

- `累計` の B127 警告なし
- 値、行順、`columns`、`rowCount` は変更前と同一

#### C. direct APP の非全順序

```sql
SELECT 製品名,
       個数,
       LAG(個数) OVER (ORDER BY 製品名) AS 前行
FROM APP4228
ORDER BY 製品名
```

受入結果:

- `前行` の B128 警告あり
- 値、行順、`columns`、`rowCount` は変更前と同一

### 10.3 警告が消えるもの

#### A. 主用途・B128

```sql
WITH 月次 AS (
  SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月,
         SUM(個数) AS 出庫数
  FROM APP4228
  WHERE 入出庫区分 = '出庫'
  GROUP BY 年月
)
SELECT 年月,
       出庫数,
       LAG(出庫数) OVER (ORDER BY 年月) AS 前月
FROM 月次
ORDER BY 年月
```

受入結果:

- `前月` の B128 警告なし
- `rowCount = 13`
- `columns = ["年月", "出庫数", "前月"]`
- 値と行順は v3.57.0 の同一 SQL の結果と同一

#### B. 主用途・B127

```sql
WITH 月次 AS (
  SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月,
         SUM(個数) AS 出庫数
  FROM APP4228
  WHERE 入出庫区分 = '出庫'
  GROUP BY 年月
)
SELECT 年月,
       出庫数,
       SUM(出庫数) OVER (ORDER BY 年月) AS 累計
FROM 月次
ORDER BY 年月
```

受入結果:

- `累計` の B127 警告なし
- `rowCount = 13`
- `columns = ["年月", "出庫数", "累計"]`
- 値と行順は v3.57.0 の同一 SQL の結果と同一

#### C. `PHYSICAL` と rename

```sql
WITH 品目別 AS (
  SELECT 製品名 AS 品名,
         SUM(個数) AS 合計
  FROM APP4228
  GROUP BY 製品名
)
SELECT 品名,
       合計,
       LAG(合計) OVER (ORDER BY 品名) AS 前品目
FROM 品目別
ORDER BY 品名
```

受入結果:

- `前品目` の B128 警告なし
- 値、行順、`columns`、`rowCount` は変更前と同一

#### D. `EXPRESSION`

```sql
WITH 月次 AS (
  SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月,
         SUM(個数) AS 出庫数
  FROM APP4228
  GROUP BY DATE_FORMAT(日付, '%Y-%m')
)
SELECT 年月,
       出庫数,
       LAG(出庫数) OVER (ORDER BY 年月) AS 前月
FROM 月次
ORDER BY 年月
```

受入結果:

- `前月` の B128 警告なし
- 値、行順、`columns`、`rowCount` は変更前と同一

#### E. 複合キーの順序変更

```sql
WITH 日別品目 AS (
  SELECT 日付,
         製品名,
         SUM(個数) AS 合計
  FROM APP4228
  GROUP BY 日付, 製品名
)
SELECT 日付,
       製品名,
       合計,
       LAG(合計) OVER (ORDER BY 製品名, 日付) AS 前行
FROM 日別品目
ORDER BY 製品名, 日付
```

受入結果:

- `前行` の B128 警告なし
- 候補キーの列順を入れ替えても証明できる
- 値、行順、`columns`、`rowCount` は変更前と同一

#### F. 複合キー全列＋追加項目

```sql
WITH 日別品目 AS (
  SELECT 日付,
         製品名,
         SUM(個数) AS 合計
  FROM APP4228
  GROUP BY 日付, 製品名
)
SELECT 日付,
       製品名,
       合計,
       SUM(合計) OVER (ORDER BY 日付, 製品名, 合計) AS 累計
FROM 日別品目
ORDER BY 日付, 製品名, 合計
```

受入結果:

- `累計` の B127 警告なし
- 候補キー以外の追加 `ORDER BY` 項目を許可する
- 値、行順、`columns`、`rowCount` は変更前と同一

### 10.4 警告が残るもの

#### A. 複合キーの一部だけ・B128

```sql
WITH 日別品目 AS (
  SELECT 日付,
         製品名,
         SUM(個数) AS 合計
  FROM APP4228
  GROUP BY 日付, 製品名
)
SELECT 日付,
       製品名,
       合計,
       LAG(合計) OVER (ORDER BY 日付) AS 前行
FROM 日別品目
ORDER BY 日付
```

受入結果:

- `前行` の B128 警告あり
- 値、行順、`columns`、`rowCount` は変更前と同一

#### B. 複合キーの一部だけ・B127

```sql
WITH 日別品目 AS (
  SELECT 日付,
         製品名,
         SUM(個数) AS 合計
  FROM APP4228
  GROUP BY 日付, 製品名
)
SELECT 日付,
       製品名,
       合計,
       SUM(合計) OVER (ORDER BY 日付) AS 累計
FROM 日別品目
ORDER BY 日付
```

受入結果:

- `累計` の B127 警告あり
- 値、行順、`columns`、`rowCount` は変更前と同一

#### C. 物理キーから非単射変換した同名出力

```sql
WITH 品目別 AS (
  SELECT UPPER(製品名) AS 製品名,
         SUM(個数) AS 合計
  FROM APP4228
  GROUP BY 製品名
)
SELECT 製品名,
       合計,
       LAG(合計) OVER (ORDER BY 製品名) AS 前品目
FROM 品目別
ORDER BY 製品名
```

受入結果:

- `前品目` の B128 警告あり
- 出力名の一致だけで警告を消さない

#### D. 同名出力による上書き

```sql
WITH 品目別 AS (
  SELECT 製品名,
         SUM(個数) AS 製品名
  FROM APP4228
  GROUP BY 製品名
)
SELECT 製品名,
       LAG(製品名) OVER (ORDER BY 製品名) AS 前値
FROM 品目別
ORDER BY 製品名
```

受入結果:

- SQL が既存契約上成功する場合、`前値` の B128 警告あり
- SQL が既存契約上エラーになる場合、その既存エラーを維持
- B140 が新たな成功または新たなエラーを作らない

#### E. `ORDER BY` 式

```sql
WITH 月次 AS (
  SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月,
         SUM(個数) AS 出庫数
  FROM APP4228
  GROUP BY 年月
)
SELECT 年月,
       出庫数,
       LAG(出庫数) OVER (ORDER BY SUBSTRING(年月, 1, 7)) AS 前月
FROM 月次
ORDER BY 年月
```

受入結果:

- `前月` の B128 警告あり
- 式が実データ上は単射に見えても、単射性を推論しない

#### F. pass-through の多段 CTE

```sql
WITH 月次 AS (
  SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月,
         SUM(個数) AS 出庫数
  FROM APP4228
  GROUP BY 年月
),
月次表示 AS (
  SELECT 年月,
         出庫数
  FROM 月次
)
SELECT 年月,
       出庫数,
       LAG(出庫数) OVER (ORDER BY 年月) AS 前月
FROM 月次表示
ORDER BY 年月
```

Phase 1 の受入結果:

- `前月` の B128 警告あり
- pass-through CTE へ候補キーを一般伝播しない
- 値、行順、`columns`、`rowCount` は変更前と同一

#### G. `DISTINCT`

```sql
WITH 品目 AS (
  SELECT DISTINCT 製品名
  FROM APP4228
)
SELECT 製品名,
       LAG(製品名) OVER (ORDER BY 製品名) AS 前品目
FROM 品目
ORDER BY 製品名
```

Phase 1 の受入結果:

- `前品目` の B128 警告あり
- `DISTINCT` 由来の一意性を Phase 1 の根拠にしない

#### H. `UNION ALL`

```sql
WITH 品目別 AS (
  SELECT 製品名,
         SUM(個数) AS 合計
  FROM APP4228
  WHERE 入出庫区分 = '出庫'
  GROUP BY 製品名
  UNION ALL
  SELECT 製品名,
         SUM(個数) AS 合計
  FROM APP4228
  WHERE 入出庫区分 <> '出庫'
  GROUP BY 製品名
)
SELECT 製品名,
       合計,
       LAG(合計) OVER (ORDER BY 製品名) AS 前品目
FROM 品目別
ORDER BY 製品名
```

受入結果:

- `前品目` の B128 警告あり
- arm 間の同じ `製品名` を見逃さない

#### I. `UNION`

```sql
WITH 品目別 AS (
  SELECT 製品名,
         SUM(個数) AS 合計
  FROM APP4228
  WHERE 入出庫区分 = '出庫'
  GROUP BY 製品名
  UNION
  SELECT 製品名,
         SUM(個数) AS 合計
  FROM APP4228
  WHERE 入出庫区分 <> '出庫'
  GROUP BY 製品名
)
SELECT 製品名,
       合計,
       SUM(合計) OVER (ORDER BY 製品名) AS 累計
FROM 品目別
ORDER BY 製品名
```

Phase 1 の受入結果:

- `累計` の B127 警告あり
- `UNION` の全行重複排除を候補キーへ変換しない

#### J. consumer JOIN

```sql
WITH 品目別 AS (
  SELECT 製品名 AS 品名,
         SUM(個数) AS 合計
  FROM APP4228
  GROUP BY 製品名
)
SELECT p.品名,
       p.合計,
       r.日付,
       LAG(p.合計) OVER (ORDER BY p.品名) AS 前品目
FROM 品目別 p
JOIN APP4228 r
  ON p.品名 = r.製品名
ORDER BY p.品名, r.日付
```

受入結果:

- `前品目` の B128 警告あり
- JOIN による候補キー行の複製を見逃さない

#### K. 拡張 grouping

```sql
WITH 品目別 AS (
  SELECT 製品名,
         SUM(個数) AS 合計
  FROM APP4228
  GROUP BY ROLLUP(製品名)
)
SELECT 製品名,
       合計,
       LAG(合計) OVER (ORDER BY 製品名) AS 前品目
FROM 品目別
ORDER BY 製品名
```

受入結果:

- SQL が既存契約上成功する場合、`前品目` の B128 警告あり
- 既存エラーになる場合、そのエラーを維持
- `ROLLUP` を plain `GROUP BY` 候補キーとして扱わない

#### L. サブテーブル

```sql
WITH 商品別 AS (
  SELECT 商品コード,
         SUM(数量) AS 合計
  FROM APP148S$明細
  GROUP BY 商品コード
)
SELECT 商品コード,
       合計,
       LAG(合計) OVER (ORDER BY 商品コード) AS 前商品
FROM 商品別
ORDER BY 商品コード
```

Phase 1 の受入結果:

- `前商品` の B128 警告あり
- サブテーブル source の候補キーを生成しない

#### M. 一時テーブル

```sql
CREATE TEMP TABLE #月次 AS
SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月,
       SUM(個数) AS 出庫数
FROM APP4228
GROUP BY 年月;

SELECT 年月,
       出庫数,
       LAG(出庫数) OVER (ORDER BY 年月) AS 前月
FROM #月次
ORDER BY 年月;
```

Phase 1 の受入結果:

- 2文目の `前月` に B128 警告あり
- 値、行順、`columns`、`rowCount` は変更前と同一
- 一時テーブルの作成・参照・破棄 lifecycle を変更しない

### 10.5 空結果

mock fixture で `WHERE` が0行になる次の構造も確認する。

```sql
WITH 月次 AS (
  SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月,
         SUM(個数) AS 出庫数
  FROM APP4228
  WHERE 入出庫区分 = '__存在しない値__'
  GROUP BY 年月
)
SELECT 年月,
       出庫数,
       LAG(出庫数) OVER (ORDER BY 年月) AS 前月
FROM 月次
ORDER BY 年月
```

受入結果:

- 候補キーは現在の行数ではなくクエリ構造から生成される
- `前月` の B128 警告なし
- `rows = []`
- `rowCount = 0`
- `columns = ["年月", "出庫数", "前月"]`

### 10.6 全 SQL 共通の回帰条件

前項までの全 SQL について次を満たす。

1. B140 実装前後で `rows` の値が同一
2. B140 実装前後で行順が同一
3. B140 実装前後で `columns` が同一
4. B140 実装前後で `rowCount` が同一
5. B140 対象外の warning が同一
6. B140 対象外のエラー種別・本文が同一
7. `ORDER BY` へ hidden tie-break key が追加されていない
8. API の query、取得件数、呼び出し順が変更されていない

---

## 11. comparator と grouping equality

候補キー証明は、grouping tuple で異なる2行が、ウィンドウの既存 comparator でも同順にならないことを前提とする。

実装時に、同じ materialized scalar columnについて次を確認する。

- plain `GROUP BY` が同値とみなす値
- materialized row に保存される値
- window `ORDER BY` が同順とみなす値

これらの equality semantics が一致しない型または表現が確認された場合、その型を Phase 1 の候補キー証明から fail-closed で除外する。実行時の全行 tie 検査へ切り替えてはならない。

特に数値について、表示文字列が異なるが既存 comparator では同値になる値が存在しないかを実測する。

---

## 12. 実装時の変更範囲

少なくとも次を対象とする。

1. B148 canonical identity を producer の出力列対応にも再利用できる形にする
2. plain `GROUP BY` の解決 plan と SELECT 列位置から候補キーを生成する
3. `SelectResult` の内部 relation metadata に候補キーを関連付ける
4. warning merge の clone 時に候補キーを引き継ぐ
5. CTE 実体化時に候補キーを `MaterializedTable` へ保存する
6. 単一 CTE consumer のウィンドウ全順序判定へ候補キーを渡す
7. B127 / B128 の両方へ同じ証明結果を適用する
8. UNION、JOIN、多段伝播、一時テーブル等で候補キーを失効させる
9. 公開 `SelectResult` の schema を変更しない

B148 canonicalizer と意味の異なる複製実装を作ってはならない。

---

## 13. Claude が実測すべき未確認事項

本仕様作成ではコード実行、テスト、kSQL MCP、git 操作を行っていない。次は未確認であり、Claude が実装前後に実測する。

### 13.1 主用途

- APP4228 の主用途が引き続き13行になること
- B128 の偽陽性だけが消えること
- 同じ CTE の B127 偽陽性も消えること
- 各行の `年月`、`出庫数`、`前月`、`累計` が変更前と同じこと
- top-level `ORDER BY 年月` の行順が変更前と同じこと

### 13.2 identity と出力列の対応

次を別々に測る。

- `PHYSICAL`
- `ALIAS_SAFE`
- `EXPRESSION`
- field alias
- literal alias
- 算術式 alias
- `CASE` alias
- 日付・文字列関数 alias
- `SUBSTR` / `SUBSTRING`
- `||` 連結
- scalar subquery alias
- batch 変数解決後の alias
- 修飾参照から非修飾出力
- 非修飾参照から修飾表記
- 余分な括弧
- 空白差
- `1` / `1.0`

B148 で実測済みの8形について、B140 の producer-output 対応でも同じ canonical identity が使われることを確認する。

### 13.3 adversarial cases

- 物理フィールド名と SELECT alias の衝突
- `UPPER(k) AS k GROUP BY k`
- `SELECT k, SUM(v) AS k ... GROUP BY k`
- 同じ grouping expression を異なる2列へ射影した場合
- 複合キーの一部だけを射影した場合
- 複合キーの一部だけを rename した場合
- wildcard と明示列の出力衝突
- canonical identity を作れない式
- 0行 relation
- 1行 relation
- grouping key に空値・null 相当値がある relation

いずれも、証明できない場合は警告が残り、偽陰性を作らないことを確認する。

### 13.4 comparator equality

次の異なる grouping 値が window comparator で同順にならないことを確認する。

- number の表記差
- date / datetime
- ASCII の大文字・小文字
- 全角・半角
- 空文字
- choice field
- 日本語文字列
- canonical string function の結果

同順になる組が確認された型は、静的に安全条件を追加できるまで候補キー証明から除外する。

### 13.5 metadata の lifecycle

- warning が0件で clone されない producer
- warning が追加され clone される producer
- producer 自身が B127/B128 warning を持つ場合
- CTE キャッシュへ保存した後
- 先行 CTE と後続 CTE がある場合
- CTE 名と一時テーブル名が同じ batch に存在する場合
- 0行 CTE
- CTE consumer の列メタ capture 有無
- 単一 CTE インライン化候補
- optimizer により materialization 経路が変わる場合

候補キーが別 relation へ漏れず、必要な clone でだけ保持されることを確認する。

### 13.6 除外経路

次で警告が残ることを B127 / B128 の両方で確認する。

- `DISTINCT`
- pass-through 多段 CTE
- rename 多段 CTE
- 式変換多段 CTE
- `UNION`
- `UNION ALL`
- producer JOIN
- consumer JOIN
- `ROLLUP`
- `CUBE`
- `GROUPING SETS`
- サブテーブル
- 一時テーブル
- wildcard
- 重複出力名
- `ORDER BY` 式
- 複合候補キーの一部だけ

### 13.7 回帰

- direct APP の `$id` 証明
- direct APP の `RECORD_NUMBER` 証明
- direct APP の非一意 `ORDER BY`
- B127 の既存 warning matrix
- B128 の既存 warning matrix
- CTE / UNION / JOIN の既存値
- CTE の既存 `columns`
- 一時テーブル batch
- B148 の ordinary dependency validation
- B65 の拡張 grouping
- build
- typecheck
- unit test
- CLI smoke
- plugin/browser smoke

特に browser/plugin の公開結果について、warning 以外の値・行順・列表示が変わっていないことを確認する。

---

## 14. Claude レビュー（2026-08-07・実測つき）

**結論＝実装着手可。指摘 1 件（中）。規則・除外・受入に問題は無い。**

**作成は codex、レビューは Claude**（[分担変更](ksql_b148_bare_column_group_by_issue.md)の 1 件目）。

### 14.1 【中】§11 の懸念は**数値列で現実**。論点を 1 つに絞れる

**§11 は「grouping equality と window comparator の equality が一致しない型があれば
fail-closed で除外する」と書き、実装時に確かめよと残した。実測した。**

**文字列列＝一致する（問題なし）**

```
WITH m AS (SELECT CASE WHEN 個数 > 100 THEN '10' ELSE '2' END AS k, … GROUP BY k)
SELECT k FROM m ORDER BY k        → 10, 2      ＝コードポイント順
同 '1' / '01'                      → 01, 1     ＝同順にならない
```

**comparator は文字列比較で、グループ化の同値（格納文字列の一致）と一致する。**

**数値列＝comparator は数値比較（一致しない可能性がある）**

```
WITH m AS (SELECT 個数 AS k, COUNT(*) AS c FROM APP4228 GROUP BY 個数)
SELECT k FROM m ORDER BY k LIMIT 40   → 10, 11, …, 19, 20, …, 49
```

**データには `193` / `340` / `646` があるのに、`19` の直後は `20`。**
**文字列順なら `19` の次は `193`。したがって数値比較である。**

**帰結**＝**数値列では「異なる格納値が数値的に等しい」ペアが存在すると、
候補キーは一意なのに comparator では同順になり、証明が不健全になる**
（偽陰性＝出すべき警告を消す）。

**残る論点は 1 つに絞れる。**

> **kintone の `NUMBER` フィールドで、異なる格納値が数値的に等しくなり得るか**
> （`1` と `1.0`、`1` と `01`、`+1` と `1` 等）。

**`DATE_FORMAT` などの文字列式は文字列比較になる**ので対象外。
**`GROUP BY <NUMBER 項目>` と、数値になる `EXPRESSION` キー**だけが対象。

**R3 への反映案**＝§11 を
「**全型を実装時に確かめる**」から
「**数値になる候補キー列について、kintone の格納正規化を確かめる。
正規化されないなら数値型を Phase 1 から除外する**」へ絞る。

### 14.2 実測で確かめて問題が無かったもの

| 項目 | 結果 |
|---|---|
| **修飾参照の consumer**（`FROM 月次 t … ORDER BY t.年月`） | **実在し、いま警告が出る**。§7.1 が正しく対象に含めている |
| **consumer の SELECT 別名**（`SELECT 年月 AS m … ORDER BY m`） | **構文として存在しない**（`unknown field code(s): m`）。**規則を書く必要が無い** |
| 主用途（CTE ＋ `LAG`） | 13 行・値は正しい・B128 の警告が出る（偽陽性）＝§2.1 のとおり |
| 同じ CTE の `SUM(...) OVER` | B127 の警告も出る＝§2.1 のとおり |

### 14.3 良かった点（R3 で消さないこと）

- **§7.3 が `$id` 関数従属との合流を明確に断っている。**
  **「`$id` が一意 → 任意の列も関数従属 → その列の `ORDER BY` も全順序」の最後の含意は成立しない**
  という理由づけが正しい。**[B148 R3 §9.2](ksql_b148_bare_column_group_by_spec_r3.md) は
  「B140 の候補キーを B148 Phase 2 で使える」と書いたが、逆向き（B140 が `$id` を使う）は別物**である
- **§5.2 の共通前提が fail-closed で十分**（JOIN・サブテーブル・wildcard・`DISTINCT`・重複出力名・
  B148 の検査成功を全部要求している）
- **§11 を自分で立てたこと。** **証明の健全性の前提**であり、
  これを書かずに実装すると**偽陰性を作る**
- **§8 で文言を変えない判断。** **B140 の目的は偽陽性を減らすことで、文言では解決しない**
- **§12 の「B148 canonicalizer と意味の異なる複製実装を作ってはならない」**。
  **同じ規則を 2 か所に書くのは、この 1 週間で何度も踏んだ形**
- **§4.2 の「出力 alias の文字列だけが一致するもの」を使わない**。
  **B148 の R1 が名前一致で崩れた教訓が効いている**

### 14.4 §13（Claude の実測）のうち、既に済んでいるもの

| §13 | 状態 |
|---|---|
| 13.1 主用途が 13 行・値が正しい | **実測済み**（v3.57.0） |
| 13.2 の canonical 8 形 | **[B148 で実測済み](ksql_b148_plugin_browser_check.md)**。B140 でも同じ道具を使うので流用できる |
| 13.4 comparator equality | **文字列は済み。数値は §14.1 のとおり論点を絞った** |
