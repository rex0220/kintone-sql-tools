# 課題: `UPDATE SET` が文字列関数を直接受け付けない（B21）

- 作成日: 2026-07-17
- 位置づけ: B20（正規表現関数）の仕様検討中に発見。**B20 とは独立した既存の欠陥**で、`UPPER` / `REPLACE` / `CONCAT` および B19（v2.17.0）で追加した `LPAD` / `LEFT` / `RIGHT` など**既存の全文字列関数に効く**ため、B20 を待たずに単独で価値が出る。
- ステータス: **課題 R1（codex レビュー前）。未実装。**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md)

---

## 0. 要約

**同じ式が `CASE WHEN` の中では書けるのに、直接書くと `ParseError` になる。**

```sql
-- ✗ ParseError: SET の値にはリテラル・算術式を指定してください（フィールド参照のみは不可）
UPDATE APP100 SET 建物名 = UPPER(建物名) WHERE 顧客No IN (1)

-- ✓ 実機で書き込み成功（同じことをしている）
UPDATE APP100 SET 建物名 = CASE WHEN 顧客No IN (1) THEN UPPER(建物名) ELSE 建物名 END
WHERE 顧客No IN (1)
```

**評価機構は既に完成しており**（`dmlToKintone.ts:539` が `evalStringFunc` を呼ぶ）、**parser の accept list から `STRING_FUNC` が漏れているだけ**に見える。

**効果は「機能」ではなく「一貫性」**。回避策（`CASE WHEN` で包む）が存在するため利用者が詰むことはないが、**`CASE WHEN 1=1 THEN … ELSE … END` という無意味な呪文**を書かせている。

---

## 1. 現象（実機実測）

### 1.1 直接書くと `ParseError`

```
UPDATE APP4148 SET 建物名 = UPPER(建物名) WHERE 顧客No IN (1) VALIDATE ONLY
→ ParseError: SET の値にはリテラル・算術式を指定してください（フィールド参照のみは不可）
             （位置 25、トークン: 「UPPER」）
```

**エラーメッセージが誤解を招く。** 「フィールド参照のみは不可」と言っているが、実際に落ちたのは `UPPER(建物名)` という**関数呼び出し**であって、フィールド参照ではない。

### 1.2 `CASE WHEN` で包むと通る（実書き込みで確認）

```
UPDATE APP4148 SET 建物名 = CASE WHEN 顧客No IN (1) THEN CONCAT(建物名, '★') ELSE 建物名 END
WHERE 顧客No IN (1)
→ ok: updatedCount = 1

確認: 建物名 'サイボウズ商事ビル'(9文字) → 'サイボウズ商事ビル★'(10文字)
（検証後、リテラル UPDATE で元の値へ復元済み）
```

**文字列として正しく書き込まれる。** 数値化などは起きない。

### 1.3 算術式に混ぜると実行時 `DmlConvertError`（fail-closed）

```
UPDATE APP4148 SET 建物名 = LENGTH(建物名) * 1 WHERE 顧客No IN (1) VALIDATE ONLY
→ DmlConvertError: UPDATE SET の算術式では文字列関数はサポートされていません
```

**B20 仕様 R2 の初稿は、ここを「`* 1` を付けると通ってしまい静かに数値化される罠」と記載していたが誤りだった。** EXPLAIN だけを見て実行していなかったのが原因。**実際は fail-closed で拒否される**（§4 で B20 側を訂正）。

---

## 2. 原因（コードで裏取り）

`src/parser/parser.ts:2418-2432`:

```ts
// 数値・識別子・括弧 → 算術式として解析
const node = this.parseArithAddSub();
if (node.type === "NUMBER") return node;   // 数値単独 → SqlValue
if (node.type === "ARITH")  return node;   // 算術式
if (node.type === "FIELD_REF") {
  const dot = node.field.indexOf(".");
  if (dot > 0 && dot < node.field.length - 1) {
    return { type: "SOURCE_FIELD", alias: ..., field: ... };   // UPDATE ... FROM
  }
}
// FIELD_REF 単独（SET f = other_field）は未サポート
throw new ParseError("SET の値にはリテラル・算術式を指定してください（フィールド参照のみは不可）", tok);
```

