# 課題: FULL_SCAN の数値比較が空セルを 0 として扱い、SIMPLE/kintone と乖離する

- 作成日: 2026-07-15
- ステータス: **実機確認済（v2.1.2）・修正方針を −∞ 準拠へ確定（案a は棄却）**
- 更新履歴:
  - 2026-07-15 R1: 起票
  - 2026-07-15 R2: codex レビュー反映（実機確認を4レコード×4演算子マトリクスへ拡張・EXPLAIN 事前確認／ASSERT の `Number("")` 重複＝共通化／サブテーブル UPDATE・DELETE・REORDER への波及と回帰／案a の正確な意味論＝空左辺は文字列フォールバックせず即 false・右辺空/文字列範囲の扱いを明示）
  - 2026-07-15 R3: **実機結果を反映（重要）**。kintone は空の数値セルを **−∞（あらゆる数より小さい）として扱う**（`>`/`>=` で除外・`<`/`<=` で含む）。**案a（空→常に偽）は棄却**（`<=`/`<` で SIMPLE と再乖離）。修正方針を「JS も kintone の −∞ 準拠に揃える」へ確定。押し下げ（③）は本修正後に全範囲演算子で超集合性 OK。
- 発見経緯: [ksql_like_predicate_pushdown_spec.md](ksql_like_predicate_pushdown_spec.md) R2 レビュー（[P1]）。述語分割で数値範囲を押し下げるための前提調査中に、`evalWhere` の空セル数値化が独立した挙動問題であると判明。
- 分担: Claude=起票/観点、Codex=検証/実装/テスト
- 位置づけ: v2.2.0 バンドルの構成要素②（①第0段 `5c987e0` 済 → ②本課題 → ③型メタ付き数値プレフィルタ）。本課題の決着が③（数値段）の前提。

## 事象（コード裏取り済み）

