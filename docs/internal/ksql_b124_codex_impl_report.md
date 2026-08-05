# B124 実装報告

## 結果

完了。

- `npm test`: 成功
  - 通常スイート: 222 suites / 5,382 tests / 22 snapshots passed
  - CLI subprocess: 2 suites / 26 tests passed
  - `version:check`: v3.45.0 の release version pin 同期を確認
- B124 専用＋B65 allowlist の最終再実行: 4 suites / 25 tests passed
- B119〜B122・集計 alias・CASE・文字列関数・変数 resolver の対象回帰: 16 suites / 371 tests passed
- `npm test` 実行プロセス内だけ `KSQL_USERNAME` / `KSQL_PASSWORD` /
  `KINTONE_USERNAME` / `KINTONE_PASSWORD` を解除した。恒久環境とリポジトリ設定は変更していない
- git 操作と kSQL MCP tool call は行っていない

## 変更ファイルと変更内容

- `src/types/ast.ts`
  - `AggOperand` に `AggGroupKeyRef` と既存 `VariableRef` を追加
  - 新しい公開型に既存型への必須プロパティ追加は行わず、`tableAlias` は仕様どおり optional とした
- `src/parser/parser.ts`
  - `parseAggPrimary` で `@変数` と修飾可能な GROUP BY キー候補を解析
  - 候補の token 位置は AST 公開型へ載せず `WeakMap` で保持
  - SELECT 列と HAVING を SELECT 単位で走査し、ordinary `GROUP BY` の `FIELD_NAME` と表記一致を検証
  - 子 SELECT / CTE / UNION 分岐は各 `parseSelect` で独立検証し、外側 scope へ降りない
  - GROUP BY 無し、membership 不一致、表記不一致、grouping sets を専用診断で拒否
  - 非集計始まりを専用診断で拒否。既存の `HAVING GROUPING()` は先に従来経路へ渡す
- `src/engine/process.ts`
  - SELECT 側の `AGG_GROUP_KEY` を先頭 group row から `resolveFieldRef` で評価
  - CASE 結果・文字列関数引数に含まれる集計算術式にも同じ評価を適用
- `src/engine/evalFunc.ts`
  - HAVING 側の materialized aggregate evaluator に `AGG_GROUP_KEY` leaf を追加
  - 出力 row から `resolveFieldRef` で評価
- `src/core/aggregateExpression.ts`
  - 既存 operand label は変更せず、`AGG_GROUP_KEY` は入力表記、変数は `@name` の安定ラベルを追加
- `src/execute.ts`
  - 既存 variable resolver を再利用し、`AGG_ARITH` 内の変数を数値へ解決
  - 非数値は既存どおり `ArgumentError`
  - alias 無しの合成キーが解決前後で `@name` を維持するよう、集計算術 context の NUMBER `raw` に元の変数表記を保持
  - field / aggregate 参照走査の narrowing を新 leaf に追従
- `src/converter/selectToKintone.ts`
  - simple / source-aware の両 field collector で `AGG_GROUP_KEY` を取得対象へ追加
  - 変数は field として収集しない
- `src/converter/dmlToKintone.ts`
  - 共通 CASE / string collector の型 narrowing を形式追従
- `docs/ksql_language_reference.md`
  - §8 に許可形、非集計始まり・membership・grouping sets の拒否、外側と内側が同値でないことを追記
- `src/parser/__tests__/b124AggregateArithmeticOperand.test.ts`
  - parser 受入・拒否テストを追加
- `src/engine/__tests__/b124AggregateArithmeticOperand.test.ts`
  - evaluator、HAVING、変数、数値規則、実需 fixture、CASE / string、合成キー回帰を追加
- `src/converter/__tests__/b124AggregateArithmeticOperand.test.ts`
  - source-aware field collection テストを追加
- `src/core/__tests__/b65GroupByConsumerAllowlist.test.ts`
  - production code の新規行追加に伴う line anchor の形式追従だけを実施

## 追加したテスト

- AST
  - `AGG_GROUP_KEY` と既存 `VARIABLE` leaf
  - SELECT / HAVING / CASE result / string function arg の受理
- fail-closed
  - GROUP BY に無い列
  - GROUP BY 無し
  - ROLLUP / CUBE / GROUPING SETS（SELECT と HAVING）
  - 非集計始まり（field / variable / parenthesized / HAVING）
  - 修飾・非修飾の表記不一致
  - 内側 SELECT による外側 GROUP BY キー参照
