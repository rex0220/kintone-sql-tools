# kintone SQL プラグイン 仕様書

**バージョン:** Ver.1  
**更新日:** 2026-04-07  
**ステータス:** Ver.1 実装済み（言語仕様は `docs/ksql_language_reference.md` を正とする）

---

## 1. 概要

### 1.1 目的

kintone アプリに対して SQL 文で「取得・結合・更新・削除」を行うプラグイン。  
kintone REST API を SQL インターフェースで統一的に操作できるようにする。

### 1.2 基本アーキテクチャ

```
ユーザーが SQL 入力
        ↓
自作 SQL パーサー（Lexer → Parser → AST）
        ↓
AST type ごとに実行分岐
        ↓
┌────────────────────────────────────────────────────────────┐
│ SELECT（SIMPLE）      → kintone クエリへ変換 → GET API      │
│ SELECT（FULL_SCAN）   → 全件取得 → JS 処理（JOIN/集計等）    │
│ INSERT                → POST /k/v1/records                  │
│ UPDATE                → GET（対象抽出）→ PUT /k/v1/records  │
│ UPSERT                → GET（重複判定）→ POST/PUT            │
│ DELETE                → GET（対象抽出）→ DELETE /k/v1/records│
│ REORDER               → GET（行順取得）→ PUT（id のみ送信）  │
│ SHOW APPS / DESCRIBE  → メタ情報 API 取得                    │
└────────────────────────────────────────────────────────────┘
        ↓
結果を画面に表示
```

### 1.3 採用技術方針

| 項目 | 採用 | 理由 |
|------|------|------|
| SQL パーサー | **自作**（Lexer + Parser） | 日本語識別子対応・エラー文言制御・外部依存ゼロ |
| SELECT 集計・JOIN | **JS 自前実装**（Map / Set / Array） | kintone API 非対応機能を吸収 |
| 外部ライブラリ | **なし** | バンドルサイズ・制御性の観点 |
| テーブル名記法 | `APP100`（APP + 数字）/ `APP100$明細`（サブテーブル） | SQL 識別子として安定 |

---

## 2. 対応 SQL 構文（Ver.1）

> **v1.4.0 追加**: `;` 区切りの **read-only バッチ**と**一時テーブル**（`CREATE TEMP TABLE #t AS SELECT ...`）に対応。最後に結果セットを返した文のみを表示する。DML を含むバッチは非対応（CLI / MCP を使用）。EXPLAIN ボタンはバッチ入力を全文プラン表示する（実行しない）。詳細は [ksql_batch_temp_table_spec.md](ksql_batch_temp_table_spec.md) §8.4。

凡例: ✅ 対応 / ❌ 非対応 / 🟣 kintone 拡張

### 2.1 SELECT / FROM / WHERE

| 構文 | 対応 | 備考 |
|------|:----:|------|
| `SELECT *` / 列指定 / `AS` | ✅ | |
| `DISTINCT` | ✅ | FULL_SCAN |
| 算術式（SELECT/WHERE/ORDER BY/UPDATE SET）、剰余 `%` | ✅ | 主に FULL_SCAN |
| `CASE WHEN` / `IF(...)` | ✅ | SELECT / WHERE / UPDATE SET |
| 文字列・数値・数学（ABS/MOD/POWER/SQRT）・FORMAT・CAST/CONVERT 関数 | ✅ | |
| 日付関数（YEAR/MONTH/DAY/DATE_FORMAT/DATEDIFF/DATE_ADD） | ✅ | |
| `CURRENT_DATE()` / `CURRENT_TIMESTAMP()` | ✅ | SELECT/WHERE で JS 評価。キーワード不要（`()` で関数と判別） |
| 比較演算子、`AND/OR/NOT`、括弧 | ✅ | |
| `BETWEEN` / `IN` / `NOT IN` | ✅ | `IN (SELECT ...)` も対応 |
| `LIKE` / `NOT LIKE` | ✅ | ワイルドカードなし LIKE は部分一致（contains） |
| `IS NULL` / `IS NOT NULL` | ✅ | 空文字を NULL 相当として扱う |
| `EXISTS` / `NOT EXISTS`（非相関） | ✅ | FULL_SCAN |
| スカラーサブクエリ `(SELECT ...)` | ✅ | WHERE 右辺・SELECT 列・HAVING。非相関のみ。FULL_SCAN |
| `TODAY()` / `NOW()` / `LOGINUSER()` | 🟣 | kintone 拡張。WHERE での kintone API 変換用 |