`evalWhere` の比較は、範囲演算子 `> < >= <=` を**数値化して比較**する（[src/engine/evalWhere.ts:118-133](../../src/engine/evalWhere.ts#L118)）:

```ts
const leftNum  = Number(leftStr);
const rightNum = Number(rightStr);
const numeric  = !Number.isNaN(leftNum) && !Number.isNaN(rightNum);
switch (op) {
  case ">":  return numeric ? leftNum > rightNum  : leftStr > rightStr;
  case "<":  return numeric ? leftNum < rightNum  : leftStr < rightStr;
  case ">=": return numeric ? leftNum >= rightNum : leftStr >= rightStr;
  case "<=": return numeric ? leftNum <= rightNum : leftStr <= rightStr;
}
```

**`Number("") === 0`（空文字は NaN ではなく 0）** のため、空セルの数値フィールドに対して JS 側で次が**真**になる:

```sql
数値フィールド >= 0     -- 0 >= 0 → true（空セルも一致）
数値フィールド <= 0     -- 0 <= 0 → true
数値フィールド > -1     -- 0 > -1 → true
```

kintone の SIMPLE モード（REST API クエリ）が空セルを数値範囲条件から除外するなら、**同じ SQL が実行モード（SIMPLE / FULL_SCAN）で異なる結果**を返す（過去に修正した WHERE/LIKE のモード乖離と同種）。

- 純粋な `WHERE 数値 >= 0` は SIMPLE（kintone へ押し下げ）なので、この乖離は **FULL_SCAN を誘発する要素（LIKE・関数・サブクエリ等）と AND したとき**に顕在化する。例: `WHERE 数値 >= 0 AND 備考 LIKE '%x%'` は全件 JS 評価となり、空セル行が混じる。

## 影響・波及先（[P1-3] コード裏取り済み）

`evalWhere` は SELECT の WHERE だけでなく、**書き込み・並べ替えの対象選定**にも直接使われる。範囲比較の空セル挙動が変わると**更新/削除対象が変わる**ため SELECT 以上に重要:

- **サブテーブル UPDATE の対象選定**（[execute.ts:2405](../../src/execute.ts#L2405) `expanded.filter((r) => evalWhere(stmt.where, r.flat))`）
- **サブテーブル DELETE の対象選定**（[execute.ts:2471](../../src/execute.ts#L2471)）
- **REORDER の対象選定**（[execute.ts:2678](../../src/execute.ts#L2678)）
- FULL_SCAN の WHERE / **JOIN 後の WHERE**（LEFT/RIGHT JOIN の欠損側も空文字になる）
- **HAVING**（[process.ts の applyHaving 経由](../../src/engine/process.ts#L364)）
- **CASE WHEN の条件**
- **モード依存の結果差**（FULL_SCAN で空セルが数値範囲に一致 / SIMPLE は kintone 依存）。件数・集計がモードでぶれる。
- **述語分割（数値段）のブロッカー**: kintone が空を範囲条件から除外するなら、数値範囲を押し下げると JS で真の行を取りこぼす＝超集合性が壊れる。

> `=` / `!=` は文字列比較（`leftStr === rightStr`）なので `数値 = 0` は空セルで偽。**範囲演算子 `> < >= <=` のみ**が対象。

## ASSERT / BETWEEN は別実装だが同じ問題を複製（[P1-2]）

ASSERT は `evalWhere` を通らないが、[`compareAssertValues`（execute.ts:872-884）](../../src/execute.ts#L872) が**同じ `Number("")` 判定を複製**している（コメントにも「型規則は evalWhere の evalOp と同一」）。`evalWhere` だけ直すと次のドリフトが残る:

- WHERE / HAVING / サブテーブル DML: 空値を除外
- ASSERT / BETWEEN: 空値を 0 として比較

→ **修正は比較処理を共通化して揃える**（推奨）。共通化しないなら ASSERT を対象外にする理由を明記する。

## 実機確認（[P1-1] 4レコード × 4演算子マトリクス）

**1組の `>= 0` だけでは全範囲演算子の超集合性を確定できない。** 空・`0`・`-1`・`1` の 4 レコードを用意し、各演算子で SIMPLE と FULL_SCAN を比較する（`ORDER BY $id` で突き合わせやすく）:

```sql
-- 事前に EXPLAIN で確認:
--   SIMPLE 版  = kintone query に金額条件がある
--   FULL_SCAN 版 = LIKE 起因の FULL_SCAN で、金額は押し下げられていない

-- 各演算子について SIMPLE / FULL_SCAN を比較（金額が空のレコードが含まれるか）
SELECT $id, 金額 FROM APP100 WHERE 金額 >= 0  ORDER BY $id;   -- SIMPLE
SELECT $id, 金額 FROM APP100 WHERE 金額 >= 0  AND $id LIKE '%' ORDER BY $id;  -- FULL_SCAN
-- 同様に:  金額 <= 0 / 金額 > -1 / 金額 < 1  を SIMPLE と (… AND $id LIKE '%') で
```

- `$id LIKE '%'` は FULL_SCAN を誘発するためだけの常真条件（`$id` は常に値ありで全件が通過）。
- **判定**: SIMPLE が空セル行を除外し FULL_SCAN が含む → 乖離確定（案 a 方向）。全演算子で一致 → 乖離なし。
- **注意**: 全ケース一致しても「**空セル問題をクローズできる**」だけ。**数値プレフィルタ全体の安全性（型判定・数値表現の書式差）は③で別途検証**が必要。
- 公式仕様（[フィールド形式](https://cybozu.dev/ja/kintone/docs/overview/field-types/) / [クエリ](https://cybozu.dev/ja/kintone/docs/overview/query/)）では空値が空文字で返ることと範囲演算子の存在は確認できるが、**空値が範囲条件に含まれるかは明記なし** → 実機確認が必要（こちらからは取得不可）。

## 実機結果（v2.1.2・確定）

数値フィールド `金額` に 空 / 0 / -1 / 1 の 4 レコードで確認:

| 演算子 | SIMPLE（kintone） | FULL_SCAN（JS 現状） |
|---|---|---|
| `金額 >= 0` | **空を除外** | 空を含む |
| `金額 <= 0` | **空を含む** | 空を含む |
| `金額 > -1` | **空を除外** | 空を含む |
| `金額 < 1` | **空を含む** | 空を含む |

**モデル**: kintone は空の数値セルを **−∞（あらゆる数より小さい値）** として扱う（4点すべてが「空 < 任意の数」で説明可能）。すなわち **`>` / `>=` で除外・`<` / `<=` で含む**。現状 JS は `Number("")===0` で常に 0 扱いのため、`>=`/`>` で乖離する。

> **追加確認（モデルの固定・推奨）**: 4点は「空 <= -1」でも矛盾しないため、極端な閾値で −∞ を確定する: `金額 <= -1000000`（−∞ なら**含む**）／`金額 >= -1000000`（−∞ なら**除外**）。`BETWEEN`（例 `金額 BETWEEN 0 AND 100` ＝ `>=0 AND <=100`）は下限 `>=` 側で空を除外する想定。

## 論点（要決定）

1. **kintone 実挙動**: 上記で確定＝**空は −∞**（`>`/`>=` 除外・`<`/`<=` 含む）。
2. **修正方針（案a は棄却）**: **JS も kintone の −∞ 準拠に揃える**。範囲比較で左辺が空のとき:
   ```ts
   // 範囲比較（> < >= <=）で leftStr === "" のとき（右辺が数値の文脈）
   //   ">"  → false   ">=" → false      （空は何より大きくない）
   //   "<"  → true    "<=" → true       （空は何より小さい）
   ```
   - **案a（`空 → 一律 false`）は不可**: `<=`/`<` で kintone は空を**含む**のに JS が除外 → SIMPLE/FULL_SCAN が再び乖離する。
   - **右辺が空の場合**: 対称に扱うか（右辺空 = −∞）は要判断。今回の実機は左辺フィールド空のみ確認。**推奨は左辺空のみを −∞ 扱い**、右辺は現状維持（`field > <リテラル>` が主ユースケース）。実装時に右辺空の挙動を明示。
   - **文字列フィールドの範囲比較**（`numeric` 文脈でない＝右辺が非数値）は**不変**（`leftStr`/`rightStr` の文字列比較のまま）。−∞ 扱いは**数値比較文脈（右辺が数値）に限定**する。
3. **ASSERT の共通化（[P1-2]）**: `compareAssertValues` も同じ −∞ 規則に揃える（共通化）。`BETWEEN` は下限 `>=`・上限 `<=` に分解されるため、`>=` 側で空が除外される。
4. **波及の回帰**: サブテーブル UPDATE/DELETE・REORDER の**確認ダイアログ件数と実際の対象**を固定するテスト。

## 推奨方針（−∞ 準拠・確定）

- **範囲比較で空左辺を −∞ として扱う**（`>`/`>=`→false、`<`/`<=`→true）。文字列フォールバックはさせない。**数値比較文脈（右辺が数値）に限定**。
- **`evalWhere` と `compareAssertValues` を共通化**して同一規則にする。
- **サブテーブル DML・REORDER を回帰テストに含める**（対象件数・確認ダイアログ件数を固定）。
- **右辺空は左辺空のみ −∞（推奨）**・文字列範囲比較は不変。
- **非対象（今回変更しない・別問題）**: 算術関数内の `Number("")`、数値ソート、集計（`SUM`/`AVG` 等）。

## 受入テスト観点（修正時・修正前 fail → 修正後 pass）

- 空セルの数値フィールドで、**SIMPLE と FULL_SCAN の結果が一致**する:
  - `金額 >= 0` → 空を**除外**、`金額 > -1` → 空を**除外**
  - `金額 <= 0` → 空を**含む**、`金額 < 1` → 空を**含む**
- `=` / `!=` は不変（`数値 = 0` は空セルで偽のまま）。
- 文字列フィールドの範囲比較（`field > ''` 等・非数値文脈）が**不変**。
- HAVING / CASE WHEN の範囲比較でも同じ −∞ 挙動（`>=` で空除外・`<=` で空含む）。
- **サブテーブル UPDATE/DELETE・REORDER**: 空数値セルを含む範囲条件で対象件数・確認ダイアログ件数が修正前後で正しく変わる（`>=`/`>` は対象から外れ、`<=`/`<` は含む）。
- ASSERT / `BETWEEN` の範囲比較が `evalWhere` と一致（共通化後）。`金額 BETWEEN 0 AND 100` は空を**除外**（下限 `>=0`）。

## 位置づけ

- **述語分割 第0段（`$id` のみ）のブロッカーではない**（`5c987e0` は独立に安全）。
- 本課題は**数値段（③）の前提**であり、かつ**押し下げと独立に「FULL_SCAN の数値範囲が空セルを拾う」挙動の是非**でもある。

## 次

実機確認済。修正方針は **−∞ 準拠**で確定（案a 棄却）。次は **codex に本 R3 をレビュー → 仕様案（−∞ 実装・`evalWhere`/`compareAssertValues` 共通化・波及回帰）→ 実装（分担どおり）**。可能なら極端閾値（`<= -1000000` / `>= -1000000`）で −∞ モデルを最終確認してから実装に入る。本修正の完了後、③（型メタ付き数値プレフィルタ）は全範囲演算子で超集合性 OK となる。
