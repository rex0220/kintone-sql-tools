# B98 JOIN の右側が打ち切られると、一致するはずの行に `NULL` が入る

- 起票: 2026-07-29
- ステータス: 📋 **未着手**（**急ぎではない**。Pro は現時点で影響なし）
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

## 3. 実機での再現（未達成・理由あり）

**手元の 2 アプリでは作れなかった。**（2026-07-29・v3.33.0）

| | |
|---|---|
| `APP4147` | 18 件 |
| `APP4148` | 215 件 |

**`$id` でも `顧客No` でも一致がほぼ 1:1** のため、
**右側の一致集合が常に左側と同じ窓に収まる。**
`maxRecords=18` で右側の打ち切り警告は出たが、**結果は正しいまま**だった
（打ち切りが先頭 18 件を残し、そこに一致がすべて含まれていた）。

### 3.1 再現に必要なデータの形

**左が上限に収まり、右の一致集合が上限を超える**こと。

- **1:N の JOIN**（左 1 行に対し右が多数一致する）
- または**右の一致が後方にある**（先頭 N 件に含まれない）

```
左 3 行 ／ 右の一致 500 行 ／ maxRecords=100
→ 左は打ち切られない。右は 100 件で打ち切られる。
→ 101 件目以降にしか一致が無い左行は NULL になる
```

**実装時に検証用データを作って確認すること。**
**「作れなかった」を「起きない」と読まないこと。**§2 のとおり仕組み上は起きる。

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
- **影響が案 A より小さい**
- **ただし `INNER JOIN` も「一致するはずの組が消える」**ので、
  **件数を数えれば誤る**（`COUNT(*)` は B97 で既に止まる）

## 5. 決めること

1. **案 A / B / C のどれか**（**C が既存の `searchAborted` の扱いと最も整合する**）
2. **`truncate` で JOIN を使えなくすることの是非**＝B97 で守った「明細は行を出せる」と衝突する
3. **B95 の `limitReachedApps` を実行時判定に使えるか**（案 B の前提）

## 6. 優先度

**低い。**

- **Pro は現時点で影響なし**（v3.33.0 の報告 §4「JOIN を使うペインはいずれも小さいアプリ同士の結合」）
- **検索打ち切り（10 万件）では既に fail-closed**（§2.4）なので、
  **残っているのは `maxRecords` の打ち切りだけ**
- **`COUNT(*)` など集計を伴う形は B97 で既に止まる**

**ただし silent wrong result であり、B78 / B79 / B86 / B90 / B97 と同じ系列である。**
**要望が出たら優先度を上げる。**
