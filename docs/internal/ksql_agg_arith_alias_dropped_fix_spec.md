# 仕様案: 集計算術式 alias 消失バグ修正（alias 非消費の共通ヘルパー化）

- 作成日: 2026-07-15
- 対象課題: [ksql_agg_arith_alias_dropped_issue.md](./ksql_agg_arith_alias_dropped_issue.md)（codex レビュー済み R2）
- ステータス: **仕様案（codex 実装レビュー前）**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- SemVer: **バグ修正**。alias が効くようになる挙動変更＋中間 alias を新たに拒否（従来は誤受理）。後者は「これまで通っていた不正 SQL がエラーになる」ため、厳密には**互換性のある不正入力の是正**。→ 版数は実装後に確定（minor 相当を想定）。

## 1. 目的とスコープ

`SELECT SUM(a) - SUM(b) AS diff` の `AS diff` が静かに捨てられ、出力列・`HAVING`/`ORDER BY`/後段参照/UNION 結果列が合成名になってしまうバグを、**パーサ側だけ**で修正する。併せて、式の途中に置いた不正な alias（`SUM(a) AS x - SUM(b)`）を**パースエラー**にする。

### 対象
- 集計算術式（`ARITH_AGG_COL`）の末尾・中間オペランドが集計関数のケースでの alias 保持。
- 集計オペランドを読むすべての経路での alias 横取り防止（§3.3 の 5＋1 経路）。