### 2.2 JOIN / GROUP BY / ORDER BY / LIMIT

| 構文 | 対応 | 備考 |
|------|:----:|------|
| `INNER` / `LEFT` / `RIGHT JOIN` | ✅ | 等値結合のみ |
| 3 テーブル以上 JOIN | ✅ | FULL_SCAN |
| `GROUP BY` / 集計関数 / `HAVING` | ✅ | FULL_SCAN |
| `ORDER BY`（複数キー） | ✅ | 式ソートは FULL_SCAN |
| `LIMIT` / `OFFSET` | ✅ | SIMPLE は API、FULL_SCAN は JS |

### 2.3 UNION / WITH / メタ参照

| 構文 | 対応 | 備考 |
|------|:----:|------|
| `UNION` / `UNION ALL` | ✅ | FULL_SCAN |
| `WITH`（CTE） | ✅ | 単純 CTE はインライン化最適化 |
| 複数 CTE / CTE JOIN / CTE 内 UNION | ✅ | |
| CTE 内 `SHOW APPS` / `DESCRIBE` / `DESC` | ✅ | WITH の body で使用可 |
| `SHOW APPS` | ✅ | 最大 1,000 件（100 件単位で自動ページング） |
| `DESCRIBE APP` / `DESC APP` | ✅ | フィールド定義一覧 |

### 2.4 DML（通常テーブル）

| 構文 | 対応 | 備考 |
|------|:----:|------|
| `INSERT ... VALUES`（複数行） | ✅ | 100 件バッチ分割 |
| `INSERT INTO ... SELECT` | ✅ | SELECT 側は SIMPLE/FULL_SCAN 自動判定 |
| `UPDATE ... SET ... WHERE ...` | ✅ | WHERE 必須 |
| `UPDATE SET` で算術式 / CASE WHEN / スカラーサブクエリ | ✅ | SET 右辺に `(SELECT ...)` 指定可。非相関のみ |
| `UPSERT ... VALUES ... ON DUPLICATE (...)` | ✅ | 複合キー対応 |
| `UPSERT ... SELECT ... ON DUPLICATE (...)` | ✅ | |
| `DELETE ... WHERE ...` | ✅ | WHERE 必須 |

### 2.5 サブテーブル仮想テーブル

サブテーブルは `APP100$明細` 形式の仮想テーブルとして操作します。

| 構文 | 対応 | 備考 |
|------|:----:|------|
| `SELECT * FROM APP100$明細` | ✅ | システム列（`_pid` / `_rid` / `_idx`）を含む |
| `_p.フィールド名` （親項目参照） | ✅ | SELECT 列・WHERE で使用可 |
| `_p.*` （親項目一括展開） | ✅ | `SELECT *` には暗黙追加しない |
| `INSERT INTO APP100$明細 (_pid, ...) VALUES (...)` | ✅ | `_pid` 必須・末尾追加 |
| `UPDATE APP100$明細 SET ... WHERE _pid=N AND _rid='...'` | ✅ | `_rid` 条件必須 |
| `DELETE FROM APP100$明細 WHERE _pid=N AND _rid='...'` | ✅ | `_rid` 条件必須 |
| `REORDER APP100$明細 BY ... WHERE _pid=N` | ✅ | 親単位で並び替え |
| `REORDER ALL APP100$明細 BY ...` | ✅ | 全親レコード対象 |

---

## 3. 実行モード

| 条件 | モード |
|------|--------|
| JOIN なし・GROUP BY なし・DISTINCT なし・WHERE/ORDER BY が単純式 | **SIMPLE** |
| JOIN / GROUP BY / DISTINCT / CASE WHEN / 式 ORDER BY | **FULL_SCAN** |
| `IN (SELECT ...)` / `EXISTS` / `NOT EXISTS` / スカラーサブクエリ | **FULL_SCAN** |
| `UNION` / `UNION ALL` | **FULL_SCAN** |
| `WITH`（単純 CTE インライン化可能） | **SIMPLE 相当で最適化** |
| サブテーブル `APP100$明細` への SELECT | **FULL_SCAN** |

### 3.1 SIMPLE

- kintone クエリへ変換して API 側で絞り込み・ソート・件数制限を実施。

### 3.2 FULL_SCAN

