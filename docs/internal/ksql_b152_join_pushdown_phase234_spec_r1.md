# B152 JOIN 押し下げ Phase 2〜4 仕様（R1）

- ステータス: **R1 正本**
- 対象: kSQL v3.59.0
- 実装候補版: **v3.60.0**
- リリース方針: **B151 と同梱**
- 起票: [B152](ksql_b152_join_pushdown_all_types_issue.md)
- 関連: [B151 R1](ksql_b151_join_number_pushdown_spec_r1.md) / [B76 Phase A](ksql_b76_join_pushdown_phase_a_spec.md) / [B84](ksql_b84_pushdown_visibility_spec.md)
- 初版: 2026-08-07
- SemVer: **minor**
- 対象 Phase:
  - Phase 2: 日付・時刻・日時系
  - Phase 3: `SINGLE_LINE_TEXT` / `LINK`
  - Phase 4: ユーザー・組織・グループ・作業者系

---

## 0. R1 の位置づけ

B152 は、B151 で確立した「server と JOIN 後 local evaluator の意味論が一致する direct field-vs-literal leaf を、比較式を変形せず `exact` prefilter として使用する」という原則を、日付・時刻、単一行文字列、ユーザー系フィールドへ拡張する性能改善である。

対象は、alias 付き物理 APP だけを入力にする `INNER JOIN` の `WHERE` にある、単一 APP が所有する直接フィールド参照である。

例:

```sql
SELECT m.製品名, t.日付, t.主担当
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.日付 >= '2026-01-01'
  AND t.主担当 IN ('rex0220')
ORDER BY t.$id
```

B152 前は、日付系の `=` と `SINGLE_LINE_TEXT` の `=` だけが `superset`、それ以外の本仕様対象は原則 `unsafe` であり、JOIN 前の APP 取得件数を減らせない。

B152 後は、型別の canonical literal 条件と実機一致条件を満たす leaf を、そのまま records API query へ送る。

```text
日付 >= "2026-01-01" and 主担当 in ("rex0220")
```

B152 は結果集合を変更しない。変更するのは次だけである。

- JOIN 前の取得候補数
- JOIN pushdown leaf の `relation`
- `EXPLAIN` の query、relation、fetch scope
- B84 公開表と関連文書

通常述語について元の `WHERE` を JOIN 後に再評価する B76 の residual 契約は維持する。widening、literal の補正、タイムゾーン変換、文字列正規化は行わない。

---

## 1. 目的

B152 Phase 2〜4 の目的は次のとおりである。

1. `DATE` / `TIME` / `DATETIME` / `CREATED_TIME` / `UPDATED_TIME` の canonical string literal に対する `=` / `!=` / `<>` / `<` / `>` / `<=` / `>=` を `exact` にする。
2. `SINGLE_LINE_TEXT` / `LINK` の非空 string literal に対する `=` / `!=` / `<>` / `IN` / `NOT IN` を `exact` にする。
3. `CREATOR` / `MODIFIER` / `USER_SELECT` / `ORGANIZATION_SELECT` / `GROUP_SELECT` / `STATUS_ASSIGNEE` の非空 code literal に対する `IN` / `NOT IN` を `exact` にする。
4. canonical 外 literal、空文字 literal、型不一致、メタ情報不足、プロセス管理無効などを fail-closed にする。
5. B84 公開表、言語リファレンス、歴史仕様、tracker、CHANGELOG、release 文書、smoke を同じ分類結果へ同期する。
6. B151 と同じ v3.60.0 に同梱し、NUMBER と Phase 2〜4 の JOIN pushdown 契約を一度に公開する。

公開上の原則は次とする。

> direct physical field と型に適合する canonical literal の比較は、kintone server と JOIN 後 local evaluator の集合が一致することを静的根拠と実機の3経路一致で確認できた組だけ、比較式を変形せず exact prefilter として使用する。

---

## 2. 根拠と確定範囲

### 2.1 コードから静的に確定していること

| 事実 | 根拠 |
|---|---|
| `SINGLE_LINE_TEXT`、`LINK`、日付・時刻・日時系、`CREATOR`、`MODIFIER` は `compareMode: "string"` になる | `src/core/fieldSemantics.ts:22-45` |
| string comparison は UTF-16 code unit 順ではなく Unicode code point 順である | `src/core/scalarCompare.ts:9-24` |
| string mode の全 scalar 演算子は同じ比較結果から判定される | `src/core/scalarCompare.ts:140-174` |
| canonical DATE `YYYY-MM-DD`、TIME `HH:mm`、DATETIME `YYYY-MM-DDTHH:mm:ssZ` は固定幅であり、code-point 順が暦・時刻順と一致する | `src/core/optimization/joinPredicatePushdown.ts:1139-1161`; `src/core/scalarCompare.ts:9-24` |
| 現行 JOIN classifier は DATE/TIME/DATETIME 系の canonical `=` だけを `superset` とする | `src/core/optimization/joinPredicatePushdown.ts:1074-1078` |
| 現行 JOIN classifier は非 canonical DATE/TIME/DATETIME literal を `unsafe` にする | `src/core/optimization/joinPredicatePushdown.ts:1139-1161` |
| 現行 JOIN classifier は `SINGLE_LINE_TEXT = 非空文字列` だけを `superset` とする | `src/core/optimization/joinPredicatePushdown.ts:1066-1071` |
| `LINK` は一般 WHERE capability では `SINGLE_LINE_TEXT` と同じ native operator 集合を持つが、JOIN classifier では未開放である | `src/core/optimization/whereCapability.ts:96-97`; `src/core/optimization/joinPredicatePushdown.ts:1066-1092` |
| kintone serializer は `<>` を `!=`、`IN` / `NOT IN` を `in` / `not in` へ変換する | `src/converter/whereToKintone.ts:74-100` |
| string literal 内の `\` と `"` は kintone query 用にそれぞれ `\\` と `\"` へエスケープされる | `src/converter/whereToKintone.ts:214-218` |
| `IN_LIST` の各 string literal にも同じ string serializer が使われる | `src/converter/whereToKintone.ts:305-317` |
| JOIN 後の filter は `applyFilter()` から `evalWhere()` を呼ぶ | `src/engine/process.ts:309-322,2089-2121` |
| direct field の scalar 比較は意味型を解決して `compareScalarValues()` へ到達する | `src/engine/evalWhere.ts:116-178` |
| `USER_SELECT` / `ORGANIZATION_SELECT` / `GROUP_SELECT` / `STATUS_ASSIGNEE` はオブジェクト配列として扱われる | `src/engine/evalWhere.ts:225-231` |
| `CREATOR` / `MODIFIER` は単一オブジェクトとして扱われる | `src/engine/evalWhere.ts:232` |
| ユーザー系 `IN` は表示名ではなく各オブジェクトの文字列 `code` と literal を比較する | `src/engine/evalWhere.ts:238-287` |
| 複数値ユーザー系の `IN` は配列要素のいずれかの `code` が list に含まれるかを判定する | `src/engine/evalWhere.ts:273-277` |
| `NOT IN` は型別 `IN` 判定の論理否定である | `src/engine/evalWhere.ts:145-159` |
| CREATOR/MODIFIER は単一オブジェクトの `code` を list と比較する | `src/engine/evalWhere.ts:279-280` |
| USER 系で code と表示名を区別する unit test がある | `src/engine/__tests__/evalWhere.test.ts:95-111` |
| 空のオブジェクト配列は、非空 list に対して `IN=false`、`NOT IN=true` になる | `src/engine/evalWhere.ts:273-277` |
| 一般 WHERE capability は CREATOR/MODIFIER、USER/ORGANIZATION/GROUP の `in` / `not in` を native operator として持つ | `src/core/optimization/whereCapability.ts:86-110` |
| `STATUS_ASSIGNEE` は local collection type だが、現行 `NATIVE_OPERATORS` に行がなく、単一表を含め `LOCAL_ONLY` になる | `src/core/optimization/whereCapability.ts:86-110,133-136,525-534`; `src/core/optimization/__tests__/whereCapability.test.ts:31,82` |
| JOIN runtime plan は全 APP の型メタを source snapshot に載せ、同じ plan を fetch と JS 評価へ使用する | `src/execute.ts:3931-3997,4000-4056,4936-4955` |
| 元の statement と field type / semantics resolver は JOIN 後の `runFullScan()` へ渡される | `src/execute.ts:5082-5106` |

