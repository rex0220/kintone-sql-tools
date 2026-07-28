# 仕様: B97 — 行を畳む処理を完全入力の対象にする

- 作成: 2026-07-29
- 対象課題: [B97](ksql_b97_incomplete_aggregate_failclosed_issue.md)
- ステータス: ✅ **リリース済み（v3.33.0・2026-07-29）**
- 分担: Claude=仕様/レビュー、codex=実装/テスト
- SemVer: **minor**（移行案内つきの正しさ修正。B78 / B79 / B86 / B90 と同じ扱い）

---

## 1. **仕組みは既にある。対象が足りないだけ**

**起票時は「新しいモードを足す」前提だったが、調査で覆った。**

`CompleteInputReason` という型と、**`truncate` を `error` へ上書きする配管が完成している。**

```ts
// src/core/dmlGuard.ts:77-83
export type CompleteInputReason =
  | "DML" | "VALIDATE" | "LOCAL_ORDER" | "WINDOW_ORDER"
  | "STATISTICAL_AGGREGATE" | "GROUPING_SETS";
```

```ts
// src/execute.ts:2914-2933 — 理由が 1 つでもあれば truncate を error へ差し替える
const truncateWasDisabled = reasons.size > 0 && options.onLimitReached === "truncate";
effectiveOptions: truncateWasDisabled ? { ...options, onLimitReached: "error" } : options
```

**エンジンは既に Pro が求めた線引きを持っている。**
ローカル `ORDER BY`・window・統計集計・grouping sets は **`truncate` でもエラー**になり、
**素の明細は打ち切り＋警告**のままである。

**足りないのは対象だけ。**

### 1.1 B56 が意図的に残していた

> 既存 `SUM` / `AVG` 等の truncate 契約を互換性のため変更せず、
> **既存集計の完全入力化を別課題とし、新旧非対称は意図的**とする。
> — [`ksql_b56_statistical_aggregates_spec.md`](ksql_b56_statistical_aggregates_spec.md) §76-83

**B97 がその「別課題」である。**

### 1.2 【オーナー決定 2026-07-29】**既存 `truncate` へ対象を足す**

**新しいモードは足さない。**

- **判定・配管・エラー文面をすべて再利用できる**（新規に書かない＝B78 / B79 / B86 と同じ轍を踏まない）
- **Pro が求めた線引きが `truncate` でそのまま得られる**
- **新モードだと、既存の `LOCAL_ORDER` 等（モード非依存で常にエラー）との一貫性を
  改めて決め直す必要が出る**

**既存 `truncate` 利用者の集計クエリはエラーになる。**
**ただし、それは今まさに誤った値を返していたもの**である（`0` が返る実測あり）。

---

## 2. 追加する理由と、その原理

### 2.1 原理＝**行を畳む処理**

**1 行の出力が、複数の入力行についての主張になっている**とき、
**部分入力から作った出力は誤りである。**

| | 出力の意味 | 打ち切り時 |
|---|---|---|
| `SELECT 案件名 FROM APPn` | **その行 1 件の事実** | 行は本物。**件数が足りないだけ** |
| `SELECT COUNT(*) FROM APPn` | **入力全体についての主張** | **値が誤り** |
| `SELECT DISTINCT 区分 FROM APPn` | **「区分はこれで全部」という主張** | **主張が誤り** |
| `SELECT 区分, COUNT(*) … GROUP BY 区分` | 同上＋各群の値 | **どちらも誤り** |

**これが Pro の線引き**（明細＝行＋警告／集計＝エラー）**と一致する。**

### 2.2 足す理由

```ts
export type CompleteInputReason =
  | "DML" | "VALIDATE" | "LOCAL_ORDER" | "WINDOW_ORDER"
  | "STATISTICAL_AGGREGATE" | "GROUPING_SETS"
  | "AGGREGATE"        // 追加: 統計集計以外の集計（COUNT / SUM / AVG / MIN / MAX …）
  | "GROUP_BY"         // 追加: plain GROUP BY（GROUPING SETS は既存理由が拾う）
  | "DISTINCT";        // 追加: SELECT DISTINCT と UNION（ALL でない）の重複排除
```

**`DISTINCT` に `UNION` を含める。**`UNION`（`ALL` でない）は**枝をまたいで重複を畳む**ため、
`SELECT DISTINCT` と同じ主張をしている。**Pro のリストには無いが、同じ原理である。**
**含めないと「`SELECT DISTINCT x FROM A` はエラーだが
`SELECT x FROM A UNION SELECT x FROM B` は通る」という説明できない差**が残る。

### 2.3 **`HAVING` に専用の理由は足さない**

`HAVING` は `GROUP BY` か集計を伴うため、**上の 2 つが必ず拾う。**
**独立した理由を足すと、同じ 1 つの問題に 2 つの理由が出る。**

