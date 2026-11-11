# B218 `/flow` の `validateScript` が一時テーブルの数などのバッチの検査を返さず、検査を通った SQL が実行の入口で止まる

- 起票: 2026-11-11（**KJ-13 の調査で発見**）
- ステータス: ✅ **リリース済み（v3.96.0・2026-11-11。npm latest と GitHub Release。公開した tarball で確かめた）**。**B217 と同じ v3.96.0**（2026-11-11 Takashi「3 OK」）
- 種別: バグ（検査と実行の食い違い。検査が厳しくなる側）
- 関連: [B217](ksql_b217_flow_batch_limits_option_issue.md)

## 1. 実測（v3.95.0）

一時テーブルを 17 個作る 18 文の SQL（`kintone-plugin/work-link/ksql-kj13-validate17.mjs`）:

| 入口 | v3.95.0 |
|---|---|
| `parseScript` | エラーなし |
| **`validateScript`** | **エラーなし** |
| `explainScript` | `ParseError: batch exceeds 16 temp tables.` |
| `createExecutionContext` | `ParseError: batch exceeds 16 temp tables.` |

未定義の一時テーブルの参照（`SELECT k FROM #nope`）も同じで、`validateScript` は通り、`createExecutionContext` で止まる。

kSQL アクションの［検査］（`checkActionSql`。オーサリングの kact_check も同じ）は `parseScript` と `validateScript` だけを使うので、
こうした SQL は**設定の検査を通り、押したときに止まる**。

## 2. 原因

一時テーブルの数・未定義の参照・同じ表の作り直し・変数の検査などは `analyzeBatch` にあり、`explainScript`（`buildBatchExplainPlans`）と
`createExecutionContext`（`createManagedStatementExecutionContext`）は通るが、`validateScript`（解析 ＋ `validateScriptCore`）は通らない。

## 3. 直し方（実装済み）

`validateScript` の最後で `analyzeBatch` を呼び（B217 の `maxTempTables` を渡す）、`BatchAnalysisError` を診断にする
（`KSQL1202`・`severity: "error"`・超えた文の `statementIndex` と位置）。解析で誤りがあるときは今までどおりそこで返すので、二重には出ない。
`analyzeBatch` は `/flow` の実行の入口が同じ文に対して呼ぶ関数なので、**ここで出る誤りはどれも実行の入口で止まるもの**＝
検査が厳しくなるのは「実行できない SQL」だけ。

## 4. 試験

`src/flow-library/__tests__/b217BatchLimits.test.ts` の B218 の 3 件（未定義の参照・誤りの位置〈文 17・18 行目〉・通る SQL に何も足さない）と、
B217 の一時テーブルの数の試験の `validateScript` の部分。