### 2.2 JOIN 後の残余 WHERE が通る経路

日付・時刻・TEXT の direct field-vs-string-literal leaf は次の経路を通る。

```text
executeFullScanSelect()
  → runFullScan()
  → applyJoin()
  → applyFilter()
  → evalWhere()
  → evalBinary()
  → semanticsForLeft()
  → evalOp()
  → compareScalarValues()
  → compareCanonicalValues()
  → compareCodePointStrings()
```

根拠:

- `src/execute.ts:5082-5106`
- `src/engine/process.ts:2089-2121`
- `src/engine/evalWhere.ts:116-178`
- `src/core/scalarCompare.ts:9-24,140-174`

ユーザー系 `IN` / `NOT IN` は次の経路を通る。

```text
executeFullScanSelect()
  → runFullScan()
  → applyJoin()
  → applyFilter()
  → evalWhere()
  → evalBinary()
  → evalOp()
  → typedInContains()
  → JSON.parse()
  → object.code membership
```

根拠:

- `src/engine/evalWhere.ts:145-159,225-287`
- `src/engine/process.ts:2089-2121`
- `src/execute.ts:4920-4933,5082-5106`

したがって、JOIN residual は単一表 FULL_SCAN と別の比較器を持たない。

### 2.3 起票・依頼で確定している実測

次は再導出せず、本仕様の前提として採用する。

1. DATE `< '2000-01-01'` は空セルを server/local の両方で含む。
2. DATE `>= '2000-01-01'` は空セルを server/local の両方で除外する。
3. TEXT `!= 'ほげ'` は空セルを server/local の両方で含む。
4. TEXT `IN (...)` は空セルを server/local の両方で除外する。
5. NUMBER の有限10進・空セル意味論は B151 で一致を確認済みである。
6. v3.0.0 の型付き比較契約は kintone 整合を設計目的とする。

根拠: `docs/internal/ksql_b152_join_pushdown_all_types_issue.md:8-24`

### 2.4 コードだけでは確定しないこと

次は kintone server の挙動であり、§12 の実測をリリース条件とする。

- DATETIME が `Z` 以外の offset literal をどう扱うか
- DATETIME の秒省略形を受理・正規化するか
- TEXT equality で大文字小文字、全角半角、Unicode 正規化を行うか
- `"` と `\` を含む query literal が serializer 後の値どおり比較されるか
- ユーザー・組織・グループのゲスト code 表現
- 存在しない code の query が空集合になるか、query error になるか
- プロセス管理無効時の `STATUS_ASSIGNEE` の fields metadata、records、query の挙動
- Phase 2〜4 の全対象組で server/local/単一表の3経路が一致すること

これらが一致しない型×演算子を、推測で `exact` にしてはならない。

---

## 3. 適用条件

B152 Phase 2〜4 は、次をすべて満たす leaf に適用する。

1. SELECT が alias 付き物理 APP だけを入力にする `INNER JOIN` である。
2. 左辺が単一の物理 APP に一意に所有される直接フィールド参照である。
3. `classifyWhereCapability()` が `EXACT_PUSHDOWN` と判定する。
4. 右辺が対象型に適合する string literal、または1件以上の string literal だけからなる `IN_LIST` である。
5. literal が型別の §4 canonical policy を通る。
6. owner のフィールド型を metadata から確定できる。
7. B76 の ownership、source kind、tree 合成、outer join、server-only function、KLIKE に関する既存 gate を通る。
8. ~~`STATUS_ASSIGNEE` はプロセス管理が有効であることまで確定できる。~~
   **【2026-08-07 失効・オーナー判断】** gate は課さず、プロセス無効時の kintone error を表面化する。
9. 実行と `EXPLAIN` が同じ runtime plan と serializer を使う。

次は対象外である。

- `LEFT JOIN` / `RIGHT JOIN`
- CTE、一時テーブル、サブテーブル仮想表、派生表、入れ子 SELECT
- field-to-field 比較
- 算術式、関数、CASE、集計、window 結果を左辺にする比較
- scalar subquery
- `IN (SELECT ...)` の JOIN prefilter
- 未解決変数を含む leaf
- 空の `IN_LIST`
- 型不一致 literal
- metadata で型を確定できない field
- canonical policy に違反する literal
- residual elimination
- widening、lower/upper-case 化、Unicode normalization、TZ 変換

---

## 4. 型別の意味論契約

### 4.1 DATE

許可 literal は実在する暦日を表す次の固定形式だけとする。

```text
YYYY-MM-DD
```

判定は既存 `isCanonicalDate()` と同じである。

- 年: 4桁
- 月: 2桁、01〜12
- 日: 2桁、その年月に実在する日
- 区切り: `-`
- 前後空白なし
- 時刻・TZ なし

例:

| literal | 判定 |
|---|---|
| `2026-08-07` | 許可 |
| `2024-02-29` | 許可 |
| `2026-2-7` | 拒否 |
| `2026-02-29` | 拒否 |
| `2026/08/07` | 拒否 |
| ` 2026-08-07` | 拒否 |
| 空文字 | 拒否 |

固定幅 canonical DATE は code-point 順と暦順が一致するため、実機の3経路一致を満たした後は6比較演算子を `exact` とする。

### 4.2 TIME

許可 literal は次の固定形式だけとする。

```text
HH:mm
```

判定は既存 `isCanonicalTime()` と同じである。

- 時: 00〜23
- 分: 00〜59
- 秒なし
- TZ なし
- 前後空白なし

例:

| literal | 判定 |
|---|---|
| `00:00` | 許可 |
| `09:30` | 許可 |
| `23:59` | 許可 |
| `9:30` | 拒否 |
| `24:00` | 拒否 |
| `09:30:00` | 拒否 |
| 空文字 | 拒否 |

### 4.3 DATETIME / CREATED_TIME / UPDATED_TIME

許可 literal は次の canonical UTC 形式だけとする。

```text
YYYY-MM-DDTHH:mm:ssZ
```

判定は既存 `isCanonicalDateTime()` と同じである。

- DATE 部分は §4.1 の canonical DATE
- 時: 00〜23
- 分・秒: 00〜59
- UTC を示す末尾 `Z` 必須
- 小数秒なし
- offset 表現なし
- 秒省略なし
- 前後空白なし

例:

| literal | 判定 |
|---|---|
| `2026-08-07T00:00:00Z` | 許可 |
| `2026-08-07T23:59:59Z` | 許可 |
| `2026-08-07T09:00:00+09:00` | 拒否 |
| `2026-08-07T00:00Z` | 拒否 |
| `2026-08-07 00:00:00Z` | 拒否 |
| `2026-08-07T00:00:00.000Z` | 拒否 |
| 空文字 | 拒否 |

offset literal や秒省略形を server が同値化するとしても、B152 classifier は正規化しない。SQL literal と local residual が同じ文字列を比較する契約を守るため、canonical 外は `unsafe` とする。

### 4.4 SINGLE_LINE_TEXT / LINK

対象演算子は次である。

```text
=, !=, <>, IN, NOT IN
```

範囲比較は開放しない。kintone の native operator 表が TEXT/LINK の `<` / `>` / `<=` / `>=` を受けないためである。

literal policy:

1. string literal だけを許可する。
2. scalar は非空文字列だけを許可する。
3. `IN` / `NOT IN` は1件以上の非空 string literal だけを許可する。
4. `"` と `\` は禁止せず、既存 serializer でそれぞれ `\"` と `\\` へ変換する。
5. serializer 前後で値を正規化しない。
6. 大文字小文字、全角半角、Unicode normalization、空白を変更しない。
7. 空文字 literal は B152 の対象外とし、従来どおり residual または既存単一表経路へ委ねる。

