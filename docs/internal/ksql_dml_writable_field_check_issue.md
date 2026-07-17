# 課題: DML が存在しない／サブテーブル内のフィールドを対象にしても黙って成功する（B34）

- 作成日: 2026-07-17
- 位置づけ: kintone の文字列ソート実機検証（Qiita 記事作成）中に発見。テスト対象に選んだ `文字列T1` がサブテーブル子フィールドだったことが端緒。レビューで「サブテーブル子に限定せず、不存在フィールドも同じ欠陥ではないか」と指摘され、実機で確認して確定した。
- ステータス: **課題 R2。実機確認済み・仕様案前。**（R1 レビュー指摘を反映: ①検査タイミングを「ソース取得・confirm より前」に固定②VALIDATE ONLY / ON ERROR SKIP は独立経路でなく DML 形式への修飾としてマトリクス化③サブテーブル DML の非回帰範囲を現行対応の INSERT VALUES / UPDATE / DELETE / REORDER に限定）
- 横断契約: [文字列の扱い](ksql_string_semantics.md) 原則 1「**不可逆または説明不能な成功を作らない**」に違反する。
- 分担: Claude=仕様/観点、Codex=実装/テスト
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md)

---

## 0. 要約

**通常の INSERT / UPDATE は、対象フィールドが (a) サブテーブル内の子フィールドでも (b) アプリに存在しないフィールドコードでも、`insertedCount` / `updatedCount` を返して成功し、実際には何も書かれない。**

原因は 2 段:

1. **kintone REST API は、レコード payload 中のトップレベルに存在しないフィールドコードを黙って無視する**（エラーにしない）
2. **kSQL の通常 DML 経路は、対象フィールドの存在・トップレベル所属・書き込み可否を検査せずに API へ送る**（型マップを作るだけ）

`VALIDATE ONLY` は不存在フィールドを `ArgumentError` で拒否するが、**サブテーブル子は `inSubtable` を見ていないため素通しする**。

---

## 1. 現象（実機実測・2026-07-17・APP4221）

APP4221 の `文字列T1` は `テーブル`（SUBTABLE）内の子フィールド（`kintone-get-form-fields` で `テーブル.fields` 内に存在することを確認済み）。`存在しないフィールドXYZ` はどこにも存在しない。

| # | 操作 | 結果 | 実際 |
|---|---|---|---|
| 1 | `INSERT INTO APP4221 (タイトル, 文字列T1, …) VALUES (…)` | **`insertedCount: 1`（成功）** | レコードは作られるが `文字列T1` は書かれない。読み返しは空 |
| 2 | `UPDATE APP4221 SET 文字列T1 = 'A' WHERE $id = 70` | **`updatedCount: 1`（成功）** | 何も書かれない。読み返しは空 |
| 3 | `INSERT INTO APP4221 (タイトル, 存在しないフィールドXYZ, …) VALUES (…)` | **`insertedCount: 1`（成功）** | 同上 |
| 4 | `UPDATE APP4221 SET 存在しないフィールドXYZ = '…' WHERE $id = 82` | **`updatedCount: 1`（成功）** | 同上 |
| 5 | 同 3 を `VALIDATE ONLY` | `ArgumentError: DML target field 存在しないフィールドXYZ does not exist.` | **不存在だけは検査済み** |
| 6 | 同 1 を `VALIDATE ONLY` | **`ok: true / validRows: 1`（素通し）** | **サブテーブル子は検査されない** |

**利用者は気付く手段がない**: `DESCRIBE` はサブテーブル子をフラット表示し所属を示さず、`updatedCount` は「書けた」ことを意味していない。フィールドコードの**タイポでも同じ経路で黙って握り潰される**（#3/#4）。

## 2. 原因（コード確定）

- フォーム情報はサブテーブル子をフラット化しつつ **`inSubtable` を保持している**（`formFieldInfo`）
- 通常 INSERT/UPDATE（`execute.ts:3962` 付近）は**型マップを作るだけ**で、対象フィールドの存在・トップレベル所属を検査せず payload を組んで送信する
- `VALIDATE ONLY` の検査（`execute.ts:3493`）は不存在を拒否するが **`info.inSubtable` を見ていない**

