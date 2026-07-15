# 課題: FULL_SCAN の数値比較が空セルを 0 として扱い、SIMPLE/kintone と乖離する

- 作成日: 2026-07-15
- ステータス: **未着手（起票のみ）**
- 発見経緯: [ksql_like_predicate_pushdown_spec.md](ksql_like_predicate_pushdown_spec.md) R2 レビュー（[P1]）。述語分割で数値範囲を押し下げるための前提調査中に、`evalWhere` の空セル数値化が独立した挙動問題であると判明。
- 分担: Claude=起票/観点、Codex=検証/実装/テスト

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

## 影響

- **モード依存の結果差**（FULL_SCAN で空セルが数値範囲に一致）。件数・集計がモードでぶれる。
- **述語分割（LIKE プレフィルタ）の数値段のブロッカー**: この意味論のままだと、数値範囲を kintone に押し下げると（kintone が空を除外する場合）JS で真の行を取りこぼす＝超集合性が壊れる。押し下げ前に決着が必要。
- `=` / `!=` は文字列比較（`leftStr === rightStr`）なので `数値 = 0` は空セルで偽。**範囲演算子 `> < >= <=` のみ**が対象。

## 論点（要検証・要決定）

1. **kintone の実挙動**: SIMPLE モードで `数値フィールド >= 0` が空セルレコードを含むか除外するか（実機確認）。SQL 標準では NULL 比較は UNKNOWN=偽（除外）。
2. **あるべき JS 意味論**: 空セルの数値フィールドを範囲比較で「値なし → 偽（除外）」にするのが妥当か（SIMPLE/kintone・SQL 標準に合わせる）。
3. **修正方針の候補**:
   - 案 a: `evalWhere` で**空文字を数値化しない**（`leftStr === ""` なら範囲比較は偽）。SIMPLE と一致する方向。
   - 案 b: 空セルの扱いを型情報で分岐（数値フィールドの空のみ除外）。型メタが要る。
   - いずれも **FULL_SCAN の結果集合が変わる**ため、回帰テスト（既存の FULL_SCAN 数値比較）を伴う独立した仕様判断が必要。
4. **波及範囲**: 範囲比較を使う箇所（WHERE / HAVING / ASSERT のスカラー比較、JOIN 後の JS 評価など）。`Number("")` 依存が他にないか要確認。

## 位置づけ

- **述語分割（LIKE プレフィルタ）第0段（`$id` のみ）のブロッカーではない**。第0段は `$id`（空なし）だけを押し下げるため、本課題の決着を待たずに進められる。
- 本課題は**数値段の前提**であり、かつ**押し下げと独立に「FULL_SCAN の数値範囲が空セルを拾う」挙動の是非**でもある。

## 次

codex に課題レビュー → 実機で kintone の空セル挙動を確認 → 仕様案（案 a/b）→ 実装（分担どおり）。
