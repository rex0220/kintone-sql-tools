# B181 実装報告（codex・2026-09-16）

- 依頼: [ksql_b181_codex_impl_request.md](ksql_b181_codex_impl_request.md)（案 A・参照解決の共通 helper）
- 起票: [ksql_b181_alias_lowercase_reference_mismatch_issue.md](ksql_b181_alias_lowercase_reference_mismatch_issue.md)
- 作業ブランチ: `b181/dev`（B182 コミット d1dbec9 の上）
- 末尾に Claude のレビュー節（実機確認・codex 版への修正 4 点・範囲外として確認した既存挙動）を追記

---

## 変更ファイル一覧

- `src/core/projectedNameResolution.ts:8` — 共通名前解決 helper を新設
- `src/execute.ts:468` — 実体化スキーマ束縛、CTE・一時表・EXPLAIN・UPDATE FROM・意味型解決
- `src/engine/process.ts:1322` — ORDER BY alias 評価
- `src/core/optimization/canonicalOrderPlanner.ts:51` — canonical ORDER 計画
- `src/core/aggregateDependencyValidation.ts:255` — HAVING/ORDER BY alias の依存検証
- `src/converter/selectToKintone.ts:503` — required-field 収集時の alias 判定
- `src/engine/__tests__/orderByAlias.test.ts:292` — ORDER BY 回帰テスト
- `src/__tests__/b181AliasReference.test.ts:44` — B181 受入テスト新設
- `docs/ksql_language_reference.md:157` — §1 と §8 の説明・実行済み例

## 修正箇所 ↔ 根拠行

| 修正箇所 | 根拠 |
|---|---|
| 完全一致→小文字正規名の共通解決 | `projectedNameResolution.ts:8` |
| 実体化列・columnMeta の共通解決 | `execute.ts:468` |
| AST を実体化列へ束縛 | `execute.ts:4838` |
| CTE・一時表・サブクエリ・UNION の再帰 preflight | `execute.ts:5127` |
| 同一 SELECT の HAVING alias | `execute.ts:3797`、`aggregateDependencyValidation.ts:255` |
| ORDER BY alias の実値評価 | `process.ts:1322` |
| canonical ORDER 意味型解決 | `canonicalOrderPlanner.ts:51`、`execute.ts:8362` |
| GROUP BY/JOIN/required-field の実体化列解決 | `execute.ts:4289`、`selectToKintone.ts:503` |
| UPDATE FROM のキー・SET・CHECK ソース列 | `execute.ts:9550` |
| EXPLAIN の同一束縛 | `execute.ts:12442` |

（行番号は codex 報告時点。Claude のレビュー修正後はずれている）

## 追加・変更したテスト

- `Amount` / `amount` の ASC・DESC 数値順：`9/10`、`99/100`、`9050000/20700000`
- SELECT alias と同名物理列がある場合の alias 優先
- 同一 SELECT の HAVING alias
- CTE の SELECT、WHERE、CASE、集計引数、GROUP BY、HAVING、window ORDER BY
- `顧客No` / `顧客no`
- JOIN ON、スカラーサブクエリ、UNION
- 一時テーブルと 0 行一時テーブル
- 従来の `unknown field code(s)` 文言
- 物理 APP の大文字小文字を区別する負例
- UPSERT SELECT `VALIDATE ONLY`
- UPDATE FROM のキー・SET ソース列
- EXPLAIN と実行の対称
- 文書掲載 SQL の実行テスト

`npm test` 最終結果（codex 実行）：

- 通常 Jest：299 suites passed、6,493 tests passed、0 failed
- サブプロセス Jest：2 suites passed、26 tests passed、0 failed
- 合計：301 suites passed、6,519 tests passed、0 failed
- Snapshots：23 passed
- `docs:check`：成功（リンク 3,923 件／台帳 16 行）

初回全体テストでは B65 の直接 `.groupBy` 参照ガードが1件失敗しました。`normalizeGroupingSpec()` 経由へ修正後、全件通過しています。

## 文書の差分

追記本文：

> 別名の英字は結果列名で小文字に正規化されます。次の段や `ORDER BY` から参照するときは元の表記でも小文字でも解決されます（v3.7x〜）。物理フィールドコードは kintone の定義どおり区別します。物理フィールドと同名の別名を付けると列名が小文字化されるので、元の表記を出力名に残したいなら別名を付けないでください。詳しい優先順位は GROUP BY の名前の解決順を参照してください。

