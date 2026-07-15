# 課題: 集計算術式の末尾オペランドが集計関数だと AS alias が静かに消える

- 作成日: 2026-07-11
- 更新履歴:
  - 2026-07-11 R1: 起票(v1.12.0 の 0 件集計対応 S1 のテスト作成中に発見。codex 実装後レビューでも起票推奨)
  - 2026-07-15 R2: レビュー反映(影響を「表示名のみ」→ HAVING/ORDER BY/後段参照/UNION の静かな不具合を含む「中」へ。修正方針を左オペランド込みの共通ヘルパー化へ。行番号を現行へ更新)。**codex レビュー済 → 仕様案へ**
- ステータス: **修正済み・v2.1.2 リリース済（CHANGELOG v2.1.2 参照）**
- 発見経緯: `docs/internal/ksql_ungrouped_aggregate_empty_result_spec.md` R3-②

## 事象

```sql
SELECT SUM(売上) - SUM(原価) AS diff FROM APP100
```

の `AS diff` が**エラーにも警告にもならず静かに無視され**、出力キーが合成名 `SUM(売上)-SUM(原価)` になる。

| 式 | alias | 理由 |
|---|---|---|
| `SUM(金額) * 1.1 AS x` | **効く** | 末尾オペランドが数値リテラル |
| `SUM(a) - SUM(b) AS x` | **消える** | 末尾オペランドが集計関数 |
| `SUM(a) / COUNT(*) AS x` | **消える** | 同上 |

## 原因(コード裏取り済み・行番号は 2026-07-15 現在)

`parseAggregateColumn`(`src/parser/parser.ts:1197-1214`)は**列パーサの流用**のため、`)` の後に **`AS alias` まで消費**する(`:1211`)。この関数が集計算術式の**左オペランドと右オペランドの両方**で使われており、式全体の alias を横取りする。

**外側 alias の消失**(`SUM(a) - SUM(b) AS diff`):
1. 集計列の入口(`parseColumn` 内 `:722-731`)が左集計を `parseAggregateColumn` で読む。左は `SUM(a)` の直後が `-` なので **AS は消費しない**(左 alias は null)。
2. `:725` で算術演算子を検出 → `:727` の `continueAggArith` が右オペランド `SUM(b)` を `parseAggPrimary`(`:829-855`)経由の `parseAggregateColumn`(`:851`)で読む。ここで **外側の `AS diff` を消費して捨てる**(`:852` は `func`/`distinct`/`arg` のみ使用)。
3. その後の `ARITH_AGG_COL` 生成(`:728`)で `consume(AS)` しても、AS は既に消費済みのため **alias は null**。

**中間 alias の誤受理**(`SUM(a) AS x - SUM(b)`・本来は不正):
- 左オペランドを読む `:724` の `parseAggregateColumn` が `SUM(a) AS x` の **`AS x` を消費**(`:726` で捨てる)→ その後 `-` を検出して算術式として継続するため、**式の途中に置いた alias を静かに受理**してしまう。CLI の dry-run でも受理される(要修正の副次バグ)。

## 修正方針(案)

**右オペランドだけを直しても不十分**(左オペランド `:724` も alias を消費するため、中間 alias 誤受理が残る)。**alias を絶対に消費しない共通ヘルパー**を設け、集計算術式の全オペランドで使う。

```text
parseAggregateRef()          // alias は読まない
  関数名 + "(" + [DISTINCT] + 引数 + ")"  → AggregateRef を返す
```

- **左端・右辺・括弧内・単項マイナス配下のすべての集計オペランド**を `parseAggregateRef()` で読む(alias を消費しない)。
- **式全体を読み終えた後にのみ** `AS alias` を消費し、`ARITH_AGG_COL.alias` に載せる。
- **単独集計列**(`SUM(a) AS x` のように算術演算子が続かない場合)だけ、読み取り後に `AS alias` を消費して `AggregateColumn` へ変換する。
- これにより `SUM(a) - SUM(b) AS diff` は alias が効き、`SUM(a) AS x - SUM(b)` は**中間 alias をパースエラーで拒否**できる。
- パース済み alias を後から `ARITH_AGG_COL` に持ち上げる案は、中間 alias を受理してしまうため**不可**。

