# kSQL CLI DML Phase 1 仕様（`UPDATE` / `DELETE` / `INSERT` / `UPSERT`）

- 作成日: 2026-04-07
- 対応版: Ver.1
- 対象: CLI（`src/cli`）での更新系 SQL 初期対応
- 位置づけ: Ver.1 構成の DML 安全実装フェーズ

## 1. 目的

`UPDATE` / `DELETE` / `INSERT` / `UPSERT` を段階導入する。
初期導入では「誤更新防止」を最優先し、`dry-run` と安全確認を既定動作とする。

## 2. 対象と非対象

対象:

1. 単発実行（`-e`, `-f`）での DML 実行
2. `--console` での DML 実行
3. 実行前確認、`WHERE` なし制御、件数ガード
4. `--dry-run` による実行計画表示

非対象（Phase 2以降）:

1. 複雑 JOIN を伴う更新最適化
2. バルク更新の高機能リトライ
3. トランザクション相当の複合実行

## 3. フラグ仕様（追加）

1. `--allow-dml`
2. `--yes`
3. `--allow-without-where`
4. `--dml-max-rows <n>`

既定値:

1. `allowDml=false`
2. `yes=false`
3. `allowWithoutWhere=false`
4. `dmlMaxRows=100`

## 4. 実行ルール

1. `--allow-dml` 未指定時:
   DML は拒否（終了コード `2`）
2. `--allow-dml` 指定時:
   DML は評価可能
3. `--dry-run` 指定時:
   DML は API 実行しない（計画のみ）
4. `--yes` 未指定時:
   実行前確認を必須化（対話入力）
5. `--yes` 指定時:
   実行前確認を省略
6. `WHERE` なし `UPDATE/DELETE`:
   `--allow-without-where` 未指定なら拒否（終了コード `2`）
7. 見積対象件数が `dmlMaxRows` 超過:
   実行前に拒否（終了コード `2`）

## 5. 実行前チェック順

1. SQL種別判定（SELECT or DML）
2. `--allow-dml` チェック
3. `WHERE` なしチェック（UPDATE/DELETE）
4. 影響件数見積（可能な範囲）
5. `dmlMaxRows` チェック
6. `--dry-run` 判定
7. 確認プロンプト（`--yes` で省略）
8. 実行

## 6. 確認プロンプト仕様

表示例:

```text
[DML Confirm]
type: UPDATE
app: APP88
estimatedRows: 24
query: UPDATE APP88 SET 状態='完了' WHERE ステータス='未着手'
Proceed? (yes/no):
```

ルール:

1. `yes` のみ実行継続
2. `no` / 空入力 / EOF は中断（終了コード `2`）
3. REPL では 1 クエリごとに都度確認

## 7. `--dry-run` 出力拡張

DML の `--dry-run` では次を表示する:

1. statementType
2. app
3. action（insert/update/delete/upsert）
4. whereSummary（該当時）
5. estimatedRows
6. guardResult（allow/deny と理由）

## 8. 設定ファイル拡張

`ksql.config.json` の `profiles.<name>.dml` に追加:

```json
{
  "profiles": {
    "dev": {
      "dml": {
        "allowDml": false,
        "yes": false,
        "allowWithoutWhere": false,
        "maxRows": 100
      }
    }
  }
}
```

優先順位:

1. CLI 引数
2. 環境変数（`KSQL_ALLOW_DML` など）
3. config
4. 既定値

## 9. エラーコード方針

1. `2`: 安全ポリシー違反（allow-dml未指定 / whereなし禁止 / maxRows超過 / confirm拒否）
2. `1`: 実行時エラー（API エラー、変換エラー）
3. `3`: 認証・接続エラー

## 10. 実装ステップ（Phase 1）

1. 引数・設定パーサーへ DML 安全フラグ追加
2. `run()` の statement 判定を SELECT固定から DML 対応へ拡張
3. DML 実行前ガード関数を `src/cli` に追加
4. `--dry-run` の DML 計画出力を追加
5. 確認プロンプト実装（非対話時は stdin で処理）
6. ユニットテスト追加（ガード分岐）
7. E2E テスト追加（`--yes`, 拒否, `whereなし`, `maxRows`）

## 11. 受け入れ条件

1. DML は `--allow-dml` なしで必ず拒否される
2. `--allow-dml --dry-run` で API を実行しない
3. `UPDATE/DELETE` の `WHERE` なしが既定で拒否される
4. `--yes` なしで確認プロンプトが表示される
5. `dmlMaxRows` 超過時に実行前に停止する
6. 既存 SELECT の挙動が回帰しない