---

## 3. 実装

### 3.1 `selectCompleteInputReasons()` へ足す

[`src/core/dmlGuard.ts:154-170`](../../src/core/dmlGuard.ts#L154) の既存の形に合わせる。

```ts
function selectCompleteInputReasons(stmt: SelectStatement): Set<CompleteInputReason> {
  const reasons = new Set<CompleteInputReason>();
  if (normalizeGroupingSpec(stmt).type === "GROUPING_SETS") reasons.add("GROUPING_SETS");
  // ↓ 追加（plain GROUP BY。GROUPING SETS は上で拾うので二重にしない）
  // ↓ 追加（集計列。STATISTICAL_AGGREGATE と重ならないようにする）
  // ↓ 追加（stmt.distinct）
  …
}
```

**判定に使う材料は既に AST にある**（調査で確認済み）。

| 理由 | 材料 |
|---|---|
| `AGGREGATE` | 列の `AGGREGATE` / `AGG_REF` ノード。**`STATISTICAL_AGGREGATES` に属さない `func`** |
| `GROUP_BY` | `normalizeGroupingSpec(stmt)` が `GROUPING_SETS` **以外**でグループ化を伴う場合 |
| `DISTINCT` | `stmt.distinct` |

**新しい walker を書かないこと。**`containsStatisticalAggregate` と同じ構造・同じ再帰の
仕方に揃える（**サブクエリ・CASE・window 内の集計も既存の再帰が到達する**）。

### 3.2 `UNION` の重複排除

[`unionCompleteInputReasons()`](../../src/core/dmlGuard.ts#L146) は現在、左右の
`selectCompleteInputReasons` を合成するだけ。

**`stmt.all === false` のとき `DISTINCT` を足す。**

### 3.3 **エラーの主語を足す**（必須）

[`completeInputErrorPrefix()`](../../src/execute.ts#L2896) は、
**`STATISTICAL_AGGREGATE` 単独と `GROUPING_SETS` 以外を全部「ORDER BY」と呼ぶ。**

```ts
: "ORDER BYの正しい結果";   // ← 現状。AGGREGATE を足すとここへ落ちる
```

**そのままだと `SELECT COUNT(*)` の失敗が「ORDER BYの正しい結果には…」と出る。**
**利用者が原因を取り違える。**

**単独理由のときの主語を足すこと。**

| 理由（単独） | 主語 |
|---|---|
| `AGGREGATE` | **集計の正しい結果** |
| `GROUP_BY` | **グループ集計の正しい結果** |
| `DISTINCT` | **DISTINCT の正しい結果** |

**複数理由のときの扱いは既存の形に合わせる**（現状は `GROUPING_SETS` を含めば「クエリ」）。
**`WINDOW_ORDER` 単独が「ORDER BY」と出る既存の粗さは、本件では直さない**
（B97 の範囲外。**直すなら別課題**）。

### 3.4 変更しないもの

- **`fetchAll` の判定**（打ち切りそのもの）
- **警告の文言**
- **`onLimitReached` の型**（`"error" | "truncate"` のまま。**新しい値を足さない**）
- **`onLimitReached: "error"` の挙動**
- **B94 の `COUNT(*)` 単発取得経路**——**そもそも `maxRecords` を消費しない**ので
  本件の影響を受けない（[調査](ksql_b97_incomplete_aggregate_failclosed_issue.md)で確認済み）
- **MCP / CLI / プラグイン**——`onLimit` を素通しするだけなので**変更不要**
- **`STATISTICAL_AGGREGATES` の集合**（`AGGREGATE` と重ならないようにするだけ）

---

## 4. **既存テストの書き換えが必要。これは本件の目的である**

**通常なら「止めて報告」の対象だが、本件は違う。**
**以下のテストは、いま誤っている挙動を「成功」として固定している。**
**書き換えることが B97 の成果物である。**

### 4.1 書き換えを許可するテスト（`main` にコミット済み）

| 場所 | 現在の期待 | B97 後 |
|---|---|---|
| [`b72RelativeDateFullScanExactStep2.test.ts:292-330`](../../src/__tests__/b72RelativeDateFullScanExactStep2.test.ts#L292) | plain `GROUP BY` + `COUNT(*)` → `[{区分:"A", c:"2"}]` | **エラー** |
| 同上 | `DISTINCT` → `[{区分:"A"}]` | **エラー** |
| 同上 | 通常 `SUM(金額)` → `[{total:"30"}]` | **エラー** |

**この 3 つは `maxRecords=2` / `truncate` の部分値であり、`0` が返るのと同じ問題である。**

**上記以外のテストで書き換えが必要になったら、止めて報告すること。**
**「必要になった」は「落ちた」ではない。**
**落ちたテストが「誤った挙動を固定していた」のか「B97 が壊した」のかを判断して報告すること。**

### 4.2 参考: 名前が正しくなるテスト

[`boundaryErrors.test.ts:95-105`](../../src/engine-library/__tests__/boundaryErrors.test.ts#L95) は
JOIN と plain `GROUP BY` を **"complete-input plan"** と呼びながら、
**mock executor に `FetchAllLimitError` を投げさせている**（実 planner を通っていない）。

**B97 で plain `GROUP BY` は本当に complete-input になる**ため、
**名前と実態が一致する。**`JOIN` のほうは一致しないままである（§5）。

**このテストは変更しないこと。**（mock のままで通る。）

---

## 5. **対象外**（意識的に外す。理由つき）

| | なぜ外すか |
|---|---|
| **JOIN** | **行を畳んでいない。**LEFT JOIN で右が打ち切られると `NULL` が入るという**別の問題**はあるが、**畳む処理ではない**ので本件の原理では説明できない。→ **[B98](ksql_b98_join_truncated_right_null_issue.md) として起票済み**（2026-07-29） |
| **ローカル `WHERE` 絞り込み** | **返る行は本物。**「先頭 N 件のうち該当したもの」であり、**素の打ち切りと同じ**性質 |
| **`LIMIT` / `OFFSET`** | 同上。**`ORDER BY` を伴う場合は `LOCAL_ORDER` が既に拾う** |
| **CTE・一時テーブルへの実体化** | 一時テーブルは**既に `onLimitReached: "error"` 固定**（`execute.ts:1785-1799`）。CTE は中の query の理由を再帰で拾う |
| **`WINDOW_ORDER` 単独のエラー主語** | 既存の粗さ。**本件で直すと変更範囲が読めなくなる** |

**外したものを CHANGELOG に書かないこと**（利用者には関係がない）。
**課題文には残す**（次に見る人のため）。

---

## 6. 受入条件

1. **`SELECT COUNT(*) … WHERE <JS 評価が要る>` が `truncate` でエラーになる**
   （実測の再現形: `APP4147` / `maxRecords=3` / `WHERE 顧客No LIKE '%6%'` → 従来 `0`）
2. **`SUM` / `AVG` / `MIN` / `MAX` も同じ**
3. **plain `GROUP BY` がエラーになる**
4. **`SELECT DISTINCT` がエラーになる**
5. **`UNION`（`ALL` でない）がエラーになり、`UNION ALL` は従来どおり**
6. **素の明細は従来どおり**＝`SELECT 案件名 FROM APPn` は**打ち切り＋警告**のまま
   （**これが Pro の要件の本体**。行が出せなくなったら失敗）
7. **エラーの主語が正しい**＝`COUNT(*)` の失敗が「ORDER BYの正しい結果には…」と出ないこと
8. **`onLimitReached: "error"` の挙動が変わらない**（従来どおり `FetchAllLimitError`）
9. **B94 の `COUNT(*)` 単発取得が影響を受けない**
   ＝押し下げが完全なら `maxRecords` を無視して正しい件数を返すこと（v3.32.0 のまま）
10. **`metrics.limitReached` は従来どおり**（B95。エラーになる形では metrics を見る前に停止する）
11. **公開型が変わらない**（`onLimitReached` は `"error" | "truncate"` のまま・snapshot 22 不変）
12. **§4.1 の 3 テスト以外に、挙動の期待を変えた書き換えが無いこと**

---

## 7. 注意点

- **git 操作は一切しないこと。**
- **判定を新規に書かないこと。**既存の `completeInputReasons` に足す
- **新しいモードを足さないこと**（`onLimitReached` の型を変えない）
- **`fetchAll` に手を入れないこと**
- **警告文言を変えないこと**
- **`docs/internal/ksql_*.md` を編集しないこと**
- **snapshot 22 件を更新しないこと**
- **仕様に矛盾・不足・誤りを見つけたら、黙って直さず、止めて報告すること**
- **既存テストの扱いは §4 が優先する。**§4.1 の 3 つは書き換えてよい。
  **それ以外で書き換えが必要になったら止めて報告すること**

### 7.1 移行案内が要る

**挙動の変更なので、B86 と同じ 3 箇所へ書くこと。**

- `CHANGELOG.md`（「未リリース」節。**B96 の下に足す**）
- `docs/ksql_language_reference.md`（該当箇所があれば）
- `release/README.txt` は**リリース時にこちらで書く**（codex は触らない）

**書く内容**＝「**現在成功して見えるクエリは実際には誤った結果を返している**ため、
エラー化によって正しい結果が失われることはない」。**実測（`0` が返る）を添えること。**
