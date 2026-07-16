# 課題+仕様案: `MIN` / `MAX` の文字列対応（テキスト列で NaN になる問題）

- 作成日: 2026-07-16
- 発見経緯: B12-B `ON ERROR SKIP` の実機確認（APP4221・2026-07-16）。看板レシピ（[ksql_on_error_skip_isolation_spec.md](ksql_on_error_skip_isolation_spec.md) §6）の `SELECT 顧客コード, MIN($err_message) … GROUP BY 顧客コード` が **`NaN` を返し**、業務キー単位のエラーメッセージ集約（B11.1 書き戻しの前段）が機能しないことが判明。
- ステータス: **課題+仕様案 R1（codex レビュー前）。未実装。**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md)

---

## 1. 課題

`MIN` / `MAX` は**数値集約専用**で、テキスト列に対しては値を `Number()` で数値化するため、非数値文字列は `NaN` になる。

```sql
-- 実測（APP4221・#err の $err_message 集約）
SELECT k, MIN(msg) AS m, MAX(msg) AS mx FROM #t GROUP BY k;
-- → m="NaN", mx="NaN"（msg が 'ERR_TYPE_NUMBER' 等のテキスト）
```

SQL 標準では `MIN`/`MAX` は文字列にも適用でき（辞書順）、多くの RDB でテキスト列の最小/最大を返す。kSQL はこれを数値限定にしているため、以下が壊れる:

- **B12 書き戻しレシピ**（§6）: 1 ソース行に複数エラーがあると `#err` は複数行になり、業務キー単位に 1 行へ畳む必要がある。`MIN($err_message)` はその定石だが `NaN` 化する。現状の回避策は「`SELECT DISTINCT 業務キー, '検証エラー' AS flag`（定数フラグ）」で 1 行化するのみ＝**具体的なエラーメッセージを書き戻せない**。
- **日時列の最古/最新**: 言語リファレンスの一時テーブル例 `MAX(受注日) AS 最新受注日`（DATE 列）も同じく `NaN` 化する（`Number("2026-07-16")=NaN`）。すなわちこのバグは B12 固有ではなく、**日時・テキストの `MIN`/`MAX` 全般**に及ぶ（文書化済みレシピが1件壊れている）。
- テキスト列の代表値抽出全般（コード・名称の辞書順 min/max 等）。

## 2. 現状（コード裏取り済み）

