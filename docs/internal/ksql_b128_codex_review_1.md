# B128 集計ウィンドウ Phase 2 仕様 codex レビュー（1 回目）

## 結論

**要修正（高 9 件、中 7 件、低 0 件）。現状の R1 のままでは実装着手不可。**

特に、R1 の代表 SQL が現行パーサで明示的に拒否されること、`isRankingWindow` が新しい `VALUE` を順位系として扱うこと、`LAG` / `LEAD` の引数フィールド取得と型メタ伝播が現行分岐から漏れること、移動フレームの境界クリップが未定義であること、prefix sum の差分誤差が Phase 1 の相対誤差契約に収まらないことは、そのまま実装すると拒否または静かな誤値につながる。

一方、空フレームを既存 kSQL 集計に合わせて `0` とする認識、`ROWS` 移動窓を O(N) で処理する方向、`MIN` / `MAX` で既存 canonical comparator を共有する方向、`LAG` / `LEAD` が集計時の空値スキップを通らないという基本方針は、条件を補えば成立する。

## 指摘

### [重要度: 高] R1 の代表 SQL は現行の「ウィンドウ結果を式に含めない」契約に反する

- 該当: R1 §2 `docs/internal/ksql_b128_window_phase2_spec.md:67-75`、`src/parser/parser.ts:1301-1305,1552-1556`
- 内容: R1 は `ROUND(AVG(...) OVER (...), 1) AS 移動平均7` を代表例にしている。しかし B125 Phase 1 はウィンドウ結果を関数・算術式に含める形を非対応としており、現行パーサも nested aggregate window を検出して拒否する。R1 はこの AST / parser 拡張を Phase 2a のスコープに入れていないため、仕様どおり実装しても代表例は動かない。
- コード根拠:
  ```ts
  if (this.tryAggregateFunc() === null && this.hasNestedAggregateWindowInSelectColumn()) {
    throw new ParseError(
      "ウィンドウ関数の結果を式に含めることはできません。CTE で一度実体化してください",
      this.peek()
    );
  }
  ```
  ```ts
  if (this.isArithOp(this.peek().kind)) {
    throw new ParseError(
      "ウィンドウ関数の結果を式に含めることはできません。CTE で一度実体化してください",
      this.peek()
    );
  }
  ```
- 提案: Phase 2a で式内 window を新規対応するのでなければ、例を「内側 CTE で `AVG(...) OVER (...) AS 移動平均7_raw`、外側 SELECT で `ROUND(移動平均7_raw, 1)`」へ直す。受入にもこの CTE 回避形を入れる。式内 window まで対象にするなら、`SelectColumn` / scalar AST / 評価順 / required-field walker まで別の高リスク拡張として明記する。

### [重要度: 高] 「7 日移動平均」と「直近 7 行」が混同され、依頼元の実需を満たす条件が欠ける

- 該当: R1 §0・§1・§2 `docs/internal/ksql_b128_window_phase2_spec.md:9-13,40-43,67-75`
- 内容: R1 自身が `RANGE` の日数指定と `ROWS` は別物だと認識している一方、代表例を「7 日移動平均（直近 7 行）」と呼んでいる。同日複数行または取引のない日がある入力では、直近 7 行は直近 7 日ではない。現行実行はソート後の配列 index を順に走査するため、日付差は見ない。依頼元の「7 日移動平均」を Phase 2a が満たすのは、1 製品 1 日 1 行へ事前集約済みの場合だけである。
- コード根拠:
  ```ts
  const sortedResult = sortDecoratedRows(partition, window.orderBy, optionOrders, sortKinds, fieldSemantics);
  const sorted = sortedResult.rows;
  // 現行 window 評価は sorted の index を 0..N-1 で走査する
  for (let index = 0; index < sorted.length; index++) {
    // ...
  }
  ```
- 提案: 「7 行移動平均」と表記を直し、7 日需要を満たすレシピは日次集約 CTE の外側で `ROWS BETWEEN 6 PRECEDING ...` を使う形にする。そのレシピが kSQL の CTE 実体化と GROUP BY/window の別 SELECT 制約で実行可能であることを受入で固定する。日付範囲そのものが必要なら、Phase 2a は実需の半分を完全には満たさず、将来の値指定 `RANGE` が必要と明記する。

### [重要度: 高] 現行 `isRankingWindow` は `VALUE` を順位系として誤判定する

- 該当: R1 §5、`src/types/ast.ts:318-323`、`src/engine/process.ts:1047-1078`
- 内容: 現行 helper は「AGGREGATE でなければ RANKING」という二者択一である。`windowKind: "VALUE"` を追加すると `isRankingWindow(valueWindow)` が `true` になり、`window.func` を読む順位ループへ入る。さらに、ユニオンだけ先に広げた場合は `!isRankingWindow(window)` 側が `AggregateWindowColumn | ValueWindowColumn` となり、`applyAggregateWindow(AggregateWindowColumn)` への引数で型エラーになる可能性が高い。
- コード根拠:
  ```ts
  export function isRankingWindow(column: WindowColumn): column is RankingWindowColumn {
    return column.windowKind !== "AGGREGATE";
  }
  ```
  ```ts
  if (!isRankingWindow(window)) {
    applyAggregateWindow(window, sortedResult, resolveAggSortKind);
    continue;
  }
  const value = window.func === "ROW_NUMBER"
    ? index + 1
    : window.func === "RANK" ? rank : denseRank;
  ```
