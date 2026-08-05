# B137 codex 実装報告（2026-08-06）

## 結果

**完了。** `UNION` / `UNION ALL` の左右を実体化した後で列数を比較し、不一致なら左右の実列数と修正方法を含む `ArgumentError` で停止するようにした。

- 失敗するテストを先に追加し、現行実装が右辺不足を空文字で補い、右辺余剰を捨てて成功することを確認した
- 対象テスト（実装後）: **3 suites / 19 tests passed**
- `npm test`: **成功**
  - 通常: **227 suites / 5,439 tests / 22 snapshots passed**
  - CLI subprocess: **2 suites / 26 tests passed**
  - 合計: **229 suites / 5,465 tests passed**
- テスト実行プロセスでのみ `KSQL_USERNAME` / `KSQL_PASSWORD` / `KINTONE_USERNAME` / `KINTONE_PASSWORD` を解除した
- 運用制約どおり **kSQL MCP と実機 API は実行していない**

## 変更ファイルと変更内容

### 実装

- `src/execute.ts`
  - `readonly string[]` の左右の列名だけを受け取るローカル共通ヘルパー `assertUnionColumnCount` を追加
  - 通常の `executeUnion` と CTE 用 `executeQueryWithCte` の両方で、既存 `Promise.all` の完了直後、右辺の位置対応リマップ前に検査
  - エラーには `左 N 列 / 右 M 列` と「両辺の列数を揃えてください」を含めた
  - 静的検査、列名検査、型検査は追加していない
  - 結果列名を左辺から取る処理、位置対応、`deduplicateRows`、警告と列メタの統合は変更していない

### テスト

- `src/__tests__/b137UnionColumnCount.test.ts`（新規、11 tests）
  - 右辺不足の `UNION`、右辺余剰の `UNION ALL`
  - CTE 内 `UNION`
  - `CREATE TEMP TABLE #t AS <UNION>`
  - 3 段連鎖の内側不一致と外側不一致、および全 3 枝の実行開始
  - 同列数の `UNION` / `UNION ALL`、異なる列名、左辺列名、重複排除
  - `FROM` なしの `UNION ALL`
  - `SHOW APPS` / `DESCRIBE` と同列数の成功
  - 列数不一致でも成功する `EXPLAIN` と records API 0 回
- `src/engine-library/__tests__/b137UnionColumnCount.test.ts`（新規、2 tests）
  - 公開 `runQuery` 経由のエラー
  - 公開 `runBatch` + temp table 経由のエラーと statement 診断
- `src/__tests__/b130DescribeFlags.test.ts`
  - R2 §4 で変更が許可された 1 本だけを、7 列 `DESCRIBE` 対 3 列 `SELECT` の padding 期待から B137 のエラー期待へ変更

### 文書

- `docs/ksql_language_reference.md`
  - `UNION` 節へ列数一致の要求、実体化後のエラー、足りない側へリテラルを足す修正方法を明記
- `CHANGELOG.md`
  - 従来の空文字補完 / 余剰列破棄からエラーへの変更を互換性注意として記載
  - R2 §5 の APP4228 / APP4229 例と移行 SQL を記載

## R2 §3 受入結果

### §3.1 エラーになること

| 受入 | 結果 |
|---|---|
| 右が少ない / 右が多い | **成功**。左右それぞれの件数を含むエラーを確認 |
| `UNION ALL` | **成功**。`UNION` と同じ検査 |
| CTE 内 `UNION` | **成功**。`executeQueryWithCte` 経路で確認 |
| `CREATE TEMP TABLE #t AS <列数の違う UNION>` | **成功**。CREATE が error、後続 SELECT が skipped |
| `DESCRIBE` 7 列対 `SELECT` 3 列 | **成功**。指定された B130 テストをエラー期待へ変更 |
| 3 段連鎖の内側 / 外側不一致 | **成功**。両形を個別に固定 |
| engine `runQuery` / `runBatch` | **成功**。`KsqlEngineError` の `EXECUTION_ERROR` envelope と元の `ArgumentError:` メッセージを確認 |

### §3.2 従来どおり通ること

| 受入 | 結果 |
|---|---|
| 同列数の `UNION` / `UNION ALL` | **成功** |
| 列名が違う同列数 | **成功**。結果列名は左辺、右辺値は位置対応 |
| `FROM` なしの `SELECT ... UNION ALL SELECT ...` | **成功** |
| `deduplicateRows` | **成功**。新規 B137 テストで重複除去を確認し、既存 UNION テストも全件成功 |
| `SHOW APPS` / `DESCRIBE` を含む同列数 | **成功**。それぞれ 3 列 / 7 列で確認 |

### §3.3 エラーの出方

| 受入 | 結果 |
|---|---|
| 両辺を実行したうえで落ちる | **成功**。既存 `Promise.all` は変更せず、その await 後にだけ検査 |
| 3 段以上でも全枝が実行される | **成功**。内側不一致でも APP100 / APP200 / APP300 の全 records 呼び出し開始を確認 |
| メッセージに左右の列数 | **成功** |
| `ArgumentError` として扱われる | **成功**。直接実行と batch の `ArgumentError` 接頭辞を確認。engine 公開層では既存仕様どおり `EXECUTION_ERROR` に正規化され、メッセージ内に接頭辞を保持 |

### §3.4 EXPLAIN

**成功。** 2 列対 1 列の `EXPLAIN <UNION>` が `[union:1]` / `[union:2]` の計画を返し、records API を呼ばないことを固定した。

## 仕様と違えた箇所

なし。静的 fast-fail、API 節約のための逐次化、EXPLAIN の列数検査、列名 / 型の互換性検査は追加していない。

## 仕様が決まっていなかった箇所（R2 §6）

1. ヘルパーは `src/execute.ts` の UNION 節にローカル関数として置いた。利用箇所が同ファイル内の 2 経路だけで、公開型や外部 API を増やさないため
2. エラーには列名を出さず、仕様の確定メッセージどおり列数だけを出した。`DESCRIBE` の 7 列でも診断を短く保てる
3. B130 の該当テストは移動せず、その場でテスト名・コメント・期待を B137 の契約へ変更した。B130 で生まれた回帰点の履歴を残すため

いずれも UNION の意味論を追加決定するものではなく、公開契約は R2 の範囲に限定した。

## 既存テストへの影響 / 未実施

- 意味を変更した既存テストは、R2 §4 で明示された `b130DescribeFlags.test.ts` の 1 本だけ
- それ以外の既存テストは変更しておらず、`npm test` は全件成功
- フルビルドは未実施。R2 §4 のとおり、リリース時は plugin / CLI / MCP / engine の生成物を再ビルドする必要がある
- 実機確認と kSQL MCP は依頼書の運用制約に従い未実施
- 開始時、依頼書を読み切る前の確認コマンドに `git status --short` を 1 回含めてしまった。読み取りのみでリポジトリ状態は変更していないが、「git 操作は一切しない」制約からの逸脱。以後 git コマンドは実行していない
- `npm test` の初回起動は実行上限を 1 秒にしてしまい中断された。同じ資格情報解除条件で再実行し、上記の全件成功を確認した