```sql
WITH t AS (SELECT 売上 AS Amount FROM APP100)
SELECT Amount FROM t ORDER BY Amount;
-- 参照は Amount / amount のどちらでもよく、結果列名は amount
```

§8 への相互参照：

> 実体化列・SELECT 別名に英字がある場合の大文字・小文字の扱いは基本ルール「大文字・小文字」を参照してください。完全一致を先に試し、その後で小文字へ正規化された列名を解決します。物理 APP のフィールドコードにはこの正規化を適用しません。

## §4 の確認事項

1. helper を通した場所／通していない場所
   通した場所は同一 SELECT の ORDER BY・HAVING、CTE・一時表、SHOW/DESCRIBE を含む実体化列、UNION 左枝由来列、GROUP BY、JOIN、required-field、サブクエリ、INSERT/UPSERT SELECT、UPDATE FROM、EXPLAIN、意味型・columnMeta 解決です。UNION とサブクエリは再帰 preflight、UPDATE FROM は専用ソース束縛を通します。
   `IMPORT … SELECT` という CTE/物理表 SELECT ソース構文は現行 dialect に存在しません。IMPORT の SELECT projection は CSV/JSON 行に対する FROM なし式なので対象外です。物理 APP、DML 対象列、物理 JOIN 列、`resolveFieldRef()` は通していません。

2. 物理フィールドへ緩和が及ばない根拠
   `B181: 不存在列の文言は維持し、物理 APP フィールドは大文字小文字を区別する` が `顧客No` と `顧客no` の非同一性を検証しています。物理 schema の `Set.has()` は維持しています。

3. EXPLAIN と実行の対称
   実行 preflight と EXPLAIN relation preflight の双方が `bindProjectedNamesForSelect()` を使用します。同一 SQL の EXPLAIN 成功テストも追加しました。

4. B183 文言に関係する挙動
   「別名に英字を使わない」は弱められます。元表記と小文字表記の両方で参照可能です。ただし公開結果の列名は従来どおり小文字です。元表記を出力名に残す場合は別名を付けない、という注意は引き続き必要です。B183 自体は変更していません。

5. `/flow`・MCP・CLI・プラグインの結果形
   変更対象は参照名の内部束縛と意味型 lookup だけです。`SelectResult`、`columns` 生成、行 projection、`warnings` の生成・統合処理は変更していません。テストでも `columns: ["amount"]` と行キー `amount` を固定し、全体テストの MCP・CLI・flow・plugin 共通コードを含む6,519件が通過しています。

## Claude が実機で確認すべき残項目

- SFA パックで起票文書 #1・#3・#7 と `顧客No` / `顧客no` の比較
- MCP v3.77.0 と修正版の `columns`・行キー・`warnings` 比較
- plugin、CLI、MCP、`/flow` で同じ SQL の結果形が不変であること
- 実 kintone の物理フィールド `顧客No` / `顧客no` 負例
- 0件 CTE・一時表、UPSERT VALIDATE ONLY、UPDATE FROM の実アプリ確認

## 上限内に終わらなかった項目

なし。指示に従い、git 操作、ビルド、MCP tool call、version・CHANGELOG・README・release・台帳・起票文書・`prod/js/desktop.js` の変更は行っていません。実機確認のみ Claude 側の残作業です。

---

## Claude レビュー（2026-09-16）

### 1. codex 版への修正 4 点

codex の実装は依頼どおり helper を通していたが、**実行時の実体化列解決（`resolveMaterializedColumn` / `b86FieldExists`）まで小文字照合に広げていた**ため、物理アプリと CTE を混在させた JOIN で退行と「静かに通る」経路ができていた。混在文の受入は依頼 §2 に無く（Claude のレビュー観点＝機能どうしの相互作用）、レビューで足した。

