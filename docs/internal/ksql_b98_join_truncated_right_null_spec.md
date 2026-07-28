# 仕様: B98 — 外部結合の保持されない側が打ち切られたら止める（案 C'）

- 作成: 2026-07-29
- 対象課題: [B98](ksql_b98_join_truncated_right_null_issue.md)
- ステータス: 📋 **実装待ち**
- 分担: Claude=仕様/レビュー、codex=実装/テスト
- SemVer: **minor**（移行案内つきの正しさ修正。B78 / B79 / B86 / B90 / B97 と同じ扱い）

---

## 1. 目的

**外部結合の「保持されない側」が取得上限で打ち切られると、
一致するはずの行に `NULL` が入る**（[B98 §3](ksql_b98_join_truncated_right_null_issue.md) で実機再現済み）。

**行そのものは本物だが、`NULL` は「相手がいない」という積極的な主張**であり、
**本当に相手がいない行と区別できない。**

**保持されない側が打ち切られたときだけ止める。**
**保持される側が打ち切られただけなら従来どおり**（偽の `NULL` は起きず、行が減るだけ）。

---

## 2. **手を入れるのは 1 箇所だけ**（調査で確定）

打ち切りの検出は 3 箇所あるが、**外部結合が通るのは 1 つだけ**である。

| 箇所 | 外部結合が通るか |
|---|---|
| [`executeSimpleSelect()`](../../src/execute.ts#L3139) | ❌ **join があれば `FULL_SCAN` へ行く**（`resolveSelectMode()`） |
| **[`fetchTableRecordsForFullScan()`](../../src/execute.ts#L5008)** | ✅ **ここだけ** |
| [`tryFetchJoinRecordsBySourceKeys()`](../../src/execute.ts#L5252) | ❌ **`join.type !== "INNER"` で `null` を返す**（[execute.ts:5211](../../src/execute.ts#L5211)） |

**`fetchTableRecordsForFullScan()` の `onTruncate` だけを変える。**

### 2.1 判定材料はスコープに揃っている

同関数の引数に **`stmt`（SELECT 全体）/ `table`（いま取っているテーブル）/ `isMainTable`** がある。
**呼び出し元は `stmt.from` または `join.table` のオブジェクトをそのまま渡している**ので、
**オブジェクト同一性で「どの join のテーブルか」を特定できる。**

**alias で照合しないこと。**`alias` は `null` になり得る。

---

## 3. 規則 — **「保持されない側」の定義**

`RIGHT JOIN` は**正規化されていない**（AST に `"RIGHT"` が残り、`applyJoin()` に専用分岐がある）。
**左右で意味が逆になるので、型ごとに定義する。**

| `joins[i].type` | **保持されない側** |
|---|---|
| `LEFT` | **`joins[i].table`** |
| `RIGHT` | **左の累積**＝`stmt.from` ＋ `joins[0]`〜`joins[i-1]` の `table`（**main を含む**） |
| `INNER` | **なし**（一致しない組は行ごと消えるだけで、偽の `NULL` を作らない） |

### 3.1 **1 つのテーブルが両方の役割を持つ**

`runFullScan()` は `stmt.joins` を**先頭から順に畳む**（各回の結果が次回の左になる）。

```
FROM a LEFT JOIN b ... LEFT JOIN c ...
        ↑ b は自分の join では「保持されない側」
                        ↑ c との join では b は「保持側」に含まれる
```

**どれか 1 つの join で「保持されない側」なら、そのテーブルは対象とする。**

### 3.2 判定関数

**新しいファイルを作らず、`src/core/` に置くこと。**
`outerJoinSearchAbortGuard.ts` の隣に置くか、同ファイルへ足すかは任せる
（**`statementContainsOuterJoin()` と同じ考え方の関数**なので、近くにあるのが自然）。

```ts
// 名前は任せる
function isNonPreservedSide(stmt: SelectStatement, table: TableRef, isMainTable: boolean): boolean
```

**この SELECT の `joins` だけを見ること。**入れ子は見ない（§4）。

---

## 4. 入れ子は見ない（調査で安全を確認済み）

**サブクエリ・CTE・UNION の枝・一時テーブル source は、それぞれ自分の `SelectStatement` を
持って実行される**（[execute.ts:9062](../../src/execute.ts#L9062) /
[4663](../../src/execute.ts#L4663) / [4564](../../src/execute.ts#L4564)）。

**`onTruncate` のスコープにある `stmt` は、常にその取得を行っている SELECT 自身である。**
**外側の `joins` を見る経路は無い。**

→ **判定は「その SELECT の `joins` だけ」で正しい。**
**`statementContainsOuterJoin()` のような全体走査を使わないこと。**（使うと入れ子で誤爆する。）

---

## 5. 止め方

### 5.1 `onTruncate` から例外を投げる

`fetchAll()` は **`onTruncate(maxRecords)` を同期的に呼んでから**切り詰めた配列を返す
（[fetchAll.ts:122](../../src/api/fetchAll.ts#L122) / [147](../../src/api/fetchAll.ts#L147) /
[188](../../src/api/fetchAll.ts#L188)）。

**コールバックが投げれば、`return` の前に伝播する。**切り詰めた配列は返らない。

### 5.2 投げるのは `FetchAllLimitError`

**公開 `code` を変えないため**（engine ライブラリは `FETCH_LIMIT_EXCEEDED` へ写す）。

**B97 で足した `completeInputWrapped` を `true` にすること。**
`throwCompleteInputError()` が**二重ラップしない**ようにするため
（[execute.ts:2958](../../src/execute.ts#L2958)）。

### 5.3 文面

**B97 と同じ 3 段**にする。**主語・理由・元の文言。**

```
外部結合の正しい結果には完全な候補集合が必要です。complete input reason: OUTER_JOIN_NON_PRESERVED（APP4225）。
onLimit=truncateは使用できません。取得件数が上限（20 件）を超えました。WHERE 句で絞り込むか、maxRecords を引き上げてください。
```

- **どのアプリが打ち切られたかを含めること。**（B93 の教訓＝**何を直せばよいか分かる文面にする**）
- **元の文言（`取得件数が上限（N 件）を超えました。…`）をそのまま末尾に置くこと。**
  文面の生成は `fetchAll` 側の文言を再利用してよい

### 5.4 **`CompleteInputReason` に足さないこと**

**これが案 C' の核心である。**

`CompleteInputReason` は **AST から静的に決まる**ため、足すと
**「外部結合があれば、どこが打ち切られても常にエラー」**（案 C）になる。
**保持側が打ち切られただけの正しいケースまで止める。**

**結果として、B97 で作ったエラー主語の規則（集計系／並び系）は変更不要である。**
文面は投げる場所で組み立てる。

---

## 6. **既存テストの書き換えが必要**

**次の 2 呼び出しは、`LEFT JOIN` で「保持されない側」も打ち切られる形**である。
**C' ではエラーになる。書き換えを許可する。**

| 場所 | 現在 | C' 後 |
|---|---|---|
| [`b95TruncationVisibility.test.ts:124`](../../src/engine-library/__tests__/b95TruncationVisibility.test.ts#L124) 自己結合 | `APP9502 a LEFT JOIN APP9502 b` / `maxRecords=2` → 成功・`[9502]` | **エラー** |
| 同 `:135` reverse-order | `APP9502 a LEFT JOIN APP9501 b` / `maxRecords=2` → 成功・`[9501, 9502]` | **エラー** |

### 6.1 **このテストの目的を残すこと**

テスト名は「**reached app IDs are unique and ascending**」であり、
**重複排除と昇順**を確かめるのが目的である。**その目的は C' 後も生きている。**

**`INNER JOIN` へ差し替えて目的を保つこと。**
`INNER JOIN` は**保持されない側を持たない**ので C' の対象外であり、
**同じ形で重複排除と昇順を確かめられる**
（[同ファイル:89](../../src/engine-library/__tests__/b95TruncationVisibility.test.ts#L89) に
`INNER JOIN` で打ち切りを観測する既存テストがある）。

**`toEqual` を緩めないこと。**主張の強さを落とさない。

### 6.2 変更しないテスト

| 場所 | 理由 |
|---|---|
| `:72`（`APP4148 a LEFT JOIN APP4149 b` / `maxRecords=230`） | **打ち切られるのは左＝保持側だけ。**偽の `NULL` は起きない。**C' でも成功する**（**これが案 C を採らなかった理由そのもの**） |
| `:106`（合算 233 > 230 だが個別は上限内） | **実際の打ち切りが無い** |
| `:89`（`INNER JOIN`） | **INNER は対象外** |

**上記以外で書き換えが必要になったら、止めて報告すること。**

---

## 7. 受入条件

1. **保持されない側が打ち切られたらエラー**＝[B98 §3](ksql_b98_join_truncated_right_null_issue.md) の再現形
   （左 3 件・右 30 件・`maxRecords=20` で右の一致が窓外）でエラーになること
2. **保持側だけが打ち切られたら従来どおり**＝`b95TruncationVisibility.test.ts:72` が**無変更で成功する**
   （**要件の本体**。ここが壊れたら案 C と同じになる）
3. **`RIGHT JOIN` で main が保持されない側になる**＝`FROM a RIGHT JOIN b` で **`a` が打ち切られたらエラー**、
   **`b` だけが打ち切られたら従来どおり**
4. **`INNER JOIN` は対象外**＝両側が打ち切られても従来どおり成功する
5. **多段 join** ＝`a LEFT JOIN b LEFT JOIN c` で **`b` が打ち切られたらエラー**
   （`b` は自分の join で保持されない側）
6. **入れ子で誤爆しない**＝**外側に外部結合があり、サブクエリ／CTE 側で打ち切りが起きても、
   サブクエリ自身に外部結合が無ければ従来どおり**
7. **エラー文面**＝主語が「外部結合の正しい結果」で、**打ち切られたアプリ ID を含む**こと。
   **二重ラップしない**こと（`complete input reason:` が 1 回だけ）
8. **`code` が変わらない**＝engine ライブラリで `FETCH_LIMIT_EXCEEDED`
9. **`onLimitReached: "error"` の挙動が変わらない**
10. **`CompleteInputReason` が変わらない**＝B97 の主語規則・EXPLAIN 出力が不変
11. **公開型が変わらない**（snapshot 22 不変）
12. **§6 の 2 呼び出し以外に、挙動の期待を変えた書き換えが無いこと**

---

## 8. 注意点

- **git 操作は一切しないこと。**
- **`CompleteInputReason` に足さないこと**（§5.4）。**EXPLAIN を変えないこと**
  （打ち切りが起きるかは実行時にしか分からない）
- **`statementContainsOuterJoin()` を使わないこと**（全体走査なので入れ子で誤爆する・§4）
- **alias で照合しないこと**（`null` になり得る。**オブジェクト同一性で照合する**）
- **`fetchAll` の判定に手を入れないこと**
- **警告文言を変えないこと**（保持側だけの打ち切りでは従来どおり出る）
- **`docs/internal/ksql_*.md` を編集しないこと**
- **`release/README.txt` を編集しないこと**（リリース時にこちらで書く）
- **snapshot 22 件を更新しないこと**
- **仕様に矛盾・不足・誤りを見つけたら、黙って直さず、止めて報告すること**

### 8.1 承知している限界（直さないこと）

- **偽の `NULL` が実際に起きたかまでは見ない。**
  「保持されない側が不完全＝`NULL` が本物か検証できない」という立場で止める。
  **`b95TruncationVisibility.test.ts:124` は実際には偽の `NULL` が起きていない**が、
  **エラーにするのが正しい**（検証できないため）
- **並行して開始済みの取得は中断されない**（調査で判明）。
  **エラーにはなるので正しさの問題ではない。**本件では直さない

### 8.2 移行案内

**CHANGELOG に「未リリース」節を作って書くこと。**要点:

- **外部結合の結合相手が上限に達した場合、`truncate` でもエラーになる**
- **保持側だけが打ち切られた場合は従来どおり**（行が減るだけ）
- **`INNER JOIN` は従来どおり**
- **根拠**＝**打ち切りで落ちた行と、本当に相手がいない行が区別できない**。
  実測を添える（真の値 `b01` の行が「相手なし」になり、本当に相手がいない行と同一に見えた）
