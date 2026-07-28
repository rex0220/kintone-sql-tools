# B98 JOIN の右側が打ち切られると、一致するはずの行に `NULL` が入る

- 起票: 2026-07-29
- ステータス: 📋 **案 C' 仕様確定・実装待ち**（オーナー決定 2026-07-29）。→ [実装仕様](ksql_b98_join_truncated_right_null_spec.md)＝**保持されない側が打ち切られたときだけ止める**。実機再現済み（v3.33.0）
- 出典: [B97 §5](ksql_b97_incomplete_aggregate_failclosed_spec.md) で**意識的に対象外**とした残件
- 関連: [B97](ksql_b97_incomplete_aggregate_failclosed_issue.md) / [B95](ksql_b95_truncation_visibility_issue.md) / [B72 §7.2](ksql_b72_relative_date_fullscan_exact_spec.md)

## 1. B97 で対象外にした理由と、残った問題

**B97 の原理は「行を畳む処理」**である。1 行の出力が**複数の入力行についての主張**に
なっているとき、部分入力から作った出力は誤り——という線引きで、
集計 / `GROUP BY` / `DISTINCT` / `UNION` を完全入力の対象にした。

**`JOIN` は行を畳んでいない**ので、この原理では説明できない。**だから対象外にした。**

**しかし別の問題がある。**

```sql
SELECT a.案件名, b.顧客名 FROM APP_A a LEFT JOIN APP_B b ON a.顧客No = b.顧客No
```

**右側（`APP_B`）が取得上限で打ち切られると、一致するはずの行が `NULL` になる。**

**行そのものは本物だが、`NULL` は「相手がいない」という誤った主張である。**
**「件数が足りないだけ」では済まない。**

## 2. 仕組み（コードで確認済み）

### 2.1 JOIN は完全入力の対象に入っていない