- 提案: legacy の `windowKind === undefined` だけを順位系互換として扱い、positive discriminator を使う。
  ```ts
  isRankingWindow = c => c.windowKind === undefined || c.windowKind === "RANKING";
  isAggregateWindow = c => c.windowKind === "AGGREGATE";
  isValueWindow = c => c.windowKind === "VALUE";
  ```
  `applyWindow` は 3 分岐を明示し、未知 kind は fail-closed にする。3 種を同じパーティション・異なる ORDER BY で混在させる受入を置く。

### [重要度: 高] `LAG` / `LEAD` の引数フィールドは現行 required-field 収集から漏れる

- 該当: R1 §5・§6.2・§6.3、`src/converter/selectToKintone.ts:778-784`
- 内容: 現行 `WINDOW_COL` walker は集計系だけ `arg` を走査する。`VALUE` を追加してもこの条件のままなら、引数にしか現れない物理フィールドは kintone から取得されず、`LAG(出庫)` が `undefined` / 空値相当になる。B125 の集計引数漏れと同じ形の静かな誤りである。
- コード根拠:
  ```ts
  case "WINDOW_COL":
    if (col.windowKind === "AGGREGATE" && col.arg.type !== "WILDCARD") {
      walkAggregateArg(col.arg, "select");
    }
    for (const ref of col.partitionBy) addFieldRef(ref.field, ref.tableAlias, "select");
    for (const item of col.orderBy) walkOrderByKey(item.key, "select");
    break;
  ```
- 提案: `VALUE` では必ず `walkAggregateArg(col.arg, "select")` 相当を通す。物理フィールド、修飾フィールド、算術、文字列関数、CASE、連結、変数を同じ walker で再帰収集する。受入 SQL は引数を SELECT / PARTITION BY / ORDER BY のどこにも重複させない。

### [重要度: 高] `VALUE` は現行の型メタ経路で一律 number になり、物理メタのロードゲートにも入らない

- 該当: R1 §4.2・§5・§6.2、`src/execute.ts:1688-1707,2591-2610,4284-4314,4445-4446,5853-5862`、`src/engine/process.ts:1826-1841`
- 内容: 現行コードには「`AGGREGATE` でなければ順位系 number」という二者択一が複数残っている。`VALUE` はコンパイルが通っても number と判定される。また `selectNeedsSourceColumnMeta` は集計窓の `MIN` / `MAX` だけを物理メタ取得対象にするため、`inferWindowColumnMeta` だけ直しても direct APP の `LAG(文字列/日付/選択肢)` では resolver が元フィールドメタを持たない。
- コード根拠:
  ```ts
  if (column.windowKind !== "AGGREGATE"
    || column.aggFunc === "COUNT" || column.aggFunc === "SUM" || column.aggFunc === "AVG") {
    return syntheticColumnMeta("number");
  }
  ```
  ```ts
  || (column.type === "WINDOW_COL" && column.windowKind === "AGGREGATE"
    && (column.aggFunc === "MIN" || column.aggFunc === "MAX"))
  ```
  ```ts
  if (isRankingWindow(column) || column.aggFunc === "COUNT" || column.aggFunc === "SUM" || column.aggFunc === "AVG") {
    result.set(column.alias, syntheticSemantics("number"));
  }
  ```
- 提案: `VALUE` は `inferAggregateArgMeta(column.arg, resolveField)` / `resolveAggregateArgSemantics(column.arg, resolver)` を通す。少なくとも次を同期する。
  1. `execute.ts:1691-1699` の scalar-subquery / 変数 numeric 判定
  2. `execute.ts:2597-2610` の alias semantics
  3. `execute.ts:4284-4295` の `inferWindowColumnMeta`
  4. `execute.ts:4304-4314` の source metadata load gate
  5. `execute.ts:4445-4446,5860-5862` の helper 呼び出し先（helper 修正で反映）
  6. `process.ts:1835-1841` の出力 ORDER semantics

  CTE / 一時テーブルへの伝播経路自体は存在する。`inferSelectColumnMeta` の結果は materialized result に保存される（CTE は `execute.ts:4972-4979`、一時テーブルは `execute.ts:1820-1825`）。したがって上記 helper とロードゲートを正しく直せば後段まで伝わるが、R1 の「引数型を継ぐ」一文だけでは必要箇所を固定できない。

### [重要度: 高] `WindowFrame.start/end` は実行・parser・EXPLAIN に対して純加法ではない