**併せて検討(実行側)**: `ARITH_AGG_COL` は plain `AGGREGATE` と異なり、集計行に**合成名キーを併記しない**(`process.ts:240-241` は `col.alias ?? aggArithDefaultKey` の 1 キーのみ。`AGGREGATE` は `:238` で alias 付き時に合成名も併記)。alias を復活させた後、`HAVING`/`ORDER BY` を **alias でも合成名でも**解決させたいなら、`ARITH_AGG_COL` にも合成名の併記を追加するか、仕様として「alias を付けたら参照は alias のみ」に統一するかを決める(受入テストに直結)。

## 影響・優先度

**表示名だけの問題ではない。** alias が drop されると集計行は**合成名キーのみ**で保存され(`process.ts:239-241`)、利用者が書いた `diff`(intended alias)を参照する各所が静かに壊れる:

```sql
SELECT 種別, SUM(a) - SUM(b) AS diff
FROM APP100 GROUP BY 種別
HAVING diff > 0
ORDER BY diff DESC;
```

- **`HAVING diff`**: `row["diff"]` が空 → `Number("") = 0` → 常に偽側に倒れ、**静かにフィルタが効かない/全落ち**。
- **`ORDER BY diff`**: 全行が同値(空)扱い → **意図した順序にならない**。
- **CTE / 一時テーブルの後段**で `SELECT diff` しても値を取得できない(列は合成名)。
- **UNION の結果列**も `diff` ではなく合成名になる(左辺列名が下流に伝播)。

値そのものは正しいが、**フィルタ・ソート・後段参照・結合結果列が静かに誤る**ため、単なる表示名の問題より重い。回避策(`FORMAT(SUM(a) - SUM(b), '#') AS x`、または後段で合成名を参照)はあるが、合成名参照は下記のようにバッククォートが要る場合がある。

- 回避策の具体例(後段で合成名を参照):
  ```sql
  -- alias が効かないため、合成名をバッククォートで参照する
  SELECT 種別, `SUM(a)-SUM(b)` FROM #agg WHERE ...;
  ```
- **優先度: 中**(静かなフィルタ・ソート・後段参照不良を含む。発生条件は「集計算術式に alias を付け、その alias を参照する」で、集計バッチ・レポートで普通に起こり得る)。

## 受入テスト観点(仕様案・実装で満たす)

- **通常ケース**: `SUM(a) - SUM(b) AS diff` の出力列名が `diff`(現状 fail → 修正後 pass)。`SUM(a) / COUNT(*) AS r` も同様。
- **DISTINCT**: `SUM(DISTINCT a) - SUM(b) AS d` で alias が効く(ヘルパーが DISTINCT を正しく読む)。
- **括弧・単項マイナス**: `(SUM(a) - SUM(b)) * 2 AS d`、`-SUM(a) AS n` など、括弧内・単項マイナス配下の集計オペランドでも alias を横取りしない。
- **中間 alias 拒否**: `SUM(a) AS x - SUM(b)` は**パースエラー**にする(現状は誤受理)。
- **HAVING / ORDER BY(alias 参照)**: `HAVING diff > 0` がしきい値で正しく絞り込む/`ORDER BY diff DESC` が値順に並ぶ。合成名参照の扱い(併記の有無)は上記「実行側の検討」で決めた仕様に沿ってテスト。
- **CTE / 一時テーブル後段参照**: `WITH g AS (SELECT SUM(a)-SUM(b) AS diff …) SELECT diff FROM g` / `CREATE TEMP TABLE #g AS … ; SELECT diff FROM #g` が値を返す。
- **UNION 結果列**: alias 付き集計算術式を含む UNION の結果列名が alias になる。
- **回帰**: 既存の効くケース(`SUM(金額) * 1.1 AS x` = 末尾が数値リテラル)と、alias 無し(合成名出力)が不変。単独集計列 `SUM(a) AS x` の alias も不変。
