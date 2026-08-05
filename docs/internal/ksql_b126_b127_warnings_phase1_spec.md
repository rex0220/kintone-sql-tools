# B126 / B127 「検出できない」を warnings で塞ぐ Phase 1 仕様（R2）

- ステータス: 📋 **仕様 R2（codex レビュー 1 回目を反映）** → [レビュー](ksql_b126_b127_codex_review_1.md)（高 4・中 6・低 1 を**全件反映**）
- 出典: [ksql-analytics の依頼](../../../ksql-analytics/docs/internal/kSQLエンジンへの依頼-20260805.md) ①② /
  [triage](ksql_analytics_request_20260805_evaluation.md)

> **R1 からの主な訂正**
> - **検出規則が広すぎた。** `native.has("in")` だけでは `USER_SELECT` / `ORGANIZATION_SELECT` /
>   `GROUP_SELECT` など**複数値型**まで拾う。これらは `IN` が集合 overlap なので、
>   **書き換えを案内すると結果が変わる**
> - **`CHECK_BOX` / `MULTI_SELECT`（と `CREATOR` / `MODIFIER`）の `=` は residual に到達しない。**
>   `LOCAL_VALID_OPERATORS` の partial policy で**先に `UNSUPPORTED`** になる
> - **「全件取得になります」は述語単体からは導けない。** `AND` に押し下がる述語が 1 つでもあれば
>   全体は `SUPERSET_PREFILTER`
> - **B127 の抑止規則が誤り。** `$id` / `RECORD_NUMBER` を含んでも、**JOIN・サブテーブルで
>   行が増幅されると結果行の全順序にならない**。「狭いから安全」は成立していなかった

---

## 0. 確定事項（実測・コード確認）

| 事実 | 確認 |
|---|---|
| `= '出庫'` は `ALL`・`WHERE_RESIDUAL`・**`warnings: []`** / `IN ('出庫')` は `PREFILTERED` | 実機 v3.46.0 |
| `SUM(x) OVER (... ORDER BY d)` は `frame: RANGE ...(既定)` を表示するが **`warnings: []`** | 実機 v3.46.0 |
| **`=` が早期に `UNSUPPORTED` になる型**＝`CREATOR` / `MODIFIER` / `CHECK_BOX` / `MULTI_SELECT` | `whereCapability.ts:105-110`（`LOCAL_VALID_OPERATORS`） |
| **単一値としてローカル評価される型**＝`LOCAL_SCALAR_TYPES`（`RADIO_BUTTON` / `DROP_DOWN` / `STATUS` を含む） | `whereCapability.ts:112-119` |
| **複数値型**＝`LOCAL_COLLECTION_TYPES`（`USER_SELECT` / `ORGANIZATION_SELECT` / `GROUP_SELECT` / `STATUS_ASSIGNEE` / `CATEGORY` ほか） | `whereCapability.ts:121-124` |
| native に `in` があるのは上記のほか `RECORD_NUMBER` / `NUMBER` / `CALC` / `SINGLE_LINE_TEXT` 等。**これらは `=` も native なので residual に落ちない** | `whereCapability.ts:74-99` |
| `AND` の片側が exact なら全体は `SUPERSET_PREFILTER` | `whereCapability.ts:478-497` |
| ウィンドウは **JOIN 後の `ProcessRow[]`** を partition してソートする | `process.ts:1038-1064` |
| JOIN planner は `RECORD_NUMBER` を `$id` と同じ canonical domain と**証明できないとして fail-closed** | `joinPredicatePushdown.ts:1036-1040` |

---

## 1. スコープ

| 区分 | 内容 |
|---|---|
| **対象** | SELECT 実行結果と `ksql_explain` の `warnings` に 1 行足す |
| **非対象** | **意味・結果・押し下げ挙動を一切変えない**（`=`→`in` 正規化は Phase 2） |
| **非対象** | 既定フレームの変更（標準準拠のまま）／新しいエラー・拒否 |
| **非対象** | `ksql_validate`（フォーム定義を読まない契約） |

---

## 2. B126 選択系 `=` の警告

### 2.1 検出規則（**単一値に限定**）

`classifyWhereCapability` が `WHERE_RESIDUAL` を返した述語のうち、**すべて**満たすもの。

1. `operator` が `=` または `!=`
2. `nativeWhereOperatorsForType(fieldType)` が `in` / `not in` を含む
3. **`fieldType` が `LOCAL_SCALAR_TYPES` に属する**（＝単一値。`IN` への書き換えが等価）