- 評価
  - unqualified / qualified GROUP BY key の SELECT と HAVING
  - SELECT / direct HAVING / alias HAVING の行集合一致
  - variable の SELECT / direct HAVING / alias HAVING
  - 非数値 key の外側 `NaN` と内側 `0`
  - 小数の外側・内側を独立に tolerance 比較
  - 空 key の `Number("") === 0`
  - 非数値 variable の `ArgumentError`
  - CASE result と string function arg の実評価
- 実需 fixture
  - 8 製品の既知期待値と合計 482,710
- 回帰
  - 既存 `SUM(amount)-SUM(price)` の合成キー
  - 新 key / variable leaf の安定合成キー
  - source-aware physical field collection

## R2 §8 の受入それぞれの確認結果

### §8.1 実需の形

PASS。APP4229 master と APP4228 transaction の JOIN 形を engine fixture で実行し、次を固定した。

- 緑茶 10,680
- 牛乳 147,350
- バター 29,200
- 野菜ジュース 18,050
- 食パン 137,800
- トマト缶 78,840
- ほうじ茶 27,040
- ライ麦パン 33,750
- 合計 482,710

実 kintone APP4229 / APP4228 への live 再実行は、依頼の「kSQL MCP を呼ばない」に従い未実施。

### §8.2 SELECT と HAVING の一致

PASS。GROUP BY key と `@変数` の双方で、SELECT 値・direct HAVING・alias HAVING を確認した。
桁違いの上下境界を同時に置き、残る具体的な group key 集合を比較した。

### §8.3 同値を主張しないケース

PASS。

- 非数値 key: 外側 `NaN`、内側 `0` を独立固定
- 0.1 × 10 行と key 0.1: 外側 / 内側を別期待値として tolerance 比較
- 空 key: 外側 `0`
- 全行が非数値 key: group ごとに外側 `NaN`、内側 `0`
- 非数値 `@変数`: `ArgumentError`

外側と内側の一般同値はテストにも文書にも書いていない。

### §8.4 拒否

PASS。6 分類をすべて parser test で固定した。grouping sets は ROLLUP / CUBE /
GROUPING SETS と SELECT / HAVING の双方を含む。

### §8.5 回帰

PASS。

- alias 消失バグの既存 parser regression を含む `parser.test.ts` が通過
- B119〜B122 と関連 CASE / variable tests: 16 suites / 371 tests passed
- CASE 内・文字列関数引数の既存形と B124 新 leaf の実評価が通過
- B120 の既存 ParseError 本文テストが通過
- 既存 aggregate rejection は全体 `npm test` で通過
- ORDER BY alias / UNION / CTE を含む全体回帰が通過
- 既存合成キー名を byte 一致で固定し、新 leaf の key も固定

## 仕様と違えた箇所

なし。

`AggGroupKeyRef.tableAlias` は R2 の `tableAlias?: string` に合わせ、必須プロパティを追加していない。
GROUP BY key の値取得は SELECT / HAVING の両方で `resolveFieldRef` を使用している。

## 仕様が決まっていなかった箇所

R2 §11 の 2 件は追加の canonical 意味論を決めていない。

1. 合成キー名は、R2 が正としたレビュー §3.2 の推奨に従い、`AGG_GROUP_KEY` を元の修飾表記、
   variable を `@name` とした。既存 operand のラベルは変更していない。
2. 同じ物理列が GROUP BY に修飾あり／なしの両表記で書かれた場合も canonical 同一性は推論しない。
   Phase 1 の確定規則どおり、各 leaf の表記が `FIELD_NAME` と文字どおり一致するかだけを判定する。

## 既存テストへの影響

- 意味変更によって落ちた既存テスト: なし
- 実装途中に検出して修正した回帰:
  - B65 `HAVING GROUPING()` を非集計始まり検査が先取りした。`GROUPING()` を従来入口へ先に渡して解消
  - scalar string function の未解決 variable 診断を新 internal error が先取りした。従来 evaluator へ戻して本文を維持
- 形式変更のみで追従した既存テスト:
  - `src/core/__tests__/b65GroupByConsumerAllowlist.test.ts` の production line anchor 3 件
    （許可対象ファイル・参照箇所・意味は不変）

## 未実施

- 実 kintone APP4229 / APP4228 の live 実行（kSQL MCP tool call 禁止に従った）
- git 操作（依頼どおり未実施）
- `npx tsc --noEmit` 単独成功: リポジトリ既存の `src/ui/desktop.ts` 型エラーがあるため全体としては失敗。
  B124 追加で生じた non-UI の型エラーは解消し、ts-jest を使う全 `npm test` は成功した