### 対象外（今回変更しない）
- **実行側（`process.ts` / `applyGroupBy`）は変更しない**。パーサが alias を保持すれば `outputKey = col.alias ?? aggArithDefaultKey(col.expr)`（[process.ts:240](../../src/engine/process.ts#L240)）が自然に `diff` を使い、`HAVING diff` / `ORDER BY diff` / 後段 `SELECT diff` / UNION 結果列が復旧する。
- **`ARITH_AGG_COL` への合成名キー併記は追加しない**（§2）。

## 2. HAVING / ORDER BY の仕様決定

| ケース | 出力キー | 参照 |
|---|---|---|
| alias あり（`… AS diff`） | `diff` | `HAVING diff` / `ORDER BY diff` / 後段 `SELECT diff` が `diff` で解決 |
| alias なし | 合成名（`aggArithDefaultKey`、例 `SUM(a)-SUM(b)`）※従来どおり | 合成名で参照 |

- **`ARITH_AGG_COL` に合成名キーは併記しない。** 根拠: 現行文法では **`HAVING` に集計算術式そのものを書けない**（[parseFieldValue:1499-1511](../../src/parser/parser.ts#L1499) の集計分岐は `func(識別子|*)` の**単一集計のみ**を合成名化する。`SUM(a) - SUM(b)` を `HAVING` 左辺に直接は書けない）。したがって「合成名でも alias でも引ける」二重解決は不要で、内部キー追加による別の挙動変化（列衝突・UNION 列順など）も避けられる。
- plain `AGGREGATE` の合成名併記（[process.ts:238](../../src/engine/process.ts#L238)）は既存の別修正（alias 付き集計で HAVING が常に偽になる問題）由来で、そのまま維持。`ARITH_AGG_COL` には拡張しない。

## 3. パーサ修正

### 3.1 新規: `parseAggregateRef()`（alias を絶対に消費しない）

現行 `parseAggregateColumn`（[:1197-1214](../../src/parser/parser.ts#L1197)）は `)` の後で `AS alias` を消費する（[:1211](../../src/parser/parser.ts#L1211)）。これを**alias を読まない**版に分離する。

```ts
/** 集計関数参照を読む。alias は絶対に消費しない（AggregateRef を返す）。 */
private parseAggregateRef(func: AggregateFunc): AggregateRef {
  this.advance();                     // 関数名トークン
  this.expect(TokenKind.LPAREN);
  const distinct = this.consume(TokenKind.DISTINCT);
  let arg: AggregateColumn["arg"];
  if (this.consume(TokenKind.STAR)) {
    arg = { type: "WILDCARD" };
  } else {
    arg = this.parseArithAddSub();    // フィールド名・算術式・関数呼び出し
  }
  this.expect(TokenKind.RPAREN);
  return { type: "AGG_REF", func, distinct, arg };   // ← AS は読まない
}
```

- 引数・戻り値の型は現行の `AGG_REF`（`AggregateRef`）に一致（[:726](../../src/parser/parser.ts#L726) / [:852](../../src/parser/parser.ts#L852) と同形）。
- `DISTINCT`・`*`・算術引数（`SUM(金額 * 1.1)` 等）の読み取りは現行 `parseAggregateColumn` と同一。**違いは末尾で `AS` を読まない点のみ**。

### 3.2 単独集計列と集計算術式の分岐（列入口 `:722-731`）

現行はまず `parseAggregateColumn`（alias 消費版）で読んでしまうため、算術が続く場合に**中間 alias を横取り**する。これを「まず alias 無しで参照を読み、算術有無で分岐してから AS を読む」に変える。

```ts
const aggFunc = this.tryAggregateFunc();
if (aggFunc !== null) {
  const ref = this.parseAggregateRef(aggFunc);        // alias を読まない
  if (this.isArithOp(this.peek().kind)) {
    // 集計算術式: ref を左端オペランドとして式全体を読む
    const expr = this.continueAggArith(ref);          // 右辺以降も alias 非消費（§3.3）
    const alias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;  // ← 式全体の後だけ
    return { type: "ARITH_AGG_COL", expr, alias } satisfies AggArithColumn;
  }
  // 単独集計列: ここでだけ AS を読む
  const alias = this.consume(TokenKind.AS) ? this.parseAliasName() : null;
  return { type: "AGGREGATE", func: ref.func, distinct: ref.distinct, arg: ref.arg, alias } satisfies AggregateColumn;
}
```

### 3.3 集計オペランドを読むすべての経路で `parseAggregateRef()` を共有

`parseAggregateColumn`（alias 消費）を使っている/経由している箇所を、すべて `parseAggregateRef()` に統一する。対象は次の **5 経路**（＋括弧・単項マイナスは `parseAggPrimary` 経由で自動的にカバー）:

| # | 経路 | 現行 | 変更 |
|---|---|---|---|
| 1 | 単独集計列の先頭 | `parseAggregateColumn`（[:724](../../src/parser/parser.ts#L724)） | `parseAggregateRef` + §3.2 の後段 AS |
| 2 | 集計算術式の左端 | 同上（[:724](../../src/parser/parser.ts#L724)） | `parseAggregateRef`（§3.2） |
| 3 | 右オペランド | `parseAggPrimary`→`parseAggregateColumn`（[:851](../../src/parser/parser.ts#L851)） | `parseAggregateRef`（[:851](../../src/parser/parser.ts#L851) を置換） |
| 4 | 括弧内 | `parseAggPrimary` の `(` 分岐（[:832](../../src/parser/parser.ts#L832)）→再帰 | #3 の置換で自動カバー |
| 4' | 単項マイナス配下 | `parseAggPrimary` の `-` 分岐（[:839](../../src/parser/parser.ts#L839)）→再帰 | 同上 |
| 5 | 文字列関数内の集計式 | `parseStringFuncArg`→`parseAggPrimary`（[:1166](../../src/parser/parser.ts#L1166)）→`parseAggregateColumn` | #3 の置換で自動カバー |

`parseAggPrimary`（[:829-855](../../src/parser/parser.ts#L829)）の集計分岐（[:851](../../src/parser/parser.ts#L851)）を `parseAggregateRef` に置換すれば、#3/#4/#4'/#5 は同経路のため一括で直る。#1/#2 は §3.2 の書き換えで直る。

**結果として `parseAggregateColumn` は呼び出し元が無くなる → 削除**（呼び出しは現状 [:724](../../src/parser/parser.ts#L724) と [:851](../../src/parser/parser.ts#L851) のみ。HAVING の集計は [:1500](../../src/parser/parser.ts#L1500) の独自実装で別物）。

### 3.4 `AS` の許可位置と中間 alias の拒否

- **`AS` は SELECT 列全体を読み終えた後だけ**消費する（§3.2 の 2 箇所：単独集計列の後、集計算術式全体の後）。
- オペランド解析中（`parseAggregateRef` / `continueAggArith` / 括弧内 / 文字列関数引数内）は `AS` を消費しない。その結果、途中に現れた `AS` は次の `expect`/分岐で**未消費のまま残り、構文エラーになる**。具体例:
  - `SUM(a) AS x - SUM(b)`: 先頭 `parseAggregateRef` が `SUM(a)` を読み、`AS` は算術演算子でないので単独集計列と判定 → `AS x` を alias として読む → 続く `- SUM(b)` が SELECT 列の後の余剰トークンとなり **ParseError**。
  - `FORMAT(SUM(a) AS x, '#')`: 関数引数内で `parseAggregateRef` が `SUM(a)` を読み、`AS` は算術演算子でないので集計式終了 → 引数の後に `,` を期待するが `AS` を検出し **ParseError**。
  - `(SUM(a) AS x - SUM(b))`: 括弧内で `SUM(a)` を読んだ後 `)` を期待するが `AS` を検出し **ParseError**。
- いずれも「不正な中間 alias を静かに受理」から「明示的な構文エラー」へ変わる（現状 fail=誤受理 → 修正後=ParseError）。

## 4. 受入テスト（修正前 fail → 修正後 pass）

- **通常ケース**: `SELECT SUM(a) - SUM(b) AS diff FROM APP` の結果列名が `diff`（現状は `SUM(a)-SUM(b)`）。`SUM(a) / COUNT(*) AS r` も同様。
- **DISTINCT**: `SUM(DISTINCT a) - SUM(b) AS d` で alias が効き、DISTINCT が保持される。
- **括弧・単項マイナス**: `(SUM(a) - SUM(b)) * 2 AS d`、`-SUM(a) AS n` で alias が効き、括弧内・単項マイナス配下の集計 alias を横取りしない。
- **中間 alias 拒否**: `SUM(a) AS x - SUM(b)` / `FORMAT(SUM(a) AS x, '#')` / `(SUM(a) AS x - SUM(b))` が **ParseError**（現状は誤受理）。
- **HAVING（alias 参照）**: `SELECT 種別, SUM(a)-SUM(b) AS diff FROM APP GROUP BY 種別 HAVING diff > 0` がしきい値で正しく絞り込む（現状は `row["diff"]` 空で常に偽側）。
- **ORDER BY（alias 参照）**: `… ORDER BY diff DESC` が値順に並ぶ（現状は全行同値）。
- **CTE / 一時テーブル後段**: `WITH g AS (SELECT 種別, SUM(a)-SUM(b) AS diff FROM APP GROUP BY 種別) SELECT diff FROM g` / `CREATE TEMP TABLE #g AS …; SELECT diff FROM #g` が値を返す。
- **UNION 結果列**: alias 付き集計算術式を左辺に含む UNION の結果列名が alias になる。
- **文字列関数内の集計式（回帰）**: `FORMAT(SUM(a) - SUM(b), '#') AS x`（回避策）が従来どおり動く。
- **回帰（不変であること）**:
  - 末尾が数値リテラルの既存効くケース `SUM(金額) * 1.1 AS x`。
  - alias 無し `SUM(a) - SUM(b)` の出力キーが合成名のまま。
  - 単独集計列 `SUM(a) AS x` / `COUNT(*) AS c` の alias。
  - plain `AGGREGATE` の合成名併記（HAVING 解決）に影響しない。

## 5. リスク・非対象

- **リスク**: `parseAggregateRef` と旧 `parseAggregateColumn` の引数・DISTINCT・`*` 読み取りがズレると回帰する → **本体は現行 `parseAggregateColumn` から `AS` 消費行だけを除いたもの**にし、標準的な複数行集計テストで `{rows, columns}` の一致を固定。
- **リスク（互換）**: 中間 alias を新たに拒否するため、もし誤って `SUM(a) AS x - SUM(b)` を書いていた既存クエリはエラーになる。ただし従来から **alias は無視されていた**（意図した名前になっていない）ので、実害のある依存は考えにくい。CHANGELOG に明記する。
- **非対象**: 実行側の合成名併記追加、`HAVING` に集計算術式を直接書けるようにする文法拡張（別課題）。