TEXT/LINK の `=` / `!=` / `IN` / `NOT IN` を `exact` にする条件は、§12 の正規化・エスケープ実測がすべて一致することである。

もし server が大文字小文字、全角半角、Unicode normalization のいずれかを local code-point equality と異なる形で同値化する場合、その型について次を維持する。

- `=`: 現行安全性を再確認したうえで `superset` のまま
- `!=` / `<>`: `unsafe`
- `IN` / `NOT IN`: `unsafe`
- B84 公開表: 開放しないセルは `✕`

補集合演算である `!=` / `NOT IN` を、`=` / `IN` の superset 証明だけから開放してはならない。

### 4.5 ユーザー・組織・グループ系

> **【2026-08-07・レビューで見送り確定＝GAIA_IL26 実測。B54 後に再評価】**
> Phase 4 は今回実装せず、以下は将来の再評価用契約として保持する。

> **【2026-08-07・オーナー判断で撤回】** kintone のレコード取得の型×演算子表との
> 全面整合を優先し、ユーザー系6型の `IN` / `NOT IN` を `exact` で開放する。
> code は逐語・非空 literal のみ、`name` は使わない。存在しない code の query error は
> 単一表と同様に表面化し、silent retry しない。

対象型:

- `CREATOR`
- `MODIFIER`
- `USER_SELECT`
- `ORGANIZATION_SELECT`
- `GROUP_SELECT`
- `STATUS_ASSIGNEE`

対象演算子:

```text
IN, NOT IN
```

値契約:

| 型 | flatten 後の値 | local membership |
|---|---|---|
| `CREATOR` / `MODIFIER` | `{code,name}` の JSON 文字列 | 単一オブジェクトの `code` |
| `USER_SELECT` / `ORGANIZATION_SELECT` / `GROUP_SELECT` / `STATUS_ASSIGNEE` | `[{code,name},...]` の JSON 文字列 | いずれかの要素の `code` |

表示名 `name` は比較に使わない。

```sql
主担当 IN ('rex0220')
```

は `code === "rex0220"` の要素を1件以上持つ行に一致する。表示名が `開発太郎` であっても、次は一致しない。

```sql
主担当 IN ('開発太郎')
```

`NOT IN` はこの membership の否定であり、「すべての要素の code が list に含まれない」場合に true となる。

literal policy:

1. 1件以上の string literal list だけを許可する。
2. 各 literal は非空とする。
3. `name` ではなく code として扱う。
4. optionOrder やフォーム選択肢による実在検証は行わない。
5. 通常 code とゲスト code を同じ文字列完全一致として扱う。
6. ゲスト code の具体形式は §12 の実測で確定し、保存された `.code` と query literal が逐語一致する形だけを許可する。
7. code の大文字小文字、slash、記号を変更しない。
8. 空文字を含む list は B152 の対象外とする。
9. malformed JSON や `code` 欠落を exact 証明に含めない。

ユーザー系には P2a の optionOrder 相当の有限選択肢集合がない。実在検証は exact membership の必要条件ではないため追加しない。ただし、存在しない code を kintone query が error にする実測結果となった場合は、全件取得 retry で隠さず、その literal を安全に判定できる仕組みが入るまで対象型を `unsafe` に戻す。

### 4.6 STATUS_ASSIGNEE

> **【2026-08-07・レビューで見送り確定＝GAIA_IL26 実測。B54 後に再評価】**
> classifier、where capability、process-enabled gate は今回変更しない。

> **【2026-08-07・オーナー判断で撤回】** `STATUS_ASSIGNEE` も `IN` / `NOT IN` を
> native capability と JOIN exact prefilter に追加する。追加 metadata 取得は行わず、
> プロセス無効時の kintone error も単一表と同様に表面化する。

> **【2026-08-07・以下の process gate 要件は失効】** 上のオーナー判断（撤回注記）により、
> 以下 1〜4 と末尾の「gate より先に query を生成してはならない」は**実装しない**。
> 現行契約＝`NATIVE_OPERATORS` に `in` / `not in` を追加し、追加 metadata 取得なし・
> プロセス無効アプリへの query は kintone error として表面化（単一表と同一）。
> 5〜7（synthetic field を作らない・既存 validation error 維持・独自エラーを増やさない）は維持。

