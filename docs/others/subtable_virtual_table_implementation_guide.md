# サブテーブル仮想テーブル 実装手順書

**対象仕様:** `docs/proposals/subtable_virtual_table_spec.md`  
**作成日:** 2026-04-03  
**目的:** `_rid` を軸に、サブテーブルを通常テーブル相当で SELECT/INSERT/UPDATE/DELETE できるように実装する。加えて `_p.<親項目>` と `_p.*` で親項目参照を簡略化し、`REORDER` で親単位の並び替えを行えるようにする。

---

## 1. 前提

- 既存方針
  - SQL パーサーは自作（Lexer + Parser）
  - テーブル名は `APP100` 形式
  - 外部ライブラリなし
- 本実装で追加する概念
  - サブテーブル仮想テーブル名: `APP100$明細`
  - システム列: `_pid`, `_rid`, `_idx`
  - 親項目ショートカット: `_p.<親項目>`, `_p.*`

---

## 2. 実装フェーズ

1. Phase 1: 構文・AST 拡張（サブテーブル表現）
2. Phase 2: SELECT 実行（仮想テーブル展開）
3. Phase 3: DML 実行（行追加/更新/削除）
4. Phase 4: REORDER 実行（親単位の並び替え）
5. Phase 5: 安全制約・競合制御
6. Phase 6: テスト整備・ドキュメント統合

---

## 3. 詳細手順

### Step 1. AST にサブテーブル情報を持たせる

- 対象ファイル
  - `src/types/ast.ts`
  - `src/parser/parser.ts`
  - `src/lexer/tokens.ts`（必要な場合）
- 実装
  - `TableRef` に `subtableCode: string | null` を追加
  - `APP100$明細` を `appId=100, subtableCode="明細"` で保持
  - 通常テーブルは `subtableCode=null`
- 完了条件
  - `FROM APP100$明細` がパースできる
  - 既存クエリ（`APP100`）に回帰なし

### Step 2. テーブル名解決ロジックを追加

- 対象ファイル
  - `src/parser/parser.ts`
  - `src/execute.ts`（ルーティング判定）
- 実装
  - `APP\d+\$...` を仮想テーブルとして判定
  - `APP\d+` のみは従来どおり
  - 不正形式は明示エラー
- 完了条件
  - `ERR_SUBTABLE_TABLE_NAME_INVALID` 相当エラーが返る

### Step 3. サブテーブル展開ユーティリティを作成

- 対象ファイル（新規）
  - `src/converter/subtableAdapter.ts`（推奨）
- 実装
  - 親レコード配列からサブテーブル行を展開し `KintoneRecord[]` へ変換
  - 追加列
    - `_pid`
    - `_rid`（kintone の行 id）
    - `_idx`
    - `_p.<親項目>`（親項目を行に投影）
  - `_subtable_rid` は読み取り時エイリアスとして受理（任意）
  - `_parent.<親項目>` は互換エイリアスとして受理（任意）
- 完了条件
  - 単体変換で 1:N 展開結果が期待どおり
  - `_p.案件名` が展開結果で参照できる

### Step 3.5 `_p.*` 展開ルールを実装

- 対象ファイル
  - `src/engine/process.ts`
  - `src/parser/parser.ts`
  - `src/types/ast.ts`
- 実装
  - SELECT 列に `_p.*` がある場合、親フィールド一覧を `_p.<field>` として展開
  - `SELECT *` 単独時は `_p.*` を暗黙追加しない
  - `_p.*` と明細列の同名衝突は `_p.` 側を優先して回避
- 完了条件
  - `SELECT _p.*, 商品コード FROM APP100$明細` が期待列順で返る

### Step 4. SELECT 実行に仮想テーブル読取を組み込む

- 対象ファイル
  - `src/execute.ts`
  - `src/converter/selectToKintone.ts`
  - `src/engine/process.ts`（必要時）
- 実装
  - `from.subtableCode != null` の場合は親レコード取得後に展開
  - JOIN 対象がサブテーブルの場合も同様に展開
  - 可能な範囲で親レコード側 WHERE を先に適用（件数削減）
  - `_p.<親項目>` を WHERE/ORDER BY/SELECT で評価可能にする
- 完了条件
  - `SELECT * FROM APP100$明細` が実行できる
  - `SELECT _p.案件名, 商品コード FROM APP100$明細` が実行できる
  - `APP100` との JOIN が実行できる

### Step 5. INSERT（サブテーブル行追加）を実装

- 対象ファイル
  - `src/execute.ts`
  - `src/converter/dmlToKintone.ts`
