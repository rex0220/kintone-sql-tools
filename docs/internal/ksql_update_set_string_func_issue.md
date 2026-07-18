# 課題: `UPDATE SET` が文字列関数を直接受け付けない（B21）

- 作成日: 2026-07-17
- 位置づけ: B20（正規表現関数）の仕様検討中に発見。**B20 とは独立した既存の欠陥**で、`UPPER` / `REPLACE` / `CONCAT` および B19（v2.17.0）で追加した `LPAD` / `LEFT` / `RIGHT` など**既存の全文字列関数に効く**ため、B20 を待たずに単独で価値が出る。
- ステータス: **課題 R4 実装済み・実機確認済み（2026-07-18・[実機記録](evidence/b21_update_set_string_func_smoke.md)）・v3.2.0 リリース待ち。**
- 横断契約: 文字列関数の単位・戻り型・空文字は [文字列の扱い](ksql_string_semantics.md) を正とする。本書は assignment の構文・行評価・DML 検証経路だけを扱う。
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

当初は parser の accept list 漏れに見えたが、**この仮説はコード追跡で否定された**。`:539` は row を持つ CASE 専用経路であり、単純 UPDATE の `buildUpdateRecord` は row を持たない（§2）。

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

**parser の accept list に無いことは事実だが、「parser だけ直せば動く」は誤り**（R1 初稿の誤り・codex レビューで判明・§3.1 で訂正）:

| 事実 | 意味 |
|---|---|
| `dmlToKintone.ts:539` が `if (result.type === "STRING_FUNC") return evalStringFunc(result, row);` | **CASE の結果としてなら STRING_FUNC を評価できる。ただしこれは `row` を渡す別経路** |
| **`buildUpdateRecord`（`dmlToKintone.ts:172`）は `(assignments, fieldTypes)` しか受け取らず、`row` を持たない** | **単純 UPDATE の経路では STRING_FUNC を評価できない。** 変換 switch（`:585`）にも `STRING_FUNC` のケースが無い |
| 「算術 SET（現在値を取得して計算）」の経路がある | **算術専用の別経路**（`updateToPutBatchesArith`）であり、単純 SET はここを通らない |

> **したがって「評価機構は完成済み・parser 側が主」は誤り。** 行取得を伴う assignment として扱う経路の追加が要る（§3.1）。

---

## 3. 対策案

### 3.1 設計は codex に委ねる（R2 で変更）

**R1 初稿は「accept list へ 1 行足せばよい」としていたが誤りだった**（§2）。単純 UPDATE の経路は行を持たないため、**評価経路の設計が本体**である。

**Claude 側が示す制約:**

- **`SqlValue` 全体ではなく `AssignmentValue` に限定する**（codex 提案）。`INSERT VALUES` / `UPSERT` / サブテーブル DML / `ASSERT` への波及を抑える。**B13 の「消費 3 系統を洗う」・B16 の「HAVING は別経路」と同型のリスクを最小化する**
- **`CASE WHEN … THEN UPPER(x) ELSE x END` は引き続き動くこと**（非回帰・実書き込みで確認済み）
- **`VALIDATE ONLY`（B12-A）/ `ON ERROR SKIP`（B12-B）が評価済みの値を検証すること**
- **算術式内の `STRING_FUNC` は従来どおり `DmlConvertError` で拒否**（§3.2・差分最小）
- `UPDATE … FROM`（B11）の `SET x = t.field`（`SOURCE_FIELD` 分岐）を壊さないこと。**`SET x = UPPER(t.field)` を許すかは codex の判断**（v1 で許さない方が安全に見えるが、ソース行の解決順序を知っているのは実装側）
- 評価結果の意味型は各関数の契約から引き継ぐ。`UPPER` / `REPLACE` / `TRANSLATE` 等は typed string、`LENGTH_CHAR` 等は typed number とし、値の見た目で再判定しない（横断仕様 原則3）。assignment 先への変換・検証はその後に行う

**codex に設計してほしいこと**（レビュー指摘より）:

- `STRING_FUNC` を**行取得が必要な assignment** として判定する仕組み
- **参照フィールドを GET 対象へ収集**する経路
- レコードごとの評価経路で `evalStringFunc` を呼ぶ形
- `UPDATE … FROM` で target/source のどちらを参照できるか

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

- [x] `UPDATE APP SET t = UPPER(t) WHERE …` が書き込める。値が**文字列として**正しい（数値化されない）
- [x] B19 の関数も効く: `SET code = LPAD(code, 5, '0')` が `'7'` → `'00007'`（**先頭ゼロが保持される**＝数値化されていないことの決定的証拠）
- [x] `CONCAT` / `REPLACE` / `SUBSTRING` / `LEFT` / `RIGHT` が `SET` で動く
- [x] **`CASE WHEN … THEN UPPER(x) ELSE x END` が引き続き動く**（非回帰・§1.2）
- [x] **`VALIDATE ONLY`（B12-A）が新経路の値を検証する**（長さ超過が `ERR_LENGTH_MAX` で捕捉される）
- [x] **`ON ERROR SKIP`（B12-B）が新経路で効く**
- [x] `SET x = LENGTH(y) * 1`（算術式内）は**従来どおり `DmlConvertError`**（§3.2・非回帰）
- [x] `SET x = other_field`（`FIELD_REF` 単独）は**従来どおり `ParseError`**（非回帰）
- [x] `UPDATE … FROM` の `SET x = t.field` が**従来どおり動く**（`SOURCE_FIELD` 分岐の非回帰）
- [x] **`SqlValue` の他の消費側が壊れない**: `INSERT VALUES` / `UPSERT` / サブテーブル DML / `ASSERT`（§3.1 の申し送り）
- [x] エラーメッセージが実態と一致する（§3.3）
