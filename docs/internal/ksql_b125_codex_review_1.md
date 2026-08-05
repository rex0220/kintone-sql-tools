# B125 Phase 1 仕様 codex レビュー（1 回目）

## 結論

**要修正（高 6 件、中 5 件、低 1 件）。**

現状の R1 のままでは実装着手不可。特に、集計引数フィールドの取得漏れ、`MIN` / `MAX` の型メタ誤判定、`ORDER BY` なし集計ウィンドウの不完全入力、浮動小数と canonical 同値値に対する「通常集計と必ず一致」の不成立は、静かに誤った結果を返し得る。さらに `SELECT DISTINCT` 併用不可という前提は v1 仕様および現行実装と逆であり、既存機能を後退させる。

## 指摘

### [重要度: 高] 集計引数の物理フィールドが取得対象に追加されない

- 該当: 仕様の §4 / §7、コードの `src/converter/selectToKintone.ts:771-774`
- 内容: `AggregateWindowColumn.arg` を追加するだけでは、引数にだけ現れる物理フィールドが kintone から取得されない。たとえば `SELECT SUM(金額) OVER (ORDER BY 日付) AS 累計 FROM APP1` では、現行 `WINDOW_COL` 分岐は `日付` を集めるが `金額` を集めないため、評価時の `row["金額"]` が `undefined` となり全行がスキップされる。
- 根拠:
  ```ts
  case "WINDOW_COL":
    for (const ref of col.partitionBy) addFieldRef(ref.field, ref.tableAlias, "select");
    for (const item of col.orderBy) walkOrderByKey(item.key, "select");
    break;
  ```
- 提案: §7 に `collectRequiredFieldsByTable` の `AggregateWindowColumn.arg` 走査を明記し、既存集計引数と同じ walker で `FIELD_REF` / 算術式 / 関数 / `CASE` / `||` / `@var` を再帰収集する。引数フィールドを SELECT していない形を受入条件に追加する。

### [重要度: 高] `MIN` / `MAX` のウィンドウ列が既存箇所で一律「数値」と判定される

- 該当: 仕様の §3.4 / §4 / §7、コードの `src/engine/process.ts:1728-1734`、`src/execute.ts:1686-1693,2490-2510,4287-4288,5655-5675`
- 内容: 順位系しかなかったため、現行コードは `WINDOW_COL` を無条件に number としている。集計ウィンドウの `MIN` / `MAX` は文字列、日時、選択肢定義順など引数の意味型を保持すべきである。このままでは CTE / 一時テーブルへ実体化した後の比較・`ORDER BY`・後段集計・スカラーサブクエリ判定が数値扱いになり、文字列 `MIN` / `MAX` の結果を壊す。
- 根拠:
  ```ts
  // process.ts
  if (column.type === "ARITH_COL" || column.type === "ARITH_AGG_COL" || column.type === "WINDOW_COL") {
    result.set(column.alias, syntheticSemantics("number"));
  }
  ```
  ```ts
  // execute.ts（同形が複数箇所にある）
  else if (column.type === "ARITH_COL" || column.type === "ARITH_AGG_COL" || column.type === "WINDOW_COL") {
    semantics = syntheticSemantics("number");
  }
  // 通常集計側は MIN/MAX だけ引数メタを引き継いでいる
  if (column.func === "MIN" || column.func === "MAX" || column.func === "MODE") {
    ... inferAggregateArgMeta(column.arg, ...)
  }
  ```
- 提案: `SUM` / `COUNT` / `AVG` は number、`MIN` / `MAX` は通常集計と同じ `inferAggregateArgMeta` / `resolveAggregateArgSemantics` を使う契約を §4 と §7 に追加する。`isRankingWindow` だけでなく、上記の全メタ推論箇所を `windowKind` と `aggFunc` で分岐する。

### [重要度: 高] `ORDER BY` なし集計ウィンドウが完全入力を要求しない