- 必要テーブルを全件取得し、JS 側で JOIN / WHERE / GROUP BY / HAVING / ORDER BY / LIMIT を評価。
- サブクエリは事前実行（非相関のため 1 回のみ API コール）。
- 件数が多い場合は性能劣化リスクがあるため、UI で警告。

---

## 4. kintone API 制約と自動処理

| 制約 | 自動処理 |
|------|---------|
| GET は 1 回最大 500 件 | `limit 500 offset N` で自動ページング |
| POST（records）は 1 回最大 100 件 | 100 件ごとに自動分割 |
| GET（apps）は 1 回最大 100 件 | SHOW APPS で自動ページング（最大 1,000 件） |
| GROUP BY / DISTINCT / JOIN を API が直接サポートしない | FULL_SCAN で JS 実行 |
| トランザクションなし | 更新・削除は事前確認を実施 |
| プロセス管理（ステータス/作業者）は records API で更新不可 | UPDATE 対象外（status API は本スコープ外） |
| サブテーブル並び替えは行 id のみ送信 | ルックアップ再評価影響を最小化 |

---

## 5. 記法ルール

### 5.1 テーブル名

- 通常テーブル: `APP` + 数字（例: `APP100`）
- サブテーブル: `APP` + 数字 + `$` + サブテーブルフィールドコード（例: `APP100$明細`）
- 大文字・小文字は区別しない

### 5.2 フィールド名

- 日本語フィールドコードをクォートなしで使用可
- スペース・特殊文字・予約語はバッククォートで囲む
- `CURRENT_DATE` / `CURRENT_TIMESTAMP` はキーワード未登録のため、`()` なしならフィールドとして扱われる

---

## 6. 安全機能

- `UPDATE` / `DELETE` は WHERE 必須
- サブテーブル `UPDATE` / `DELETE` は `_rid` 条件必須
- 実行前に対象件数を確認
- 高コスト実行（JOIN / DISTINCT / GROUP BY 等）で警告
- 取得上限（デフォルト 10,000 件）を超える場合はエラー

---

## 7. 非対応（Ver.1時点）

- 相関サブクエリ（非相関の IN/EXISTS/スカラーサブクエリは対応済み）
- `INTERSECT` / `EXCEPT`
- 再帰 CTE
- `FULL OUTER JOIN`
- `JOIN` を含む `UPDATE` / `DELETE`
- `ROLLUP` / `CUBE` / `GROUPING SETS`
- トランザクション / ROLLBACK
- WHERE なし `UPDATE` / `DELETE`（安全上禁止）
- 添付ファイル（FILE）への INSERT / UPDATE（別APIが必要）

---

## 8. バージョン履歴

| バージョン | 内容 |
|---|---|
| 0.1 | 基本 SELECT / INSERT / UPDATE / DELETE |
| 0.2 | JOIN / GROUP BY / HAVING / DISTINCT / ORDER BY 算術式 / CASE WHEN |
| 0.3 | UNION / WITH（CTE）/ CTE インライン化 / WHERE 算術式・CASE WHEN |
| 0.4 | 数学関数（ABS/MOD/POWER/SQRT）/ SHOW APPS / DESCRIBE / UPSERT / IN (SELECT) / EXISTS |
| 0.5 | サブテーブル仮想テーブル / _p. ショートカット / REORDER / IF() |
| 0.6 | スカラーサブクエリ / CURRENT_DATE() / CURRENT_TIMESTAMP() / LIKE 挙動統一 |
| 0.7 | UPDATE SET スカラーサブクエリ / EXPLAIN UPSERT・REORDER / JOIN エイリアス省略対応 |
| 0.8 | カスタム一覧判定（`#rex0220-ksql-main`）/ 右ペイン独立化 / 一覧API取得（条件・ソート、最大1000件）/ 結果表示拡張（行番号・フィルター・ソート・全画面）/ 履歴オプション保存 / SQLID自動採番 |
| 0.9 | ファイル表示オプション追加（そのまま/名前/fileKey）/ 詳細・編集・追加画面のオプション反映強化 / サブテーブルポップアップの重複オープン防止（閉じる1回で閉じる） |
| 1.0 | 現行仕様を Ver.1 として確定（CLI/言語仕様/ドキュメント構成を同期） |

---

## 9. UI運用仕様（Ver.1）

### 9.1 一覧画面の表示対象

- SQL実行UIはカスタマイズ一覧でのみ表示する。
- 判定条件:
  - `viewType = custom`
  - HTML に `<div id="rex0220-ksql-main"></div>` が存在すること