**`parseArithAddSub()` は `STRING_FUNC` ノードも返す**（`UPPER(建物名)` は正しく解析される）。しかし accept list が `NUMBER` / `ARITH` / `FIELD_REF`(ドット付き) の 3 つしかないため、**`STRING_FUNC` は末尾のエラーへ落ちる**。

**設計上の制約ではなく列挙漏れ。** 根拠:

| 事実 | 意味 |
|---|---|
| `dmlToKintone.ts:539` が `if (result.type === "STRING_FUNC") return evalStringFunc(result, row);` | **DML の書き込み経路は STRING_FUNC を評価できる**（CASE WHEN の結果として通っている経路がこれ） |
| 「算術 SET（現在値を取得して計算）」の経路が既にある | **現在値を GET してから計算する機構が既にある**（`SET x = x + 1` が動く）。`UPPER(x)` も同じ機構で足りる |
| `CASE WHEN … THEN UPPER(x) ELSE x END` が実機で書き込める（§1.2） | **やりたいことは既に全部できている**。入口だけが塞がっている |

---

## 3. 対策案

### 3.1 案 A（推奨）: accept list へ `STRING_FUNC` を追加する

```ts
if (node.type === "ARITH")       return node;
if (node.type === "STRING_FUNC") return node;   // ← 追加
```

`SqlValue` 型が `StringFuncExpr` を含むかの確認が要る（含まなければ型追加）。書き込み経路（`dmlToKintone.ts:539`）は既に対応済みのため、**変更は parser 側が主**と見込む。

**要確認（codex への申し送り）**:

- `SqlValue` に `STRING_FUNC` を足したとき、**他の `SqlValue` 消費側が全て対応しているか**。`INSERT VALUES` / `UPSERT` / サブテーブル DML / `ASSERT` など、同じ型を使う経路を洗う。**B13 の教訓「消費 3 系統を洗う」・B16 の教訓「HAVING は別経路でパースされる」と同型のリスク。**
- **`VALIDATE ONLY`（B12-A）が新経路の値を検証できるか。** §1.2 の CASE 版は `VALIDATE ONLY` を通ったので、同じ値解決を通るなら問題ないはずだが要確認。
- **`UPDATE … FROM`（B11）との衝突**。`SET x = t.field` は `SOURCE_FIELD` へ分岐する。`SET x = UPPER(t.field)` を許すか（**v1 では許さない**方が安全。ソース行の解決順序が絡む）。

### 3.2 §1.3 の算術式内 `STRING_FUNC` はどうするか

`resolveArithOperand`（`dmlToKintone.ts:407`）が `DmlConvertError` で拒否している。**本課題では変更しない。**

理由: `SET 数値 = LENGTH(建物名) * 2` は意味のある式だが、**現状 fail-closed で安全に落ちている**。案 A は「文字列関数の結果を文字列として書く」ことだけを解禁し、**算術式への混入は従来どおり拒否したまま**にするのが差分として最小。需要が出たら別課題。

### 3.3 エラーメッセージの修正（案 A に同梱）

「フィールド参照のみは不可」は、関数を書いて落ちた利用者に誤った手がかりを与える。案 A を入れると `STRING_FUNC` は通るようになるため、**残る非対応は「`FIELD_REF` 単独」だけ**になり、メッセージが実態と一致する。**案 A を入れない場合はメッセージだけでも直す価値がある。**

---

## 4. 本課題の価値と、価値でないもの

### 4.1 価値

