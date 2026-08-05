# B123 通常の `GROUP BY` だけの SELECT は `EXPLAIN` / `--dry-run` がエラーになる

- 起票: 2026-08-05
- ステータス: 🐞 **残課題（未着手）**。原因特定済み・**実測で再現条件を確定**（v3.44.0・MCP `ksql_explain`）。修正は `selectNeedsOwnMetadata` へ 1 条件の純加法。回避策あり（`ORDER BY` を 1 つ足す）
- 出典: `ksql-analytics` の在庫分析セッションで AI（Claude Code）が遭遇 → 記事の裏取り中に真因を特定（2026-08-05）
- 関連: [B114](ksql_b114_explain_fetch_scope_issue.md)（`EXPLAIN` が取得範囲を名乗る・v3.40.0）/
  [B65](ksql_b65_rollup_grouping_sets_spec.md)（`ROLLUP` / `GROUPING SETS` は**この述語に入っている**のに通常の `GROUP BY` だけ漏れている）
- **既存の欠陥**: B114・B65 とは独立。述語に通常 `GROUP BY` を入れ忘れたまま推移している

## 1. 症状（実測 2026-08-05・v3.44.0・MCP `ksql_explain`・APP4229 / APP4228）

**通常の `GROUP BY` を含む SELECT の実行計画を取ろうとすると、内部ガードのエラーで落ちる。**

```
> ksql_explain: SELECT 分類, COUNT(*) FROM APP4229 GROUP BY 分類
Error: No-op client should not be called.

> CLI: node scripts/q.mjs --dry-run -e "SELECT 分類, COUNT(*) FROM APP4229 GROUP BY 分類"
DryRunError: API call should not happen in dry-run.
```

### 再現条件（全 6 形を実測）

| SQL | EXPLAIN |
|---|:---:|
| `SELECT 分類, COUNT(*) FROM APP4229 GROUP BY 分類` | ❌ |
| `SELECT 分類, COUNT(*) FROM APP4229 GROUP BY 分類 **ORDER BY 分類**` | ✅ |
| `SELECT 分類, COUNT(*) FROM APP4229 **WHERE 生産状況 IN ('生産可能')** GROUP BY 分類` | ✅ |
| `SELECT 分類, COUNT(*) FROM APP4229 GROUP BY 分類 **HAVING COUNT(*) > 1**` | ❌ |
| `SELECT m.製品番号, SUM(t.個数_在庫計算用) FROM APP4229 m LEFT JOIN APP4228 t ON m.製品名 = t.製品名 GROUP BY m.製品番号` | ❌ |
| 同上 ＋ `, m.製品名` ＋ **`ORDER BY m.製品番号`**（分析の主表クエリ） | ✅ |

**分かれ目は `GROUP BY` の有無ではなく、「`GROUP BY` があり、かつフィールドを参照する `WHERE` も `ORDER BY` も無い」こと。**
`HAVING` は判定に寄与しない。`SELECT COUNT(*) FROM APPn`（`GROUP BY` 無し）や
`SELECT SUM(仕入価格) FROM APP4229`（集計のみ）は従来どおり通る。

> **記事側の訂正材料**: 出典セッションの切り分け表は「JOIN + `GROUP BY` の主表クエリ ❌」としているが、
> 主表クエリには `ORDER BY m.製品番号` があり、**実測では通る**（上表 6 行目）。
> 落ちるのは `ORDER BY` を外した形。

## 2. なぜ重いか

- **エラーで止まっており、誤った実行計画は返していない。** 「静かに間違う」系ではないので優先度は中
- ただし**分析クエリはほぼ全部 `GROUP BY` を含む**。「大量取得や JOIN は `EXPLAIN` まで通す」という運用ルールを立てても、**集計に対しては最初から通せない**
- 出典セッションでは、AI が `CLAUDE.md` に自分で書いた運用ルール（「JOIN・相対日付関数・大量取得を含むものは `ksql_explain` まで通す」）がこれを踏み、**ルールが機能していないことに 2 記事ぶん気づかなかった**
- エラーメッセージ（`No-op client should not be called.` / `DryRunError`）が**内部実装の言葉**で、利用者側に原因も回避策も伝わらない

## 3. 原因（特定済み）

`EXPLAIN` と CLI `--dry-run` は「この文はフォーム定義を読む必要があるか」を 1 つの述語で判定している。

```ts
// src/core/explainMetadata.ts
function selectNeedsOwnMetadata(statement: SelectStatement): boolean {
  return whereNeedsFieldMetadata(statement.where)
    || normalizeGroupingSpec(statement).type === "GROUPING_SETS"   // ROLLUP / CUBE / GROUPING SETS のみ
    || statement.orderBy.length > 0
    || statement.columns.some((c) => c.type === "WINDOW_COL" && c.orderBy.length > 0);
}
```

**`statement.groupBy` を見ていない。** B65 で足した grouping-set 構文（`grouping?: GroupingSpec`）は入っているが、
通常の `GROUP BY`（`groupBy: GroupByKey[]`）が漏れている。