> **条件 3 が R1 に無かった。** これが無いと `USER_SELECT` / `ORGANIZATION_SELECT` /
> `GROUP_SELECT` / `STATUS_ASSIGNEE` / `CATEGORY` まで拾う。これらは**複数値**で
> `IN` が集合 overlap（`ksql_language_reference.md:1080-1081`）なので、
> **書き換えると結果が変わる**。`CHECK_BOX` / `MULTI_SELECT` は §0 のとおり
> 手前で `UNSUPPORTED` になるため元から対象外。
>
> 実際に該当するのは **`RADIO_BUTTON` / `DROP_DOWN` / `STATUS`** の 3 型になる見込みだが、
> **型名はハードコードせず既存の集合で判定する**（押し下げ表が変わっても追随する）。

### 2.2 文面（**述語単位の事実だけを書く**）

```
入出庫区分 = '出庫' は kintone 側へ押し下げられません（取得候補が増えます）。
入出庫区分 IN ('出庫') と書くと kintone 側で絞り込めます。結果は同じです。
```

- **「全件取得になります」とは書かない。** `AND` に押し下がる述語が 1 つでもあれば
  全体は `SUPERSET_PREFILTER` で、全件取得ではない（§0）
- 「結果は同じです」は**単一値に限定した（§2.1 条件 3）から書ける**
- `!=` は `NOT IN` を案内

### 2.3 JOIN での扱い（**文面を変える**）

言語リファレンス §6 は JOIN の field vs literal に別表を持ち、**JOIN では
`IN` でも押し下がらない条件がある**。**JOIN を含む文では「絞り込めます」と断定しない。**

```
入出庫区分 = '出庫' は kintone 側へ押し下げられません。
IN ('出庫') と書くと押し下げの候補になります（JOIN では結合先まで絞られないことがあります）。
```

**→ R3 までに、JOIN 経路で選択系 `IN` が実際に押し下がる条件を確定する（§7-1）。**
確定するまでは **Phase 1 を単一表に限定**し、JOIN を含む文では警告を出さない案も可（§7-1）。

---

## 3. B127 ウィンドウ既定フレームの警告

### 3.1 検出規則

集計ウィンドウ列（`windowKind === "AGGREGATE"`）のうち、

1. `orderBy.length > 0`
2. `frame !== null` かつ `frame.source === "DEFAULT"`

### 3.2 抑止規則（**R1 から全面的に狭める**）

**次を「すべて」満たすときだけ抑止する。**

1. `ORDER BY` キーに `$id`、または `RECORD_NUMBER` 型のフィールドが含まれる
2. **その SELECT が単一の物理アプリを入力とし、`JOIN` を含まない**
3. **サブテーブル仮想テーブルを入力にしていない**
4. **CTE / 一時テーブル / `UNION` など、行を増幅または一意性の来歴を失う中間結果を経ていない**

> **R1 は条件 1 だけで「狭いから誤抑止は起きない」と書いたが誤り。**
> ウィンドウは **JOIN 後の行**を評価するため、`a` の 1 行が JOIN 相手の複数行に一致すれば
> **同じ `a.$id` が結果に複数回現れる**。サブテーブル展開でも親のレコード番号が反復する。
> JOIN planner 自身が `RECORD_NUMBER` を `$id` と同じ canonical domain と
> **証明できないとして fail-closed** にしている（§0）。
>
> **抑止を誤ると「正しく書いたのに警告が出ない」ではなく「危ないのに警告が出ない」**
> になるので、**証明できないときは抑止しない**（警告を出す）。

### 3.3 文面

```
累積 は既定フレーム（RANGE）で評価されます。ORDER BY の値が同じ行はすべて同じ値になります。
行ごとの値が必要なら ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW を明示するか、
ORDER BY にレコード番号などのタイブレークキーを足してください。
```

alias を含める。**ウィンドウ列 1 つにつき 1 行。**

---

## 4. 警告の運搬と重複排除

### 4.1 置き場所（レビュー指摘 7）

**converter から新しい引数で運ばない。** 分類結果は**実行 / `EXPLAIN` が既に持っている解析結果**
（fetch plan / capability の解析結果）に載せ、そこから `warnings` を組み立てる。
**R3 までに具体的な構造体名を確定する（§7-2）。**

### 4.2 `UNION` / 実体化 CTE（レビュー指摘 8）

