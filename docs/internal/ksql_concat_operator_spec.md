# B38 スカラー値式基盤＋文字列連結演算子 `||` 仕様

- 作成日: 2026-07-18
- ステータス: **仕様 R4・実装前レビュー可**（R3→R4＝B37 R6 差分レビュー重大#2「なお不足」を確定＝§3.1.1 で既存 `StringFuncArg`(`AggOperand` 保持)・`FIELD` vs `FIELD_REF`・消費側 audit を**非破壊の加法方針**で確定。`FORMAT(SUM(...))` 非回帰必須）
- 分担: Claude=仕様/観点・Codex=実装/テスト
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B38（**B37 の前提**・束ねて次リリース）
- 関連: 既存 `CONCAT(...)`（[evalFunc.ts:286](../../src/engine/evalFunc.ts)）・[B37 カスタムチェック](ksql_custom_check_spec.md)

## 1. 目的

2 つの汎用基盤を入れる。

1. **文字列連結演算子 `||`**（SQL 標準）— 現状は `CONCAT(...)` のみで `'x=' || y` が書けない。
2. **再利用可能なスカラー値式 `parseScalarValueExpr` / `ScalarValueExpr`** と**関数引数の `@var` 受理** — 現状、値式のパース入口が非対称（WHERE 左辺 `parseFieldValue`／右辺 `parseSqlValue`）で、`CONCAT('x=', @v)` すら受理できない（`StringFuncArg` に `VariableRef` が無い・実機 ParseError）。B37 のメッセージ式・条件オペランドがこの共通基盤を必要とする。

いずれも SELECT 列・WHERE・SET など全スカラー式で効く汎用機能で、記述性と一貫性が上がる。

## 2. `||` 演算子

- **二項中置** `a || b`・**左結合**（`a||b||c` = `((a||b)||c)`）。意味は既存 `CONCAT(a,b)` と同義（両辺を文字列化して連結）。評価は CONCAT 評価へ委譲。数値も連結可。
- **NULL/空**: `'x' || 空セル = 'x'`（空は空文字。SQL 標準の NULL 伝播とは異なるが kSQL `CONCAT` と一貫）。言語リファレンスに明記。
- **優先順位**: 加減算（`+`/`-`）と同レベル・左結合（`*`/`/` より低く、比較より高い）。`a || b = c` → `(a||b)=c`。
- **トークン**: `||`（`|` 単体は kSQL に無く衝突なし）。予約語は増えない。

## 3. スカラー値式基盤（B37 依存・中#3 対応）

### 3.1 `ScalarValueExpr` の具体 AST（重大#2 対応）

現行 AST はリテラル/フィールド/変数/関数/算術/`||` を**1 つの再帰式で表せない**（`StringFuncArg` は文字列・算術・関数・集約のみ・[ast.ts:275](../../src/types/ast.ts)／`ArithNode` は文字列リテラル・変数をオペランドにできない・[ast.ts:686](../../src/types/ast.ts)）。よって新 union を確定する。

```ts
// 値レベルのスカラー式（述語・比較は含まない）
type ScalarValueExpr =
  | StringLiteral
  | NumberLiteral
  | FieldRef            // 修飾可 t.f / APP<n>.f
  | VariableRef         // @var
  | StringFuncExpr      // CONCAT / UPPER / ... （引数は ScalarValueExpr）
  | ArithExpr           // + - * / %（オペランドは ScalarValueExpr）
  | ConcatExpr          // a || b
  | CaseExpr;           // 既存 CASE（B37 メッセージでは parse 後検証で不許可・§3.3）

interface ConcatExpr { type: "CONCAT_OP"; left: ScalarValueExpr; right: ScalarValueExpr; }
```

- `parseScalarValueExpr` を公開入口として新設。**優先順位層**＝`* /`（最上位）＞`+ - ||`（同レベル左結合）＞（比較は含まない）。**停止トークン**＝`WHEN`/`THEN`/`CHECK`/処分節キーワード/`,`/`)`/文末。
- **非受理**: サブクエリ・集約（値式として不許可＝準備段で拒否）。`IS NULL` 等の**述語は `ScalarValueExpr` に含めない**（条件側 `WhereExpr` で受理・軽微#7）。
### 3.1.1 既存型との整合（B37 R6 レビュー重大#2 の確定・非破壊方針）

既存 `ArithNode`/`StringFuncArg` を無理に置換せず、**加法的に**共存させる（既存を壊さないことを最優先）。