- 該当: R1 §5・§6.3、`src/parser/parser.ts:1525-1549`、`src/engine/process.ts:1100-1149`、`src/execute.ts:10868-10884`
- 内容: 現行 parser は default / explicit frame を `{ unit, source }` だけで生成し、実行は常に先頭から累積している。`RANGE` は累積配列の peer group 末尾を書き戻し、EXPLAIN は境界を文字列で固定している。必須 `start/end` を型へ足すだけでは parser がコンパイルエラーになり、仮に optional にして通しても runtime と EXPLAIN は固定境界のままになる。
- コード根拠:
  ```ts
  let frame: WindowFrame | null = orderBy.length > 0
    ? { unit: "RANGE", source: "DEFAULT" }
    : null;
  // ...
  frame = { unit, source: "EXPLICIT" };
  ```
  ```ts
  // 常に先頭から current row までを累積
  for (let index = 0; index < sorted.length; index++) {
    // count/sum/best を加算するだけ
    output.push(String(result));
  }
  ```
  ```ts
  `    frame: ${column.frame.unit} UNBOUNDED PRECEDING AND CURRENT ROW${
    column.frame.source === "DEFAULT" ? " (既定)" : ""
  }`
  ```
- 提案: 既存 frame 生成をすべて明示的な固定 bounds へ migrate し、実行を `(null=partition entire) / (fixed RANGE) / (ROWS arbitrary bounds)` に分ける。EXPLAIN は bound formatter で実値を表示する。B127 の `frame.source === "DEFAULT"` 判定はそのままで正しい。`RANGE` に固定境界以外の AST が渡された場合は、parser だけに依存せず runtime/planner でも fail-closed にする。

### [重要度: 高] 境界の「クリップ」の定義が不足し、パーティション外だけのフレームを current row に化けさせ得る

- 該当: R1 §2・§3.1・§6.1
- 内容: R1 は `[i-a, i+b]` をパーティション範囲でクリップするとだけ書くが、一般の start/end bounds の index 変換と空判定順を定義していない。たとえば先頭行の `ROWS BETWEEN 3 PRECEDING AND 1 PRECEDING` は raw bounds が `[-3,-1]` で、パーティションとの共通部分は空である。両端を個別に `[0,N-1]` へ clamp すると `[0,0]` となり、誤って current row を含める。
- コード根拠: 現行 `applyAggregateWindow` は arbitrary bounds を計算せず、`index=0..N-1` の累積しか持たない（`src/engine/process.ts:1100-1133`）。空 frame を既存コードから自然に得られる経路はないため、R1 で新規に一意な規則が必要である。
- 提案: 各 bound を未クリップ index へ写像し、`l = max(rawStart, 0)`、`r = min(rawEnd, N-1)` として、**`l > r` なら空**と定義する。endpoint を双方とも範囲内へ clamp してはならない。`UNBOUNDED_*`、`CURRENT ROW`、0 offset、start-after-end、partition 長 1 の全組合せを表で固定する。

### [重要度: 高] prefix sum の差分誤差は Phase 1 の相対誤差 1e-12 契約に収まらない

- 該当: R1 §3.3・§6.1、B125 §3.4、`src/engine/process.ts:610-613,1100-1131`
- 内容: Phase 1 の誤差は「同じ値集合を異なる順序で逐次加算する」差である。Phase 2 の `P[r] - P[l-1]` は、大きな共通 prefix 同士を減算するため別種の catastrophic cancellation を起こす。例として prefix が `1e16` の後の 1 行窓 `[1]` は、binary64 では `P[r]` と `P[l-1]` がとも `1e16` になり、差が `0` になり得る。期待値 `1` に対する相対誤差は 100% で、1e-12 には入らない。
- コード根拠:
  ```ts
  case "SUM": return nums.reduce((a, b) => a + b, 0);
  case "AVG": return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
  ```
  現行 window も `sum += Number(value)` という逐次加算であり、prefix 差分は現行と同じ計算法ではない。
- 提案: 「Phase 1 の契約を引き継ぐ」を削除し、Phase 2 用の数値契約を決める。少なくとも `[1e16, 1, -1e16]`、大きな共通 prefix の後の小窓、正負相殺、AVG を受入に入れる。1e-12 を維持するなら単純 prefix sum は不採用で、補償和・ブロック再集計等の別方式と誤差解析が必要である。性能 O(N) と精度契約のどちらを優先するかを R2 で明示する。

### [重要度: 高] 任意の `default` と「引数型をそのまま継ぐ」契約が矛盾する

- 該当: R1 §4.1・§4.2・§5・§6.2、`src/execute.ts:4270-4295`、`src/core/scalarCompare.ts:35-52,140-156`
- 内容: R1 は default に任意のスカラーリテラルを許しつつ、出力メタは常に引数型を継ぐとしている。`LAG(number_field, 1, 'N/A')` では通常行は数値、先頭行は非数値文字列だが、列全体は number semantics になる。後段の CTE ORDER BY / MIN / MAX / 比較は number comparator で `'N/A'` を扱い、引数型を継いだ列として一貫しない。日付・選択肢・ユーザー等でも同じ問題がある。
- コード根拠:
  ```ts
  function inferAggregateArgMeta(arg, resolveField) {
    if (arg.type === "FIELD_REF") return resolveField(...) ?? unknownStringColumnMeta();
    if (arg.type === "FIELD") return resolveField(arg) ?? unknownStringColumnMeta();
    // ...
  }
  ```
  ```ts
  case "number":
    return compareNumbers(left, right);
  case "option":
    return compareOptions(left, right, semantics);
  ```
