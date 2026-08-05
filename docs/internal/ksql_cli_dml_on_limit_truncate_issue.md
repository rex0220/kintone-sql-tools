# CLI: DML × `--on-limit truncate` で SELECT-based DML のソースが黙って切り捨てられる問題

- 作成日: 2026-07-10
- ステータス: **v2.11.0 予定①（案A・実装済み / codex 検証済み）。2026-07-16 に B1+B2+B8 を v2.11.0 へ束ねる方針決定、本課題を先行実装。codex 指摘3点（注記の発火条件を `onLimit==="truncate"` 限定・テスト配置を CLI 経路へ・docs §8.3/CLI docs 追記）を §3.1/§4 に明記し、CLI 実装・テスト・docs へ反映済み**
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
| 案A: DML では `error` に強制（プラグイン・MCP と同型） | 単文 = DML 文のとき / バッチ = `containsDml` のとき、`onLimitReached` を `"error"` にして渡す。**注記は解決後 `onLimit === "truncate"` のときだけ** stderr に1行: `note: onLimit=truncate is ignored for DML (forced to error)`（truncate の由来は `--on-limit` に限らず `KSQL_ON_LIMIT` / profile もあるため、フラグ名でなく設定名で表記する — レビュー指摘）。詳細な発火条件は §3.1 | ユーザー明示のフラグを黙って上書きする点が CLI 的に議論。注記で緩和 |
| 案B: DML × truncate を `ArgumentError` で拒否 | 競合を明示エラーにする（`ArgumentError: --on-limit truncate is not allowed with DML.`） | 最も明示的だが、profile で truncate 常用のユーザーは DML のたびにエラー。`--on-limit error` の明示で回避可能とはいえ摩擦が大きい |
| 案C: SELECT-based DML を含む場合のみ強制（または拒否） | 影響経路に限定した最小変更。判定は単文 = `stmtType`、バッチ = 文タイプ走査（MCP の `containsSelectBasedDml` と同型） | 「truncate が効く DML と効かない DML がある」という説明の複雑さが残る |

レビュー時の codex 推奨: 「`--allow-dml` 時は `onLimit=error` 強制、または少なくとも SELECT-based DML だけ `error` 強制が本命」。

**起案者の推奨は案A（注記付き）**: UPDATE / DELETE ではもともと truncate が無効（伝播しない）ため、「DML では truncate に意味のある正当なユースケースがない」。一律 error 化で失うものがなく、挙動の説明も「DML は常に error」で単純。`--allow-dml` フラグ基準（codex 案前段）は、`--allow-dml` を付けて read-only 文を流すケースで SELECT の truncate まで変わってしまうため、文タイプ基準を推す。

### 3.1 注記の発火条件と参照実装（codex レビュー反映・裏取り済み）

`onLimit` は [src/cli/index.ts:1601](../../src/cli/index.ts#L1601) で `args.onLimit ?? envOnLimit("KSQL_ON_LIMIT") ?? profile.query?.onLimit ?? "error"` と解決される。既定は `"error"`。注記は**この解決後の値が `"truncate"` のときだけ**出す。既定 `error` や明示 `--on-limit error` の DML で注記が出ると誤報になる（codex 指摘）。

**発火条件（4 条件すべて）**: `(isDmlStatement || batchContainsDml)` かつ `onLimit === "truncate"` かつ `!quiet` かつ `!args.dryRun`。
- `isDmlStatement`（[src/cli/index.ts:2027](../../src/cli/index.ts#L2027) 近傍）と `batchContainsDml`（[src/cli/index.ts:1990](../../src/cli/index.ts#L1990) 近傍）は既存の変数。
- dry-run 単文は `EXPLAIN` 経路（[:2021-2022](../../src/cli/index.ts#L2021)）で実書き込みなし → 注記抑制。

**参照実装**（`execute.ts` は触らない）:

```ts
const dmlForcesOnLimitError = isDmlStatement || batchContainsDml;
const effectiveOnLimit = dmlForcesOnLimitError ? "error" : onLimit;

if (dmlForcesOnLimitError && onLimit === "truncate" && !quiet && !args.dryRun) {
  process.stderr.write("note: onLimit=truncate is ignored for DML (forced to error)\n");
}
```

`executeBatch`（[:2000-2003](../../src/cli/index.ts#L2000)）と `execute`（[:2023-2026](../../src/cli/index.ts#L2023)）の `onLimitReached` に `onLimit` ではなく **`effectiveOnLimit`** を渡す。コア（`src/execute.ts`）の truncate 挙動は意図的に残し（[回帰テスト executeBatch.test.ts:1082](../../src/__tests__/executeBatch.test.ts#L1082) が設計を支える）、防御は呼び出し層の責務とする。

## 4. 実装時の変更対象（案A の場合）

| 区分 | 内容 |
|---|---|
| `src/cli/index.ts` | 単文 `execute` / バッチ `executeBatch` 呼び出しの `onLimitReached` を `effectiveOnLimit`（§3.1）に差し替え + stderr 注記（発火条件は §3.1） |
| **CLI 経路のテスト**（`src/cli/__tests__/dml_guard.e2e.test.ts` もしくは `runWithArgv` 系。**`integration.test.ts` は不可**＝ヘルパー中心で CLI 引数経路を通らない — codex 指摘） | 最低4本を固定: ①単文 `INSERT_SELECT` + `--on-limit truncate` で error 固定②バッチ `INSERT_SELECT` + 同 で error 固定③`--quiet` で注記抑制④**read-only `SELECT` + `--on-limit truncate` は従来どおり truncate**（回帰＝DML 以外は不変）。①②では注記が出ること、④では注記が出ないことも確認 |
| `docs/ksql_batch_temp_table_spec.md` §8.3（[:294](ksql_batch_temp_table_spec.md#L294)） | 「**CLI の DML バッチ・単文では `--on-limit` / env `KSQL_ON_LIMIT` / profile `query.onLimit` に関わらず `onLimitReached: "error"` に固定**」を追記（プラグインの §8.4:306 と対になる CLI 版がないため） |
| `docs/ksql_cli_console_spec.md` の `--on-limit` 説明（[:88](ksql_cli_console_spec.md#L88)） | 「**DML では常に error（truncate 指定は無視）**」を追記し利用者向けに閉じる |
| `docs/internal/ksql_plugin_dml_batch_spec.md` §6 | 別課題の解消を記録 |

コア（`src/execute.ts`）は変更不要（[回帰テスト executeBatch.test.ts:1082](../../src/__tests__/executeBatch.test.ts#L1082) で truncate 挙動は固定済み。防御は呼び出し層の責務とする現行設計を維持）。
