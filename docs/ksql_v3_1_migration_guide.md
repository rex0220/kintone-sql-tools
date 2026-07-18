# v3.1.0 移行ガイド — B33 `KORDER BY` 大規模窓の Cursor API 対応

v3.1.0 は **B33 単独**の minor リリースです。**既存クエリの挙動変更はありません** — v3.0.0 で planning error だった `KORDER BY` の大きい窓が、条件を満たす場合に成功するようになる純加法的変更です。v3.0.0 からの移行作業は不要です。

## 1. 何ができるようになるか

v3.0.0 の `KORDER BY` は単発 Records API の窓（`LIMIT 0..500`・`OFFSET 0..10000`）に限定されていました。v3.1.0 では、この窓に収まらないクエリを kintone **Cursor API** で実行できます（計画名 `KORDER_CURSOR`）。

```sql
-- v3.0.0: planning error → v3.1.0: 成功（21 ページを kintone 固有順のまま連結）
SELECT $id, 郵便番号 FROM APP730
KORDER BY 郵便番号 ASC, $id ASC
LIMIT 10001
-- CLI/MCP の既定 maxRecords=500 では走査件数が超過するため引き上げが必要:
--   CLI: --max-records 10001   MCP: maxRecords: 10001
```

条件（すべて満たす場合だけ。満たさなければ理由コード付き planning error）:

- `KORDER BY` の共通条件（トップレベル SELECT・単一物理アプリ・非修飾キー・型 allowlist・WHERE 完全押し下げ・`KLIKE` なし・`LIMIT` 明示）
- 単発 GET の窓に**収まらない**（収まる場合は従来どおり `KORDER_NATIVE` 単発 GET を優先）
- **走査件数 `OFFSET + LIMIT` ≤ 実行時 `maxRecords`**（カーソルの OFFSET は kSQL が先頭から受信して読み捨てるため、返却行数ではなく走査件数に上限が掛かります）

結果順は kintone が返した順のままです（ローカル再ソート・暗黙の `$id` 追補なし）。同値群の決定性が必要な場合は v3.0.0 契約どおり `$id` を最後のキーへ明示してください。

## 2. 新設定: `cursorMaxActive`

host 単位の同時カーソル上限（既定 2・最大 5）。kintone のカーソルは **1 ドメイン最大 10 個を全製品で共有**するため、kSQL は自制的に枠を制限します。

| 面 | 指定方法 |
|---|---|
| CLI | `--cursor-max-active <1..5>` |
| 環境変数 | `KSQL_CURSOR_MAX_ACTIVE` |
| profile | `query.cursorMaxActive` |
| MCP | ツール入力 `cursorMaxActive` |
| プラグイン | 「⚙ オプション → 取得」の Cursor 上限（localStorage に保存） |

同一 host では最後に実行した面の設定が反映されます。縮小した場合、実行中のカーソルは強制終了せず、自然減で新上限に収束します。

## 3. 新しいエラー・警告

| code | 意味 | 対処 |
|---|---|---|
| `KORDER_SCAN_ROWS_EXCEEDS_MAX_RECORDS` | 走査件数が `maxRecords` 超過（planning error・API 呼び出しなし） | `maxRecords` を引き上げる／`LIMIT`・`OFFSET` を減らす／通常 `ORDER BY` を使う |
| `CursorCapacityError` | kSQL 内部の同時カーソル枠が 30 秒以内に空かない | 並列実行を減らす・`cursorMaxActive` を見直す |
| kintone `GAIA_TM12`（HTTP 429） | **ドメイン全体**の 10 枠が満杯（他製品・他プロセス含む） | 時間を置く・同一ドメインの並列ジョブを減らす |
| `CursorCreateOutcomeUnknownError` | カーソル作成の成否不明（応答喪失）。自動再試行しない | 最大 10 分+安全余裕の間、枠が 1 つ減る可能性を考慮して再実行 |
| `CursorCleanupWarning` | **結果は正しい**が、カーソルの解放を確認できなかった | 結果はそのまま利用可。最大 10 分+安全余裕の間は枠を隔離 |

## 4. 制限（利用前に知っておくこと）

1. **完全なスナップショットではない**: 対象集合と行の位置はカーソル作成時点で固定されますが、値は各取得時点のものです。走査中にソートキーが更新されると、結果が表示値上 KORDER 順に見えない場合があります。更新のない時間帯の実行を推奨します
2. **ドメイン枠の共有**: kSQL の内部上限以下でも、同一ドメインの他利用者・他製品がカーソルを使っていると作成に失敗することがあります（`GAIA_TM12`）
3. **Cursor API を使うのは `KORDER BY` の大きい窓だけ**です。通常の `ORDER BY`・FULL_SCAN・JOIN・DML の取得方式は v3.0.0 から変わりません
4. カーソルの有効期限は 10 分（取得で延長）。異常終了時は最大 10 分程度、ドメイン枠を 1 つ占有する可能性があります

## 5. EXPLAIN

`KORDER_CURSOR` は独立した計画として表示されます。実行前に `EXPLAIN` で計画・走査件数を確認できます。

```text
order plan:    KORDER_CURSOR
order semantics: kintone native (not kSQL canonical)
fetch API: POST/GET/DELETE records/cursor.json
cursor page size: 500
cursor concurrency: 2 per domain (process-local)
scan rows:     10001
```

MCP の `ksql_explain` には `maxRecords` 入力が追加されました。実行時と同じ値を渡すことで、実行と同一の計画を確認できます。