## 3. 対策案: 共有の「書き込み可能なトップレベルフィールド検査」

DML 準備段階に共通検査を置き、**全 DML 経路へ横断適用**する。フォーム定義は `prepareDmlValidation` 相当で取得するため**追加 API の種類は増えない**が、**取得と検査の位置は前倒しが必要**である:

> **検査タイミング（R2 で固定）**: 対象フィールド検査は、**ソース SELECT・更新対象取得・confirm・POST/PUT より前**に完了する。フォーム定義取得のみ許可し、不正時はレコード取得・confirm・書き込み API を呼ばない。

現行の `INSERT … SELECT` は **ソース SELECT 実行 → confirm → フィールド情報取得** の順（`execute.ts:3999` / `:4015` / `:4022`）のため、既存の `getFieldTypeMap` 付近へ検査を足すだけでは、明らかに不正な書き込み先でもソースを全件取得し確認ダイアログまで出してから失敗する。

| 検査 | 挙動 |
|---|---|
| 対象フィールドコードがアプリに存在するか | 無ければ `ArgumentError`（既存 VALIDATE ONLY の文言と統一） |
| `inSubtable` でないか | サブテーブル子なら `ArgumentError`。エラー文言でサブテーブル DML 構文（`APPxxxx$テーブル`）へ誘導する |
| 書き込み可能な型か | 既存の書き込み可否判定と統合（実装時に整理） |

**対象経路:** DML 形式 × 修飾の全組み合わせに適用する。

- DML 形式: INSERT VALUES / INSERT … SELECT / UPDATE 通常・算術・CASE・UPDATE … FROM / UPSERT VALUES / UPSERT … SELECT
- 修飾: なし / `VALIDATE ONLY` / `ON ERROR SKIP`（修飾は独立経路ではなく各 DML 形式に掛かる。`VALIDATE ONLY`・`ON ERROR SKIP` には `inSubtable` 拒否の追加が必要）

**非回帰:** 正規のサブテーブル DML（`APPxxxx$テーブル` 対象）のうち**現行で対応する INSERT VALUES / UPDATE / DELETE / REORDER** は現行どおり動くこと。

## 4. SemVer

**minor**。挙動変更（黙って成功 → エラー）を含むが、**変わるのは「何も書いていないのに成功を報告していたケース」だけ**であり、誤った成功を明示的な失敗へ正す方向（B19 `DATE_ADD` 不正単位・B22 と同じ判断）。正しい対象への DML は完全に不変。

## 5. 受入条件

- [ ] **DML 形式×修飾×対象の直積**をテストする: DML 形式 = {INSERT VALUES, INSERT…SELECT, UPDATE 通常, UPDATE 算術, UPDATE CASE, UPDATE…FROM, UPSERT VALUES, UPSERT…SELECT} × 修飾 = {なし, VALIDATE ONLY, ON ERROR SKIP}（適用可能な組み合わせ全部） × 対象 = {不存在, サブテーブル子, 正常トップレベル（非回帰）}
- [ ] **検査タイミング**: 対象フィールド検査は、**ソース SELECT・更新対象取得・confirm・POST/PUT より前**に完了する。フォーム定義取得のみ許可し、不正時はレコード取得・confirm・書き込み API を呼ばない（`INSERT … SELECT` で不正な書き込み先を指定したとき、ソース SELECT が実行されないことをテストで確認する）
- [ ] 正規のサブテーブル DML（`APPxxxx$テーブル`）のうち現行対応の **INSERT VALUES / UPDATE / DELETE / REORDER** が非回帰
- [ ] エラー文言: 不存在と サブテーブル子 を区別し、後者は正規構文を案内する
- [ ] `ON ERROR SKIP` では行単位の隔離ではなく**文単位の ArgumentError** とする（対象フィールドの誤りは全行に共通で、`#err` へ流す性質のものではない）
- [ ] 実機: 上記 §1 の 6 パターン（すべて不正対象）が、修正後は**すべて文単位の `ArgumentError`** になり、**confirm・レコード取得・書き込み API の呼び出しが 0 件**であること