- 実装
  - `INSERT INTO APP100$明細 ...` を検知
  - `_pid` で親取得
  - サブテーブル配列末尾へ新規行追加
  - `PUT /k/v1/record.json` 相当で更新（`revision` 指定）
- 完了条件
  - 行追加後に `_rid` が採番された状態で再取得できる

### Step 6. UPDATE（サブテーブル行更新）を実装

- 対象ファイル
  - `src/execute.ts`
  - `src/converter/dmlToKintone.ts`
- 実装
  - `UPDATE APP100$明細 ... WHERE ...` を検知
  - `_rid` で対象行特定し更新
  - 非対象行・非対象列を保持してマージ更新
- 完了条件
  - 指定行のみ更新される
  - `_rid` 未指定時の安全制約が効く

### Step 7. DELETE（サブテーブル行削除）を実装

- 対象ファイル
  - `src/execute.ts`
  - `src/converter/dmlToKintone.ts`
- 実装
  - `_rid` で対象行特定
  - サブテーブル配列から除外して親更新
- 完了条件
  - 指定行のみ削除される
  - 競合時に失敗を返す

### Step 8. 安全制約を導入

- 対象ファイル
  - `src/execute.ts`
  - `src/converter/dmlToKintone.ts`
- 実装
  - サブテーブル UPDATE/DELETE は WHERE 必須
  - 安全モードでは `_rid` 条件必須
  - `revision` 指定を必須化
- 完了条件
  - 危険クエリが事前にエラー化される

### Step 8.5 REORDER（サブテーブル並び替え）を実装

- 対象ファイル
  - `src/parser/parser.ts`
  - `src/types/ast.ts`
  - `src/execute.ts`
- 実装
  - 構文: `REORDER APP100$明細 BY ... WHERE ...`
  - `_pid` 単位で対象行を抽出し、`BY` キーで並べ替えて保存
  - `WHERE` なしはエラー
  - `UPDATE ... SET _idx = ...` は禁止（並び替え専用機構へ集約）
- 完了条件
  - `REORDER ... WHERE _pid = ...` が親単位で正しく再順序化される
  - `REORDER ...`（WHERE なし）で拒否される

### Step 9. テストを追加

- 対象ファイル
  - `src/parser/__tests__/parser.test.ts`
  - `src/converter/__tests__/dmlToKintone.test.ts`
  - `src/__tests__/execute.test.ts`
- テスト観点
  - パース
    - `APP100$明細` の構文
    - `_p.案件名`, `_p.*` の構文
  - SELECT
    - 単体取得、`_p` 参照、`_p.*` 展開、親JOIN、複数サブテーブルJOIN（行爆発確認）
  - INSERT/UPDATE/DELETE
    - `_rid` 指定時の正しい行特定
    - `_rid` なしの拒否
    - revision 競合エラー
  - REORDER
    - `_pid` 単位で並び替えが反映される
    - `WHERE` なしが拒否される
- 完了条件
  - 追加テストが全て通る
  - 既存テスト回帰なし

### Step 10. 言語仕様・全体仕様を更新

- 対象ファイル
  - `docs/ksql_language_reference.md`
  - `docs/kintone_sql_plugin_spec.md`
- 実装
  - サブテーブル仮想テーブル構文を追記
  - `_rid` 正式列名を明記
  - `_p.<親項目>` / `_p.*` を明記
  - DML 例（INSERT/UPDATE/DELETE）を追加
  - REORDER 例（WHERE 必須）を追加
- 完了条件
  - 仕様と実装差分がない状態

---

## 4. 実装順の推奨

1. Step 1-4（読み取り完成）
2. Step 5-7（DML 完成）
3. Step 8.5（REORDER 完成）
4. Step 8（安全強化）
5. Step 9-10（品質・文書整備）

理由:
- まず読み取り系を固めると、DML 実装時の検証が容易になる。
- `_rid` の流れを先に確定してから更新系を実装すると手戻りが少ない。

---

## 5. 受け入れ条件（Definition of Done）

- `APP100$明細` を通常テーブルのように SELECT できる
- `_p.<親項目>` と `_p.*` で親項目を JOIN なしで参照できる
- `_rid` を使って行更新/行削除ができる
- `_pid` 指定で行追加できる
- `REORDER ... BY ... WHERE _pid = ...` で親単位の並び替えができる
- 安全制約（WHERE 必須、`_rid` 必須モード、revision）が機能する
- テストとドキュメントが更新され、既存機能に回帰がない