**子 SELECT で出た警告が合成結果から失われないこと。** 現状の合成では落ちる。
子の警告を親の `warnings` へ集約する。

### 4.3 重複排除（レビュー指摘 9）

`Set<string>` は**文面が同一のときだけ**重複を消す。
**「同一フィールド・同一演算子で 1 行」を満たすには、文面生成の前に
`(field, operator)` で一意化する。** 同じフィールドが `OR` で複数回現れても 1 行。

---

## 5. 受入条件

### 5.1 B126

| SQL | 期待 |
|---|---|
| `WHERE 入出庫区分 = '出庫'`（RADIO_BUTTON・単一表） | **警告 1 行**。行数・値は不変 |
| `WHERE 入出庫区分 IN ('出庫')` | 警告なし |
| `WHERE 入出庫区分 != '出庫'` | 警告 1 行（`NOT IN` を案内） |
| `WHERE 分類 = '食品'`（DROP_DOWN） | 警告 1 行 |
| **`WHERE 担当者 = 'user1'`（USER_SELECT・複数値）** | **警告なし**（§2.1 条件 3） |
| **`WHERE チェック = 'A'`（CHECK_BOX）** | **従来どおりエラー**（`UNSUPPORTED`・警告の話にならない） |
| `WHERE 製品名 = '牛乳'`（SINGLE_LINE_TEXT） | 警告なし |
| **`WHERE 入出庫区分 = '出庫' AND $id > 100`** | **警告 1 行。ただし文面に「全件取得」を含まない**（全体は `SUPERSET_PREFILTER`） |
| 同じフィールド・同じ演算子が `OR` で 2 回 | **1 行**（§4.3） |
| 異なる 2 フィールドが該当 | 2 行 |
| JOIN を含む文 | **§2.3 / §7-1 の決定に従う**（受入で固定する） |

### 5.2 B127

| SQL | 期待 |
|---|---|
| `SUM(x) OVER (PARTITION BY p ORDER BY 日付)`（単一表） | 警告 1 行 |
| `... ORDER BY 日付, レコード番号`（単一表・JOIN なし） | 警告なし |
| `... ORDER BY $id`（単一表） | 警告なし |
| **同じ形で JOIN を含む** | **警告あり**（§3.2 条件 2・**抑止しない**） |
| **サブテーブル仮想テーブルを入力にする** | **警告あり**（条件 3） |
| **CTE / `UNION` を経る** | **警告あり**（条件 4） |
| `... ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` | 警告なし（明示） |
| `... RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` | 警告なし（`frame.source === "EXPLICIT"`） |
| `SUM(x) OVER (PARTITION BY p)`（`ORDER BY` なし） | 警告なし |
| 順位系（`ROW_NUMBER` 等） | 警告なし |

### 5.3 非変更性（レビュー指摘 10・**機械的に固定する**）

**警告を出す全ケースについて、修正前後で次が完全一致すること。**

- 行数・各行の値・列名と順序
- `EXPLAIN` の計画本文（`warnings` 以外の全行）
- `metrics.fetchedRows`（**押し下げ挙動が変わっていないことの直接の証拠**）

既存警告 2 件（取得上限の打ち切り・検索中断）が従来どおり出ること。
`ksql_validate` には出ないこと。

---

## 6. 影響範囲

| ファイル | 内容 |
|---|---|
| `core/optimization/whereCapability.ts` | §2.1 の 3 条件を満たすかの判定を足す（既存集合を使う） |
| 実行 / `EXPLAIN` の解析結果を持つ構造体 | §4.1。**R3 で確定** |
| `execute.ts` | `warnings` へ追加（`(field, operator)` 一意化のうえ） |
| `UNION` / CTE の結果合成 | §4.2 |
| B127 の判定 | AST ＋ **入力の形（JOIN / サブテーブル / CTE の有無）** |

---

## 7. 未確定（R3 までに詰める）

1. **JOIN 経路で選択系の `IN` が実際に押し下がる条件**（§2.3）。
   確定するまで **Phase 1 を単一表限定にする**案を含めて決める
2. **警告を載せる具体的な構造体**（§4.1）。converter → execute / EXPLAIN の実際の受け渡し
3. **`RECORD_NUMBER` 型の判定にフォーム定義が要るか**（§3.2 条件 1）。
   要るなら `EXPLAIN` と実行のどちらで判定できるか
4. 警告の**上限**（述語が多い文で何行まで出るか）