- 該当: 仕様の §0 / §3.2 / §8.5、コードの `src/core/dmlGuard.ts:175-184`、`src/converter/selectToKintone.ts:75-81`
- 内容: FULL_SCAN は評価場所を決めるだけで、取得上限到達時に部分結果を許さないことまでは保証しない。現行の complete-input 判定はウィンドウ内 `orderBy.length > 0` のときだけ `WINDOW_ORDER` を立てる。したがって `COUNT(*) OVER (PARTITION BY 製品名)` や `SUM(x) OVER ()` は、`onLimit=truncate` 等で切れた入力をパーティション全体として集計し、もっともらしい誤値を全行へ書き得る。
- 根拠:
  ```ts
  if (stmt.distinct) reasons.add("DISTINCT");
  if (stmt.orderBy.length > 0) reasons.add("LOCAL_ORDER");
  for (const column of stmt.columns) {
    if (column.type === "WINDOW_COL" && column.orderBy.length > 0) reasons.add("WINDOW_ORDER");
  }
  ```
  ```ts
  if (hasWindowColumns(stmt.columns)) return "FULL_SCAN";
  ```
- 提案: 集計ウィンドウはフレームにかかわらず完全入力依存とし、専用 reason（例 `AGGREGATE_WINDOW`）を追加する。`onLimit=truncate` でも上限到達時に部分結果を返さない受入を §8.5 に追加する。

### [重要度: 高] 浮動小数では「パーティション最終値 = 通常集計値」が保証できない

- 該当: 仕様の §3.4 / §6.2 / §8.1 / §11.1、コードの `src/engine/process.ts:629-632,1041-1043`
- 内容: 通常 `SUM` / `AVG` は入力行順で `reduce` するが、ウィンドウ側は `ORDER BY` 後の順で加算する。binary64 の加算は順序依存なので、同じ値集合でも最終 bit pattern と文字列が異なり得る。§11.1 の「同じ倍精度なら一致条件で担保」は成立しない。たとえば `[1e16, -1e16, 1]` と `[1e16, 1, -1e16]` は通常の逐次加算結果が異なる。
- 根拠:
  ```ts
  const nums = statistical ? eff as number[] : (eff as string[]).map(Number);
  case "SUM": return nums.reduce((a, b) => a + b, 0);
  case "AVG": return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
  ```
  ```ts
  const sortedResult = sortDecoratedRows(partition, window.orderBy, ...);
  const sorted = sortedResult.rows;
  ```
- 提案: 次のどちらかを仕様で選ぶ。(a) 完全一致を捨て、有限値・許容誤差・`NaN` / `Infinity` の契約を明記する、または (b) 通常集計とウィンドウ集計の双方を同じ順序非依存または決定的な加算方式へ変更し、その方式自体を回帰契約にする。整数だけの APP4228 受入ではこの欠陥を検出できないため、桁差・相殺を含む小数ケースを追加する。

### [重要度: 高] canonical 同値の `MIN` / `MAX` は走査順変更で raw 出力が変わる

- 該当: 仕様の §3.4 / §6.2 / §8.1、コードの `src/engine/process.ts:618-626,699-721,1041-1043`
- 内容: 既存 `MIN` / `MAX` は canonical 比較が同値 (`cmp === 0`) の候補では先に現れた raw 文字列を保持する。通常集計は入力順、ウィンドウ集計はソート後順なので、数値意味型の `"1"` と `"01"` のような canonical 同値値があると、最終 raw 出力が変わり得る。比較規則が同じだけでは「値も必ず一致」しない。
- 根拠:
  ```ts
  let result = comparableValues[0];
  for (const candidate of comparableValues.slice(1)) {
    const cmp = compareCanonicalValues(candidate, result, semantics);
    if ((func === "MAX" && cmp > 0) || (func === "MIN" && cmp < 0)) result = candidate;
  }
  return result;
  ```
- 提案: canonical 同値時の決定規則を通常集計とウィンドウ集計で共有する（例: raw コードポイントを二次キーにする）か、raw 表記までの一致を契約から外す。CTE / 一時テーブル由来の数値意味型で表記の異なる同値値を受入へ追加する。

### [重要度: 高] `SELECT DISTINCT` 併用不可は既存契約と逆