`STATUS_ASSIGNEE` は、プロセス管理が有効なアプリにだけ存在する record-level field として扱う。

現行 `loadTypedPushdownMeta()` は `STATUS` 候補について `status.json` を取得するが、`STATUS_ASSIGNEE` について同じ有効性確認をしていない。

B152 では次を必須とする（**1〜4 は上記注記により失効**）。

1. ~~`STATUS_ASSIGNEE` が候補に含まれる場合、キャッシュ付き `getProcessStatuses()` で `enable` を確認する。~~
2. ~~`enable === true` の場合だけ、JOIN source metadata に pushdown 対象として載せる。~~
3. ~~`enable === false`、応答不完全、メタ取得失敗、型不明の場合は `unsafe` とする。~~
4. ~~プロセス管理無効アプリに対して `STATUS_ASSIGNEE in (...)` を records API query へ送らない。~~
5. 存在しない field を synthetic に作らない。
6. SQL 自体が存在しない field を参照している場合は、既存の field validation error を維持する。
7. 単に pushdown 判定不能な場合は元の residual 評価へ戻し、押し下げのための独自エラーを増やさない。

`STATUS_ASSIGNEE` を開放するため、一般 WHERE capability の `NATIVE_OPERATORS` にも `in` / `not in` を追加する。

---

## 5. 開放する型×演算子

relation は、§12 の実機 gate を通過した型について次のとおりとする。

| フィールド型 | `=` | `!=` / `<>` | `<` | `>` | `<=` | `>=` | `IN` | `NOT IN` |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `DATE` | exact | exact | exact | exact | exact | exact | unsafe | unsafe |
| `TIME` | exact | exact | exact | exact | exact | exact | unsafe | unsafe |
| `DATETIME` | exact | exact | exact | exact | exact | exact | unsafe | unsafe |
| `CREATED_TIME` | exact | exact | exact | exact | exact | exact | unsafe | unsafe |
| `UPDATED_TIME` | exact | exact | exact | exact | exact | exact | unsafe | unsafe |
| `SINGLE_LINE_TEXT` | exact | exact | unsafe | unsafe | unsafe | unsafe | exact | exact |
| `LINK` | exact | exact | unsafe | unsafe | unsafe | unsafe | exact | exact |
| `CREATOR` | unsafe | unsafe | unsafe | unsafe | unsafe | unsafe | exact | exact |
| `MODIFIER` | unsafe | unsafe | unsafe | unsafe | unsafe | unsafe | exact | exact |
| `USER_SELECT` | unsafe | unsafe | unsafe | unsafe | unsafe | unsafe | exact | exact |
| `ORGANIZATION_SELECT` | unsafe | unsafe | unsafe | unsafe | unsafe | unsafe | exact | exact |
| `GROUP_SELECT` | unsafe | unsafe | unsafe | unsafe | unsafe | unsafe | exact | exact |
| `STATUS_ASSIGNEE` | unsafe | unsafe | unsafe | unsafe | unsafe | unsafe | exact | exact |

> **【2026-08-07・レビューで見送り確定＝GAIA_IL26 実測。B54 後に再評価】**
> 上表のユーザー系6型（`CREATOR` から `STATUS_ASSIGNEE`）の `IN` / `NOT IN` は
> 今回は開放せず、実装および B84 公開表ではすべて `unsafe` / `✕` を維持する。

> **【2026-08-07・オーナー判断で上記を撤回】** ユーザー系6型は表どおり `exact` で開放する。
> さらに `CALC` / `RECORD_NUMBER` は8演算子を `superset` で開放し、取得後に再評価する。
> literal は B151 numeric policy の数値または非空文字列（list は非空・同種のみ）。書式・値・
> code が不正な指定の kintone query error は表面化する。

`<>` は serializer 上 `!=` となり、relation も `!=` と同じである。

### 5.1 開けない組

| 組 | 理由 |
|---|---|
| DATE/TIME/DATETIME 系の `IN` / `NOT IN` | kintone native operator 表が受けない |
| TEXT/LINK の範囲比較 | kintone native operator 表が受けない |
| ユーザー系の scalar comparison | kintone は `in` / `not in` だけを受ける |
| 空文字 literal | Phase 2〜4 の exact 証明対象外 |
| 非 canonical 日付・時刻・日時 | server normalization と local literal の逐語比較が一致する保証がない |
| LIKE / NOT LIKE | v2.0.0 以降の意図的 local 統一を維持する |
| KLIKE / NOT KLIKE | 既存の別契約を維持する |
| CATEGORY | kintone が比較 operator を受けない |
| MULTI_LINE_TEXT / RICH_TEXT / FILE | 対象比較 operator を受けない |
| CALC | 表示書式による値領域差が未証明 |
| RECORD_NUMBER | アプリコード付き表示値の値領域が未証明 |

> **【2026-08-07・オーナー判断】** 上表の CALC / RECORD_NUMBER は「未証明だから閉じる」を
> 撤回し、単一表との一致を優先して `superset` で開放する。CALC の時間書式等と
> RECORD_NUMBER のアプリコード形式を含む順序は kintone 準拠（単一表と同一）とし、
> kintone の候補取得後に元の WHERE を再評価する。

---

## 6. 空セル契約

以下は右辺または list が非空 canonical literal である場合の固定表である。

### 6.1 日付・時刻・日時系

local string mode では空文字 `""` はすべての非空 canonical literal より小さい。

| 演算子 | 空セル |
|---|:---:|
| `=` | false |
| `!=` / `<>` | true |
| `<` | true |
| `>` | false |
| `<=` | true |
| `>=` | false |

DATE の `<` と `>=` は起票の実測値と一致する。

### 6.2 SINGLE_LINE_TEXT / LINK

| 演算子 | 空セル |
|---|:---:|
| `=` 非空 literal | false |
| `!=` / `<>` 非空 literal | true |
| `IN` 非空 list | false |
| `NOT IN` 非空 list | true |

TEXT の `!=` と `IN` は起票の実測値と一致する。

### 6.3 ユーザー系

非空 code list に対する空・未選択値は次とする。

| 型 | 空値 | `IN` | `NOT IN` |
|---|---|:---:|:---:|
| `USER_SELECT` / `ORGANIZATION_SELECT` / `GROUP_SELECT` / `STATUS_ASSIGNEE` | `[]` | false | true |
| `CREATOR` / `MODIFIER` | 空または形不一致 | false | true |

CREATOR/MODIFIER は通常 record 上で非空だが、LEFT JOIN 欠損側や異常入力を含む対照試験では同じ結果を固定する。

