# CLI: DML × `--on-limit truncate` で SELECT-based DML のソースが黙って切り捨てられる問題

- 作成日: 2026-07-10
- ステータス: **v2.11.0 予定①（仕様完成・案A で実装着手可）。2026-07-16 に B1+B2+B8 を v2.11.0 へ束ねる方針決定、本課題を先行実装**
- 発端: プラグイン DML バッチ対応（`ksql_plugin_dml_batch_spec.md` R4）のレビューで、UI の `onLimitReached: "truncate"` が SELECT-based DML のソース読み取りに継承される問題が見つかり、プラグインは「DML では error 固定」で修正済み。**同種の経路が CLI に残っている**（コード裏取り済み）
- 関連資料:
  - [ksql_plugin_dml_batch_spec.md](ksql_plugin_dml_batch_spec.md) R4（発端。プラグイン側の修正と経路の裏取り）
  - [ksql_mcp_dml_source_read_limit_issue.md](ksql_mcp_dml_source_read_limit_issue.md)（SELECT-based DML の読み取り上限に関する隣接課題。v1.8.0 で対処済み）

---

## 1. 課題

CLI は単文・バッチとも、解決済みの `onLimit`（`--on-limit` / `KSQL_ON_LIMIT` / `profile.query.onLimit`、既定 `"error"`）を **DML 実行にもそのまま** `onLimitReached` として渡す（`src/cli/index.ts` — 単文 `execute` 呼び出しとバッチ `executeBatch` 呼び出しの両方）。

`truncate` が指定されていると、SELECT-based DML（`INSERT_SELECT` / `UPSERT_SELECT`）のソース SELECT が `maxRecords` 到達時に**黙って切り捨てられ**、以下が起きる:

1. confirm フック（`--dml-max-rows` ガード + 確認プロンプト）には**切り捨て後の件数**が渡る — ガードは防げないどころか、切り捨てにより**通りやすくなる**
2. そのまま**部分書き込み**になる（ソースの残り行は書き込まれず、エラーも出ない）

コアのこの挙動は `src/__tests__/executeBatch.test.ts` の回帰テスト（「SELECT-based DML のソース読み取りは onLimitReached=truncate に従う」）で固定済み。

## 2. 影響範囲（裏取り済み）

| 経路 | `onLimit` の伝播 | 影響 |
|---|---|---|
| SELECT-based DML のソース SELECT（単文・バッチとも） | `options.onLimitReached` を継承 | **あり（本課題）** |
| UPDATE / DELETE の対象取得（`resolveDmlTargetIds`） | 渡さない → 常に `"error"` | なし |
| UPSERT / UPSERT_SELECT の照合読み取り | 渡さない → `fetchAll` 既定 `"error"` | なし |
| サブテーブル DML の親レコード読み取り | 渡さない → 既定 `"error"` | なし |
| CREATE TEMP TABLE の実体化 | バッチ実装が `"error"` を強制（仕様 §5.6） | なし |
| read-only SELECT の truncate | — | 意図された機能（対象外） |

他ツールの現状: **MCP** は `ksql_mutate` が `DEFAULT_ON_LIMIT = "error"` 固定（`onLimit` 入力自体を受けない）で安全。**プラグイン**は v1.9.0 で DML を含む実行（バッチ・単文とも）を `"error"` 固定に修正済み。**CLI のみ残存**。

発生条件が「明示的に `--on-limit truncate`（または env / profile）を設定した上で SELECT-based DML を実行」と限定的なため緊急度は低いが、`profile.query.onLimit: truncate` を常用しているユーザーは DML でも常時この状態になる。

## 3. 対策案

| 案 | 内容 | 論点 |
|---|---|---|
| 案A: DML では `error` に強制（プラグイン・MCP と同型） | 単文 = DML 文のとき / バッチ = `containsDml` のとき、`onLimitReached` を `"error"` にして渡す。`--quiet` でなければ stderr に1行注記: `note: onLimit=truncate is ignored for DML (forced to error)`（truncate の由来は `--on-limit` に限らず `KSQL_ON_LIMIT` / profile もあるため、フラグ名でなく設定名で表記する — レビュー指摘） | ユーザー明示のフラグを黙って上書きする点が CLI 的に議論。注記で緩和 |
| 案B: DML × truncate を `ArgumentError` で拒否 | 競合を明示エラーにする（`ArgumentError: --on-limit truncate is not allowed with DML.`） | 最も明示的だが、profile で truncate 常用のユーザーは DML のたびにエラー。`--on-limit error` の明示で回避可能とはいえ摩擦が大きい |
| 案C: SELECT-based DML を含む場合のみ強制（または拒否） | 影響経路に限定した最小変更。判定は単文 = `stmtType`、バッチ = 文タイプ走査（MCP の `containsSelectBasedDml` と同型） | 「truncate が効く DML と効かない DML がある」という説明の複雑さが残る |

レビュー時の codex 推奨: 「`--allow-dml` 時は `onLimit=error` 強制、または少なくとも SELECT-based DML だけ `error` 強制が本命」。

**起案者の推奨は案A（注記付き）**: UPDATE / DELETE ではもともと truncate が無効（伝播しない）ため、「DML では truncate に意味のある正当なユースケースがない」。一律 error 化で失うものがなく、挙動の説明も「DML は常に error」で単純。`--allow-dml` フラグ基準（codex 案前段）は、`--allow-dml` を付けて read-only 文を流すケースで SELECT の truncate まで変わってしまうため、文タイプ基準を推す。

## 4. 実装時の変更対象（案A の場合）

| 区分 | 内容 |
|---|---|
| `src/cli/index.ts` | 単文 `execute` / バッチ `executeBatch` 呼び出しの `onLimitReached` を DML 判定で `"error"` に固定 + stderr 注記（`--quiet` 抑制） |
| `src/cli/__tests__/integration.test.ts` | `--on-limit truncate` + INSERT_SELECT（単文・バッチ）で error 固定になること・注記が出ることを固定 |
| `docs/ksql_batch_temp_table_spec.md` §8.3 / CLI ドキュメント | 「DML では `--on-limit` は常に error」を明記 |
| `docs/internal/ksql_plugin_dml_batch_spec.md` §6 | 別課題の解消を記録 |

コア（`src/execute.ts`）は変更不要（回帰テストで truncate 挙動は固定済み。防御は呼び出し層の責務とする現行設計を維持）。