### 9.2 一覧画面レイアウト

- `ksql-panel` と独立した右ペイン「レコード一覧」を表示する。
- 右ペイン機能:
  - 右方向へ折りたたみ/展開
  - レコード詳細リンク（新規タブ）
  - レコード選択時に以下を画面へ反映
    - SQL
    - 表示オプション（ユーザー/配列/ファイル/日時/テーブル）
    - 最大取得件数
    - 上限到達時の動作
    - 一時テーブル上限（v1.11.0。**任意フィールド** `一時テーブル上限行`〔数値〕を持つレコードのみ反映。空欄 = 既定 10,000 に復帰、フィールドなし = パネル現在値を維持）

### 9.2.1 詳細・編集・追加画面の初期反映

- スペース項目の初期表示は `event.record` を基準に行う。
- 表示オプションは以下のレコード項目値から初期反映する:
  - `ユーザー` / `配列` / `ファイル` / `日時` / `テーブル`
- `ファイル` の選択肢:
  - `そのまま` / `名前` / `fileKey`
- 一時テーブル上限（v1.11.0）: 任意フィールド `一時テーブル上限行`（数値）があれば初期反映・保存する（フィールドがないアプリでは従来どおり動作。既存アプリへの追加手順は言語リファレンス「プラグインでの一時テーブル上限指定」を参照）

### 9.3 右ペインのレコード取得

- `event.records` は使用しない。
- 一覧設定の表示条件・ソートを使って API 取得する。
  - `/k/v1/app/views.json` から `filterCond` と `sort` を取得
  - `/k/v1/records.json` の `query` に反映
  - `sort` が `field desc` 形式の場合は `order by` を補完する
- 取得上限は 1,000 件（500件ページング）。

### 9.4 右ペインのフィルターと表示

- テキストフィルター（SQLID/タイトル）を提供。
- アプリIDフィルター（単一数値入力）を提供。
  - 入力は `85` 形式
  - 内部判定は `,85,` 完全一致
- 一覧表示は 1行形式:
  - `SQLID` + `タイトル`
  - 補助表示として対象アプリID（`APP: 85,89` 形式）

### 9.5 対象アプリIDの保存

- レコード保存時に `SQL` から `APP\d+` を抽出し、`対象アプリ` に保存する。
- 保存形式は正規化した CSV:
  - `,85,89,`（前後カンマ付き）
  - 数値化、重複除去、昇順化

### 9.6 結果表示拡張

- 結果テーブルに行番号列（左端 `#`）を表示。
- 結果フィルターを提供（表示行を絞り込み）。
- 件数表示はフィルター時 `表示件数 / 全件数` 形式（例: `4 / 36`）。
- 列ヘッダークリックで昇順/降順ソート。
- 結果全画面表示を提供:
  - アイコンボタンで切替
  - 全画面中は SQL 入力エリアを非表示
  - `Esc` で解除
- サブテーブル行数セル（`N 行`）クリックで「テーブル内容」ダイアログを表示:
  - タイトルに対象フィールドコードを表示
  - 左端に行番号列（`#`）
  - ダイアログ内フィルターと件数表示（例: `3 / 36`）
  - 列ヘッダークリックでソート（昇順/降順）
  - 先頭100行まで表示し、超過時は省略メッセージを表示

### 9.7 履歴機能拡張

- 履歴に SQL だけでなく実行時オプションを保存する。
  - `displayOptions`
  - `maxRecords`
  - `onLimitReached`
- 履歴実行時は保存時オプションを優先して再実行する。
- 既存の文字列履歴は互換フォールバックで実行可能。
- 履歴ドロップダウンにフィルター入力を追加。

### 9.8 SQLID 自動採番（追加/編集画面）

- 追加画面:
  - `SQLID` は表示時にクリア（複写対応）
  - `SQLID` は編集不可
  - 保存時に `識別-連番` を自動採番
- 採番ルール:
  - `SQLID like "識別-%"` を検索し最大値+1
  - 連番は最低3桁ゼロ埋め（`004`）
  - 1000以上は4桁以上をそのまま使用
- 編集画面:
  - `SQLID` は編集不可

---

## 10. ドキュメント運用

- 言語仕様の詳細・具体例は `docs/ksql_language_reference.md` を一次情報とする。
- 本仕様書は設計要約と実装境界の共有を目的とする。
- 構文の追加・挙動変更時は、実装・テスト・言語リファレンス・本仕様書を同時更新する。