空文字を list に含む `IN ('')` / `NOT IN ('')` は既存の選択系空セル契約があるが、B152 exact pushdown の対象には含めない。

---

## 7. 実装要件

### 7.1 canonical literal policy

既存の次の判定を reusable policy として切り出すか、同一ロジックを一つの公開されない pure helper に集約する。

- `isCanonicalDate`
- `isCanonicalTime`
- `isCanonicalDateTime`

`=` 用と range 用に別の正規表現を複製して drift を作ってはならない。

pure policy の unit test は最低限次を含む。

- DATE の閏年、存在しない日、桁不足
- TIME の `00:00`、`23:59`、`24:00`、秒付き
- DATETIME の `Z`、offset、秒省略、小数秒
- 前後空白
- 空文字

### 7.2 JOIN classifier

`classifySupportedLeaf()` を次の順で判定する。

1. LIKE 系、KLIKE 系、`$id`、RECORD_NUMBER、NUMBER の既存分岐
2. Phase 2 の date/time policy
3. Phase 3 の text/link policy
4. 既存 selection policy
5. Phase 4 の user-code list policy
6. その他は `unsafe`

B151 の NUMBER policy、`$id`、既存 selection、KLIKE を回帰させない。

### 7.3 where capability

次を確認・修正する。

- Phase 2 と Phase 3 は現行 native operator map と一致していること
- CREATOR/MODIFIER、USER/ORGANIZATION/GROUP は現行 map を維持すること
- `STATUS_ASSIGNEE` に `in` / `not in` を追加すること
- ~~`STATUS_ASSIGNEE` の process-enabled gate を capability の無条件開放と混同しないこと~~
  **【2026-08-07 失効・オーナー判断】** gate なしの開放が現行契約（エラーは表面化）
- local contract と native contract の両方を通った場合だけ JOIN classifier へ進むこと

### 7.4 serializer

既存 serializer を変更せず再利用する。

- `<>` → `!=`
- SQL string → kintone double-quoted string
- `\` → `\\`
- `"` → `\"`
- `IN` list は comma 後の空白なし
- field alias は records API query へ送る直前に除去

literal を lower-case、upper-case、NFC/NFD、全角半角、UTC へ変換してはならない。

### 7.5 relation

対象 leaf は `exact` とする。

同一 alias の `AND` で、対象 exact leaf と既存 superset leaf を合成した plan item 全体は従来どおり `superset` となる。

```text
exact AND exact       → exact
exact AND superset    → superset
superset AND exact    → superset
```

### 7.6 residual

通常の B152 leaf は、exact であっても元の `WHERE` から除去しない。JOIN 後に同じ literal と field metadata で再評価する。

server-only function の第5-W / 第5-L による既存 residual 除去だけを例外とし、B152 を理由に範囲を広げない。

### 7.7 fail-closed

次は `unsafe` とする。

- 型 metadata なし
- 曖昧な非修飾 field
- APP 以外の source
- literal 型不一致
- canonical 外
- 空文字
- 空 list
- list 内の number、function、未解決 variable 混在
- process disabled / unknown の `STATUS_ASSIGNEE`
- serializer error
- owner 再検査不一致

records API error を捕捉して全件取得へ黙って retry し、誤った classifier を隠してはならない。

---

## 8. `EXPLAIN` 契約

### 8.1 DATE range

```sql
EXPLAIN
SELECT m.製品名, t.日付
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.日付 >= '2026-01-01'
ORDER BY t.$id
```

APP4228 側:

```text
kintone query: 日付 >= "2026-01-01"
fetch: EXACT
pushdown applied: 日付 >= "2026-01-01"
relation: exact
```

### 8.2 DATETIME

```sql
EXPLAIN
SELECT m.製品名, t.更新日時
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.更新日時 < '2026-08-08T00:00:00Z'
ORDER BY t.$id
```

```text
kintone query: 更新日時 < "2026-08-08T00:00:00Z"
fetch: EXACT
pushdown applied: 更新日時 < "2026-08-08T00:00:00Z"
relation: exact
```

offset literal は適用しない。

```sql
WHERE t.更新日時 < '2026-08-08T09:00:00+09:00'
```

この leaf は `join pushdown not applied:` 側へ出す。

### 8.3 TEXT escape

SQL literal が `A"\B` の場合:

```sql
EXPLAIN
SELECT m.製品名, t.件名
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.件名 = 'A"\B'
ORDER BY t.$id
```

実 serializer 形:

```text
kintone query: 件名 = "A\"\\B"
fetch: EXACT
pushdown applied: 件名 = "A\"\\B"
relation: exact
```

### 8.4 TEXT IN

```sql
WHERE t.件名 IN ('A', 'B')
```

```text
kintone query: 件名 in ("A","B")
fetch: EXACT
pushdown applied: 件名 in ("A","B")
relation: exact
```

### 8.5 USER_SELECT

```sql
WHERE t.主担当 IN ('rex0220', 'guest/example')
```

```text
kintone query: 主担当 in ("rex0220","guest/example")
fetch: EXACT
pushdown applied: 主担当 in ("rex0220","guest/example")
relation: exact
```

ゲスト code は §12 の実測で確定した実値を使用する。

### 8.6 混合 relation

```sql
WHERE t.日付 >= '2026-01-01'
  AND t.既存Superset列 = 'A'
```

alias 全体:

```text
fetch: PREFILTERED
relation: superset
```

個々の B152 leaf が exact であることと、合成 item の relation を混同してはならない。

---

## 9. 公開文書と歴史資料の同期

### 9.1 B84 公開表

`docs/ksql_language_reference.md` の B84 marker 内を、分類器から生成した次のセルへ更新する。

```markdown
| `CREATED_TIME` | ○ | ○ | ○ | ○ | ○ | ○ | ✕ | ✕ |
| `CREATOR` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ○ | ○ |
| `DATE` | ○ | ○ | ○ | ○ | ○ | ○ | ✕ | ✕ |
| `DATETIME` | ○ | ○ | ○ | ○ | ○ | ○ | ✕ | ✕ |
| `GROUP_SELECT` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ○ | ○ |
| `LINK` | ○ | ○ | ✕ | ✕ | ✕ | ✕ | ○ | ○ |
| `MODIFIER` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ○ | ○ |
| `ORGANIZATION_SELECT` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ○ | ○ |
| `SINGLE_LINE_TEXT` | ○ | ○ | ✕ | ✕ | ✕ | ✕ | ○ | ○ |
| `STATUS_ASSIGNEE` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ○ | ○ |
| `TIME` | ○ | ○ | ○ | ○ | ○ | ○ | ✕ | ✕ |
| `UPDATED_TIME` | ○ | ○ | ○ | ○ | ○ | ○ | ✕ | ✕ |
| `USER_SELECT` | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ○ | ○ |
```