- 提案: default を省略または引数メタと互換な literal に限定し、planning 時に検証する。少なくとも number には有限な数値 literal または空既定、文字列には string、選択肢等には型ごとの方針を定義する。あるいは arg/default のメタを merge して string へ劣化させる契約も可能だが、その場合「引数型をそのまま継ぐ」は成立しない。

### [重要度: 中] `LAG` / `LEAD` の parser 分岐と soft keyword 方針が実装可能な粒度まで定義されていない

- 該当: R1 §4.1・§7、`src/parser/parser.ts:1336-1375,1440-1442,221-225,2249-2333`、`src/lexer/tokens.ts:82-85,257-259`
- 内容: `LAG` / `LEAD` は aggregate token map に入らないため、既存の集計直後 `OVER` 分岐には乗らない。順位系 map にそのまま入れると `parseWindowColumn` が「引数なし」を要求する。さらに `parseAggregateArgExpr` の終端は `RPAREN` / `SEPARATOR` だけで、LAG の第 1 引数後の comma ではそのまま再利用できない。Lexer に hard keyword を追加すると、既存フィールド名 `LAG` / `LEAD` を非引用で参照できなくなる。
- コード根拠:
  ```ts
  const windowFunc = this.tryWindowFunc();
  if (windowFunc !== null) return this.parseWindowColumn(windowFunc);
  ```
  ```ts
  private isAggregateArgEnd(): boolean {
    return this.peek().kind === TokenKind.RPAREN || this.isSoftKeyword("SEPARATOR");
  }
  ```
  ```ts
  if (this.peek().kind !== TokenKind.RPAREN) {
    throw new ParseError(`${func} は引数を受け付けません`, this.peek());
  }
  ```
- 提案: `parseSelectColumn` の field 分岐より前に、IDENT spelling が `LAG` / `LEAD` かつ次が `(` の場合だけ value-window parser へ分岐する。引数 parser は terminator set を `COMMA | RPAREN` で parameterize する。`OVER` / `PARTITION` と同様に関数名も soft にすれば既存フィールド互換を保てる。`BETWEEN` は既存 hard keyword、`UNBOUNDED` / `PRECEDING` / `FOLLOWING` / `CURRENT` / `ROW` は現行 IDENT なので soft keyword で足りる。

### [重要度: 中] frame offset / LAG offset の「整数」は safe integer まで固定されていない

- 該当: R1 §2・§4.1、`src/parser/parser.ts:4194-4201`
- 内容: AST は offset を JavaScript `number` で持つ。現行 `parseUnsignedInt` は整数・非負だけを確認し、`Number.isSafeInteger` を確認しない。2^53 を超える literal は丸められ、別の offset として実行され得る。
- コード根拠:
  ```ts
  const n = Number(tok.value);
  if (!Number.isInteger(n) || n < 0) {
    throw new ParseError("正の整数が必要です", tok);
  }
  return n;
  ```
- 提案: 両 offset を非負 safe integer とし、必要なら `maxRecords` 以下へ制限する。`0`、最大 safe integer、2^53、指数表記、小数、負数を parser 受入に入れる。

### [重要度: 中] `LAG` / `LEAD` の「raw 値評価」は既存 helper をそのまま呼べず、契約が必要

- 該当: R1 §4.2、`src/engine/process.ts:648-674`、`src/engine/evalFunc.ts:26-41,45-78,82-113`
- 内容: `AggregateArgExpr` は legacy `FIELD_REF` / `ARITH` と新しい `ScalarValueExpr` の union である。`evalScalarValueExprNullable` は `ScalarValueExpr` しか受けず、`aggregateRowValues` は `FIELD_REF`・算術・scalar を分岐した上で空文字や NaN を skip する。LAG は skip してはいけないため、どちらもそのまま再利用できない。
- コード根拠:
  ```ts
  if (arg.type === "FIELD_REF") {
    const raw = row[arg.field];
    if (raw === undefined || (raw === "" && func !== "MIN" && func !== "MAX")) return null;
  } else if (arg.type === "ARITH" || arg.type === "NUMBER") {
    const n = evalArithExpr(arg, row);
    if (isNaN(n)) return null;
  } else {
    const value = evalScalarValueExprNullable(arg, row);
    if (value === null) return null;
  }
  ```
