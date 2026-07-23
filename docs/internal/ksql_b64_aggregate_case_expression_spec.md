# B64 仕様 R2 — 集計関数引数のスカラー値式対応（CASE / `||` / `@var`）

- ステータス: ✅ リリース済み（v3.16.0・2026-07-23・実装 PR #240→release #241→npm latest 3.16.0・実機 PASS・言語リファレンス §4/§8/§9 反映済み）。以下は仕様 R2 の記録。
- 種別: 改善（集計関数引数の式文法拡張）／SemVer: minor 想定
- 優先: 中
- 関連: [B64 issue](ksql_b64_aggregate_case_expression_issue.md)／[B14 型メタ](ksql_temp_column_type_meta_spec.md)／[B16 GROUP_CONCAT](ksql_group_concat_spec.md)／[B37 CHECK](ksql_custom_check_spec.md)／[B38 `||`](ksql_concat_operator_spec.md)／[B56 統計集約](ksql_b56_statistical_aggregates_spec.md)／[B58 MODE](ksql_b58_mode_aggregate_spec.md)／[文字列・空セル意味論](ksql_string_semantics.md)

## 0. 結論（R2 確定）

B64 の根因は、`parseAggregateRef()` が集計引数を `parseArithAddSub()` で読み、`AggregateColumn.arg` / `AggregateRef.arg` も `ArithNode` に固定していることである（[parser.ts:1840](../../src/parser/parser.ts#L1840)・[ast.ts:264](../../src/types/ast.ts#L264)・[ast.ts:986](../../src/types/ast.ts#L986)）。R2 は、旧算術 AST に加えて、既存 `parseScalarValueExpr({ allowCase: true })` が表現できる CASE・`||`・裸の `@var` を `AggregateArgExpr` で受ける。

**出荷範囲は単一 Phase 1 = CASE + `||` + 裸の `@var` と確定する。** `||` は `CONCAT` 関数形と同義の連結、裸の `@var` は実行前に解決されるスカラー変数であり、いずれも既存スカラー値式の意味論を再利用できる。看板需要である条件付き集計に加え、同じ式階層差に起因する拒否を一度に解消する。

一方、`SUM(amount > 0)` / `COUNT(amount > 0)` のように比較・述語そのものを集計値にする構文は、Phase 1 だけでなく**恒久的に拒否**する。kSQL は boolean 型を持たず、`parseScalarValueExpr()` も比較・述語を明示拒否している（[parser.ts:1441-1446](../../src/parser/parser.ts#L1441)）。暗黙の boolean 値を追加せず、`SUM(CASE WHEN amount > 0 THEN 1 ELSE 0 END)` のように CASE で値を明示させる。

ELSE 省略の NULL を現行評価器が `""` へ潰す点（`evalCaseWhen()`）には集計入力専用 nullable 評価を導入する。既存 SQL は旧 `ArithNode` と評価経路を保持し、`MIN(UPPER(text))` 等の AST snapshot・成功・失敗・空値挙動を変えない。

---

## 1. 目的・スコープ

### 1.1 目的

集計関数の引数を「識別子・数値・括弧・関数呼び出しを算術演算子で結んだ式」だけから、行ごとに評価できるスカラー値式へ拡張する。第一の受入形は次である。

```sql
SELECT
  SUM(CASE WHEN status = 'done' THEN amount ELSE 0 END) AS done_amount,
  COUNT(CASE WHEN status = 'done' THEN 1 END) AS done_count
FROM APP1
```

[B64 issue §2](ksql_b64_aggregate_case_expression_issue.md#2-原因推定-case-単独ではなく集計引数算術式限定の一般制約) の `ksql_validate` 実測境界を現状の正とする。すなわち、関数呼び出しと算術は受理済み、CASE・`||`・裸の `@var`・比較式は拒否され、`SUM((CASE ...))` も拒否される。

### 1.2 対象集計関数

Phase 1 では、引数を取る全集計関数について CASE・`||`・解決済みの裸 `@var` を同じ文法で受理する。関数固有の入力規約は変えない。

| 関数 | Phase 1 の CASE / `||` / `@var` 引数 | 理由・維持する契約 |
|---|---:|---|
| `SUM` | 可 | 条件付き合計の主用途。NULL/空入力を除外し、残った値は既存の数値化・加算規則を使う |
| `COUNT` | 可 | `COUNT(CASE WHEN p THEN 1 END)` を条件付き件数として提供。CASE の NULL 結果は数えない。`COUNT(*)` は従来どおり別構文 |
| `AVG` | 可 | 条件に一致し非 NULL の値だけを分母・分子へ入れる。ELSE 0 を明記した場合は 0 も件数へ入る |
| `MIN` | 可 | CASE 結果の静的型メタで数値順／文字列順を決める。NULL は候補外 |
| `MAX` | 可 | `MIN` と同じ |
| `GROUP_CONCAT` | 可 | 条件に一致した文字列だけを連結する用途。NULL と空値のスキップ、収集順、`SEPARATOR` は B16 のまま |
| `STDDEV_POP` | 可 | 条件付き母標準偏差。B56 の完全入力必須・数値専用ガードを維持 |
| `STDDEV_SAMP` | 可 | 条件付き標本標準偏差。非 NULL 入力 0 件／1 件の未定義値規約を維持 |
| `VAR_POP` | 可 | 条件付き母分散。B56 契約を維持 |
| `VAR_SAMP` | 可 | 条件付き標本分散。B56 契約を維持 |
| `MEDIAN` | 可 | 条件付き中央値。B56 の数値化、DISTINCT、未定義値規約を維持 |
| `MODE` | 可 | 条件付き最頻値。B58 の完全入力必須、文字列／数値の比較メタ、文字列完全一致の頻度単位、同率時 tie-break を維持。`DISTINCT` 禁止も維持 |

関数別に CASE を許可／拒否する分岐は設けない。評価器が安全に扱えない関数だけを構文で閉じる方式は、同じ AST の SELECT/HAVING 経路を再びドリフトさせるため採らない。

### 1.3 対象外

- `ROW_NUMBER()` / `RANK()` / `DENSE_RANK()` は引数を取らない順位系ウィンドウ関数であり対象外。
- `STDDEV_POP(x) OVER (...)` 等の集計ウィンドウ形は B56 と同じく対象外で、従来どおり ParseError。
- 集計内集計（`SUM(SUM(x))`）、CASE 条件・結果内の集計、スカラーサブクエリ、配列結果は対象外。
- `GROUP_CONCAT(... ORDER BY ...)` や動的 `SEPARATOR` は B16 の将来課題のまま。
- SUM/AVG の既存の寛容な数値化、binary64、空集合結果を B64 で再定義しない。

---

## 2. 現状コードの根拠

### 2.1 パーサと AST

- `parseAggregateRef()` は `DISTINCT` / `*` を読んだ後、非 `*` 引数を `parseArithAddSub()` へ固定委譲する（[parser.ts:1840-1858](../../src/parser/parser.ts#L1840)）。
- `parseArithPrimary()` のオペランドは数値、フィールド、括弧内算術式、文字列／数値関数であり、CASE・変数・文字列リテラルを受理しない（[parser.ts:1579-1627](../../src/parser/parser.ts#L1579)）。
- `parseScalarValueExpr()` は CASE を既定で許可し、`VARIABLE`、`STRING_FUNC`、`CONCAT_OP`、`SCALAR_ARITH` を表せる一方、比較・述語・集約・サブクエリを拒否する（[parser.ts:1427-1501](../../src/parser/parser.ts#L1427)）。
- `AggregateColumn.arg` と `AggregateRef.arg` はともに `WildcardColumn | ArithNode`（[ast.ts:264-270](../../src/types/ast.ts#L264)・[ast.ts:985-992](../../src/types/ast.ts#L985)）。

### 2.2 評価

- `evalAggregate()` は `ArithNode` を受け、直接 `FIELD_REF` とそれ以外で入力収集規則を分ける（[process.ts:316-345](../../src/engine/process.ts#L316)）。直接フィールドは空値を関数別に処理し、それ以外は `evalArithExpr()` で数値化する。
- 新しい値式用 `evalScalarValueExpr()` は `string | number` を返し、CASE は `evalCaseWhen()` へ委譲する（[evalFunc.ts:38-72](../../src/engine/evalFunc.ts#L38)）。
- `evalCaseWhen()` は ELSE 省略を `""`（NULL 相当）として返すため、現状の型だけでは「NULL」と「明示的な空文字」を集計時に区別できない（[evalWhere.ts:363-377](../../src/engine/evalWhere.ts#L363)）。
- `MIN` / `MAX` / `MODE` は引数が直接 `FIELD_REF` の場合だけ `AggregateSortKindResolver` を参照し、その他を数値式として扱う（[process.ts:367-373](../../src/engine/process.ts#L367)）。

### 2.3 SELECT 以外の同一構文面

HAVING は `parseAggregateRef()` を共有していない。`parseFieldValue()` 内で集計名、`DISTINCT`、引数の**識別子 1 個**を別実装で読み、`SUM(field)` の合成フィールド名に変換する（[parser.ts:2197-2226](../../src/parser/parser.ts#L2197)）。B16/B56 でもこの別経路が実装漏れ源になった。B64 では SELECT だけを直して完了としてはならない。

> **実装時注記:** 本仕様の行番号は R2 起草時点の参照であり、実装着手時に再確認する。特に型メタは `caseResultColumnMeta()` / `stringFunctionColumnMeta()` / `inferSelectColumnMeta()`、合成名は `arithColDefaultKey()` / `isAggregateSyntheticName()` を関数名で追跡し、行番号だけに依存しない。

---

## 3. 文法・AST 変更設計

### 3.1 構文

確定形を次とする。

```ebnf
aggregate_ref     ::= aggregate_name "(" ["DISTINCT"] aggregate_arg
                      ["SEPARATOR" string_literal] ")"
                    | "COUNT" "(" ["DISTINCT"] "*" ")"

aggregate_arg     ::= legacy_arith_expr
                    | scalar_value_expr
```

`scalar_value_expr` は CASE・`||`・裸の `@var` を含む既存の非述語スカラー値式である。既存の `legacy_arith_expr` は構文・AST・評価を保持する。比較・述語は `aggregate_arg` に含めない。

### 3.2 AST

`ArithNode` を直接置換せず、上位型を追加する。

```ts
type AggregateArgExpr =
  | ArithNode          // 既存受理 SQL はこの形を維持
  | ScalarValueExpr;   // CASE / || / @var

interface AggregateColumn {
  // ...既存フィールド...
  arg: WildcardColumn | AggregateArgExpr;
}

interface AggregateRef {
  // ...既存フィールド...
  arg: WildcardColumn | AggregateArgExpr;
}
```

`ScalarValueExpr` 自体へ `WhereExpr` を足す案も、集計引数専用の比較値 AST を作る案も採らない。B38 の型コメントと `parseScalarValueExpr()` の公開契約が「比較・述語を含めない」であり、kSQL に boolean 型がないためである。

型の union には `NumberLiteral` / `StringFuncExpr` の重なりがあるが、既存 SQL は旧パーサ優先により従来タグ（`FIELD_REF` / `ARITH`）を保持する。新規形は `FIELD` / `SCALAR_ARITH` / `CASE_WHEN` / `CONCAT_OP` / `VARIABLE` で判別できる。

### 3.3 二段パースによる AST 後方互換

`parseAggregateRef()` の単純な一行置換（`parseArithAddSub()` → `parseScalarValueExpr()`）は行わない。代わりに `parseAggregateArgExpr()` を追加し、次の順で読む。

1. 現在位置を保存して `parseArithAddSub()` を試す。
2. 次トークンが `)` または B16 の `SEPARATOR` なら旧 AST を採用する。
3. 旧パーサが失敗した、または引数終端以外のトークンを未消費で残した場合は位置を戻す。
4. `parseScalarValueExpr({ allowCase: true, allowAggregateArgs: false })` で引数全体を読み直す。これにより CASE・`||`・裸の `@var` を同じ Phase 1 で受理し、`SUM((CASE ...))` と `SUM((CASE ...) + 0)` も同じ経路で受理する。
5. 読み直し後も終端が `)` / `SEPARATOR` でなければ、§9.2 の集計引数専用 ParseError とする。比較・述語を値式として解釈する fallback は設けない。

これにより `SUM(amount)`、`SUM((amount + 1) * 2)`、`SUM(ROUND(amount))`、`GROUP_CONCAT(CONCAT(name, '!'))` は AST snapshot まで不変になる。新評価器へ一律変換して既存の関数引数や空値挙動を変えない。

### 3.4 比較・述語は恒久的に拒否する

現行 `parseScalarValueExpr()` は比較トークンを検出すると `スカラー値式に比較・述語は使用できません` を投げる（[parser.ts:1441-1446](../../src/parser/parser.ts#L1441)）。この境界を集計引数でも維持し、`SUM(amount > 0)` / `COUNT(amount > 0)`、`LIKE` / `KLIKE` / `IN` 等の述語、`AND` / `OR` で結んだ条件を値としては受理しない。

条件付きの数値化は CASE で明示する。比較式を検出した集計引数専用 ParseError は、第一候補として `SUM(CASE WHEN amount > 0 THEN 1 ELSE 0 END)` の形を案内する。複雑な式や再利用が必要なら CTE で CASE 列を作ってから集計する。

### 3.5 ネスト集約禁止

次の三重防御を受入条件とする。

1. `parseScalarPrimary()` は集約トークンを検出すると既に `スカラー値式に集約関数は使用できません` を投げる（[parser.ts:1496-1501](../../src/parser/parser.ts#L1496)）。これで `SUM(SUM(x))` と CASE 結果内の直接集約を拒否する。
2. `parseAggregateRef()` の引数解析中フラグ（例: `insideAggregateArg`）を設ける。CASE 条件は `parseWhereExpr()` を通り、現行 `parseFieldValue()` は集約関数を受理できるため、同フラグ中に集約トークンを見たら拒否する。これで `SUM(CASE WHEN SUM(x) > 0 THEN 1 END)` を拒否する。
3. パース後に `AggregateArgExpr` walker で `AGG_REF` / `AGG_ARITH` と合成集計名を再検査する。将来の式ノード追加や関数引数経由の抜けを fail-closed にする。

エラーは `ParseError: 集計関数の引数内に集計関数は使用できません` に統一し、外側と内側の関数名を可能なら含める。

### 3.6 HAVING

HAVING の集計参照も `parseAggregateRef()` または同一の引数 helper を使うよう統合する。解析結果を現行どおり合成フィールド参照へ変換する場合でも、引数ラベルは §7.3 の共通 canonical serializer で生成する。**SELECT が生成する集計列キーと HAVING が生成する合成名は byte 単位で一致しなければならない。** 入力 SQL の空白やキーワード大小はキーへ持ち込まず、同じ AST から同じ正規形を生成する。

```sql
SELECT kind, SUM(CASE WHEN ok = 'yes' THEN amount ELSE 0 END) AS ok_sum
FROM APP1
GROUP BY kind
HAVING SUM(CASE WHEN ok = 'yes' THEN amount ELSE 0 END) > 100
```

alias を使う `HAVING ok_sum > 100` も従来どおり有効である。SELECT と HAVING で CASE 引数の受理、DISTINCT、`*` 拒否、`SEPARATOR` の扱いを別実装にしない。

---

## 4. NULL・空セル・数値の意味論

### 4.1 集計入力専用の nullable 評価

現行の表示・DML 用 `evalCaseWhen(): string` は変えない。B64 では集計入力専用に、少なくとも次を区別する評価結果を導入する。

```ts
type AggregateInputValue =
  | { isNull: true }
  | { isNull: false; value: string | number; meta?: MaterializedColumnMeta };
```

実装名は問わないが、`null` を即座に `""` へ変換してはならない。理由は、`MIN(CASE WHEN p THEN x END)` の非一致行は候補外である一方、`MIN(CASE WHEN p THEN x ELSE '' END)` の明示的な空文字は既存 canonical empty band の候補になり得るためである。

### 4.2 CASE

- 最初に真になった WHEN の結果を行ごとに評価する。
- ELSE 省略かつ全条件 false は内部 NULL。
- `ELSE 0` は数値 0 であり NULL ではない。
- `ELSE ''` と、選択された分岐が空セルを返す場合は空値。集計関数固有の既存空値規約へ渡す。
- CASE 条件は WHERE / HAVING / CHECK と同じ `evalWhere()`、同じフィールド型・比較意味論を使う。B64 専用比較器を作らない。

### 4.3 関数別の NULL／空値

| 関数群 | 内部 NULL | 空セル／空文字 | 非数値・NaN |
|---|---|---|---|
| `COUNT(expr)` | 常に除外 | 既存 `COUNT(field)` と同じく除外 | NULL でなければ数える。ただし式評価自体が失敗した場合はエラー |
| `SUM` / `AVG` | 除外 | 直接値として返った空セルは除外。算術式が空値を 0 に変換する既存挙動は維持 | 既存 SUM/AVG 規約を変更しない |
| `MIN` / `MAX` | 非一致（ELSE 省略で全 WHEN false）は候補外 | 選択された分岐のフィールドが空セルなら既存 `MIN(field)` / `MAX(field)` と同じ canonical empty band に残す。明示 `ELSE ''` も空文字値として残す | 型メタに従う。型破損値の canonical band は横断仕様を使用 |
| `GROUP_CONCAT` | 除外 | B16 どおりスキップ | 文字列化可能な非 NULL 値を収集 |
| `STDDEV_*` / `VAR_*` / `MEDIAN` | 除外 | B56 どおり未入力として除外 | B56 の非数値・非有限 fail-closed を維持 |
| `MODE` | 除外 | B58 どおり未入力として除外 | 文字列値は有効。算術式の NaN は既存どおりスキップ |

`SUM` / `AVG` の 0 件結果が 0、統計集約の未定義結果が `""` である既存差は変更しない。B56 の「統計集約を含む文は完全入力必須」も、CASE で絞った後の値件数にかかわらず維持する。

### 4.4 `COUNT(CASE ...)` の例

入力 4 行のうち `status = 'done'` が 2 行なら、次の差を固定する。

```sql
COUNT(CASE WHEN status = 'done' THEN 1 END)        -- 2
COUNT(CASE WHEN status = 'done' THEN 1 ELSE 0 END) -- 4
SUM  (CASE WHEN status = 'done' THEN 1 ELSE 0 END) -- 2
```

この差を出せない実装（ELSE 省略を 0 や空文字として COUNT する実装）は不採用。

---

## 5. 型メタ伝播

### 5.1 集計引数の型推論

B14 の `MaterializedColumnMeta`、現行の `stringFunctionColumnMeta()` / `caseResultColumnMeta()` / `mergeExpressionColumnMeta()`（[execute.ts:2995](../../src/execute.ts#L2995) 付近）を再利用して `inferAggregateArgMeta()` 相当を作る。

| 引数ノード | 推論 |
|---|---|
| 旧 `FIELD_REF` / 新 `FIELD` | 物理フィールドまたは temp/CTE の `columnMeta` を継承 |
| 数値リテラル、算術式 | `sortKind: "number"` |
| 文字列リテラル、`CONCAT` / `||` | `sortKind: "string"` |
| 文字列／数値関数 | 既存 `stringFunctionColumnMeta()` の関数別規則 |
| CASE | THEN/ELSE 各結果を再帰推論し、全非 NULL 分岐が同一型ならその型。混在・不明は横断仕様どおり string 側へ倒す |
| ELSE 省略 | nullable にはなるが、型候補は追加しない |
| 解決済み `@var` | batch 変数置換後のリテラル型。未解決変数が評価器へ到達したら既存どおりエラー |

値集合が偶然すべて数値に見えるかで sortKind を決めない。`ksql_string_semantics.md` §4.5.2 の「型で先に決め、混在・不明は文字列」が根拠である。

### 5.2 関数への適用

- `MIN` / `MAX` / `MODE`: 直接フィールドだけでなく `AggregateArgExpr` 全体の推論結果を `ResolvedFieldSemantics` へ変換して比較する。`CASE ... THEN number ELSE number` は数値、文字列 CASE はコードポイント順、混在・不明は文字列。
- `SUM` / `AVG`: 出力型は従来どおり number。B64 で既存より強い静的型拒否は追加しない。
- `COUNT`: 常に number。
- `GROUP_CONCAT`: 入力型にかかわらず出力は string。B16 どおり入力の sortKind は連結に使わない。
- `STDDEV_*` / `VAR_*` / `MEDIAN`: 出力は number（未定義時は空セル）。引数メタだけで安全と判断せず、B56 の実値ガードを必ず残す。
- `MODE`: 出力メタは推論した引数メタを継承する。値の頻度は B58 どおり raw 文字列完全一致単位であり、数値化ガードは追加しない。

### 5.3 実体化後の列メタ

`inferSelectColumnMeta()` と HAVING/ORDER BY alias 用メタ解決の両方を更新する。現行は `MIN` / `MAX` / `MODE` の引数が直接 `FIELD_REF` のときだけ元メタを継承し、それ以外を number とする同型の分岐を持つ。この `arg.type === "FIELD_REF"` 前提を `inferAggregateArgMeta()` へ置き換える。具体行は実装時に `inferSelectColumnMeta()` の関数名から再確認する。

これにより、次の二段目の比較も一段目 CASE の型を保持する。

```sql
WITH t AS (
  SELECT MIN(CASE WHEN enabled = 'yes' THEN label END) AS first_label
  FROM APP1
)
SELECT MAX(first_label) FROM t
```

---

## 6. DISTINCT

DISTINCT は CASE 評価と NULL/空値除外の**後**、集計演算の前に適用する。

```text
行ごとに引数評価
  → NULL/関数固有の空値を除外
  → DISTINCT の同値単位で重複除去
  → 集計
```

- `COUNT(DISTINCT CASE ...)`: 非 NULL の CASE 結果を既存 6 集計と同じ文字列表現単位で重複除去して数える。
- `GROUP_CONCAT(DISTINCT CASE ...)`: B16 と同じ文字列単位、初出順保持。`SEPARATOR` の意味は不変。
- `STDDEV_*` / `VAR_*` / `MEDIAN(DISTINCT CASE ...)`: B56 と同じ Number 化後の数値同値単位（`"1"` と `"01"` は同値）。数値化不能は ArgumentError。
- `MODE(DISTINCT ...)`: 現行どおり ParseError。CASE 対応を理由に解除しない。
- `SUM` / `AVG` / `MIN` / `MAX` の DISTINCT は既存の文字列単位を維持する。B64 で SQL 方言全体の DISTINCT 単位を変更しない。

NULL は DISTINCT 集合へ入れない。明示的空文字を各関数が既存規約でスキップする場合も集合へ入れない。

---

## 7. 評価パイプラインへの影響

### 7.1 影響一覧

| 領域 | 現在の `ArithNode` 前提 | 対処 |
|---|---|---|
| parser SELECT | `parseAggregateRef()` → `parseArithAddSub()` | §3.3 の二段パースと集計内集計ガード |
| parser HAVING | `parseFieldValue()` が引数を `parseIdentifier()` で別解析 | 共通 `parseAggregateRef` / arg helper と共通ラベル生成へ統合 |
| AST | `AggregateColumn.arg` / `AggregateRef.arg` が `WildcardColumn | ArithNode` | `WildcardColumn | AggregateArgExpr` へ上位互換拡張 |
| 行ごとの入力評価 | `evalAggregate()` が `FIELD_REF` または `evalArithExpr()` | 旧分岐を残し、新引数だけ nullable scalar evaluator へ送る |
| 型・比較 | `MIN/MAX/MODE` が直接 `FIELD_REF` のみ resolver 使用 | 式全体の静的メタを解決し、比較意味論を渡す |
| 必須フィールド収集 | `walkArith()` / `collectArithNode()` | CASE 条件（WhereExpr）と全結果、scalar を歩く `walkAggregateArg()` を追加 |
| 合成名 | `arithColDefaultKey()` / `arithNodeLabel()` | §7.3 の共通 canonical serializer を追加 |
| 集計算術式 | `AGG_REF.arg` を `evalAggregate()` へ渡す | 新 arg union を再帰全体へ伝播。集計結果の外側算術は不変 |
| 関数内集計 | `resolveAggInStringFuncArg()` が `AGG_REF` を評価 | 新 arg union を透過。CASE 引数の NULL 規約を失わない |
| 列メタ | `inferSelectColumnMeta()` 等が直接フィールドだけ継承 | §5 の `inferAggregateArgMeta()` を共有 |
| 完全入力 | `containsStatisticalAggregate()` は AST 全体を汎用再帰 | 原則そのまま。ただし新ノードを含む fixture で検出を固定 |
| projection / alias | 合成名を内部キーとして HAVING/ORDER BY が参照 | alias 付きでも canonical 合成名キーを併記する既存契約を維持 |

### 7.2 必須フィールド収集

`collectRequiredFieldsByTable()` の集計分岐は現在 `walkArith(col.arg)` を呼ぶ（[selectToKintone.ts:476-495](../../src/converter/selectToKintone.ts#L476)・[selectToKintone.ts:643-645](../../src/converter/selectToKintone.ts#L643)）。次をすべて収集する必要がある。

- CASE の各 WHEN 条件の左辺・右辺フィールド
- THEN / ELSE のフィールド、算術、関数、連結の参照
- 修飾フィールドと JOIN 各表への帰属

CASE 条件は入力を絞る WHERE ではなく、各行の値を決めるだけである。フィールド収集では `phase = "select"` とし、条件を WHERE pushdown 候補へ混ぜない。

### 7.3 合成名・alias

`process.ts` と `selectToKintone.ts` に別々の集計引数ラベル生成があり、どちらも `ArithNode` 前提である（[process.ts:469-489](../../src/engine/process.ts#L469)・[selectToKintone.ts:729-764](../../src/converter/selectToKintone.ts#L729)）。CASE を単に `"case"` と短縮すると異なる条件付き集計が衝突する。

1 個の pure canonical serializer を SELECT・HAVING・projection/alias 解決で共有し、CASE の条件・各結果・ELSE、`||`、変数を括弧と演算子込みで決定的に直列化する。空白・キーワード大小は正規形へ揃える。SELECT の集計列キーと HAVING の合成名には同じ serializer 出力を使用し、byte 一致を受入条件とする。`isAggregateSyntheticName()` の関数名 regex は現行 12 関数を維持する。

利用者には新規の複雑な集計式で alias を強く推奨するが、alias を構文必須にはしない。alias なしでも列名衝突を起こさないことをテストする。B16 の既存契約どおり `SEPARATOR` は合成名に含めないため、同一引数を異なる separator で並べる場合は alias 必須のまま。

### 7.4 EXPLAIN と pushdown

- 集計列がある文は現行 `resolveSelectMode()` により FULL_SCAN であり（[selectToKintone.ts:67-80](../../src/converter/selectToKintone.ts#L67)）、CASE 引数を kintone の集計や WHERE へ押し下げない。
- WHERE 自体の安全な pushdown は従来どおり可能。ただし集計 CASE の WHEN 条件は pushdown しない。例えば `SUM(CASE WHEN status='done' THEN 1 ELSE 0 END)` の `status='done'` を WHERE へ移すと `COUNT(*)` 等の同時集計結果が変わる。
- EXPLAIN の mode は `FULL_SCAN` のまま。必要フィールド、WHERE の applied/residual、統計集約の `completeInputRequired` が新 AST でも正しく表示されることを固定する。
- `constant false WHERE` で records API を使わない場合の B56 完全入力表示免除は従来契約を維持する。

### 7.5 batch 変数

Phase 1 の裸 `@var` は、`resolveBatchVariableReferences()` が実行前に `VARIABLE` ノードを数値／文字列リテラルへ置換する既存経路を利用する。未定義・配列変数・未解決ノード到達時のエラー規約は既存 batch 契約を維持する。型メタは置換後リテラルから決め、変数値の内容を行ごとに推測しない。`SUM(@rate)` は解決された定数を入力行ごとに集計するため、結果は「入力行数 × rate」となる。

---

## 8. 後方互換

### 8.1 保証する不変条件

- 既に通る集計引数は旧 parser / `ArithNode` / `evalArithExpr()` を通り、AST snapshot と結果を維持する。
- `COUNT(*)`、各関数の wildcard 可否、`MODE(DISTINCT ...)` 拒否、B16 `SEPARATOR` は不変。
- 既存 6 集計の文字列単位 DISTINCT、B56 統計集約の数値単位 DISTINCT は不変。
- SUM/AVG の NaN・空入力、MIN/MAX の canonical comparison、GROUP_CONCAT の収集順、統計集約の完全入力・ArgumentError は不変。
- 集計算術式、文字列関数内集計、HAVING、ORDER BY alias の既存結果を変えない。

### 8.2 既存テスト・fixture

`src/parser/__tests__/parser.test.ts`、`parser_compat.test.ts` snapshot、`src/engine/__tests__/process.test.ts`、`statisticalAggregates.test.ts`、`modeAggregate.test.ts`、`src/converter/__tests__/selectToKintone.test.ts`、`src/__tests__/explain.test.ts` が主要回帰面である。

既存 fixture の期待 AST を新 AST へ一括更新する実装は不採用。二段パースにより既存 snapshot が無変更で通ること自体を drift guard とする。関数カタログの語数・関数名は増えないため B55 catalog fixture の一覧変更は不要だが、構文例または説明に「集計引数 CASE」を足す場合は MCP docs / statement syntax catalog の drift test を同時更新する。

SemVer は新規受理構文の追加なので minor。予約語追加は無く、既存の有効 SQL を意図的に無効化しない。

---

## 9. Phase 1 確定スコープと ParseError

### 9.1 単一 Phase 1

Phase 1 で CASE・`||`・裸の `@var` を一括出荷する。3 形はいずれも既存 `parseScalarValueExpr({ allowCase: true })` が `CASE_WHEN` / `CONCAT_OP` / `VARIABLE` / `SCALAR_ARITH` として表現でき、`||` は `CONCAT` 関数形と同義、`@var` は解決済みスカラー値である。比較・述語は同じ AST の範囲外であり、将来 Phase へ先送りするのではなく恒久拒否とする。

R1 では CASE の nullable 評価へ検証を集中するため CASE 単独出荷も比較したが、`||`・`@var` は新しい言語意味論を伴わず、同じ parser・walker・serializer・型推論を通る。受理ゲートを後で開き直すより、同一の drift guard で一括検証する方針に確定した。

### 9.2 Phase 1 同時出荷の集計引数専用 ParseError

Phase 1 でも拒否する比較・述語、サブクエリ／`EXISTS`、ネスト集約、`MODE(DISTINCT ...)` 等には、集計引数コンテキスト限定の専用メッセージを同時出荷する。汎用 `parseArithPrimary()` のエラー文は、集計以外の算術式位置を誤案内するため全置換しない。

比較・述語では CASE を第一候補として案内する。

```text
ParseError: 集計関数の引数に比較・述語は使用できません。CASE で値を明示してください。
例: SUM(CASE WHEN amount > 0 THEN 1 ELSE 0 END)
```

サブクエリ／`EXISTS` 等、CASE への直接置換だけでは十分でない形は CTE を案内する。

```text
ParseError: この集計関数の引数形式は使用できません。
CASE で値を明示するか、CTE で式を列にしてから集計してください。
```

ネスト集約と `MODE(DISTINCT ...)` は §3.5／既存 MODE 契約の専用理由を先に示し、必要に応じて CTE による段階分離を案内する。エラー分類と位置情報は既存 `ParseError` 契約を維持する。

---

## 10. エッジケース・負例

| SQL 形 | 現状 | R2 Phase 1 | 理由・期待 |
|---|---:|---:|---|
| `SUM(CASE WHEN p = 1 THEN amount ELSE 0 END)` | 拒否 | 受理 | 条件付き合計 |
| `COUNT(CASE WHEN p = 1 THEN 1 END)` | 拒否 | 受理 | 非一致は内部 NULL で非計数 |
| `AVG(CASE WHEN p = 1 THEN amount END)` | 拒否 | 受理 | 非 NULL 行だけで平均 |
| `MIN(CASE WHEN p = 1 THEN label END)` | 拒否 | 受理 | CASE 分岐メタが string、非一致 NULL は候補外 |
| `GROUP_CONCAT(CASE WHEN p = 1 THEN name END SEPARATOR '/')` | 拒否 | 受理 | NULL/空値をスキップ、収集順維持 |
| `STDDEV_POP(CASE WHEN p = 1 THEN amount END)` | 拒否 | 受理 | 完全入力・数値ガード維持 |
| `SUM((CASE WHEN p = 1 THEN 1 ELSE 0 END))` | 拒否 | 受理 | 新スカラー括弧は CASE を包める |
| `SUM((CASE WHEN p = 1 THEN 1 ELSE 0 END) + 0)` | 拒否 | 受理 | CASE を含む scalar arithmetic |
| `COUNT(DISTINCT CASE WHEN p = 1 THEN code END)` | 拒否 | 受理 | NULL 除外後、既存単位で DISTINCT |
| `GROUP_CONCAT(DISTINCT CASE WHEN p = 1 THEN name END)` | 拒否 | 受理 | 初出順の DISTINCT |
| `GROUP_CONCAT(name || '!')` | 拒否 | 受理 | `CONCAT(name, '!')` と同義の連結 |
| `SUM(@rate)` | 拒否 | 受理 | 解決済み scalar batch 変数。入力行ごとに定数 rate を集計するため「行数 × rate」 |
| `MODE(DISTINCT CASE WHEN p = 1 THEN x END)` | 拒否 | 拒否＋専用案内 | MODE の既存 DISTINCT 禁止 |
| `SUM(SUM(x))` | 拒否 | 拒否＋専用案内 | ネスト集約禁止 |
| `SUM(CASE WHEN SUM(x) > 0 THEN 1 END)` | 現状は外側 CASE で拒否 | 拒否＋専用案内 | CASE 条件内もネスト集約 |
| `SUM(CASE WHEN p = 1 THEN SUM(x) ELSE 0 END)` | 現状は外側 CASE で拒否 | 拒否＋専用案内 | CASE 結果内もネスト集約 |
| `SUM(amount > 0)` | 拒否 | **恒久拒否＋CASE 案内** | `SUM(CASE WHEN amount > 0 THEN 1 ELSE 0 END)` で明示 |
| `COUNT(amount > 0)` | 拒否 | **恒久拒否＋CASE 案内** | 比較を暗黙の値にしない |
| `SUM(EXISTS (SELECT ...))` | 拒否 | 拒否＋CASE/CTE 案内 | サブクエリ・EXISTS は対象外 |
| `ROW_NUMBER(CASE ...) OVER (...)` | 拒否 | 拒否 | 順位系は引数なし |

CASE の内部・外部を問わず、`parseScalarValueExpr({ allowCase: true })` が既に表現する範囲を受理する。例えば `CASE WHEN p THEN name || '!' END` とトップレベルの `GROUP_CONCAT(name || '!')` は同じ Phase 1 の対象である。

---

## 11. テスト計画

新規テスト名には `B64` を付ける。新規受理形は現状の ParseError を先に固定し、同じ SQL を実装後の成功期待へ反転して **before fail → after pass** を示す。恒久拒否する比較式は before/after とも ParseError とし、Phase 1 後は CASE 誘導を含む改良メッセージへ変わることを固定する。

### 11.1 パーサ特性化・受理

| ID | 修正前 | 修正後 |
|---|---|---|
| `B64-P01` | `SUM(CASE...)` が `CASE` 位置で ParseError | `AggregateColumn.arg.type === "CASE_WHEN"` |
| `B64-P02` | `SUM((CASE...))` が ParseError | 括弧を除いた CASE AST と同値 |
| `B64-P03` | CASE を持つ全 12 集計が ParseError | 全関数で受理。関数固有 option を保持 |
| `B64-P04` | `COUNT(DISTINCT CASE...)` / `GROUP_CONCAT(DISTINCT CASE... SEPARATOR '/')` が ParseError | `distinct` / `separator` と CASE AST を保持 |
| `B64-P05` | HAVING の CASE 引数が識別子期待で ParseError | SELECT と同じ parser helper で受理 |
| `B64-P06` | 既存算術引数が `ArithNode` | 修正後も AST deepEqual / snapshot 無変更 |
| `B64-P07` | `SUM(SUM(x))` 等が拒否 | 同じく拒否、専用 nested aggregate エラー |
| `B64-P08` | CASE 条件内集約は外側で先に失敗 | 外側 CASE 対応後も内側集約で確実に拒否 |
| `B64-P09` | `SUM(amount > 0)` / `COUNT(amount > 0)` が汎用 ParseError で拒否 | before/after とも拒否を維持し、修正後は集計引数専用 ParseError が `CASE` と具体例を案内 |
| `B64-P10` | `GROUP_CONCAT(*)` 等の既存負例 | 修正後も同じ ParseError |
| `B64-P11` | `GROUP_CONCAT(name || '!')` が ParseError | `CONCAT_OP` を持つ引数として受理し、`CONCAT(name, '!')` と同じ結果 |
| `B64-P12` | `SUM(@rate)` が ParseError | `VARIABLE` を持つ引数として受理し、実行前の解決経路を保持 |
| `B64-P13` | HAVING は CASE 引数を読めない | `SUM(CASE WHEN x=1 THEN 1 END)` と `SUM( CASE WHEN x = 1 THEN 1 END )`、さらに小文字キーワードの同値形が同一 canonical キーへ正規化され、SELECT の集計列キーと HAVING の合成名が byte 一致 |

`parser_compat.test.ts` の既存 snapshot は更新せず green を要求する。B64 の新 AST は別 snapshot/構造アサーションを追加する。

### 11.2 評価器

| ID | データ／期待 |
|---|---|
| `B64-E01` | done 2 行／other 2 行で §4.4 の COUNT/COUNT ELSE/SUM が `2/4/2` |
| `B64-E02` | `SUM(CASE ... THEN amount ELSE 0 END)` が事前に JS で条件抽出した合計と一致 |
| `B64-E03` | `AVG(CASE ... THEN amount END)` の分母が一致行かつ非空値だけ |
| `B64-E04` | MIN/MAX で ELSE 省略かつ全 WHEN false の内部 NULLは候補外 |
| `B64-E05` | MIN/MAX で WHEN が一致し、選択したフィールド値が空セルなら、既存 `MIN(field)` / `MAX(field)` と同じ canonical empty band の候補に残る。`B64-E04` の非一致 NULL と混同しない |
| `B64-E06` | MIN/MAX の明示 `ELSE ''` は空文字値として canonical empty band の候補に残る |
| `B64-E07` | GROUP_CONCAT CASE が非一致・空値を飛ばし、DISTINCT 初出順・separator を維持 |
| `B64-E08` | CASE + 旧集計算術（例: `SUM(CASE...)*2`）と関数内集計（`FORMAT(SUM(CASE...), '#')`）が正しい |
| `B64-E09` | GROUP BY あり／なし、入力 0 行、全 CASE false の出力が関数別既存規約と一致 |
| `B64-E10` | 解決済み `@rate` に対する `SUM(@rate)` が入力行数 × rate、`COUNT(@rate)` が非 NULL 入力行数になる |

### 11.3 統計・完全入力

- `B64-S01`: 5 統計関数と MODE の CASE 入力を外部計算と照合する。
- `B64-S02`: B56 の 5 関数では、CASE 選択結果に非数値／Infinity があれば関数名・値付き ArgumentError。非選択分岐の非数値は評価されずエラーにしない。MODE は文字列を有効値として頻度集計し、算術 NaN をスキップする B58 契約を別アサーションで固定する。
- `B64-S03`: 全 CASE false で `_POP` / `MEDIAN` / MODE、`_SAMP` の既存未定義値規約を固定する。
- `B64-S04`: `completeInputReasons()` が直接列、集計算術、文字列関数内、HAVING の新 AST でも `STATISTICAL_AGGREGATE` を返す。
- `B64-S05`: `onLimit=truncate` の完全入力拒否と EXPLAIN 表示が B56/B58 からドリフトしない。

### 11.4 型メタ

- `B64-M01`: number CASE の MIN/MAX/MODE が数値順（`2 < 10`）。
- `B64-M02`: string CASE がコードポイント順で、数値に見える文字列を数値順にしない。
- `B64-M03`: CASE の全分岐同型は伝播、混在・不明は string、ELSE 省略は型へ影響しない。
- `B64-M04`: CASE 集計を temp/CTE へ実体化し、二段目の MIN/MAX、ORDER BY、WHERE が伝播メタを使う。
- `B64-M05`: `SET @v = (SELECT SUM(CASE...))` は number、GROUP_CONCAT は string、MIN/MAX/MODE は引数推論型になる。

### 11.5 planner・field walker・EXPLAIN

- `B64-X01`: CASE 条件だけで使うフィールドと THEN/ELSE だけで使うフィールドを、単一表・JOIN・temp/CTE で必要フィールドへ収集する。
- `B64-X02`: CASE WHEN 条件は WHERE pushdown plan に入らず、元の WHERE だけが applied/residual になる。
- `B64-X03`: mode は FULL_SCAN、統計完全入力理由、maxRecords/onLimit 表示が正しい。
- `B64-X04`: alias なしの異なる 2 個の CASE 集計が異なる canonical 合成名を持ち、HAVING/ORDER BY の内部キーが衝突しない。
- `B64-X05`: SELECT と HAVING の両経路が同じ canonical serializer を使用する。`SUM(CASE WHEN x=1 THEN 1 END)` / `SUM( CASE WHEN x = 1 THEN 1 END )` と小文字キーワードの同値形を同一キーへ正規化し、SELECT で作った列を HAVING が参照できることを、生成文字列の byte 一致と実行結果の両方で検証する。

### 11.6 drift guard・全体回帰

- 既存集計 parser fixture と `parser_compat` snapshot が無変更。
- 既存 `process.test.ts` の SUM/AVG/MIN/MAX/COUNT/GROUP_CONCAT、`statisticalAggregates.test.ts`、`modeAggregate.test.ts` が green。
- `selectToKintone.test.ts` の required-field / FULL_SCAN、`explain.test.ts` の完全入力表示が green。
- B55 function catalog の 12 集計名・語数 guard は無変更 green。構文ヘルプへ例を追加した場合だけ対応 fixture を同時更新。
- `npm test`、build、MCP smoke/pack-smoke を実装時の最終 gate とする。ブラウザ固有処理は無いが、リリース手順が plugin smoke を要求する版ではその gate を省略しない。

---

## 12. 確定した判断と残論点

### 12.1 R2 で解決済み

1. **Phase 1 範囲**: CASE・`||`・裸の `@var` を単一 Phase 1 で出荷する。
2. **比較・述語**: 集計引数の値として恒久拒否する。暗黙 boolean 値は導入せず CASE へ誘導する。
3. **述語範囲**: 単純比較、`IS NULL`、`LIKE` / `KLIKE` / `IN`、論理結合を含め、述語自体はすべて値化しない。サブクエリ／`EXISTS` も対象外。
4. **NULL／空値**: 集計入力専用 nullable 評価を使い、MIN/MAX では非一致 NULL、選択された空セル、明示 `ELSE ''` を区別する。
5. **型・関数契約**: CASE の混在・不明型は string。全 12 集計で一貫受理し、MODE の DISTINCT 禁止、統計集約の完全入力・数値ガード、B16 の DISTINCT・空値・順序を維持する。
6. **HAVING／合成名**: SELECT と同時対応し、共有 canonical serializer で列キーと合成名の byte 一致を保証する。alias は推奨するが必須にせず、canonical 合成名キーを併記する。
7. **後方互換**: 旧 `ArithNode` を先に試す二段パースと旧評価経路を維持し、既存 AST snapshot・結果を変えない。
8. **ParseError**: 集計引数コンテキスト限定の CASE/CTE 誘導を Phase 1 と同時出荷する。

### 12.2 残論点

言語契約上の残論点はない。実装時に確定するのは helper／tagged value の具体名、backtrack の内部表現、既存 serializer の統合位置だけであり、本仕様の受理範囲・NULL/空値・型・合成名契約を変更してはならない。

---

## 13. 想定実装コストと完了条件

### 13.1 概算

コード未変更時点の R2 概算である。

| 範囲 | 規模 | 概算 |
|---|---|---:|
| Phase 1 CASE + `||` + 裸 `@var`（SELECT/HAVING、nullable 評価、型メタ、walkers、canonical serializer、専用 ParseError、全テスト） | 中〜大 | **5〜9 人日** |

比較・述語を値化する Phase は存在しない。最大の不確実性は parser ではなく、(1) NULL・選択空セル・明示空文字の分離、(2) CASE 分岐型の静的推論、(3) SELECT/HAVING の canonical 合成名 byte 一致、(4) required-field walker と EXPLAIN の経路網羅である。

### 13.2 Phase 1 完了条件

- §10 の Phase 1 受理／恒久拒否が一致する。
- §4.4 の条件付き COUNT/SUM が正しい。
- 全 12 集計で CASE・`||`・解決済み裸 `@var` の parser・評価・関数固有契約を検証する。
- 比較・述語、サブクエリ／`EXISTS`、ネスト集約、`MODE(DISTINCT ...)` が専用 ParseError で拒否され、比較は CASE を第一候補として案内する。
- MIN/MAX で非一致 NULL、選択された空セル、明示 `ELSE ''` の三系統が §4 と `B64-E04`〜`B64-E06` どおり区別される。
- B56 の完全入力・数値ガード、B58 MODE の完全入力・文字列頻度規約、B16 DISTINCT/空値/順序、B14 型メタが維持される。
- 既存算術引数の AST fixture と結果が無変更。
- required-field、EXPLAIN、pushdown の drift test が green。SELECT/HAVING の canonical 合成名は空白・キーワード大小差を正規化し、byte 一致と実参照成功の両方を満たす。
- 実装前 fail → 実装後 pass の B64 ID 付き証跡を残す。

---

## 14. R1 → R2 判断要約

R2 は、R1 の CASE 単独 Phase 1 と後続 Phase 案を廃し、既存 `ScalarValueExpr` が表現済みの CASE・`||`・裸 `@var` を単一 Phase 1 に確定した。一方、boolean 型を持たない言語契約を守るため比較・述語の値化案を全面撤回し、比較は恒久拒否して CASE を案内する。旧 `ArithNode` 優先の二段パース、集計入力専用 nullable 評価、ネスト集約の三重防御、混在・不明型の string、全 12 集計の既存規約、alias 非必須＋canonical 合成名キーは維持する。Claude レビューを受け、SELECT/HAVING が共有 serializer で byte 一致すること、および MIN/MAX で非一致 NULL・選択された空セル・明示空文字を別々に検証することを受入条件へ追加した。言語契約上の残論点はなく、実装内部名・統合位置だけが実装時確定事項である。概算は単一 Phase 1 全体で 5〜9 人日とする。
