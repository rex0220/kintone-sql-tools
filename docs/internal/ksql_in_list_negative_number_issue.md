# 課題: `IN` / `NOT IN` が負数リテラルを拒否する（`=` / `BETWEEN` とは非対称）

- 作成日: 2026-07-16
- 発見経緯: `NULLIF`/`ISNULL` の実機確認中（APP4221・2026-07-16）に `WHERE 金額 IN (0, 1000, -1)` が ParseError となり判明。
- ステータス: **v2.14.1 でリリース済み**（実装・コードレビュー承認・1,289 テスト green・実機確認 全11項目 pass）。
- 分担: Claude=課題/観点、Codex=実装/テスト
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md)

---

## 1. 事象

`IN` / `NOT IN` のリストに**負数リテラル**を書くと ParseError になる。`=` や `BETWEEN` では同じ負数が問題なく使えるため、**演算子間で非対称**。

```sql
-- ❌ ParseError: IN リストには文字列、数値、またはバッチ変数が必要です（トークン: 「-」）
SELECT 金額 FROM APP4221 WHERE 金額 IN (-1);
SELECT 金額 FROM APP4221 WHERE 金額 NOT IN (-1);
SELECT 金額 FROM APP4221 WHERE 金額 IN (0, 1000, -1);

-- ✅ 動作する（同じ -1）
SELECT 金額 FROM APP4221 WHERE 金額 = -1;                  -- → -1
SELECT 金額 FROM APP4221 WHERE 金額 BETWEEN -10 AND 10;    -- → 0, -1, 1
```

### 実機実測（APP4221・2026-07-16）

| クエリ | 結果 |
|---|---|
| `WHERE 金額 = -1` | ✅ `-1` を返す |
| `WHERE 金額 BETWEEN -10 AND 10` | ✅ `0` / `-1` / `1` を返す |
| `WHERE 金額 IN (-1)` | ❌ `ParseError`（位置 36・トークン `-`） |
| `WHERE 金額 NOT IN (-1)` | ❌ `ParseError`（位置 40・トークン `-`） |

## 2. 原因（コード裏取り済み）

`parseInValues`（[parser.ts:1721](../../src/parser/parser.ts#L1721)）は **1 トークンだけ `advance()` して** `STRING` / `NUMBER` / `VARIABLE` のみを受理する:

```ts
private parseInValues(): InList["values"] {
  const values: InList["values"] = [];
  do {
    const tok = this.advance();
    if (tok.kind === TokenKind.STRING) {
      values.push({ type: "STRING", value: tok.value });
    } else if (tok.kind === TokenKind.NUMBER) {
      values.push({ type: "NUMBER", value: Number(tok.value) });
    } else if (tok.kind === TokenKind.VARIABLE) {
      values.push({ type: "VARIABLE", name: tok.value.slice(1).toLowerCase() });
    } else {
      throw new ParseError("IN リストには文字列、数値、またはバッチ変数が必要です", tok);
    }
  } while (...);
}
```

`-1` は字句解析で **`MINUS` ＋ `NUMBER("1")` の 2 トークン**になるため、先頭の `-` が最後の `else` に落ちて ParseError となる。`=` / `BETWEEN` は単項マイナスを解釈する別経路（算術・スカラー式）を通るため動作する。

## 3. 影響

- 負数を含む `IN` / `NOT IN` が**一律に書けない**（例: `調整額 IN (-100, -200)` / `気温 IN (-5)` / `区分 IN (-1)`）。
- 回避策は `OR` 展開（`金額 = -1 OR 金額 = -2`）のみで、リストが長いと著しく冗長。`NOT IN` の回避は更に面倒（`AND` の連鎖＋否定）。
- `=` と `BETWEEN` では書けるため、利用者からは**一貫性のない制限**に見える（実際そうである）。
- 影響度: **中**。負数を業務で扱うアプリ（調整額・差額・温度・損益）に限られるが、その範囲では回避策が苦しい。

## 4. 修正方針

`parseInValues` で**単項マイナス（および単項プラス）を受理**する。`=` 側の既存処理と意味論を揃えるのが原則。

- `MINUS` トークンを見たら次トークンが `NUMBER` であることを確認し、`{ type: "NUMBER", value: -Number(tok.value) }` として push する。
- `PLUS` も同様に受理して符号なしと同値に正規化する（`IN (+1)` は `IN (1)`）。
- `MINUS` の次が `NUMBER` でなければ従来どおり ParseError（メッセージは現行を維持）。
- **文字列リテラルには適用しない**（`IN ('-1')` は従来どおり文字列 `-1`）。

### 押し下げ（pushdown）との整合

`IN` は選択系・数値の kintone 押し下げ対象になり得る（v2.5.0〜v2.6.0）。負数を受理した後:

- `convertInList` 経由で kintone クエリへ渡す値が `-1` になること（`"-1"` の引用符付き文字列にならないこと）を確認する。
- 数値押し下げの安全整数ゲート（`Number.isSafeInteger`・v2.2.0 案A）は負数でも成立する（`Number.isSafeInteger(-1) === true`）。
- 選択系（DROP_DOWN 等）の実在検証は文字列前提なので、負数は数値フィールドのみに現れる想定。型メタが選択系を返した場合は従来どおり非押下。

## 5. 受入条件

- [ ] `WHERE 数値 IN (-1)` / `NOT IN (-1)` がパースでき、`= -1` と同じ行集合を返す。
- [ ] `IN (0, 1000, -1)` のように**正負混在**が動作する。
- [ ] `IN (+1)` が `IN (1)` と同値。
- [ ] `IN ('-1')` は**文字列** `-1` のまま（数値化しない）。
- [ ] `IN (-)` / `IN (-'a')` など不正形は従来どおり ParseError（メッセージ不変）。
- [ ] バッチ変数との併用 `IN (@v, -1)` が動作する。
- [ ] 押し下げ: 数値フィールドの `IN (-1)` が kintone クエリへ `-1`（引用符なし）で渡り、SIMPLE と FULL_SCAN が同一結果。
- [ ] `= -1` / `BETWEEN -10 AND 10` に回帰なし。
- [ ] 既存の `IN` テスト（文字列・数値・変数・選択系押し下げ）に回帰なし。

## 6. SemVer・リスク

- **SemVer: patch**。従来 ParseError だった構文が通るようになるだけで、既存の動作するクエリの挙動は変わらない（**受理範囲の拡大のみ**）。
- リスク: 小。パーサの局所修正。押し下げ経路は既存の数値ゲートをそのまま通る。
- 注意: `IN ('-1')`（文字列）と `IN (-1)`（数値）の区別を壊さないこと。kintone の数値フィールドは文字列比較でなく数値として扱われるため、両者の押し下げ結果が食い違わないか受入で確認する。