- 提案: `evaluateValueWindowArg(arg,row)` を別契約で用意し、`FIELD_REF` は `resolveFieldRef` の raw string、legacy arithmetic は数値結果の文字列、新 scalar は nullable evaluator の結果を **skip せず** 返す。CASE の null、欠損 field、空文字、NaN をそれぞれ default に置換するのか raw 表示するのかを表にする。「行が offset 外のときだけ default」であれば、target row 内の null/空値は default に置換してはいけない。

### [重要度: 中] 単調キューは成立するが canonical 同値時の raw 先勝ち規則が未定義

- 該当: R1 §3.3・§6.1、`src/engine/process.ts:599-607,1115-1121`
- 内容: 既存 MIN/MAX は canonical 比較が strict に良い候補のときだけ更新し、同値なら先に現れた raw を保持する。単調キューで `cmp <= 0` / `>= 0` の候補まで後方 pop すると、`"1"` と `"01"` のような canonical 同値値で後勝ちとなり、素朴な `evalAggregate` と raw 出力が一致しない。
- コード根拠:
  ```ts
  const cmp = compareCanonicalValues(candidate, result, semantics);
  if ((func === "MAX" && cmp > 0) || (func === "MIN" && cmp < 0)) result = candidate;
  ```
- 提案: キュー後方の除去は「新値が strict に良い場合」だけとし、同値の古い候補を残す。窓左端から古い同値値が抜けた後に次の同値値へ移ることを確認する。number/record/option semantics と raw 表記違いを受入へ入れる。

### [重要度: 中] 素朴実装との一致だけでは、共有コード由来の誤りを oracle が検出できない

- 該当: R1 §6.1・§6.3、`src/engine/process.ts:533-674,255-310`
- 内容: `evalAggregate` と `aggregateRowValues` は module-private で、テストから直接 import できない。参照実装は、切り出した frame ごとに export 済み `applyGroupBy` を呼べば既存 `evalAggregate` を間接利用できるため現実的である。ただし optimized path と reference path が同じ argument evaluator / semantics resolver を共有すると、両方が同じように空値・型・field 欠損を誤って一致する。
- コード根拠:
  ```ts
  function evalAggregate(...) { /* private */ }
  function aggregateRowValues(...) { /* private */ }
  export function applyGroupBy(...) {
    // ...
    materializeAggregateColumns(outRow, groupRows, columns, resolveAggSortKind);
  }
  ```
- 提案: ランダム / property 的な optimized-vs-`applyGroupBy(slice)` 比較に加え、手計算の固定期待値を置く。required-field、parser、metadata は full execute / CTE 受入で別に検証する。oracle 用に production private helper を export する必要はない。

### [重要度: 中] 現行受入条件は clipping・型伝播・取得漏れ・同順 tie を十分に検出しない

- 該当: R1 §6 全体
- 内容: APP4228 と素朴実装の一致だけでは、引数 field が偶然ほかの SELECT/ORDER 列にもある、物理 APP 直読みだけで CTE を通さない、値域が小さい、ORDER BY が全順序、canonical 同値 raw がない、といった場合に主要バグを見逃す。
- コード根拠:
  - required-field は `selectToKintone.ts:778-784` の独立 walker であり、engine 単体比較では通らない。
  - materialized metadata は CTE の `execute.ts:4972-4979` と一時テーブルの `execute.ts:1820-1825` で別経路に保存されるため、直読み結果の raw 値だけでは確認できない。
  - numeric / source meta の分岐は `execute.ts:1688-1707,4284-4314` にあり、`applyWindow` 単体テストでは通らない。
- 提案: 少なくとも次を追加する。
  1. SELECT に出さない物理 field を LAG 引数だけで参照
  2. `WITH w AS (... LAG(text/date/option) ...) SELECT MIN/ORDER BY ... FROM w`
  3. 一時テーブルへ実体化後の同形
  4. partition 長 0/1、offset 0/1/N/N+1、partition 越境なし
  5. `3 PRECEDING AND 1 PRECEDING` の先頭、`1 FOLLOWING AND 3 FOLLOWING` の末尾という clipping 後空 frame
  6. canonical 同値 raw 候補
  7. prefix cancellation 固定値
  8. default と引数メタの互換 / 非互換
  9. 既定・明示・移動 frame の EXPLAIN 全境界表示

### [重要度: 中] `LAG` / `LEAD` の非全順序 ORDER BY に対する決定性契約がない

- 該当: R1 §4.1・§6.2、`src/engine/process.ts:1059-1061`、R1 §6.2 の例
- 内容: `LAG` / `LEAD` は peer 内の並び順そのものが値を決める。現行 `sortDecoratedRows` の比較器が同順を `0` とすることは RANGE には正しいが、ORDER BY が一意でない value window では「前の行」が一意に定まらない。受入例は `日付, レコード番号` で全順序にしているが、構文は非全順序も許す。
- コード根拠:
  ```ts
  const sortedResult = sortDecoratedRows(partition, window.orderBy, optionOrders, sortKinds, fieldSemantics);
  const sorted = sortedResult.rows;
  ```
  comparator は peer を同値として返す設計であり、LAG 固有の tie breaker は追加されていない。
