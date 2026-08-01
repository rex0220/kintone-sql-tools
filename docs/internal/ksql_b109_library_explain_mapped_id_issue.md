# B109 engine ライブラリの `explainQuery` / `runBatch(EXPLAIN)` が内部 mapped ID を表示する

- 起票: 2026-08-01
- ステータス: ✅ **完了（v3.37.1 でリリース）**（2026-08-01・受入 1〜6 すべて実機確認済み。codex の停止 0 回）。**Pro も実機の実行計画ダイアログで確認 OK・自前凡例を撤去**（[報告 2026-08-01d](../../../ksql-dashboard-pro/docs/internal/kSQLエンジンへの連絡-20260801d-送付版.md)）
- 出典: [Pro の報告 2026-08-01c](../../../ksql-dashboard-pro/docs/internal/kSQLエンジンへの連絡-20260801c-送付版.md)（K-88・**急ぎではない**＝Pro は計画ダイアログに自前の凡例を添えて回避中）
- 関連: [B108](ksql_b108_inline_explain_mapped_id_issue.md)（CLI / MCP の同種修正・v3.37.0）/ [B107](ksql_b107_lapp_spec.md)

## 1. 症状（実測 2026-08-01・再現済み）

**engine ライブラリの `explainQuery(sql, { client, logicalApps })` で、
`LAPP_<名前>` を使う SQL の計画本文が内部の仮想 ID のみで出力される。**

```
  metadata API: form definition APP900000000
  app:           APP900000000 AS APP900000000 (900000000)
```

**`runBatch` に `EXPLAIN` 文を流した場合も同じ**（両方こちらで再現済み）。

**どの論理名の話か出力から判別できない。**論理アプリが複数ある計画では
Pro の自前凡例でも対応関係が完全には分からない。

## 2. 原因 — **B108 の仕様の範囲落ち**

**B108 §6.1 の縫い目は CLI 単文・CLI バッチ・MCP `ksql_query` の 3 箇所だけで、
engine ライブラリ面が挙がっていなかった。**仕様を書いた側（Claude）の見落としであり、
codex は仕様どおりに実装した。

**B107 の「診断の併記」はエラー整形（`engine-library/logicalApps.ts`）には配線済み**——
未定義名エラー等には論理名が出る。**EXPLAIN の計画本文だけが残った。**

## 3. 方針（仕様）

**B108 と同じ規則を engine ライブラリの 2 経路へ配線する。**

| 箇所 | 変更 |
|---|---|
| `explainQuery`（`engine-library/query.ts`） | 計画本文へ復元を配線 |
| `runBatch` の EXPLAIN 文由来の結果（`engine-library/batch.ts`） | 同上（**EXPLAIN 文由来だけ**） |

### 3.1 設計制約（B108 §6.2 を引き継ぐ）

1. **判別は文の型（AST の EXPLAIN）**。実行結果の `result.type` は SELECT で返る
2. **復元は EXPLAIN の計画出力に限定**。データ行に掛けない
   （`SELECT 'APP900000000' AS x` が消えないことをテストで固定）

### 3.2 追加の制約（ライブラリ固有）

- **`restoreSqlDiagnosticValue` は `src/node/sqlDiagnostics.ts` にある。**
  純粋な文字列処理なので、**B107 のスキャナと同じく core へ移して node は re-export**
  （engine bundle のゼロ依存・bundle guard を守る）
- **表示形式はライブラリの既存のエラー併記と揃える**（browser に profile は無いので
  `@profile` は付けない。`LAPP_検証アプリ -> APP4227` 相当）
- **公開型は不変**（表示文字列の変化のみ）

### 3.3 受入条件

1. `explainQuery` の計画本文に論理名が併記され、mapped ID が露出しない
2. `runBatch` の EXPLAIN 文由来の結果も同様。**同じバッチの SELECT データ行には掛けない**
3. データ非破壊（`SELECT 'APP900000000' AS x` がそのまま）
4. CLI / MCP の既存復元（B108）と `--dry-run`・`ksql_explain` は不変
5. `LAPP_` を含まない SQL の挙動・文言は完全不変
6. 既存テスト全 green・snapshot 22 不変・語数予算 exact 不変

## 4. 優先度

**中（B108 は低だったが、こちらは Pro の実利用機能＝K-88 実行計画ボタンが直接踏んでいる）。**
急ぎではないと明言されているが、回避策（自前凡例）は論理アプリ複数で不完全。
**修正は小さい**（B108 と同じ形・縫い目 2 箇所＋restore の core 移動）。
