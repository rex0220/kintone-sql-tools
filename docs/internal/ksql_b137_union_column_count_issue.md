# B137 列数の違う `UNION` が静かに空文字で埋め、余りを捨てる

- 起票: 2026-08-06
- ステータス: ✅ **v3.50.0 でリリース**（2026-08-06）→ [仕様 R2](ksql_b137_union_column_count_spec.md)
- 発見: [B130](ksql_b130_describe_flags_spec.md) の実装時。**受入条件の書き方を誤ったことで露出した**

---

## 1. 事実

`UNION` / `UNION ALL` は**右辺を左辺の列名へ位置対応でリマップする**。

```ts
// src/execute.ts（executeUnion と executeQueryWithCte の 2 か所に同じ形がある）
const leftCols  = leftResult.columns;
const rightCols = rightResult.columns;
const remapped  = rightResult.rows.map((row) => {
  const mapped: ProcessRow = {};
  leftCols.forEach((col, i) => { mapped[col] = row[rightCols[i] ?? col] ?? ""; });
  return mapped;
});
```

**列数が違っても止まらない。**

| 状況 | 起きること |
|---|---|
| 右辺の列が**少ない** | 足りない左辺の列が**空文字で埋まる** |
| 右辺の列が**多い** | 余った右辺の列が**黙って捨てられる** |

**どちらもエラーも警告も出ない。** 標準 SQL は列数一致を要求する。

### 実測（v3.48.0 相当・B130 の実装ブランチで確認）

7 列の `DESCRIBE` と 3 列の `SELECT` を `UNION ALL` した結果:

```
{ フィールドコード: "code", ラベル: "label", タイプ: "type",
  ルックアップ: "", コピー元: "", 重複禁止: "", 計算式: "" }
```

**4 列が空文字で作られている。** 利用者から見ると「値が無い行」と区別が付かない。

---

## 2. なぜ重要か

**B119〜B122 / B126 / B127 / B134 と同じ「静かに間違う」系列。**

- 空文字は「無い」ではなく「**そもそも列が無かった**」
- 集計に載せると `SUM` は 0、`COUNT` は数える（空セルの扱いと同じ罠）
- **列を足す変更（本件の B130 のような）と組み合わさると、既存の `UNION` が黙って形を変える**

`INSERT ... SELECT` は**列数一致を要求している**（`execute.ts:7842-7847`）ので、
**同じエンジン内で扱いが割れている**のも据わりが悪い。

---

## 3. 経緯（なぜ B130 で入れなかったか）

B130 の受入条件に **「UNION の列数不一致が意図どおり検出される」**と書いた。
これは**「既存挙動が変わらないことを確認する」の意味で書いたが、
文面上は「検出せよ」という要求**になっていた。

**実装した codex はそのとおりに読み、エンジンへ列数検査を追加した**（報告に明記あり）。
レビューで気づき、**B130 から切り離して差し戻した**。理由は 3 つ。

1. **B130 は `DESCRIBE` に列を足す改善**で、`UNION` の意味論とは無関係
2. **既存クエリを壊す変更**（padding に依存していたものがエラーになる）を、
   仕様・レビュー・実需の測定なしに出すことになる
3. テストが 1 本しか無く、`UNION ALL` / CTE 経由 / 3 段以上の連鎖が未検証

**B130 側では「現状挙動を固定するテスト」に置き換えた**（`b130DescribeFlags.test.ts`）。

---

## 4. 対応案

| 案 | 内容 | 見立て |
|---|---|---|
| **A** | 列数不一致を**エラーにする** | 標準 SQL に合う。**既存クエリを壊す**ので破壊的変更の扱いが要る |
| **B** | **警告を出して現状動作を維持** | 壊さないが、警告は読まれないと効かない（B127 の議論と同じ） |
| **C** | 文書化のみ | 最も安いが「静かに間違う」は残る |

## 4.1 他の RDBMS はすべてエラー（2026-08-06 調査）

| 製品 | 挙動 |
|---|---|
| **MySQL** | **エラー 1222** `The used SELECT statements have a different number of columns` |
| PostgreSQL | エラー `each UNION query must have the same number of columns` |
| SQLite | エラー `SELECTs to the left and right of UNION do not have the same number of result columns` |
| SQL Server | エラー `All queries combined using a UNION, INTERSECT or EXCEPT operator must have an equal number of expressions in their target lists` |

標準 SQL が **union-compatible**（列数一致・対応する列の型に互換性）を要求しているため。
**kSQL の「足りない分を空文字で埋め、余りを捨てる」は独自挙動**であり、標準的な根拠が無い。

**列名を左辺から取る点は MySQL と同じ**なので、そこは変えない。

### kSQL と MySQL の決定的な違い＝検出できるタイミング

**MySQL は prepare 時に弾く**（スキーマが静的に分かるため）。
**kSQL は実行後にしか分からない。**

- `DESCRIBE` の列数は**バージョンで変わる**（v3.49.0 で 3 → 7 になったばかり）
- `SHOW APPS` も同様
- CTE 経由の `SELECT *` は実体化するまで列が確定しない

**したがって kSQL では「両辺を実行してからのエラー」になる**＝API を消費してから落ちる。
**MySQL のような安いエラーではない。** 受入条件にこれを明記すること
（「事前に弾ける」と誤解したまま仕様を書くと実装時にまたずれる）。

## 4.2 決定（2026-08-06）

**案 A（エラーにする）で確定。** 根拠は 3 つ。

1. **主要 4 実装がすべてエラー**にしており、padding に標準的な根拠が無い（§4.1）
2. **破壊的変更の懸念が外れた**＝オーナー判断「**まだユーザーがいないので問題ない**」
3. **内部にも依存が無い（測定済み）**＝B130 の実装時に codex が列数検査を入れた状態で
   `npm test` を回し、**225 suites / 5,426 tests が全通した**。
   **既存テストで padding に依存しているものは 1 件も無い**

**それでも独立した仕様と codex レビューを経ること**（B130 で受入条件の書き方を誤って
エンジンを変えてしまった直後なので、同じ轍を踏まない）。確認すべき点:

- `UNION` と `UNION ALL` で扱いを変えるか（変えない方が素直）
- **3 段以上の連鎖**（`A UNION B UNION C`）で左端の列数が基準になるか
- CTE 内 `UNION`（`executeQueryWithCte` の経路）でも同じ判定になるか
- **`SHOW APPS` / `DESCRIBE` を含む `UNION`**（列数が固定で変わり得る面）
- 既存の利用者が padding に依存していないか（**実需の測定**）