B84 parity test は、分類器ソースから型集合を導出し、実際の literal policy を通して表と比較する。

専用回帰として次を追加する。

- DATE 閏日・存在しない日
- TIME 境界
- DATETIME `Z` / offset / 秒省略
- TEXT 空文字拒否
- TEXT `"` / `\`
- TEXT list の空文字混在拒否
- USER 系の非空 code list
- USER 系の空文字混在拒否
- process disabled `STATUS_ASSIGNEE`

### 9.2 言語リファレンス

WHERE REST 押し下げ節へ次を明記する。

1. 日付・時刻系は canonical literal に限り6比較演算子が exact。
2. DATETIME は `YYYY-MM-DDTHH:mm:ssZ` だけが対象。
3. offset、秒省略、小数秒は押し下がらない。
4. TEXT/LINK は非空 literal による equality、inequality、IN が exact。
5. TEXT の範囲比較は押し下がらない。
6. string literal は値を正規化せず、kintone query 用 escape だけを行う。
7. ユーザー系は表示名でなく code を比較する。
8. 複数値ユーザー系は「いずれかの code を含む」意味論である。
9. `STATUS_ASSIGNEE` はプロセス管理有効時だけ対象。
10. 空文字 literal は B152 exact prefilter の対象外。
11. `LIKE` は従来どおり local、kintone keyword search は KLIKE を使う。
12. CALC / RECORD_NUMBER は未開放。

### 9.3 B76 失効注記

`docs/internal/ksql_b76_join_pushdown_phase_a_spec.md` の型×演算子表付近に日付付き注記を追加する。

```markdown
> **【B152 により失効・2026-08-07】**
> DATE / TIME / DATETIME / CREATED_TIME / UPDATED_TIME の canonical literal 比較、
> SINGLE_LINE_TEXT / LINK の非空 equality・IN、
> およびユーザー・組織・グループ・作業者系の非空 code IN は、
> B152 で server/local の型別意味論を再確認し exact prefilter 対象へ拡張した。
> 現行契約は B152 R1 を参照。
> B76 の ownership、tree 合成、outer join、source kind、residual 規則は維持する。
```

### 9.4 B84 歴史仕様

`docs/internal/ksql_b84_pushdown_visibility_spec.md` の旧 matrix にも、B152 で対象セルが失効した旨を注記する。歴史資料の当時の表を無言で現行値へ書き換えない。

### 9.5 同期対象

最低限次を監査する。

- `docs/ksql_issue_tracker.md`
- `docs/ksql_language_reference.md`
- `docs/internal/ksql_b76_join_pushdown_phase_a_spec.md`
- `docs/internal/ksql_b84_pushdown_visibility_spec.md`
- `CHANGELOG.md`
- `docs/ksql_release_history.md`
- `README.md`
- `release/README.txt`
- `src/mcp/index.ts` の説明・schema `.describe()`
- `scripts/mcp-smoke.mjs`
- CLI / plugin smoke の `EXPLAIN` 期待文字列
- `prod/manifest.json`
- package version
- release artifact

B151 と同梱するため、公開文書は「NUMBER だけ開放済み、Phase 2〜4 は未開放」という中間状態を残さない。

---

## 10. 受入用データ

検証 APP には、master と1対1で JOIN できるキーを持つ次の行を用意する。

### 10.1 日付・時刻

- 空セル
- canonical 境界の直前
- 境界と同値
- 境界の直後
- 閏日
- 日跨ぎ
- `00:00`
- `23:59`

### 10.2 DATETIME

- 空セル
- UTC 日境界の直前・同値・直後
- `00:00:00Z`
- `23:59:59Z`
- CREATED_TIME / UPDATED_TIME の既存値を挟む境界

### 10.3 TEXT / LINK

- 空セル
- ASCII 大文字・小文字
- 半角・全角
- NFC/NFD で見た目が近い文字
- 前後空白
- `"` を含む値
- `\` を含む値
- `"` と `\` の両方を含む値
- URL
- 同値、非同値、list 内、list 外

### 10.4 ユーザー系

- 通常 user code
- 複数 user を持つ USER_SELECT
- organization code
- group code
- guest user code
- 空配列
- list の先頭・中間・末尾で一致する行
- CREATED_BY / UPDATED_BY に相当する CREATOR/MODIFIER
- process enabled の STATUS_ASSIGNEE
- process disabled の対照 APP

検証用レコードを追加した場合は、実測後に削除し、フォーム・プロセス設定も元へ戻す。

---

## 11. 受入条件

### 11.1 3経路一致

各対象条件について次の3経路を比較する。

1. JOIN exact prefilter
2. JOIN leaf を residual にした FULL_SCAN 対照
3. 単一表 server 経路

JOIN exact prefilter:

```sql
SELECT t.$id, t.製品名, t.日付
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.日付 >= '2026-01-01'
ORDER BY t.$id
```

FULL_SCAN 対照:

```sql
SELECT t.$id, t.製品名, t.日付
FROM APP4229 AS m
JOIN APP4228 AS t ON m.製品名 = t.製品名
WHERE t.日付 >= '2026-01-01'
   OR t.製品名 LIKE '__B152_NO_MATCH__'
ORDER BY t.$id
```

単一表:

```sql
SELECT $id, 製品名, 日付
FROM APP4228
WHERE 日付 >= '2026-01-01'
ORDER BY $id
```

`__B152_NO_MATCH__` に一致する行がないことを事前に確認する。

3経路で次が一致しなければならない。

- `$id` 集合
- 行順
- 公開値
- `rowCount`
- error / warning
- 境界行の包含・除外
- 空セルの包含・除外

### 11.2 Phase 2 の全演算子

各日付・時刻型で次を逐語実行する。

```sql
field =  'canonical'
field != 'canonical'
field <> 'canonical'
field <  'canonical'
field >  'canonical'
field <= 'canonical'
field >= 'canonical'
```

全組で3経路一致し、`=` を含め `relation: exact` になること。

### 11.3 DATE の空セル両方向

最低限次を確認する。

```sql
日付 < '2000-01-01'
日付 >= '2000-01-01'
日付 != '2000-01-01'
日付 <= '2000-01-01'
```

期待:

- `<`: 空セルを含む
- `>=`: 空セルを除外
- `!=`: 空セルを含む
- `<=`: 空セルを含む

### 11.4 DATETIME canonical 外

次はすべて pushdown しない。

```sql
更新日時 = '2026-08-07T09:00:00+09:00'
更新日時 = '2026-08-07T00:00Z'
更新日時 = '2026-08-07T00:00:00.000Z'
更新日時 = '2026-08-07 00:00:00Z'
```

分類器 unit test と `EXPLAIN` の両方で固定する。