偽になると、レコード API を呼ばないことを保証するためのダミークライアントが渡される。

```ts
// src/mcp/tools.ts
const needsAppMetadata = normalized.appBindingByMappedApp.size > 0
  && statements.some(explainNeedsAppMetadata);
const runtime = needsAppMetadata ? await createRuntime(...) : null;
const explainClient = runtime?.client ?? noOpClient();   // ← getFields が fail
```

そのあと `GROUP BY` の計画作成がグループキーの型メタを取りに `getFields` を呼び、ガードに弾かれる。
CLI も同じ述語（`cli/index.ts` の `dryRunNeedsMetadata`）を使うため、**MCP と CLI の両方で同じ条件で再現する**。

### 裏づけ: 計画側は `GROUP BY` をメタデータ必要として扱っている

`ORDER BY` を足して通った計画には、**グループキーの解決結果とフォーム定義の取得が明示されている**。

```
  metadata API: form definition APP4229@dev
  group key 分類: PHYSICAL (source=0, field=分類)
  complete input reason: GROUP_BY, LOCAL_ORDER, AGGREGATE
```

`group key ...: PHYSICAL (source=0, field=分類)` を出すにはフォーム定義が要る。
`complete input reason` にも `GROUP_BY` が一級の理由として並んでいる。
**計画側は `GROUP BY` をメタデータ必要と扱っているのに、要否の述語にだけ入っていない**という不整合。

## 4. 対応案

**案 A（推奨）**: 述語に通常 `GROUP BY` を足す。純加法・1 条件。

```ts
function selectNeedsOwnMetadata(statement: SelectStatement): boolean {
  return whereNeedsFieldMetadata(statement.where)
    || statement.groupBy.length > 0                                // ← 追加
    || normalizeGroupingSpec(statement).type === "GROUPING_SETS"
    || statement.orderBy.length > 0
    || statement.columns.some((c) => c.type === "WINDOW_COL" && c.orderBy.length > 0);
}
```

- `explainNeedsAppMetadata` は `WITH` / `UNION` / サブクエリ / DML を同じ規則で再帰走査するため、**サブクエリや CTE の中の `GROUP BY` も同時に直る**
- 影響は「これまで取得していなかったフォーム定義を 1 回取りに行くようになる」こと。**レコード API は呼ばない**（`EXPLAIN` の契約は維持）
- CLI `--dry-run` も同じ述語なので同時に直る

**案 B（案 A の前段として検討）**: ガードのエラーメッセージを利用者向けに変える。
`No-op client should not be called.` は内部実装の言葉で、原因も回避策も伝わらない。
ただし**案 A を入れれば `EXPLAIN` 経由でこのメッセージには到達しなくなる**ため、案 A を優先し、
案 B は「他の経路で同じガードに当たったとき」の保険として別途評価する。

## 5. 受入条件

APP4229（8 件）/ APP4228（1,000 件）で、§1 の 6 形すべてが `ok: true` を返すこと。

| SQL | 期待 |
|---|---|
| `SELECT 分類, COUNT(*) FROM APP4229 GROUP BY 分類` | ✅ 計画を返す |
| `SELECT 分類 FROM APP4229 GROUP BY 分類`（集計関数なし） | ✅ |
| `SELECT 分類, COUNT(*) FROM APP4229 GROUP BY 分類 HAVING COUNT(*) > 1` | ✅ |
| JOIN + `GROUP BY`（`ORDER BY` なし） | ✅ |
| CTE / サブクエリの中に `GROUP BY` があるだけの文 | ✅ |
| CLI `--dry-run` で上記と同じ 5 形 | ✅ |

**回帰**:

1. `EXPLAIN` が**レコード API を呼ばない**こと（`getRecords` / `openCursor` が呼ばれない）。案 A はフォーム定義の取得を増やすだけで、この契約は変えない
2. 既存の通る形が変わらないこと（`SELECT COUNT(*) FROM APPn` = `COUNT_TOTAL_COUNT` / 集計のみ / `WHERE` 付き / `ORDER BY` 付き / `ROLLUP` / `GROUPING SETS`）
3. `ORDER BY` を足した形の計画本文が**変わらない**こと（§1 の 2 行目と 6 行目の出力を修正前後で比較）
4. `GROUP BY` の無い文で、**フォーム定義の取得回数が増えていない**こと（`metadata API:` 行の有無で確認）

## 6. 影響範囲の見立て

| 面 | 影響 |
|---|---|
| MCP `ksql_explain` | 直る |
| CLI `--dry-run` | 同じ述語のため同時に直る |
| `ksql_query` / `ksql_mutate` の実行経路 | **影響なし**（実行時は実クライアントを使うため元から正しく動く） |
| プラグイン（desktop.js） | EXPLAIN エンジンをバンドルするため要確認 |
| engine ライブラリ `explainQuery()` | 同じ `core` を通るため直る。`plan` の構造は不変（`metadata API:` 行が増えるのみ） |