- 提案: SQL と同様に「同順内の結果は未規定」と文書化し、レコード番号等の tie breaker を推奨するか、B127 相当の warning を value window にも出す。暗黙 `$id` tie break を入れると ranking/RANGE の peer 契約を壊すため、共有 comparator 自体へ混ぜてはいけない。

## 依頼 7 点への回答

### 1. `WindowFrame.start/end` は純加法か

**純加法ではない。** 型の追加だけでも現行 parser の `{ unit, source }` 生成が壊れ、runtime と EXPLAIN は固定境界を前提にしている。

| 箇所 | 判定 | 必要な対応 |
|---|---|---|
| `types/ast.ts:291-294` | 型変更 | bounds を必須化。legacy AST を受けるなら normalize 境界を別に置く |
| `parser.ts:1528-1549` | 固定前提 | default RANGE と既存明示 ROWS/RANGE に `UNBOUNDED_PRECEDING` / `CURRENT_ROW` を格納。移動 ROWS を parse |
| `process.ts:1100-1133` | 固定前提 | 先頭累積だけでは moving start を扱えない。fixed RANGE と moving ROWS を分岐 |
| `process.ts:1135-1138` | 影響なし | `frame === null` は ORDER BY なし・partition entire のままでよい |
| `process.ts:1140-1147` | 条件付き | RANGE peer 末尾書き戻しは固定 bounds にのみ継続。moving RANGE は reject |
| `execute.ts:10880-10884` | 固定前提 | hard-coded bounds を formatter に置換 |
| `execute.ts:2528-2553` | 影響なし | B127 は `windowKind === AGGREGATE` かつ `frame.source === DEFAULT`。moving explicit では出ない |

B127 の source 判定はコードどおり正しい。

```ts
column.type === "WINDOW_COL"
&& column.windowKind === "AGGREGATE"
&& column.orderBy.length > 0
&& column.frame?.source === "DEFAULT"
```

### 2. `WindowColumn` 3 メンバー化の全参照分類

`rg -l 'WINDOW_COL' src -g '*.ts'` の現行結果は **13 ファイル（production 11 + test 2）**。分類は依頼どおり、(a) 影響なし、(b) 処理追加・修正が要る、(c) union 追加だけで型エラーになる箇所、である。

| ファイル | 分類 | 根拠・対応 |
|---|---|---|
| `src/converter/selectToKintone.ts` | **(b)** | FULL_SCAN (`:60-81`) と output name (`:855-857`) は不変。required-field (`:778-784`) に VALUE arg walker が必要 |
| `src/core/applyPatchScope.ts` | (a) | `WINDOW_COL` 存在を禁止する汎用 traversal (`:510-511,545-546`)。kind 非依存 |
| `src/core/dmlGuard.ts` | (a) | VALUE は ORDER BY 必須なので既存 else-if の `WINDOW_ORDER` (`:184-187`) で完全入力になる。AGGREGATE_WINDOW は集計系だけでよい |
| `src/core/explainMetadata.ts` | (a) | VALUE も ORDER BY 必須なので `orderBy.length > 0` の存在判定 (`:68-75`) で metadata が必要になる |
| `src/core/groupingValidation.ts` | (a) | window 全体の存在禁止 / traversal (`:197-208,226-227,249-250`) で kind 非依存 |
| `src/core/optimization/canonicalOrderPlanner.ts` | (a) | 全 window の order keys を収集 (`:68-71`) する設計が VALUE にも必要 |
| `src/core/optimization/plainGroupByPlan.ts` | (a) | 全 window は `POST_GROUP_ONLY` (`:60-67`) のまま |
| `src/engine/process.ts` | **(c)** | `!isRankingWindow` から `applyAggregateWindow(AggregateWindowColumn)` (`:1062-1064`) へ渡す箇所と、negative branch で `aggFunc/arg` を読む型メタ (`:1835-1841`) が `Aggregate | Value` になり得る。3-way dispatch と VALUE evaluator が必要 |
| `src/execute.ts` | **(b)** | 多くはコンパイルが通るが VALUE を number と誤処理する (`:1691-1699,2597-2610,4284-4295`)。source meta gate (`:4304-4314`) と EXPLAIN (`:10868-10884`) も追加処理が必要。generic order/FULL_SCAN/no-FROM 存在判定は不変 |
| `src/parser/parser.ts` | **(b)** | value function の入口、引数、OVER parser が必要。既存 aggregate/window 分岐には直接乗らない (`:1336-1375,1469-1572`) |
| `src/types/ast.ts` | **(b)** | `ValueWindowColumn` と 3 個の positive type guards が必要 (`:287-323`) |
| `src/core/optimization/__tests__/b71PlainGroupByPlan.test.ts` | (a) | 手書き ranking AST (`:245-253`) は引き続き `POST_GROUP_ONLY`。VALUE 固有変更は不要 |
| `src/parser/__tests__/window.test.ts` | **(b)** | parser の VALUE / moving frame / reject case を追加。既存 ranking exact AST と Phase 1 frame expectations (`:9-117`) も回帰維持 |