### 11.5 TEXT equality / inequality

最低限次を3経路で比較する。

```sql
件名 = 'ほげ'
件名 != 'ほげ'
件名 <> 'ほげ'
```

空セルについて `=` は除外、`!=` / `<>` は包含する。

### 11.6 TEXT IN / NOT IN

```sql
件名 IN ('A', 'B')
件名 NOT IN ('A', 'B')
```

空セルについて `IN=false`、`NOT IN=true` で3経路一致する。

### 11.7 TEXT escape

少なくとも次の実値を個別に保存し、逐語 SQL で比較する。

```text
A"B
A\B
A"\B
```

SQL、serializer 後 query、local right value、保存値の4者を記録する。

例:

```text
SQL literal value:    A"\B
server query value:   A\"\\B
local right value:    A"\B
stored value:         A"\B
```

escape 後 query 文字列そのものと、実際に返る rows の両方を受入対象とする。

### 11.8 TEXT normalization

次のペアを別値として保存し、server/local の一致を確認する。

- `A` / `a`
- `ABC` / `ＡＢＣ`
- NFC / NFD
- `A` / `A `
- 半角カナ / 全角カナ

server が local code-point equality と異なる同値化を行う場合、その型は §4.4 の fallback matrix に従い exact 開放しない。

### 11.9 LINK

TEXT と同じ scalar/list/escape/空セル試験を、実際の LINK フィールドでも行う。`SINGLE_LINE_TEXT` の結果を LINK へ推測で流用しない。

### 11.10 ユーザー系 code

各型で表示名ではなく code が一致することを確認する。

```sql
主担当 IN ('rex0220')
主担当 NOT IN ('rex0220')
```

複数値フィールドでは、対象 code が配列のどの位置にあっても `IN=true` となること。

表示名を指定した対照 SQLは一致しないこと。

```sql
主担当 IN ('開発太郎')
```

### 11.11 ゲスト code

実レコードの `.code` を取得し、その文字列を変更せず SQL literal に指定する。

次を記録する。

- records response の `.code`
- serializer 後 query
- 単一表結果
- JOIN prefilter 結果
- JOIN residual 結果

推測した `guest/...` 形式だけで完了としてはならない。

### 11.12 空のユーザー系フィールド

非空 list に対して次を確認する。

```sql
主担当 IN ('u1')
主担当 NOT IN ('u1')
```

空配列行は `IN` から除外され、`NOT IN` に含まれること。

### 11.13 STATUS_ASSIGNEE

プロセス管理有効 APP:

- field metadata が `STATUS_ASSIGNEE`
- process `enable === true`
- `IN` / `NOT IN` が3経路一致
- `relation: exact`
- query に code が出る

プロセス管理無効 APP:

- process `enable === false`
- records API query に `STATUS_ASSIGNEE` を送らない
- synthetic field を作らない
- classifier は `unsafe`
- field validation が拒否する場合は既存エラーを維持
- `EXPLAIN` と実行が同じ判断をする

### 11.14 prefilter 有無で rows 同一

Phase 2〜4 の全対象型について、prefilter 有効/無効で公開 `rows` が完全一致すること。

件数だけでなく、各セルの公開文字列、ユーザー系 JSON の投影、列順も比較する。

### 11.15 outer join 非回帰

`LEFT JOIN` / `RIGHT JOIN` では B152 leaf を押し下げない。preserved side / non-preserved side の既存契約を変更しない。

### 11.16 B84 文書パリティ

次を満たす。

1. §9.1 の対象セルがすべて `○`
2. 対象外セルが `✕`
3. canonical 外 fixture は表の `○` にかかわらず `unsafe`
4. empty literal は `unsafe`
5. classifier の1セルを壊すと parity test が落ちる
6. 文書の1セルを戻すと parity test が落ちる
7. `STATUS_ASSIGNEE` が型集合へ含まれる
8. process disabled の専用 test がある

### 11.17 既存 B76/B151 規則

次を回帰させない。

- ownership
- 曖昧な非修飾 field の拒否
- cross-alias `OR`
- 同一 alias `OR`
- GROUP
- KLIKE-containing `OR`
- server-only function 第5-W / 第5-L
- outer join 非適用
- CTE / temp / subtable source 非適用
- search-aborted 契約
- 取得上限
- 元 WHERE residual
- NUMBER 8演算子 exact
- `$id`
- selection option existence policy

### 11.18 全 surface

同じ SQL、同じアプリデータ、同じ `maxRecords` で次を確認する。

- Node engine
- CLI
- MCP
- Firefox plugin
- Chrome plugin
- engine library

各 surface で次が一致する。

- `rows`
- `columns`
- `rowCount`
- 公開文字列値
- user code membership
- error classification
- `EXPLAIN` query
- relation
- fetch scope
- warning

ブラウザ smoke は Node test、CLI smoke、MCP smoke で代替しない。

---

## 12. Claude が実測すべき未確認事項

### 12.1 DATETIME の TZ と秒

次を server query、FULL_SCAN、JOIN prefilter で測る。

```text
2026-08-07T00:00:00Z
2026-08-07T09:00:00+09:00
2026-08-07T00:00Z
2026-08-07T00:00:00.000Z
```

B152 は最初の canonical `Z`＋秒ありだけを開放する。server が他形式を受けることは、開放範囲を広げる理由にしない。

### 12.2 TEXT の正規化有無

次を実値で比較する。