- 該当: 仕様の §0 / §1 / §7 / §8.5、v1 仕様の `docs/internal/ksql_window_function_spec.md:145,253,288`、コードの `src/parser/parser.ts:1176-1180`、`src/engine/process.ts:764-827,1189-1190`
- 内容: v1 は `SELECT DISTINCT` とウィンドウ関数の併用を明示的に実装・受入している。現行パーサにも `hasWindow && distinct` の拒否はなく、`applyWindow` 後に `applyDistinct` が呼ばれ、`WINDOW_COL` は alias 値を DISTINCT tuple に含める。R1 の「従来どおり不可」を実装すると既存機能を壊す。
- 根拠:
  ```md
  <!-- v1 仕様 -->
  DISTINCT のキー生成 ... ウィンドウ列の出力値をキーへ含める。
  ... `SELECT DISTINCT` がウィンドウ列の値を区別する ...
  ```
  ```ts
  const hasWindow = columns.some((column) => column.type === "WINDOW_COL");
  const hasAggregate = columns.some((column) => this.selectColumnHasAggregate(column));
  if (hasWindow && (groupBy.length > 0 || grouping !== undefined || hasAggregate)) { ... }
  ```
  ```ts
  return (row) => JSON.stringify(buildDistinctTuple(columns, row, distinctContext));
  // evaluateSelectColumnValue の WINDOW_COL は row[column.alias] を返す
  ```
- 提案: `SELECT DISTINCT` 併用を維持し、§0・§1・§7・§8.5 を修正する。もし意図的に禁止へ変えるなら、これは「v1 踏襲」ではなく明示的な破壊的変更として根拠と移行策が必要。

### [重要度: 中] `RANGE` / `ROWS` 比較表の `RANGE` 値が末尾値になっていない

- 該当: 仕様の §3.2 / §6.3 / §9
- 内容: 同じ日付の 3 行が `+100, -30, -20` で、`ROWS` が `130, 100, 80` なら、同順グループ末尾の値は `80`。§6.3 のアルゴリズムどおりなら `RANGE` は 3 行とも `80` であり、表の `130` ではない。§9 は誤った表を言語リファレンスへそのまま転載するよう要求している。
- 根拠:
  ```md
  | +100 | RANGE 130 | ROWS 130 |
  | -30  | RANGE 130 | ROWS 100 |
  | -20  | RANGE 130 | ROWS 80  |
  ```
  ```md
  `RANGE` の場合、同順グループの末尾の値をそのグループ全行へ書き戻す
  ```
- 提案: `RANGE` 列を `80, 80, 80` に直す。受入では「同じ値」だけでなく、同順グループの全増減を含む期待値を固定し、先頭値を書き戻す誤実装も検出する。

### [重要度: 中] AST から「既定か明示か」が失われ、EXPLAIN の `(既定)` を判定できない

- 該当: 仕様の §4 / §7.2
- 内容: `frame` に実効 unit だけを入れ、「書かれたかは見ない」とする一方、EXPLAIN は既定時だけ `(既定)` を付けるとしている。同じ `{ unit: "RANGE" }` では、フレーム省略と明示 `RANGE ...` を区別できない。
- 根拠:
  ```ts
  export interface WindowFrame { unit: WindowFrameUnit; }
  frame: WindowFrame | null;
  ```
  ```md
  `frame` はパーサが既定を解決して入れる（実効フレーム）。
  明示された場合は `(既定)` を付けない。
  ```
- 提案: `frameSource: "DEFAULT" | "EXPLICIT"`、または `explicit: boolean` を AST に保持する。表示差を不要とするなら `(既定)` 要件を削除する。

### [重要度: 中] `aggregateRowValues` の契約が `COUNT(*)` と 12 集計回帰を固定できていない

- 該当: 仕様の §6.2 / §8.5、コードの `src/engine/process.ts:540-567,569-584`
- 内容: 現行の `COUNT(*)` は行評価ループの前で `rows.length` を返すため、「546-567 行を切り出す」だけでは wildcard の行ごとの値が定義されない。また現行はスキップ行を配列へ入れないが、提案ヘルパーは行数と同じ長さの `(string | null)[]` を返す。`evalAggregate` 側で null を一度だけ除去してから、統計関数の Number 化、例外、DISTINCT の順へ渡すことが明記されていない。
- 根拠:
  ```ts
  if (arg.type === "WILDCARD") {
    return func === "COUNT" ? rows.length : 0;
  }
  // 現行ループは skip 時 continue し、strValues へ要素を追加しない
  ```
  ```ts
  const numericValues = statistical ? strValues.map(Number相当) : null;
  const eff = distinct ? ... : ...;
  ```