補足: `WindowFrame.start/end` も同時に必須化すると、`parser.ts:1528-1549` の object literal は別理由で確実に型エラーになる。上表の (c) は **WindowColumn の 3 メンバー化単独**の判定である。

`isRankingWindow` 使用箇所は現行では `process.ts:1062,1836` の 2 箇所だけで、どちらも VALUE 対応が必要。execute 側は helper を使わず `windowKind !== "AGGREGATE"` を書いているため、型エラーではなく silent number 判定になる。

### 3. 空フレームの値

現行コードの実値は次のとおりであり、R1 の認識は正しい。

| 関数 | `evalAggregate([])` 相当 | `applyAggregateWindow` の未初期化値 | WINDOW_COL への格納 |
|---|---:|---:|---|
| `COUNT(*)` | `rows.length = 0` | `count = 0` | `"0"` |
| `COUNT(expr)` | `eff.length = 0` | `count = 0` | `"0"` |
| `SUM` | `reduce(..., 0) = 0` | `sum = 0` | `"0"` |
| `AVG` | `nums.length === 0 ? 0` | `count === 0 ? 0` | `"0"` |
| `MIN` / `MAX` number | `comparableValues.length === 0 ? 0` | `best ?? 0` | `"0"` |
| `MIN` / `MAX` string/date/option | 同じく number の `0` を返す | 同じく `0` | `"0"`。ただし列メタは引数型を継ぐ |

根拠:

```ts
if (arg.type === "WILDCARD") {
  return func === "COUNT" ? rows.length : 0;
}
if (func === "COUNT") return eff.length;
if (comparableValues.length === 0) return 0;
case "SUM": return nums.reduce((a, b) => a + b, 0);
case "AVG": return nums.length === 0 ? 0 : ...;
```

```ts
const result = window.aggFunc === "COUNT" ? count
  : window.aggFunc === "SUM" ? sum
  : window.aggFunc === "AVG" ? count === 0 ? 0 : sum / count
  : best ?? 0;
output.push(String(result));
```

注意点として、`MIN` / `MAX` は空文字を skip しない (`process.ts:656-670`)。したがって raw `""` が候補にある frame は「全行 skip」ではなく、結果 `""` になり得る。

意見: **Phase 2a も kSQL 側の `0` に揃える案は実装整合性が高く、採用可能**。ただし標準 SQL と異なり、文字列・日付・選択肢の MIN/MAX でも `"0"` を返し、moving frame では通常操作で頻発する。R2 では「非標準」「全 5 関数・全意味型」「出力は文字列」を明記し、言語リファレンスと固定期待値へ入れるべきである。将来 NULL へ変えるなら Phase 2 だけでなく通常集計 / Phase 1 と result representation をまとめて扱う別変更にする。

### 4. 計算量設計

#### SUM / COUNT / AVG

`COUNT` の prefix count は成立する。`SUM` / `AVG` の単純 prefix difference も O(N) だが、**Phase 1 の相対誤差 1e-12 契約は引き継げない**。大きな共通 prefix の差分で小窓が消えるため、R2 で別の精度契約または別アルゴリズムが必要である。

#### MIN / MAX

単調両端キューは成立する。`resolveAggregateArgSemantics` を partition/window ごとに 1 回解決し、比較は `compareCanonicalValues` だけを使える。比較器の二重実装は不要。ただし canonical 同値の raw 先勝ちを保つため、後方 pop は strict improvement のときだけにする。

#### 素朴参照実装

現実的であるが、`evalAggregate` / `aggregateRowValues` は private なので直接 import はできない。テスト内で frame slice を作り、export 済み `applyGroupBy(slice, [], [aggregateColumn], resolver)` を使えば既存 evaluator を間接利用できる。production helper を test のためだけに public export する必要はない。ただし fixed expected vectors を併用しないと shared bug を検出できない。

### 5. `LAG` / `LEAD` の出力型メタ

**引数の意味型を継ぐ方針は正しい。ただし現行の 6 箇所を同期することが条件。**

- execute/materialized meta: `inferAggregateArgMeta`
- process/order meta: `resolveAggregateArgSemantics`
- direct physical APP の field info load gate: `selectNeedsSourceColumnMeta`
- scalar subquery を変数へ入れる numeric 判定
- HAVING / alias semantics（到達可能な派生 query を含む）
- `inferWindowColumnMeta` の consumers

CTE / 一時テーブルへの格納先は既に `MaterializedColumnMetaMap` を持ち、`inferSelectColumnMeta` の結果を保存する（CTE は `execute.ts:4972-4979`、一時テーブルは `execute.ts:1820-1825`）。したがって入口を直せば後段へ伝播する。ただし default の型互換規則も同時に必要である。

受入は raw 値確認だけでなく、CTE / temp の後段で `ORDER BY`、`MIN/MAX`、scalar subquery numeric 判定を通す必要がある。

### 6. パース上の落とし穴