`evalAggregate`（[process.ts:274](../../src/engine/process.ts#L274)）は**返り値型が `number`**で、収集した文字列値を一律 `Number()` する:

```ts
function evalAggregate(func, distinct, arg, rows): number {
  ...
  const nums = eff.map(Number);          // ← テキストは NaN
  switch (func) {
    case "SUM": return nums.reduce((a,b)=>a+b, 0);
    case "AVG": ...
    case "MAX": return nums.length === 0 ? 0 : maxOf(nums);  // 数値比較のみ
    case "MIN": return nums.length === 0 ? 0 : minOf(nums);
  }
}
```

- 収集段（[:287-300](../../src/engine/process.ts#L287)）は `FIELD_REF` を**文字列のまま**保持しているため、素材（文字列値）は既にある。数値化は最後の `eff.map(Number)` だけ。
- 呼び出し元は3箇所: `applyGroupBy`（[:241](../../src/engine/process.ts#L241)）・`evalArithExpr` の `AGG_REF`（[:333](../../src/engine/process.ts#L333)）・集計列 project（[:829](../../src/engine/process.ts#L829)）。いずれも結果を `String(...)` 化して出力/後段へ渡す。
- **`FieldTypeResolver`** は同ファイルの多数の関数（evalWhere/project/HAVING）へ既に配線済み（[:174/376/594/864](../../src/engine/process.ts#L174)）で、`evalAggregate` へ渡す土台はある。

## 3. 意味論の選択肢

| 案 | 比較規則 | 評価 |
|---|---|---|
| A: **型メタで分岐**（推奨） | NUMBER/CALC(number)/RECORD_NUMBER=数値比較（従来）／テキスト・日時・スカラー選択=辞書順文字列比較 | 正確。型不明・関数結果・算術式は従来の数値に据え置き（後方互換）。`FieldTypeResolver` 配線が要る |
| B: 値ベースヒューリスティック | 全値が有限数なら数値・そうでなければ辞書順 | 配線不要だが**型混在・数値文字列で不安定**（例: 郵便番号 `"0100"` を数値化・`"10"` vs `"9"` の順序が数値/辞書で逆転） |
| C: 常に辞書順へ統一 | すべて文字列辞書順 | 実装単純だが**既存の数値 MIN/MAX が挙動変更**（`"10" < "9"`）で回帰。不可 |

**推奨は案A**。数値フィールドは従来の数値比較を厳密に維持し（回帰ゼロ）、テキスト系だけ辞書順を足す。判定根拠を「値の見た目」でなく「フィールド型」に置くのは、選択系 IN（v2.5.0〜）と同じ設計方針。

## 4. 仕様（案A）

### 4.1 比較規則（`MIN`/`MAX` のみ。`SUM`/`AVG`/`COUNT` は不変）

`arg` が**直接フィールド参照**で、`FieldTypeResolver` が型を確定できたとき:

- **数値系**（`NUMBER` / `CALC`(format=NUMBER系) / `RECORD_NUMBER`）: 従来どおり `Number()` 化して数値 min/max。返り値は数値文字列。
- **日時系**（`DATE` / `TIME` / `DATETIME`）: ISO 文字列の辞書順＝時系列順のため、**辞書順文字列比較**でよい（min=最古・max=最新）。
- **テキスト系**（`SINGLE_LINE_TEXT` / `MULTI_LINE_TEXT` / `LINK` / `DROP_DOWN` / `RADIO_BUTTON` / `STATUS`）: **辞書順文字列比較**（JS の `<`／UTF-16 code unit 順）。返り値はその文字列。
- **型不明 / 非フィールド参照（算術式・文字列関数・スカラーサブクエリ）**: **従来どおり数値**（後方互換）。

### 4.2 空値・DISTINCT・NULL

- 空値スキップは現行維持（`FIELD_REF` の空文字は収集前に除外＝[:292](../../src/engine/process.ts#L292)）。全行が空なら現行同様「該当なし」。数値系の空グループは従来 `0`、テキスト系の空グループは **`""`（空文字）** を返す（数値の 0 に相当する中立値）。
- `DISTINCT` は文字列レベル重複除去（現行と同じ [:304](../../src/engine/process.ts#L304)）で、テキストでも自然に効く。

### 4.3 対象外（本仕様では非対応）

- **複数値/オブジェクト型**（`CHECK_BOX` / `MULTI_SELECT` / `USER_SELECT` / 組織 / グループ / 作業者 / 添付ファイル）: JSON 文字列の辞書順 min/max は意味を持たないため対象外＝**従来どおり数値（実質 NaN）**。将来必要なら別課題。
- `SUM` / `AVG`（数値専用のまま）・`COUNT`（不変）。
- **厳密10進**の数値 min/max（案B・保留 [[exact-decimal-compare]] と同じく本仕様は IEEE-754 の従来挙動を維持）。

## 5. 実装差分

| 箇所 | 変更 |
|---|---|
| `evalAggregate`（process.ts:274） | 返り値型を **`number \| string`** へ拡張。`arg` が `FIELD_REF` かつ型がテキスト/日時系なら**辞書順で文字列 min/max**（収集済み文字列値をそのまま比較・数値化しない）。数値系・型不明・非フィールドは従来の数値経路。引数に `resolveFieldType?: FieldTypeResolver` を追加 |
| 呼び出し元3箇所（241/333/829） | `resolveFieldType` を渡す。結果は既に `String(...)`/文字列化して扱うため、`string` 返却でも下流は透過（数値→文字列化と同じ出口） |
| `evalArithExpr` の `AGG_REF`（333） | 集計を**算術オペランド**に使う場合はテキスト min/max を数値へ戻せないため、**テキスト集約を算術に混ぜたら従来どおり `NaN`**（`SUM(a) + MIN(テキスト)` 等は元々無意味）。仕様に明記 |

- `FieldTypeResolver` は「直接フィールド参照のみ・JOIN 非修飾は一意時のみ・衝突/CTE/集計 alias/関数結果は型なし」の既存契約（typed IN と同じ [FieldTypeResolver]）を流用。**一時テーブル/CTE 経由は型メタを持たない**ため、テキスト集約は型不明扱い＝従来数値（＝ B12 の `#err` は temp のため、そのままでは効かない点に注意。§7 参照）。

## 6. 受入条件

- [ ] テキスト列 `MIN`/`MAX` が辞書順の最小/最大**文字列**を返す（`MIN('B','A','C')='A'`・`MAX='C'`）。
- [ ] **数値フィールドの `MIN`/`MAX` は従来どおり数値比較**（`"9"` と `"10"` で min=9/max=10・辞書順にならない）＝回帰ゼロ。
- [ ] 日時フィールドの `MIN`=最古・`MAX`=最新（ISO 辞書順）。
- [ ] 型不明（算術式・文字列関数・CTE/temp 経由）は従来どおり数値経路（後方互換）。
- [ ] 空グループ: 数値系=`0`／テキスト系=`""`。全行空のテキスト列も `""`。
- [ ] `DISTINCT` 併用でテキスト重複除去が効く。
- [ ] 複数値/USER 等は対象外（従来挙動）。
- [ ] `HAVING` / `ORDER BY` / 後段 SELECT / UNION 左辺列でテキスト集約の alias が参照できる（文字列として）。
- [ ] `SUM`/`AVG`/`COUNT` に回帰なし。

## 7. B12 書き戻しレシピとの関係

本仕様が入っても、**B12 の `#err` は一時テーブル**で `FieldTypeResolver` が型メタを持たないため、`MIN($err_message) FROM #err` は §5.1 の契約上「型不明＝従来数値＝NaN」のままになる可能性が高い。したがって:

- **短期（本仕様と独立・即対応）**: B12 レシピ（§6・roadmap）を**定数フラグ 1 行化**（`SELECT DISTINCT 業務キー, '検証エラー' AS flag FROM #err`）に修正し、`MIN($err_message)` を使わない。言語リファレンスに「`MIN`/`MAX` はテキスト非対応（本仕様まで）」を注記。
- **本仕様の適用範囲**: まずは**型メタを持つ実アプリ列**のテキスト min/max を対象にする。一時テーブル/CTE 列へ広げるには、実体化時に列型メタを保持する拡張（B2 の `MaterializedTable` に型情報を足す）が別途必要＝**フェーズ2**として分離。
- よって B12 の看板レシピを「メッセージ集約」で成立させるには、本仕様（実アプリ列）＋temp 列型メタ（フェーズ2）の両方が要る。当面は定数フラグ回避で十分。

## 8. リスク・SemVer

- **SemVer**: 挙動変更（テキスト列が従来 `NaN` → 文字列）。ただし**現状 `NaN` は実質使い物にならない**ため依存コードは想定されず、実害は小さい。数値フィールドは厳密に従来維持（回帰ゼロ）。→ minor。
- **リスク（返り値型拡張の波及）**: `evalAggregate` の `number → number|string` 化は集約を消費する全経路（project・HAVING・ORDER BY・算術）に波及。tsc で洗い出し、算術混在時は数値へ強制（NaN 許容）と明記。
- **リスク（数値テキストの意図せぬ辞書順化）**: 郵便番号・電話番号など「数値に見えるテキスト」は**テキスト型なので辞書順になる**。これは kintone の型に忠実で正しい（数値フィールドではないため数値順を期待すべきでない）。仕様に明記。

## 9. スコープ外・将来

- 一時テーブル/CTE 列のテキスト min/max（`MaterializedTable` への列型メタ付与＝フェーズ2）。
- 複数値/USER/組織/グループ/添付の集約。
- 厳密10進の数値 min/max（案B・保留）。
- 文字列集約 `GROUP_CONCAT` 相当（別課題）。