- 提案: ヘルパーの事後条件を明記する。`COUNT(*)` は各行を count 対象として別分岐にするか、sentinel ではない専用表現を返す。通常集計側は `values.filter(v => v !== null)` を一度だけ行い、その後の Number 化→例外→DISTINCT→集計の順序を現行どおり固定する。実値の `null` は現行 `ProcessRow` では表現されず、`evalScalarValueExprNullable` の `null` はすでにスキップなので sentinel 自体との衝突はない。

### [重要度: 中] パーサの「変更点は 1 箇所」はトップレベル単独列に限ると明記が必要

- 該当: 仕様の §2 / §5.1、コードの `src/parser/parser.ts:1288-1359,1497-1549,1836-1840,2014-2051,2453-2474`
- 内容: SELECT の先頭集計は `parseSelectColumn` から `parseAggregateRef` を呼ぶが、同じ `parseAggregateRef` は集計算術式、スカラー式、`CASE` 内、HAVING にも使われる。`parseAggregateRef` 自体を「OVER 先読み 1 箇所」にすると戻り型 `AggregateRef` と合わず、許可していない位置まで窓構文を飲み込む。一方 `parseSelectColumn` の呼出し直後だけで先読みすれば、Phase 1 のトップレベル単独列には成立する。
- 根拠:
  ```ts
  const ref = this.parseAggregateRef(aggFunc);
  if (this.isArithOp(this.peek().kind)) {
    const expr = this.continueAggArith(ref);
    return { type: "ARITH_AGG_COL", ... };
  }
  ```
  ```ts
  // HAVING 経路も同じ関数を呼ぶ
  const ref = this.parseAggregateRef(aggFunc);
  ```
- 提案: 「変更点は `parseSelectColumn` のトップレベル集計分岐 1 箇所。`parseAggregateRef` は従来どおり引数閉じ括弧までを返す」と限定する。`SUM(a) OVER (...) * 2`、文字列関数や `CASE` に窓結果を入れる形、HAVING / ORDER BY への直接記述は Phase 1 で非対応と明記し、それぞれ専用 ParseError の受入を置く。現状設計のまま `SUM(a) OVER (...) * 2` を読むと、窓パーサが `AS` を期待する位置で `*` に当たり拒否されるのが自然である。

### [重要度: 中] `WINDOW_COL` 参照の「13ファイル」と §7 の列挙単位が一致していない

- 該当: 仕様の §4 / §7、コードの `src` 全体
- 内容: `rg -l --glob "*.ts" "WINDOW_COL" src` は確かに 13 ファイルだが、内訳はプロダクション 11、テスト 2。§7 の表はプロダクションの `src/execute.ts` を欠き、テスト 2 ファイルも示していない。また `window.func` を直接読むプロダクション箇所は `applyWindow` の `src/engine/process.ts:1051-1055` だけだが、直接 `func` を読まなくても「全 WINDOW_COL は数値」「WINDOW_COL の引数は partition/order だけ」という仮定を持つ箇所があり、こちらの方が影響が大きい。
- 根拠: 13 ファイルは以下。
  - プロダクション 11: `converter/selectToKintone.ts`、`core/applyPatchScope.ts`、`core/dmlGuard.ts`、`core/explainMetadata.ts`、`core/groupingValidation.ts`、`core/optimization/canonicalOrderPlanner.ts`、`core/optimization/plainGroupByPlan.ts`、`engine/process.ts`、`execute.ts`、`parser/parser.ts`、`types/ast.ts`
  - テスト 2: `core/optimization/__tests__/b71PlainGroupByPlan.test.ts`、`parser/__tests__/window.test.ts`
  ```ts
  const value = window.func === "ROW_NUMBER"
    ? index + 1
    : window.func === "RANK" ? rank : denseRank;
  ```
