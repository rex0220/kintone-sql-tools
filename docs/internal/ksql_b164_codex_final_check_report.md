# B164 実装の最終チェック報告（codex・2026-08-08）

- 対象: `b164/dev` の実装（`a34a290` 相当）
- 結論: **指摘 1 件（中＝サブクエリ内警告の外側非伝播）→ 修正済み**・他 5 観点（key 同一性・警告条件・fail-open 互換・焼き付き残存なし・非回帰）は問題なし

最終判定: 指摘 1 件です。

- 中 — サブクエリ内で発生した未解決集計警告が外側の結果へ伝播しません。  
  `src/engine/process.ts:163` でサブクエリ境界を除外し、各 SELECT 内で警告を判定する設計自体は妥当です。しかし `IN`／scalar／`EXISTS` のサブクエリ実行結果は `src/execute.ts:9893`、`src/execute.ts:9899`、`src/execute.ts:9918` で値だけが取り出され、`result.warnings` が外側の warnings に併合されません。SELECT 列の scalar subquery も `src/execute.ts:9971` で同様です。したがって、サブクエリ内の「HAVING 非掲出」では再生成 key が未一致でも、利用者には新警告が届きません。B164 テストにもサブクエリ警告の伝播確認はありません。

観点別結論:

1. 再生成 key  
   問題なし。参照側は `src/engine/evalWhere.ts:351`、SELECT 保存側は `src/engine/process.ts:553`、依存集計保存側は `src/engine/process.ts:635` で、いずれも同じ `aggregateSyntheticName(func, distinct, arg)` を使用しています。DISTINCT、全 `AggregateFunc`、文字列内の単一引用符も共通 serializer `src/core/aggregateExpression.ts:17` に集約されています。

2. 警告条件  
   トップレベル、GROUPING SETS の部分集計行、UNION 各枝では正常 key が materialize されていれば誤発火しません。UNION は枝ごとの警告を併合しています。ただし前述のとおり、サブクエリは誤発火ではなく「必要な警告の欠落」があります。

3. fail-open 互換  
   問題なし。再生成 key が未一致なら最終的に `src/engine/evalFunc.ts:741` の `resolveFieldRef()` が従来どおり `""` を返します。警告検出は値を変更せず、挙動変更は警告追加だけです。

4. 焼き付き `FieldRef.field` の残存消費  
   grep 全列挙を確認しました。集計値の実行時 lookup で焼き付き文字列を使用する箇所は残っていません。converter は `aggregateRef` を優先し、集計依存・GROUP BY validation は該当 FIELD を物理フィールド扱いしません。その他の `.field` 参照は通常フィールド、列名、GROUPING、算術参照です。

5. 非回帰  
   SELECT 列位置読み、集計算術式、THEN/ELSE、ORDER BY alias、window、UNION の既存経路にB164変更による構造上の回帰は認めません。B164テストにも対応する期待値があります。ただし書き込み禁止を厳守し、テスト実行は行わず静的確認のみです。

コード変更、ファイル書き込み、git、MCPはいずれも行っていません。