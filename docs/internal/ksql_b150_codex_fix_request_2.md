# B150+B153 修正依頼 2（Critical 残存＝CLI `--dry-run` の CTE→APP JOIN）

禁止事項は従来どおり。

## 1. 症状（Claude 実機・修正依頼 1 の後も残存）

```
node dist-cli/ksql.js --dry-run -e "WITH s AS (GENERATE_SERIES('2025-08-04','2025-08-06') AS 日付)
  SELECT s.日付 FROM s INNER JOIN APP4228 AS t ON s.日付 = t.日付"
→ DryRunError: API call should not happen in dry-run.（in 経路の手書き CTE でも同じ）
```

- **単一表・物理→物理 JOIN の `--dry-run` は正常**（フォーム定義行も表示される）
- **MCP の `ksql_explain` は同形を正常表示**（修正依頼 1 のテストも green）
- したがって **CLI `--dry-run` 固有の配線**で、CTE/一時テーブル→APP JOIN のときだけ
  何らかの API（`src/cli/index.ts:1027-1042` の dry-run client は `getRecords` も `getFields` も
  throw）に到達している

## 2. 依頼

1. **CLI `--dry-run` が CTE/一時テーブル→APP JOIN の WITH 文で通る実行経路を特定**し、
   EXPLAIN エンジン（MCP と同じ計画表示・API 0 回）に揃える。
   どの API 呼び出しが発生していたか（getRecords か getFields か・どの段か）を報告に明記
2. v3.60.0 の CLI で同形が動いていたかをコードから判定できる範囲で記載
   （どちらでも修正は必須。B150 リリースのゲート）
3. **CLI e2e テストを追加**＝`runCli(["--dry-run", "-e", <CTE→APP JOIN>])` が exit 0 で
   計画（runtime candidate 表示）を出力すること。in 経路・範囲経路・フォールバックの 3 形。
   **修正前に fail することを確認してから直す**
4. `npm test` 全体（環境変数除外可）。最終メッセージ＝修正報告のみ