- 提案: §7 を上の 13 ファイルで明示し、各参照を (a) 存在判定のままでよい、(b) 順位系に絞る、(c) 集計系の引数・型・完全入力を追加処理する、の 3 分類にする。`execute.ts` の型メタ箇所は必須レビュー対象にする。

### [重要度: 低] `windowKind?: "RANKING"` は判別ユニオンとしては非対称

- 該当: 仕様の §4
- 内容: 提案の `isRankingWindow(c) { return c.windowKind !== "AGGREGATE"; }` を必ず使えば型ガードとして成立し、既存 AST も互換に扱える。ただし `windowKind === "RANKING"` の通常の判別では、既存 AST の `undefined` を順位系として絞れないため、将来の参照がヘルパーを迂回しやすい。
- 根拠:
  ```ts
  windowKind?: "RANKING";
  // 対して集計系は必須
  windowKind: "AGGREGATE";
  ```
- 提案: パーサ生成 AST は `windowKind: "RANKING"` を必ず入れ、旧 AST 互換を受ける境界でだけ normalize する案が型安全。optional を維持するなら、全参照で `isRankingWindow` を使うことを lint / テストで固定する。

## §3 の 6 点への回答

### 3.1 `evalAggregate` の切り出しは本当に安全か

**条件付きで安全だが、R1 の記述だけでは安全性を担保できない。**

- 現行の行評価は `FIELD_REF`、算術、その他スカラー式で分岐し、`MIN` / `MAX` だけ空文字を残す (`process.ts:545-567`)。このロジックを無変更で共有する方針自体は正しい。
- 実値の `null` は `evalScalarValueExprNullable` から返った時点でスキップされ (`560-562`)、`ProcessRow` の直接値は `string | undefined` として扱われている。したがって helper 内部の `null = skip` と、保持すべき空文字 `""` は区別できる。
- ただし 12 集計の DISTINCT 順序は、通常 6 集計が raw 文字列単位、統計集計が Number 化後の数値同値単位である (`569-584`)。helper の後で null 除去→統計 Number 化と有限性例外→DISTINCT の順を維持しなければ回帰する。
- `COUNT(*)` はループ外の特別分岐 (`540-543`) なので helper 契約に別途含める必要がある。
- 二重スキップは仕様からは排除できない。通常集計側の null 除去を「一度だけ」と明文化すべきである。

### 3.2 増分計算は既存の集計と同値か

**一般には同値でない。**

- `COUNT` は同じ skip 判定と `COUNT(*)` 特例を共有すれば同値。
- `SUM` / `AVG` は既存が入力順の `reduce` (`process.ts:629-632`)、窓側が `ORDER BY` 後の走査 (`1041-1043`) なので、binary64 の加算順序が変わり得る。数学的には同じでも exact な出力一致は保証できない。
- `MIN` / `MAX` は `compareCanonicalValues` の比較規則自体を共有できる。ただし canonical 同値時は既存が先勝ち (`621-625`) なので、入力順から窓順へ変わると raw 出力が変わり得る。
- 全行 skip の場合、既存は `MIN` / `MAX`、`SUM`、`AVG`、`COUNT` とも `0` (`620,631-632,586`)。増分側も未初期化 sentinel を最終的に `0` に変換すれば一致するが、R1 はその初期状態を規定していない。

### 3.3 `applyWindow` の同順検出は `RANGE` に流用できるか

**流用できる。§6.3 のアルゴリズムも正しい。**

`sortDecoratedRows` の comparator は `compareDecoratedRows` を呼び、`orderBy` の各キーだけを比較し、全キー同値なら `0` を返す (`process.ts:904-921`)。安定化用 index は comparator に混ざっていない。したがって `sortedResult.compare(prev, current) !== 0` は peer group 境界として使える。`ROWS` 累積値を作り、peer group の末尾値を全 peer へ書き戻す方法で、Phase 1 の `RANGE UNBOUNDED PRECEDING ... CURRENT ROW` になる。

ただし §3.2 の例表は末尾値ではなく先頭値 `130` を書いており、§6.3 と矛盾する。

### 3.4 パーサの先読みは成立するか

**トップレベル SELECT の単独集計列に限定すれば 1 箇所で成立する。共通 `parseAggregateRef` 自体での先読みは成立しない。**