1. **`StringFuncArg` は集約を保持**：`StringFuncArg = ScalarValueExpr | AggOperand` とする（現行が `AggOperand` を含み `FORMAT(SUM(金額))`・`FORMAT(100+SUM(金額))` で使用中・[ast.ts:275](../../src/types/ast.ts)・[parser.ts:1320](../../src/parser/parser.ts)・[process.ts:924](../../src/engine/process.ts)）。`ScalarValueExpr` 側は集約を含まないまま、引数として**両方**を受ける。→ 既存集約入り関数は非回帰。
2. **フィールド節は `FIELD`（修飾可）に統一**：`ScalarValueExpr` のフィールド参照は WHERE と同じ `{type:"FIELD", tableAlias, field}`（[ast.ts:427](../../src/types/ast.ts)）を使う。**算術用 `FIELD_REF`（[ast.ts:695](../../src/types/ast.ts)）とは別ノードのまま**とし、`ScalarValueExpr` 内の算術は**新 `ArithExpr`（オペランド＝`ScalarValueExpr`）**で表す（既存 `ArithNode` は SET 等で従来どおり温存・**強制統合しない**）。
3. **消費側 audit は新 union 全 node kind を対象**：`ScalarValueExpr` が到達し得る経路（拡張した関数引数・B37 メッセージ/条件オペランド）で、`CONCAT_OP`/`VARIABLE`/`STRING`/`FIELD`/`CASE` の各分岐を handle。既存の算術評価器が `NUMBER`/`FIELD_REF`/`STRING_FUNC`/`ARITH` しか見ない点（[evalFunc.ts:21](../../src/engine/evalFunc.ts)）に、新 node が**旧経路へ流れ込まないよう**入口を分離する（新 `ArithExpr`/`ScalarValueExpr` は新評価器・旧 `ArithNode` は旧評価器）。
4. **非回帰必須**：`FORMAT(SUM(...))`・`FORMAT(100+SUM(...))`（[process.test.ts:378](../../src/engine/__tests__/process.test.ts)）・既存 `ArithNode` 利用箇所。

- WHERE 左右オペランドの旧 `parseSqlValue`/`parseFieldValue` との完全統合は**任意**（本仕様は新 `parseScalarValueExpr` 公開入口までを必須とする・§7）。

### 3.2 関数引数・算術オペランドの拡張と全消費側 audit（中#5 対応）

- `StringFuncArg` を `ScalarValueExpr` へ拡張（＝`VariableRef` を含む）。`CONCAT('x=', @v)`・`CONCAT('a'||'b', x)`・`CONCAT(UPPER(@v), x)` が通る（現状 ParseError の解消）。
- **`StringFuncArg`/`ArithNode` の全消費側に `VARIABLE` 分岐を追加**（exhaustive audit・未更新だと型エラーor誤った算術処理）:
  - 引数評価 [evalFunc.ts:557](../../src/engine/evalFunc.ts)
  - SELECT フィールド収集 [selectToKintone.ts:271](../../src/converter/selectToKintone.ts)・[selectToKintone.ts:464](../../src/converter/selectToKintone.ts)
  - DML フィールド収集 [dmlToKintone.ts:246](../../src/converter/dmlToKintone.ts)
  - 無 alias 出力名生成 [process.ts:903](../../src/engine/process.ts)
  - 集約有無判定 `selectColumnHasAggregate`（`VARIABLE` は非集約・[parser.ts:899](../../src/parser/parser.ts)）
- **未解決 `@var` が評価器へ到達したら明示的 fail-closed**（既存のバッチ変数解決は AST 全体を再帰処理・[execute.ts:1197](../../src/execute.ts) 共有）。

### 3.3 B37 メッセージでの CASE 不許可

`ScalarValueExpr` は `CaseExpr` を含むが、**B37 メッセージ式は v1 で CASE 不許可**（[custom_check spec §4.2](ksql_custom_check_spec.md)）。共有入口にオプション（`allowCase`）を設けるか parse 後検証で拒否する、のどちらかを実装時に選ぶ。

## 4. 評価

- `||` は既存 CONCAT 評価（`String(left)+String(right)`・空は空文字）へ委譲。
- `@var` は既存のバッチ変数解決（WHERE/SET と同じ）を関数引数・スカラー値式でも適用。二重実装しない。

## 5. SemVer・実装順序・文書

- **minor**（純加法・既存クエリに影響なし・新規予約語なし）。
- **B37 の前提**として B38 を**先に確定・実装**する（B37 のメッセージ式・条件オペランドが `parseScalarValueExpr` と `@var` 引数に依存）。B38+B37 を 1 リリース。
- 言語リファレンスへ `||`（`CONCAT` 同義・NULL/空は空文字・優先順位）と「関数引数に `@var` 可」を追記。CHANGELOG・台帳 B38 を同期。

## 6. 受入条件（テスト化）

- `||`: `'a'||'b'`=`'ab'`／数値連結／`'a'||'b'||'c'`（左結合）／NULL・空は空文字（`CONCAT` と一致）／優先順位（比較より高い・`*//` より低い）／SELECT/WHERE/SET/CASE で動作／`a||b` == `CONCAT(a,b)`。
- **`@var` 引数**: `CONCAT('x=', @v)`・`CONCAT('x=', @v) || '!'`・入れ子 `CONCAT(UPPER(@v), x)` が評価される（現状 ParseError の解消）。
- **`parseScalarValueExpr`**: 修飾フィールド・`@var`・関数・算術・`||`・リテラルを受理し、**サブクエリ・集約・`IS NULL`（述語）は拒否**。優先順位（`*//` ＞ `+ - ||` ＞ 比較なし）と停止トークンをテストで固定。B37 がこの入口を共有できる（B37 テストで確認）。
- **全消費側 audit の非回帰**（中#5）: `VARIABLE` を関数引数に含む式で、引数評価・SELECT/DML フィールド収集・集約有無・無 alias 出力名が壊れない。未解決 `@var` は fail-closed。
- 非回帰: `||`/`@var 引数` を含まない既存クエリの挙動不変・`|` 単体トークンが無い・既存 `ArithNode`/`StringFuncArg` 利用箇所の回帰なし。

## 7. 対象外（v2）

- SQL 標準の NULL 伝播（`x || NULL = NULL`）への切替（kSQL は空文字連結を維持）。
- WHERE 左右オペランド parser の完全統合（本仕様は「公開入口の用意」までで、内部の全面統合は任意）。