| # | 症状（codex 版） | 修正 |
|:-:|---|---|
| 1 | 物理 `Amount`（APP300）と CTE 列 `amount`（`売上 AS Amount`）が並ぶ JOIN で、未修飾の `Amount` が両方に一致して曖昧になる。`SELECT Amount AS pa … ORDER BY pa` が `ORDER_KEY_UNRESOLVED`、`ORDER BY Amount` が `ORDER_KEY_AMBIGUOUS`。**B181 以前は通っていた**（物理の完全一致が勝つ） | 実行時の解決（`resolveMaterializedColumn`・`b86FieldExists`・意味型の多表照合）は**完全一致へ戻す**。表記ゆれの吸収は実行前の束縛 3 か所（`bindProjectedNamesForSelect`・`bindSelectAliasesInHaving`・`UPDATE … FROM` の source 束縛）だけに限定。束縛の未修飾名の規則は「実体化列に完全一致があれば書き換えない → 小文字正規名が実体化列に一意にあるとき、物理側が同名を持ち得なければ正規名へ書き換える」。物理側の有無は form 定義で確かめる（`buildPhysicalFieldProbe`。定義が取れない・サブテーブル source は「持ち得る」に倒す） |
| 2 | Claude が最初に入れた保護（混在文では小文字フォールバックを使わない）では、物理側に同名が無いケース（`SELECT Amount AS pa FROM t INNER JOIN APP100 …`）が `b86FieldExists` の小文字照合で preflight を通過し、**実行時に空文字で評価される**（`pa` が `''`・`WHERE Amount > 9` が 0 行）。§15「存在しない列は空文字として評価せず拒否する」の契約違反 | #1 の「完全一致へ戻す」で fail-closed に戻り、かつ probe で物理側に同名が無いと分かれば CTE 列へ束縛して正しく通る |
| 3 | probe の form 定義取得を無条件にすると、EXPLAIN のフォーム定義取得回数の契約を固定した 6 スイート（B123・B163・B176・B107・B67 表面一致・MCP tools）が失敗 | 遅延化。1 回目は「物理側が持ち得る」と答える probe で束縛し、probe が参照されなかった（＝小文字正規名の候補が無い。物理だけ・CTE だけの文はすべてここ）ならそれで確定。参照されたときだけ定義を取得して束縛し直す（束縛は冪等） |
| 4 | `COUNT(*) AS Amount … HAVING SUM(Amount)` の `Amount` が別名 `amount` へ束縛され、集計の引数（物理フィールド）が別名にすり替わる | `bindSelectAliasesInHaving` は `AGG_REF` / `AGG_ARITH` の内側を束縛しない |

追加テスト（`b181AliasReference.test.ts`・計 18 本）: 混在 JOIN で物理完全一致が勝つ（`ORDER BY pa` と `ORDER BY Amount DESC`）／物理側に同名が無ければ CTE 列へ束縛（SELECT と WHERE）／HAVING の集計引数は物理／EXPLAIN の混在束縛／実体化列だけ・物理だけの文で束縛のための `getFields` 追加取得が無いこと。

### 2. 結果

- `npm test`（Claude 実行・修正後の最終）: 299 suites / 6,497 tests passed、サブプロセス 2 suites / 26 passed、snapshots 23、`docs:check` 通過（リンク 3,927 件）
- 実機（dev profile・SFA パック・`npm run build:cli` で再ビルドした CLI）:
  - 起票表 #1（CTE `Amount`）・#3（一時テーブル）・#4（同文 `ORDER BY Amount`）・#7（`c.顧客No AS 顧客No` を `顧客No` で参照）: すべて成功。列名は `amount` / `顧客no`（#2・#5・#9 と同じ）
  - #8（別名なし `c.顧客No`）: 列名 `顧客No` のまま。物理 `顧客no` は従来どおり `unknown field code(s): 顧客no (APP4148)`
  - 混在 JOIN（顧客管理 × 集計 CTE）: 物理側に無い `Amount` / `CustNo` は CTE 列へ束縛（SELECT・WHERE・ORDER BY）。物理と同名の `顧客No` は物理側が勝つ（結果列名 `顧客No`・値は顧客管理の値）。EXPLAIN も同じ束縛で成功

### 3. 範囲外として確認した既存挙動（B181 以前から同じ・別課題候補）

- **HAVING に SELECT に無い集計を書くと空結果**（`SELECT grp, COUNT(*) AS n … HAVING SUM(Amount) > 950` が 0 行）。言語リファレンス「SELECT にない集計を HAVING 専用で追加計算はしません」の契約どおり。→ B187 として起票。**同日訂正**: エンジンは `warnings` に「比較条件で参照した集計値を確認できません…」を出しており、「静かに」は CLI テキスト表示の穴（B189）だった
- **混在 JOIN の WHERE に未修飾の CTE 列を書くと EXPLAIN が `WHERE_FIELD_UNRESOLVED`**（小文字で書いても同じ・v3.77.0 の MCP でも同じ）。実行は通るので EXPLAIN と実行の非対称。修飾（`s.Amount`）すれば EXPLAIN も通る