- `parseSelectColumn` は `parseAggregateRef` 後、算術演算子を調べて `ARITH_AGG_COL` か `AGGREGATE` にする (`parser.ts:1341-1359`)。ここで `OVER` を先読みして `AggregateWindowColumn` に分岐できる。
- `parseAggregateRef` は集計算術式 (`1545-1549`)、スカラー値 / `CASE` 系、HAVING (`2453-2474`) からも共有される。戻り型は `AggregateRef` なので、ここで窓列を返す設計にはできない。
- `SUM(a) OVER (...) * 2` は Phase 1 AST に窓結果を operand とする型がない。窓列パーサが alias 必須を処理するなら `*` の位置で拒否される。専用の非対応診断と受入が必要。
- 集計ウィンドウ列は最終的に `WINDOW_COL` なので、現行 `selectColumnHasAggregate` は false を返す (`1446-1451`)。同じ SELECT に別の通常集計列があれば `hasAggregate` が true となり、`1176-1180` の併用チェックで拒否される。この R1 の主張は正しい。

### 3.5 `WindowColumn` をユニオンにする影響

**13 ファイルという数はテスト込みなら正しい。プロダクションだけなら 11 ファイル。§7 の表は不完全。**

- 全 13 ファイルは上の「`WINDOW_COL` 参照の 13 ファイル」の指摘に列挙した。
- `window.func` を直接読むプロダクション箇所は `src/engine/process.ts:1051-1055` の順位計算だけで、ここは `isRankingWindow` で絞る必要がある。
- 直接 `func` を読まないが kind-aware に直す必要がある箇所は、少なくとも `selectToKintone.ts:771-774`（集計引数収集）、`dmlGuard.ts:182-184`（完全入力）、`process.ts:1728-1734` と `execute.ts:1686-1693,2490-2510,4287-4288,5655-5675`（型メタ）である。
- `windowKind` optional でも提示ヘルパーを経由すれば既存 AST 互換は成立する。ヘルパーを通さない `windowKind === "RANKING"` では `undefined` の旧 AST を取りこぼすという型上の穴は残る。

### 3.6 既存契約との齟齬

- **`SELECT DISTINCT`: そのまま当てはまらない。** v1 は併用をサポートし、DISTINCT key にウィンドウ値を含めることまで受入条件にしている。R1 の拒否方針は既存契約と逆。
- **トップレベル `KORDER BY`: 結果として併用不可だが「従来の ParseError」ではない。** パーサの既存拒否条件は window + group/aggregate だけ (`parser.ts:1176-1180`)。一方ウィンドウ列は `resolveSelectMode` で FULL_SCAN となり (`selectToKintone.ts:75-81`)、`planKorder` は `staticMode !== "SIMPLE"` を `KORDER_QUERY_SHAPE_UNSUPPORTED` とする (`korderPlanner.ts:30-35`)。R2 は拒否フェーズと診断を正確に記述すべき。
- **`OVER (ORDER BY ...)` から同一 SELECT alias を参照不可:** 集計ウィンドウにもそのまま適用できる。窓内ソートは alias evaluator を渡さず入力行を評価し、canonical planner も物理 / 実体化列の意味型を要求する。CTE で一度実体化する回避策も同じ。
- **v1 §5 の DISTINCT 未対応記述:** これは実装前の現状分析であり、同じ v1 仕様内の実装差分・受入で対応済み。現行 `buildDistinctTuple` は `evaluateSelectColumnValue` の `WINDOW_COL` alias 値を使うため、Phase 1 で新たな穴にはならない。R1 §7 は古い「未対応」文だけを現在の前提として読んでいる。

## 受入条件で検出できること・できないこと

§8.1 の一致条件で検出できるのは、対象データに実際に含まれる空値、型、値域について、パーティション全体フレームの最終値が通常集計と一致するかである。`COUNT(*)` と `COUNT(field)`、全行 skip の初期値、APP4228 に存在する選択肢順などには有効。

一方、次は現行 §8 では検出できない。