1. **一貫性**。`CASE WHEN 1=1 THEN … ELSE … END` という**無意味な呪文**が要らなくなる（§1.2）
2. **既存の全文字列関数に効く**。`UPPER` / `LOWER` / `TRIM` / `REPLACE` / `SUBSTRING` / `CONCAT` / `COALESCE` / `ISNULL`、および **B19（v2.17.0）で追加した `LPAD` / `RPAD` / `LEFT` / `RIGHT` / `TRUNCATE` / `LAST_DAY` / `GREATEST` / `LEAST` / `INSTR`**。**新機能を待たずに、既にあるものが書けるようになる**
3. **エラーメッセージの誤りが解消する**（§3.3）

**特に 2 が効く。** B19 で `LPAD` を「桁揃え」の用途で追加したが、**その結果を書き戻せない**（`SET code = LPAD(code, 5, '0')` が `ParseError`）。関数を足しておいて `UPDATE` で使えないのは、B19 の価値を半分にしている。

### 4.2 価値ではないもの: 「1 文で正規化できるようになる」ではない

**本課題が入っても `UPDATE … SET f = 関数(f) WHERE 関数(f) …` の形は書けない。** 親 DML の `WHERE` は文字列関数を**一律拒否する**（実機実測）:

```
UPDATE APP4148 SET 建物名 = 'x' WHERE LEFT(郵便番号, 3) = '100'
→ KintoneQueryError: WHERE 句の関数（LEFT）は kintone クエリに変換できません
```

対象を絞り込めないため、**「不正な行だけを正規化する」には引き続き一時テーブルを経由する**:

```sql
CREATE TEMP TABLE #norm AS
  SELECT $id AS 対象id, REPLACE(REPLACE(電話番号, '-', ''), ' ', '') AS 正規化
  FROM APP100 WHERE ...;
UPDATE APP100 SET 電話番号 = n.正規化 FROM #norm AS n WHERE APP100.$id = n.対象id;
```

（この形は実機で `VALIDATE ONLY` 通過を確認済み。結合キーに `RECORD_NUMBER` は使えず `$id` 結合が要る。）

**`WHERE` 側の解禁は本課題の対象外**で、別の重い課題になる（`LIKE` を親 DML で拒否している判断＝FULL_SCAN ゆえ対象集合が `maxRecords` に依存し静かな部分更新が起きる、との整合を取る必要がある）。

**したがって本課題は「`SET` の右辺に関数を書けるようにする」だけに限定する。** 期待値を上げすぎないよう、リファレンスにも §4.2 の制限を明記する。

---

## 5. SemVer

**minor**。受理範囲の拡大のみで、既存の動作するクエリの挙動は変わらない（`CASE WHEN` 版も引き続き動く）。

---

## 6. 受入条件

- [ ] `UPDATE APP SET t = UPPER(t) WHERE …` が書き込める。値が**文字列として**正しい（数値化されない）
- [ ] B19 の関数も効く: `SET code = LPAD(code, 5, '0')` が `'7'` → `'00007'`（**先頭ゼロが保持される**＝数値化されていないことの決定的証拠）
- [ ] `CONCAT` / `REPLACE` / `SUBSTRING` / `LEFT` / `RIGHT` が `SET` で動く
- [ ] **`CASE WHEN … THEN UPPER(x) ELSE x END` が引き続き動く**（非回帰・§1.2）
- [ ] **`VALIDATE ONLY`（B12-A）が新経路の値を検証する**（長さ超過が `ERR_LENGTH_MAX` で捕捉される）
- [ ] **`ON ERROR SKIP`（B12-B）が新経路で効く**
- [ ] `SET x = LENGTH(y) * 1`（算術式内）は**従来どおり `DmlConvertError`**（§3.2・非回帰）
- [ ] `SET x = other_field`（`FIELD_REF` 単独）は**従来どおり `ParseError`**（非回帰）
- [ ] `UPDATE … FROM` の `SET x = t.field` が**従来どおり動く**（`SOURCE_FIELD` 分岐の非回帰）
- [ ] **`SqlValue` の他の消費側が壊れない**: `INSERT VALUES` / `UPSERT` / サブテーブル DML / `ASSERT`（§3.1 の申し送り）
- [ ] エラーメッセージが実態と一致する（§3.3）