- 大文字小文字
- ASCII / 全角英数
- 半角 / 全角カナ
- NFC / NFD
- 前後空白
- `"` / `\`

`=`、`!=`、`IN`、`NOT IN` をそれぞれ測る。`=` の結果だけから補集合演算を推測しない。

### 12.3 ユーザー系のゲスト形式

USER_SELECT と STATUS_ASSIGNEE の実レコードから guest code を取得し、そのまま query へ送る。

- code の実形式
- slash の escape 不要性
- 存在する guest
- 存在しない guest
- 通常 user と guest の混在 list

を確認する。

### 12.4 プロセス管理無効アプリ

次を記録する。

- `getFields` に STATUS / STATUS_ASSIGNEE が出るか
- `status.json` の `enable`
- records response に field が出るか
- query を送った場合の server response
- kSQL の field validation
- `EXPLAIN` の判断

実測結果にかかわらず、B152 は process disabled で fail-closed とする。

### 12.5 存在しない code

通常 user、organization、group、guest について存在しない code を query へ送る。

- 空集合として成功する場合: 実在検証なしを維持
- query error の場合: 対象型を exact 開放しないか、安全な事前検証 policy を別途設計する

全件取得 retry で error を隠さない。

### 12.6 serializer と residual の同一値

少なくとも TEXT escape と guest code について次を固定する。

```text
SQL parsed value
server query serialized value
local residual value
stored field/code value
```

escape 表現の違いと値の違いを混同しない。

---

## 13. Phase 線引き

### 13.1 本仕様に含めるもの

- DATE/TIME の canonical scalar comparison
- DATETIME/CREATED_TIME/UPDATED_TIME の canonical UTC scalar comparison
- TEXT/LINK の非空 equality、inequality、IN
- ユーザー・組織・グループ・作業者の非空 code IN
- relation exact
- literal policy
- serializer 回帰
- process-enabled gate
- EXPLAIN
- B84 表
- 言語リファレンス
- B76/B84 失効注記
- unit、integration、実機、全 surface smoke
- B151 との同梱リリース

### 13.2 本仕様に含めないもの

- `CALC`
- `RECORD_NUMBER`
- `$id` 契約の変更
- TEXT/LINK の範囲比較
- 日付系の IN
- ユーザー系の scalar comparison
- 空文字 literal の JOIN exact 化
- LIKE / NOT LIKE
- KLIKE 契約の変更
- CATEGORY
- MULTI_LINE_TEXT / RICH_TEXT / FILE の比較拡張
- arithmetic field
- function field
- CASE
- aggregate / window result
- field-to-field comparison
- scalar subquery
- `IN (SELECT ...)` pushdown
- outer join
- CTE / temp / derived source
- residual elimination
- literal normalization
- TZ conversion
- directory API による実在ユーザー全件検証
- malformed record の exact 証明

### 13.3 CALC・RECORD_NUMBER を Phase 5 に残す理由

> **【2026-08-07・オーナー判断で失効】** 本節の見送り判断は撤回した。単一表との一致を
> 優先し、両型の8演算子を `superset` で開放する。書式に合わない literal は kintone error
> とし、全件取得へ retry しない。

`CALC` は表示書式により値領域が異なる。

例:

- 数値
- 通貨
- 桁区切り
- 時間
- `49:30` のような24時間超表現
- 日数等の表示変換

同じ `CALC` 型でも string/number/date-time のどの比較契約を使うべきか、field metadata と保存値だけでは一律に証明できない。

`RECORD_NUMBER` はアプリコードの有無により表示値が変わる。

```text
123
APP-123
```

JOIN 中の `RECORD_NUMBER` がどの APP の表示契約を持つかを classifier が証明する経路も現状ない。

一方 `$id` は正準な record ID domain を持ち、既存 classifier が代替として使用できる。したがって CALC・RECORD_NUMBER は Phase 5 に残し、B152 Phase 2〜4 と同梱しない。

---

## 14. 実装手順

### Step 1: pure literal policy

- date/time/datetime canonical helper を集約
- text non-empty scalar/list helper
- user-code non-empty list helper
- unit test
- この段階では本番 classifier を変えない

### Step 2: capability と process metadata

- `STATUS_ASSIGNEE` の native `in` / `not in`
- process-enabled metadata gate
- disabled / unknown の fail-closed test
-既存 STATUS option metadata を回帰させない

### Step 3: JOIN classifier

- Phase 2 branch
- Phase 3 branch
- Phase 4 branch
- exact relation
- NUMBER、selection、KLIKE、`$id` 非回帰
- tree 合成・ownership test

### Step 4: runtime と EXPLAIN

- 実行と EXPLAIN が同じ runtime plan を使用
- 実 serializer query を固定
- `pushdown applied:`
- `relation: exact`
- `fetch: EXACT`
- mixed alias item の `PREFILTERED`
- residual original WHERE 維持

### Step 5: B84・公開文書

- B84 生成表
- 言語リファレンス
- B76/B84 失効注記
- tracker / CHANGELOG / release docs
- MCP schema / docs
- docs parity test

### Step 6: 実機と全 surface

- DATE/TIME/DATETIME 境界
- TEXT normalization / escape
- user/organization/group/guest code
- process enabled / disabled
- CLI / MCP
- Firefox / Chrome
- engine library
- before / after EXPLAIN と rows
- package / manifest / artifact version gate

実測で exact 条件を満たさない型は、同梱期限を理由に開放しない。該当セルを `unsafe` に戻し、文書とテストも同じ値へ合わせる。

---

## 15. 完了条件

B152 Phase 2〜4 は次をすべて満たした場合だけ完了とする。

1. DATE/TIME/DATETIME/CREATED_TIME/UPDATED_TIME の canonical literal 6演算子が `exact` になる。
2. non-canonical DATE/TIME/DATETIME literal が `unsafe` になる。
3. DATETIME offset、秒省略、小数秒を押し下げない。
4. SINGLE_LINE_TEXT/LINK の非空 `=` / `!=` / `<>` / `IN` / `NOT IN` が、正規化実測一致を条件に `exact` になる。
5. TEXT の範囲比較を開放しない。
6. `"` / `\` を含む TEXT literal が実 serializer 形で3経路一致する。
7. TEXT の大文字小文字、全半角、Unicode normalization、空白を実測する。
8. CREATOR/MODIFIER/USER_SELECT/ORGANIZATION_SELECT/GROUP_SELECT の非空 code `IN` / `NOT IN` が `exact` になる。
9. ユーザー系は表示名でなく code を比較する。
10. 複数値ユーザー系は「いずれかの code を含む」意味論で3経路一致する。
11. guest code の実形式を実測する。
12. `STATUS_ASSIGNEE` は process enabled 時だけ `exact` になる。
13. process disabled / unknown では query を送らず fail-closed になる。
14. 空文字 literal を B152 exact 対象にしない。
15. 型不一致、空 list、混在 list、metadata 不足を fail-closed にする。
16. 空セルの全対象演算子が §6 と一致する。
17. prefilter 有無で公開 rows が一致する。
18. `EXPLAIN` が実行時 query、relation、fetch scope と一致する。
19. B84 公開表が分類器から生成され、§9.1 と一致する。
20. B76/B84 の旧判断に B152 失効注記が付く。
21. CALC / RECORD_NUMBER を開放しない。
22. LIKE / NOT LIKE の local 契約を変更しない。
23. widening、TZ変換、文字列正規化を行わない。
24. ownership、tree 合成、server-only function、outer join、search-aborted、取得上限を回帰させない。
25. B151 NUMBER 8演算子 exact を回帰させない。
26. Node、CLI、MCP、Firefox、Chrome、engine library の公開結果が一致する。
27. ブラウザ smoke を実ブラウザで通す。
28. tracker、CHANGELOG、言語リファレンス、MCP docs、package、manifest、release artifact が v3.60.0 と同じ契約を示す。
29. B151 と B152 Phase 2〜4 が同じリリース成果物に含まれる。
30. 実測で一致しなかった型×演算子を、期限や推測を理由に `exact` として残さない。