- 引数フィールドが SELECT / PARTITION / ORDER キーにも偶然含まれている場合の required-field 収集漏れ。
- `onLimit=truncate` でパーティション入力が途中までしかない場合の部分集計。
- 小数の桁差・相殺による SUM / AVG の加算順序差。
- canonical 同値だが raw 表記が異なる `MIN` / `MAX` 候補。
- 文字列・日時・選択肢の `MIN` / `MAX` を CTE / 一時テーブルへ実体化した後の型メタ。
- RANGE で peer group の「先頭値」を全行へ書く誤実装。現状の期待は「同じ値」としか書かれていない。
- 既定 RANGE と明示 RANGE の EXPLAIN 表示差。
- `SUM(a) OVER (...) * 2`、CASE / 関数内、HAVING / ORDER BY への直接記述の拒否診断。

## §11 の未確定 3 点への意見

1. **AVG の丸め:** 「通常と同じ倍精度」だけでは不十分。通常集計と窓集計で加算順が変わるため、exact 一致、許容誤差、決定的加算方式のどれを契約にするかを R2 で確定すべき。推奨はまず Phase 1 の互換性を優先し、結果比較は有限値に対する明示的許容誤差とし、将来通常集計も含めて補償和等を導入する場合は別の回帰変更として扱うこと。
2. **`canonicalOrderPlanner`:** `ORDER BY` ありの集計ウィンドウは現行どおり window `orderBy` を `allOrderBy` に含め、canonical contract と完全入力を要求する扱いでよい。追加で必要なのは planner より、`ORDER BY` なしでも集計ウィンドウを complete-input とする guard である。トップレベル KORDER との拒否診断も固定する。
3. **規模上限:** Phase 1 のアルゴリズムが O(N) 時間・O(N) 追加値なら、v1 と別の固定「パーティション数 × 行数」上限は直ちには不要。ただし FULL_SCAN の既存 `maxRecords` を必ず完全入力ゲートとして効かせ、`truncate` で部分集計しないことが先決。複数集計ウィンドウ列では列数 × N の CPU が増えるため、性能受入に 1,000 件だけでなく複数窓列を含めるとよい。

## 仕様が正しかった点

- `resolveSelectMode` は `WINDOW_COL` の存在で FULL_SCAN を強制している (`selectToKintone.ts:75-81`)。
- `applyWindow` は `optionOrders` / `sortKinds` / `fieldSemantics` を `sortDecoratedRows` へ渡しており、既存の canonical comparator を共有している (`process.ts:1022-1043`)。
- `sortDecoratedRows` の comparator は ORDER BY キーだけを比較し、安定化 index を含まないため、RANK の同順境界を RANGE peer 判定へ再利用できる (`process.ts:895-921`)。
- ROWS 累積後、同順グループ末尾値を全 peer へ書き戻す §6.3 のアルゴリズムは、対象フレームの意味論に合う。
- `evalAggregate` の行評価部分を共有し、空文字 / null / NaN の規則を一箇所に保つ方向は妥当 (`process.ts:545-567`)。
- 通常 6 集計の DISTINCT は raw 文字列単位、統計集計は Number 化後の数値同値単位という現行順序の認識は正しい (`process.ts:569-584`)。
- `MIN` / `MAX` は空文字を候補に残し、全候補なしでは `0` を返すという現行契約の認識は正しい (`process.ts:550-563,618-626`)。
- 集計ウィンドウ列を `WINDOW_COL` とすれば `selectColumnHasAggregate` 自体には入らず、別の通常集計列または GROUP BY がある場合は既存の併用チェックが拒否する (`parser.ts:1176-1180,1446-1451`)。
- `RankingWindowColumn | AggregateWindowColumn` のユニオンと `isRankingWindow` の方向は、順位系と集計系で異なる payload を安全に分ける設計として妥当。
- `AS alias` 必須、PARTITION BY はフィールド参照、OVER ORDER BY は既存 `OrderByItem` 再利用という前提は現行 v1 と整合する (`parser.ts:1414-1443`)。
- ORDER BY ありの窓について `canonicalOrderPlanner` が window order keys を含めて検証する現行設計は集計窓にも適用できる (`canonicalOrderPlanner.ts:68-100`)。
- `core/explainMetadata.ts` の「window orderBy があればメタデータが必要」という存在判定は集計窓でもそのまま正しい (`explainMetadata.ts:68-74`)。