[`selectCompleteInputReasons()`](../../src/core/dmlGuard.ts#L172) は `stmt.joins` を見ない。
**`CompleteInputReason` に JOIN 由来の理由が無い**（v3.33.0 時点）。

```ts
DML | VALIDATE | LOCAL_ORDER | WINDOW_ORDER
   | STATISTICAL_AGGREGATE | GROUPING_SETS | AGGREGATE | GROUP_BY | DISTINCT
```

### 2.2 打ち切られた配列がそのまま突き合わせに渡る

- main と JOIN 各テーブルは**それぞれ同じ `maxRecords` / `onLimit`** で取得される
  （[execute.ts:4393-4497](../../src/execute.ts#L4393)）
- `runFullScan()` が**打ち切り後の配列**を `applyJoin()` へ渡す
  （[process.ts:1632-1658](../../src/engine/process.ts#L1632)）
- `applyJoin()` は**渡された行だけ**で INNER / LEFT / RIGHT を作る
  （[process.ts:123-199](../../src/engine/process.ts#L123)）

**右側に無い＝一致しない**として扱われる。**打ち切られたのか元から無いのかを区別しない。**

### 2.3 JOIN 経路にも打ち切りの検出はある

[`tryFetchJoinRecordsBySourceKeys()`](../../src/execute.ts#L5200) の `onTruncate` は
**警告を出し、B95 の `limitReachedApps` にアプリ ID を記録する。**

**つまり「右側が打ち切られた」ことはエンジンが知っている。**
**知っているのに、その入力で JOIN を続けている。**

### 2.4 検索打ち切り（10 万件）は既に fail-closed

**外部結合を含む文は `searchAborted` で fail-closed** になっている
（[outerJoinSearchAbortGuard.ts](../../src/core/outerJoinSearchAbortGuard.ts#L12) /
[execute.ts:765-778](../../src/execute.ts#L765)）。

**同じ危険を kintone 側の都合（検索打ち切り）では止めているのに、
利用者が選んだ `truncate` では止めていない。**

**B97 と同じ構図**である＝B72 が検索打ち切りで下した判断が、`maxRecords` の打ち切りに
まだ適用されていない。

## 3. 実機で再現した（2026-07-29・v3.33.0）

**起票時は再現できていなかった**（手元の 2 アプリは一致がほぼ 1:1 で、
右の一致集合が常に左と同じ窓に収まっていた）。**検証用データを作って裏を取った。**

### 3.1 データ

| アプリ | 内容 |
|---|---|
| **APP4225**（右） | 30 件。**`キー`='A' が 29 件（`値`=a01〜a29）→ 最後に `キー`='B' が 1 件（`値`=b01）** |
| **APP4226**（左） | 3 件。`キー`='A' / 'B' / 'C'（**'C' は右に一致が無い**） |

**要点＝左が上限に収まり、右の一致が打ち切り窓の外にある。**

### 3.2 基準値（打ち切りなし）

```sql
SELECT l.キー AS 左キー, r.値 AS 右値 FROM APP4226 l LEFT JOIN APP4225 r ON l.キー = r.キー
-- maxRecords=1000 → 30 行。B は b01 に一致する
```

### 3.3 **打ち切ると `B` の一致が消える**

```sql
-- 同じ SQL / maxRecords=20 / truncate
```

| 左キー | 右値 | 真の値 |
|---|---|---|
| A | a01 〜 a20 | a01〜a29（**20 件で打ち切り**） |
| **B** | **（空）** | **b01** |

warnings: `取得上限（20 件）に達したため、20 件で打ち切って表示しています。`

**行は返る。値が誤っている。**

### 3.4 **「本当に相手がいない行」と区別できない**（最も重要）

```sql
SELECT l.キー AS 左キー, r.値 AS 右値
FROM APP4226 l LEFT JOIN APP4225 r ON l.キー = r.キー
WHERE l.キー <> 'A'
-- maxRecords=20 / truncate
```

| 左キー | 右値 | 実際は |
|---|---|---|
| **B** | **（空）** | **相手がいる**（b01）。打ち切りで落ちた |
| **C** | **（空）** | **本当に相手がいない** |

**2 行はバイト単位で同一である。**
**警告は「どちらの行が該当するか」を言わない。**
**利用者が結果だけを見て見分けることはできない。**

**B97 の `0` と同じ性質**＝**「相手なし」という完結した答えに読める。**

### 3.5 INNER JOIN との違い（案 C の根拠）

```sql
-- 同じ条件で INNER JOIN
SELECT ... FROM APP4226 l INNER JOIN APP4225 r ON l.キー = r.キー WHERE l.キー <> 'A'
-- → 0 行 ＋ 警告
```

**INNER JOIN は行が消えるだけで、偽の「相手なし」を作らない。**
**返る行は本物**であり、**素の打ち切りと同じ性質**である。

**LEFT JOIN だけが「返した行の中で嘘をつく」。**
→ **§4.3 の案 C（INNER と OUTER で分ける）を支持する実測である。**

### 3.6 検証用アプリの扱い

**APP4225 / APP4226 は残してある。**実装時の受入確認にそのまま使える。
**不要になったら削除してよい**（本文書に作り方を書いてあるので再作成できる）。

## 4. 対応案

### 4.1 案 A — JOIN を完全入力の対象にする

`CompleteInputReason` に `JOIN` を足す。**B97 と同じ配管に乗る。**

- **実装は浅い**（B97 で通った道）
- **ただし影響が大きい**＝**JOIN を含むクエリは `truncate` で一切使えなくなる**。
  **明細ペインで JOIN を使っている利用者は行を出せなくなる**
- **B97 で「素の明細は行を出せる」を要件の本体としたばかり**なので、
  **その要件を JOIN について取り消すことになる**

### 4.2 案 B — 右側が打ち切られたときだけ止める

**左が打ち切られただけなら従来どおり**（行が減るだけ）、
**右（結合相手）が打ち切られたときはエラー**にする。

- **正確**＝`NULL` が誤りになる条件そのもの
- **B95 の `limitReachedApps` で「どのアプリが打ち切られたか」は分かる**（§2.3）
- **ただし判定が実行時**になる＝`CompleteInputReason` は AST から静的に決まるので、
  **既存の配管には乗らない**。**新しい仕組みが要る**
- **B97 の教訓**＝新しい判定を書くのは silent wrong result の温床。**慎重に**

### 4.3 案 C — INNER JOIN と OUTER JOIN で分ける

**`NULL` が入るのは OUTER JOIN だけ**である。
`INNER JOIN` は**行が減る**だけで、返る行は本物。

- **`searchAborted` の既存の扱いと揃う**（外部結合だけ fail-closed・§2.4）
- **§3.5 の実測が支持する**＝INNER は行が消えるだけ、**LEFT だけが返した行の中で嘘をつく**
- **影響が案 A より小さい**
- **ただし `INNER JOIN` も「一致するはずの組が消える」**ので、
  **件数を数えれば誤る**（`COUNT(*)` は B97 で既に止まる）

## 5. 【オーナー決定 2026-07-29】**案 C' を採用**

**案 C（外部結合があれば常に）ではなく、
「保持されない側が打ち切られたときだけ止める」**（案 B と案 C の中間）。

### 5.1 案 C を採らない理由＝**正しいケースまで止める**

| 打ち切られた側 | 偽の `NULL` | 案 C | **案 C'** |
|---|---|---|---|
| **保持側**（`LEFT JOIN` の左） | **起きない**（行が減るだけ） | ❌ エラー | **✅ 従来どおり** |
| **保持されない側**（結合相手） | **起きる** | ❌ エラー | ❌ エラー |

**過剰であることの証拠が既存テストにある。**

```ts
// b95TruncationVisibility.test.ts:72（B95 で 2026-07-29 に追加）
"SELECT a.key FROM APP4148 a LEFT JOIN APP4149 b ON a.key = b.key"
  APP4148: 231 件 ← 打ち切られる（maxRecords=230）
  APP4149:  20 件 ← 打ち切られない
→ 成功を期待
```

**打ち切られたのは保持側で、右は全件揃っている。偽の `NULL` は 1 つも起きない。**
**案 C はこれをエラーにする。**

**しかもこれは珍しい形ではない**＝**大きな実績アプリ `LEFT JOIN` 小さなマスタ**は
ダッシュボードで最も普通の形である。**案 C の過剰は最も多い形を直撃する。**

### 5.2 案 C' の代償

- **判定が実行時になる**＝`CompleteInputReason` は AST から静的に決まるので、
  **B97 で使った配管にそのまま乗らない**
- **B97 の教訓が効く場所**＝**新しい判定を書くのは silent wrong result の温床**。
  **既存の材料で足りるかを先に測る**（→ §5.3）

### 5.3 実装前の調査（2026-07-29・実施済み → §7）

**「`onTruncate` の時点で、そのテーブルが外部結合の保持されない側かを
判定する材料が既にあるか」**を codex に測らせてから仕様を書いた。

**B97 / B91 で同じやり方が 2 回とも前提を覆している**ため。
**→ 結果は §7。設計が 3 つ決まり、うち 1 つは §5.4 の前提を覆した。**

### 5.4 ~~エラー主語の規則を広げる~~ → **不要になった**（§7.4）

**当初は「`CompleteInputReason` に `OUTER_JOIN` を足す」前提で、
B97 のエラー主語の規則（集計系／並び系の 2 系統）に第 3 の系統が要る**と考えていた。

**調査で覆った。**案 C' は **`CompleteInputReason` に足さない**
（足すと静的判定になり案 C と同じ過剰になる・§7.4）。
**文面は投げる場所で組み立てる**ので、**B97 の主語規則は変更不要である。**

### 5.5 見積もり

**1.0〜1.5 人日**（§5.3 の調査結果で動く）。**SemVer=minor**（移行案内つきの正しさ修正）。

## 6. 優先度

**中**（2026-07-29 に実機再現したので、低から上げた）。**急ぎではない。**

- **Pro は現時点で影響なし**（v3.33.0 の報告 §4「JOIN を使うペインはいずれも小さいアプリ同士の結合」）
- **検索打ち切り（10 万件）では既に fail-closed**（§2.4）なので、
  **残っているのは `maxRecords` の打ち切りだけ**
- **`COUNT(*)` など集計を伴う形は B97 で既に止まる**

**ただし silent wrong result であり、B78 / B79 / B86 / B90 / B97 と同じ系列である。**
**しかも §3.4 のとおり、利用者が結果から見分けることはできない。**
**要望が出たら優先度を上げる。**

---

## 7. 調査結果（2026-07-29・codex による事実調査）

**設計が 3 つ決まり、うち 1 つは §5.4 の前提を覆した。**

### 7.1 **手を入れるのは 1 箇所だけ**

打ち切りの検出は 3 箇所あるが、**外部結合が通るのは 1 つだけ**である。

| 箇所 | 外部結合が通るか |
|---|---|
| [`executeSimpleSelect()`](../../src/execute.ts#L3139) | ❌ **join があれば `FULL_SCAN` へ行く**（`resolveSelectMode()`・[selectToKintone.ts:63](../../src/converter/selectToKintone.ts#L63)） |
| **[`fetchTableRecordsForFullScan()`](../../src/execute.ts#L5008)** | ✅ **ここだけ** |
| [`tryFetchJoinRecordsBySourceKeys()`](../../src/execute.ts#L5252) | ❌ **`join.type !== "INNER"` で `null` を返す**（[execute.ts:5211](../../src/execute.ts#L5211)） |

**判定材料はスコープに揃っている**＝`fetchTableRecordsForFullScan()` の引数に
**`stmt`（SELECT 全体）/ `table`（取得中のテーブル）/ `isMainTable`** がある
（[execute.ts:4993](../../src/execute.ts#L4993)）。
**呼び出し元は `stmt.from` または `join.table` のオブジェクトをそのまま渡す**ので、
**オブジェクト同一性で特定できる**（[execute.ts:4420](../../src/execute.ts#L4420) /
[4453](../../src/execute.ts#L4453)）。

> **alias で照合してはいけない。**`alias` は `null` になり得る
> （[ast.ts:392](../../src/types/ast.ts#L392)）。

### 7.2 **保持されない側は静的に決まる。ただし `RIGHT` で逆転する**

**`RIGHT JOIN` は正規化されていない**＝AST に `"RIGHT"` が残り、
`applyJoin()` に専用分岐がある（[parser.ts:2122](../../src/parser/parser.ts#L2122) /
[process.ts:132](../../src/engine/process.ts#L132)）。

| `joins[i].type` | 保持されない側 | 根拠 |
|---|---|---|
| `LEFT` | **`joins[i].table`** | 左行を走査し、右に一致が無ければ空の右行を足す（[process.ts:169](../../src/engine/process.ts#L169)） |
| `RIGHT` | **左の累積**＝`from` ＋ `joins[0..i-1].table`（**main を含む**） | 右行を全件走査し、左に一致が無ければ空の左行を足す（[process.ts:143](../../src/engine/process.ts#L143)） |
| `INNER` | **なし** | 一致しない組は行ごと消える。偽の `NULL` を作らない |

**`runFullScan()` は `stmt.joins` を先頭から順に畳む**（各回の結果が次回の左になる・
[process.ts:1632](../../src/engine/process.ts#L1632)）。

→ **`a LEFT JOIN b LEFT JOIN c` の `b` は、自分の join では保持されない側、
`c` との join では保持側**。**どれか 1 つで保持されない側なら対象**とする。

**テーブル単位で役割を返す既存関数は無い**（codex が `src` 全体を探して「無い」と報告）。

### 7.3 **入れ子は安全。ただし全体走査を使うと誤爆する**

**サブクエリ・CTE・UNION 枝・一時テーブル source は、それぞれ自分の `SelectStatement` を
持って実行される**（[execute.ts:9062](../../src/execute.ts#L9062) /
[4663](../../src/execute.ts#L4663) / [4564](../../src/execute.ts#L4564)）。

**`onTruncate` のスコープにある `stmt` は、常にその取得を行っている SELECT 自身**であり、
**外側の `joins` を見る経路は無い。**

→ **判定は「その SELECT の `joins` だけ」で正しい。**

> **[`statementContainsOuterJoin()`](../../src/core/outerJoinSearchAbortGuard.ts#L16) を
> 使ってはいけない。**あれは **statement 全体を再帰走査する boolean** で、
> **サブクエリ側の打ち切りを外側の外部結合のせいにしてしまう。**
> （こちらは当初「既存の判定器があるから使えばいい」と考えていた。**調査で覆った。**）

### 7.4 **`CompleteInputReason` に足さない**（§5.4 の前提が覆った）

`CompleteInputReason` は **AST から静的に決まる**（[dmlGuard.ts:108](../../src/core/dmlGuard.ts#L108)）。
**足すと「外部結合があれば、どこが打ち切られても常にエラー」＝案 C** になり、
**§5.1 の過剰がそのまま出る。**

→ **足さない。文面は投げる場所で組み立てる。**
→ **結果として B97 のエラー主語の規則は変更不要**（§5.4）。

### 7.5 止める経路は既にある

- `fetchAll()` は **`onTruncate(maxRecords)` を同期的に呼んでから**切り詰めた配列を返す
  （[fetchAll.ts:122](../../src/api/fetchAll.ts#L122) / [147](../../src/api/fetchAll.ts#L147) /
  [188](../../src/api/fetchAll.ts#L188)）。**投げれば `return` の前に伝播する**
- `executeSelect()` の `catch` が `throwCompleteInputError()` へ渡す。
  **`FetchAllLimitError` で、かつ未ラップのときだけ**文面を足す
  （[execute.ts:2958](../../src/execute.ts#L2958)）
  → **B97 で足した `completeInputWrapped` を `true` にすれば二重ラップしない**

### 7.6 影響を受ける既存テスト（codex が全件調べた）

**外部結合 ＋ `truncate` ＋ 成功期待は 4 呼び出し。すべて `b95TruncationVisibility.test.ts`。**
**`RIGHT JOIN` の該当は無い。**

| 場所 | 打ち切られる側 | 偽の `NULL` | C' 後 |
|---|---|---|---|
| `:72` | **左＝保持側だけ** | **起きない** | ✅ **無変更で成功**（**案 C を採らなかった理由そのもの**） |
| `:106` | **実際の打ち切り無し** | — | ✅ 無変更 |
| `:124` 自己結合 | **両方**（保持されない側も） | **起きない**（両側の窓が同一） | ❌ **エラーになる** |
| `:135` reverse-order | **両方**（保持されない側も） | **起きない**（同上） | ❌ **エラーになる** |

**下 2 件は「実際には偽の `NULL` が起きていないのにエラーになる」**。
**C' はそれを知る術がない**（保持されない側が不完全なら `NULL` が本物か検証できない）。
**エラーにするのが正しい。**→ 仕様 §6 で書き換えを許可した。

### 7.7 承知している限界（本件では直さない）

- **並行して開始済みの取得は中断されない**（[execute.ts:4418](../../src/execute.ts#L4418)）。
  **エラーにはなるので正しさの問題ではない**
- **B95 の `limitReachedApps` は appId の集合**であり、
  **同一 appId の main / join / 複数 alias / 入れ子を区別しない**
  （[execute.ts:820](../../src/execute.ts#L820)）
