# B89 engine ライブラリの `explainQuery` がバッチを受けず、Pro の構文チェックが効かなくなる

- 起票: 2026-07-29
- ステータス: 📋 **設計待ち（優先 高／代替手段なし）＝v3.31.0 対象**（Pro 回答で戻り値の形が確定・2026-07-29）
- 出典: [Pro からの連絡 2026-07-29](../../../ksql-dashboard-pro/docs/internal/kSQLエンジンへの連絡-20260729-送付版.md) 依頼①
- 関連: [B68 ライブラリ read-only 拡張](ksql_b68_engine_library_readonly_impl_plan.md) / [B87](ksql_b87_metadata_cache_spec.md)

## 1. 事象

```
explainQuery("CREATE TEMP TABLE #g AS …; SET @total = (SELECT …); SELECT …", { client })
  → PARSE_ERROR: This API accepts one statement; use runBatch for multiple statements
```

**Pro の設定画面は SQL 入力を 0.6 秒デバウンスで `explainQuery` に通し「✓ 構文 OK」を表示している。**
`runBatch` を採用した結果、**利用者がバッチを書いた瞬間に検証が効かなくなる。**

さらに `PARSE_ERROR` が返るため、**正しい SQL でも「構文エラー」と表示される。**

**Pro に代替手段は無い**（3 依頼のうち本件だけ）。暫定対応は「複文なら検証をスキップ」だが、
**構文エラーの位置が分からなくなる。**

## 2. 経緯＝B68 で作った `runBatch` の採用が前提

Pro は前回「Phase 2 で検討。急ぎではない」としていたが、
**`SET` / `DECLARE` を検討できていなかった**として採用を決定した（2026-07-29）。

`runBatch` でしか書けない有用な形が 4 つあったという実測が根拠:
**構成比（全体比 %）**〔従来「SQL では出せない」と文書化していた〕/ Top N + その他 /
`VALIDATE` の内訳グラフ / 外部パラメータ注入。

**B68 が価値を生んだ結果、その検証面の欠落が顕在化した**という関係にある。

## 3. **「配線するだけ」ではない**＝許可集合の契約が論点

> **【Pro 回答 2026-07-29】指摘を受け入れ**＝「受理集合が違うという指摘はこちらの見落としでした」。
> **単文の `VALIDATE APPn` が通るようになるのも「嬉しい副産物」**（データ品質チェックのペインを
> 設定画面で検証できるようになる）とのことで、§3.1 の純加法な広がりは歓迎されている。

Pro は「CLI / MCP に既にバッチ EXPLAIN があるので配線するだけでは」と見ているが、
**プランナの有無ではなく、受け付ける文の集合が問題**である。

| API | ガード | 受け付ける文 |
|---|---|---|
| `runBatch` | `assertRunBatchStatement` | read-only 全般（`CREATE TEMP TABLE` / `SET` / `DECLARE` / `VALIDATE` / `SHOW APPS` / `DESCRIBE` を含む）。`IMPORT` / `APPLY` / DML `VALIDATE ONLY` を拒否 |
| **`explainQuery`** | `isExplainableReadOnlyStatement` | **`SELECT` / `WITH` / `UNION` のみ** |

**複文対応だけを足しても Pro は救われない。**バッチには `CREATE TEMP TABLE` / `SET` /
`DECLARE` / `VALIDATE` が入るため、許可集合が今のままでは弾かれる。

> **本当の依頼は「`explainQuery` が `runBatch` と同じ集合を受けること」である。**

Pro 自身が **「`runBatch` は単文もそのまま流せるので実行経路を一本化する」**と書いている。
**検証経路も同じ集合でなければ必ずずれる。**

### 3.1 単文側も広がる（純加法）

`explainQuery("VALIDATE APPn")` は現在拒否される。
`runBatch` と揃えると**受け付けるようになる**＝**従来拒否していたものを通す方向のみ**で、
既存の利用者に影響しない。

## 4. 実装の見通し

**プランナは既にある。**[`buildBatchExplainPlans()`](../../src/execute.ts#L9595) が
`{ statementCount, statements: BatchStatementPlan[] }` を返し、
**metadata API 以外の実行 API を呼ばない**（レコードを読まない）。
B87 で実行単位スコープ化した 3 つ目の入口がこれである。

必要なのは次の 3 点。

1. `guardExplainQuerySql` を**バッチ対応**にし、判定を `assertRunBatchStatement` へ寄せる
2. 複文なら `buildBatchExplainPlans` へ、単文なら従来経路へ振り分ける
3. 戻り値の形を決める（§5）

## 5. 戻り値の形（決めごと）

Pro は**どちらでも良い**としている（「構文が通るか」と「エラーならどの文か」が分かれば足りる）。

- **案 A（推奨）＝現行 `ExplainResult` の `lines` に文番号付きで連結**
  **公開型を変えずに済む**。`ExplainResult` に配列を足すと
  declaration snapshot（B66）が動き、engine ライブラリの公開面が変わる
- 案 B ＝文ごとの計画配列を足す。表現力は上がるが公開型の変更を伴う

**エラー時の文の特定は既に手当て済み**で、B68 が `statementIndex` / `statementType` を
エラーへ載せている。

### 5.1 【Pro 回答 2026-07-29】**案 A で確定**

> ご提案の形で進めてください。公開型を変えずに済むのであれば、そのほうが良いです。

**Pro が `explainQuery` に求めているのは 2 点だけ**と明言された。

1. **構文が通るか**（通れば「✓ 構文 OK」を表示）
2. **通らなければどこが悪いか**（`statementIndex` があれば「3 文目の SELECT で…」と提示できる）

**計画の中身（`lines` の内容）は現状 Pro では表示に使っていない。**
→ **`lines` の表現に凝る必要はない**が、将来 表示に使われる可能性は残る。

## 6. 規模

- 設計（許可集合の統一・戻り値の形・parity テストの範囲）: 0.25 人日
- 実装: 0.5 人日
- テスト（`runBatch` と `explainQuery` の受理集合が一致することを機械的に固定）: 0.25〜0.5 人日

**合計 1.0〜1.25 人日。SemVer=minor（純加法）。**

## 7. 優先度の根拠

**Pro の 3 依頼で唯一、代替手段が無い。**
しかも **B68（v3.29.0）で出した `runBatch` を採用した結果として生じた欠落**であり、
こちらの提供物が原因で検証が効かなくなっている。

**B68 の parity（受理可否の一致）を EXPLAIN 面へ広げる**という位置づけでもあり、
「MCP で AI が書いた SQL が本番で落ちる」を防ぐという B68 の目的と一貫する。
