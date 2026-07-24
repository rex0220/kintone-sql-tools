# B67 Phase1 Step 7 — relative date catalog / docs smoke

- 実施日: 2026-07-24
- 対象: catalog、parser spellings、function fixtures、MCP instructions、言語リファレンス、embedded docs
- SQL意味論: 変更なし（Step 7 は純加法の発見性・docs同期）

## 同期結果

- `KSQL_FUNCTION_CATALOG.contextual` は既存順 `TODAY NOW LOGINUSER` を維持し、後ろへ次の12関数を追加:
  - `YESTERDAY TOMORROW FROM_TODAY`
  - `THIS_WEEK LAST_WEEK NEXT_WEEK`
  - `THIS_MONTH LAST_MONTH NEXT_MONTH`
  - `THIS_YEAR LAST_YEAR NEXT_YEAR`
- `PARSER_FUNCTION_SPELLINGS` は token map に加え、`PARSER_IDENT_RELATIVE_DATE_FUNCTIONS` の12 spellingを含む。
- `KSQL_FUNCTION_SQL_FIXTURES` は12関数を各1件以上含み、全fixtureがparse成功。
  - `FROM_TODAY`: `DAYS` / `WEEKS` / `MONTHS` / `YEARS`
  - 週: 引数なしと `SUNDAY`〜`SATURDAY`
  - 月: 引数なし、`LAST`、数値`31`
  - 年・前日・翌日: 引数なし
- catalog ⇔ parser ⇔ fixture の双方向drift guardがgreen。
- CLI / plugin / Node library / MCP の実行面は共有engineを使い、相対日付allowlistの重複を持たない既存guardがgreen。

## instructions / docs

- MCP instructions実測: **541語**（期待値541、上限550以下）。
- complete function catalogは `KSQL_FUNCTION_CATALOG.contextual` から生成。
- server-onlyの長文はinstructionsへ重複せず、既存の `Use ksql_docs for arguments and constraints.` を維持。
- `docs/ksql_language_reference.md` の日付関数節とWHERE節へ、12関数、引数、4型、6比較、`BETWEEN`、server-only、exact pushdown必須、client fallbackなし、5 reason code、soft keyword、バッククォート退避を記載。
- Node非bundle docsとMCP embedded `language-reference/05-string-number-functions` / `language-reference/06-where` の同一説明への到達testがgreen。
- build後のMCP smokeはinstructions内の相対日付catalogとembedded docsのserver-only / exact-pushdown説明を確認。

## gate

| gate | 結果 |
|---|---|
| 対象test（catalog / fixture parse / docs resource / instructions語数） | 4 suites、52 tests、green |
| `npm test` | 通常154 suites / 3,853 tests + subprocess 2 suites / 25 tests、全green |
| 既存snapshot | 22 passed、変更なし |
| `npm run build` | plugin / CLI / MCP / MCPB / engine 全成功 |
| `npm run mcp:smoke` | ok |
| `npm run mcp:pack-smoke` | ok |
| `npm run mcpb:verify` | MCP / MCPB再buildを含め ok |

未解決点: なし。