- `BETWEEN` は既存 hard keyword (`TokenKind.BETWEEN`) なのでそのまま使える。
- `UNBOUNDED` / `PRECEDING` / `FOLLOWING` / `CURRENT` / `ROW` は現行 keyword enum にないため、`isSoftKeyword` / `consumeSoftKeyword` で足りる。
- `LAG` / `LEAD` は既存フィールド名互換のため soft function spelling を推奨する。hard token にすると非引用 field が壊れる。
- 分岐位置は `parseSelectColumn` の既存 ranking 分岐付近、field fallback より前。`IDENT(LAG|LEAD) + LPAREN` のときだけ value-window parser へ入る。
- `parseAggregateRef` は使わない。`parseAggregateArgExpr` を再利用するなら comma を terminator にできるよう parameterize する。
- offset/default を読んだ後に `OVER (...)` を必須化し、ORDER BY 必須、frame token 残存時は専用 ParseError にする。
- same SELECT alias を `LAG(arg)` に書く契約も明記する。現行 required-field walker は識別子を物理 field として収集するため、推奨は Phase 2b では拒否し CTE 実体化を案内することである。

### 7. 受入条件で検出できない穴

素朴実装との一致で検出できるのは、同じ入力値・同じ意味型・同じ frame slice を与えたときの optimized accumulator / queue の差である。次は別の受入が必要である。

- optimized/reference が共有する argument evaluator の空値・NaN・CASE 誤り
- required-field walker の VALUE arg 漏れ
- direct APP metadata load gate と CTE/temp metadata の欠落
- parser が代表 SQL を拒否する問題
- default と arg metadata の非互換
- clipping 前後の空判定を両実装が同じように誤る問題
- prefix difference の誤差を reference 側の許容比較が見逃す問題
- canonical 同値 raw が fixture にない場合の queue tie 誤り
- 非全順序 ORDER BY の LAG/LEAD 非決定性
- window alias を同じ SELECT の LAG arg に使う依存問題

## 仕様が正しかった点

R2 で消さない方がよい点は次のとおり。

1. ウィンドウ列があれば FULL_SCAN とする前提は現行 `resolveSelectMode` と一致する (`selectToKintone.ts:60-81`)。
2. VALUE window も ORDER BY 必須なら、現行 `dmlGuard.ts:184-187` の `WINDOW_ORDER` で完全入力要求に乗る。
3. `sortDecoratedRows` と canonical order metadata を共有し、比較器を二重実装しない方向は正しい (`process.ts:1059-1061`、`canonicalOrderPlanner.ts:68-71`)。
4. moving `ROWS` と値指定 `RANGE` を分け、後者を Phase 2a 非対象にする切り分けは妥当。
5. start/end の grammar から不正な `UNBOUNDED FOLLOWING` start と `UNBOUNDED PRECEDING` end を除外している点は妥当。
6. start-after-end を受理して空 frame の値を返す方針は、moving window の一般性を保つ。ただし index/intersection 規則の補足が必要。
7. `COUNT(*)` と `COUNT(expr)`、SUM/AVG、MIN/MAX で既存の空値規則を共有する方向は回帰防止に有効 (`process.ts:533-674`)。
8. `LAG` / `LEAD` が `aggregateRowValues` の skip 規則を通らず、target row の raw 値を返すという区別は正しい。
9. `offset=0`、partition 先頭/末尾の default、partition 越境禁止を受入に挙げている点は正しい。
10. MIN/MAX を単調キュー、SUM/COUNT/AVG を O(N) 系で扱い、O(N×W) を production 実装にしない性能目標は妥当。
11. 素朴実装を test oracle に置く方向は有効。固定期待値との併用だけ補えばよい。
12. B127 warning を `frame.source === "DEFAULT"` で判定し、明示 moving ROWS では出さない方針は現行 AST / code と一致する (`execute.ts:2528-2553`)。
13. `GROUP BY` / 通常集計との同一 SELECT 併用拒否、`SELECT DISTINCT` 併用維持、順位系回帰を前提にしている点は現行 parser / pipeline と一致する (`parser.ts:1188-1192`)。

## R2 での最小修正チェックリスト

1. 代表例を CTE 形へ直し、「7 行」と「7 日」を分離する。
2. frame bound の raw index・intersection・empty 規則を定義する。
3. fixed RANGE / moving ROWS / partition entire の runtime 分岐と EXPLAIN 表示を列挙する。
4. 3-way type guards と 13 ファイル分類を仕様本文へ取り込む。
5. VALUE arg required-field walker と全型メタ経路を列挙する。
6. default の型互換規則を決める。
7. offset を非負 safe integer とする。
8. parser の soft function / comma-aware arg parsing を明記する。
9. prefix difference 用の独立した数値誤差契約を決める。
10. monotonic queue の canonical 同値・raw 先勝ち規則を明記する。
11. optimized-vs-naive に fixed expected / full execute / CTE / temp 受入を足す。
12. 非全順序 ORDER BY の結果契約または warning 方針を決める。
