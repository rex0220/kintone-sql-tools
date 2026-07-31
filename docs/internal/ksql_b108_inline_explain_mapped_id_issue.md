# B108 インライン `EXPLAIN` 文が論理アプリの内部 mapped ID を表示する

- 起票: 2026-08-01
- ステータス: 📝 **評価（優先 低）**
- 出典: B107 の実機検証中に発見（2026-08-01）。**B107 の回帰ではない**（ASCII 名でも同じ＝v1.13.x 以来の既存ギャップ）
- 関連: [B107](ksql_b107_lapp_engine_library_issue.md) / `src/node/sqlDiagnostics.ts`

## 1. 症状（実測 2026-08-01）

**CLI で `EXPLAIN` を文として書くと、論理アプリが内部の仮想 ID のまま表示される。**

```
ksql -e "EXPLAIN SELECT COUNT(*) FROM LAPP_KENSHO"
  app:           APP900000000 (900000000)      ← 内部 mapped ID がそのまま

ksql --dry-run -e "SELECT COUNT(*) FROM LAPP_検証アプリ"
  app:           LAPP_検証アプリ@dev            ← こちらは正しく復元される
```

**バッチ形（`EXPLAIN ...; EXPLAIN ...`）も同様に復元されない。**

## 2. リファレンスとの食い違い

言語リファレンス §1（論理アプリ参照）:

> EXPLAIN と利用者向け診断は論理名・最終物理 ID・profile を表示し、内部 mapped ID は表示しない

**インライン `EXPLAIN` の経路はこの契約を満たしていない。**

## 3. 原因（配線の欠落）

`restoreSqlDiagnosticValue` の呼び出しは 2 箇所だけ:

| 経路 | 復元 |
|---|---|
| `--dry-run`（`src/cli/index.ts:2387`） | **される** |
| `buildBatchExplainPlans` 経由（同 `:2238`） | される |
| **インライン `EXPLAIN` 文**（通常実行で `result.type === "EXPLAIN"`） | **されない** |

**修正はこの経路へ同じ復元を配線するだけ**に見える（要確認）。

## 4. 未確認事項（着手時に）

1. **MCP の `ksql_explain`** が復元されているか（`src/mcp/tools.ts` は
   `restoreSqlDiagnosticValue` を import しており、配線済みの可能性が高い。実測して確定する）
2. バッチ内インライン `EXPLAIN` の結果オブジェクト側（JSON 出力）も同様か
3. 既存テストがこの表示を固定していないか

## 5. 優先度の根拠

**低。** 誤った結果を返す問題ではなく、診断表示の契約違反。
`--dry-run` という正しく動く代替経路がある。
**ただし B107 で日本語論理名の利用者が増えると露出しやすくなる**ため、
次の小修正の機会に拾う価値がある。
