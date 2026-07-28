# B97 打ち切られた入力の集計を fail-closed にする（B95 案 B・Pro から要望）

- 起票: 2026-07-29
- ステータス: ✅ **リリース済み（v3.33.0・2026-07-29・新モードではなく既存 truncate へ対象を足した）**。→ [実装仕様](ksql_b97_incomplete_aggregate_failclosed_spec.md)
- 出典: [Pro からの報告 v3.32.0](../../../ksql-dashboard-pro/docs/internal/kSQLエンジンへの報告-v3320.md) §4
- 関連: [B95 案 B](ksql_b95_truncation_visibility_issue.md#42-案-b--打ち切られた入力の集計を-fail-closed-にする) / [B72 §7.2](ksql_b72_relative_date_fullscan_exact_spec.md) / [B94](ksql_b94_count_star_totalcount_issue.md)

## 1. 経緯

[B95](ksql_b95_truncation_visibility_issue.md) で案 A（`metrics.limitReached`）だけを出し、
**案 B は「要望次第」とした**（オーナー決定 2026-07-29）。

**v3.32.0 の連絡 §3 で「要望をいただければ実装します」と伝え、Pro が受けた。**

> **「要望をいただければ実装します」に対する回答です。お願いします。**

**急ぎではない**（Pro は `onLimitReached: "error"` で運用しており安全側に倒れている）。

## 2. **`limitReached` だけでは分けられない**（Pro の論点・妥当）

案 A で**打ち切られたかは判別できる**ようになった。
しかし **「その結果が集計かどうか」は判別できない。**

Pro 側で分けようとすると `rowCount < fetchedRows` のような**結果の形からの推測**になる。

```sql
SELECT 顧客No, COUNT(*) FROM APP912 GROUP BY 顧客No
```

> **キーが全件一意なら `rowCount == fetchedRows` になり、集計なのに素通りします。**

**この反例は正しい。**穴を塞ぐには SQL 解析が必要で、**エンジンの判定を再実装することになる。**
Pro は「そちらは数日で版が進むので再実装は確実にずれる」と書いており、
**依頼③（MCP 互換モード）と同じ理由**である。**エンジン側でやるべき判定**という主張は妥当。

## 3. 求められている線引き

| 形 | 期待 |
|---|---|
| 集計 / `GROUP BY` / `DISTINCT` / window / ローカル絞り込み | **エラー**（値が変わる） |
| 行をそのまま返すだけの明細 | **打ち切り + 警告**（行そのものは本物） |

**名前は問わない**とのこと（`onLimitReached: "error-if-incomplete"` など）。

**「打ち切り + 警告」を残したいのが要点**＝明細ペインだけは行を出したい。
**行そのものは本物**なので、「全件ではない」と伝えたうえで表示するほうが有益な場面がある。

## 4. **最も強い形は `0` が返ること**（Pro の追送・2026-07-29）

**Pro が APP912 で観測し、こちらでも別アプリで再現した。**

```
（Pro・APP912）
SELECT COUNT(*) FROM APP912 WHERE 文字列 LIKE '%1%'   maxRecords=500
  truncate → 0     fetchedRows 500 / limitReached true
  error    → FETCH_LIMIT_EXCEEDED
```

### 4.1 こちらでの再現（APP4147・18 件・2026-07-29）

**同じアプリ・同じ真の答え・同じ上限で、WHERE が押し下がるかどうかだけで割れる。**

| SQL | `maxRecords=3` / truncate | 真の値 |
|---|---:|---:|
| `COUNT(*) … WHERE 顧客No LIKE '%6%'`（JS 評価） | **0** | 3 |
| `COUNT(*) … WHERE 顧客No = 6`（押し下がる） | **3** | 3 |

**`顧客No = 6` は `$id` 4 / 10 / 14 にあり、先頭 3 件（`$id` 1〜3）に 1 件も無い。**
**先頭 3 件だけを JS で絞った結果が `0`** である。警告は 1 行出る。

**押し下がる形は B94 の単発 GET を通るので正しい 3 を返す**（§1.2 の切り分けがそのまま効いている）。

### 4.2 **`0` は「小さすぎる値」より危ない**（Pro の見立て・同意する）

| 返る値 | 気づけるか |
|---|---|
| `COUNT` 5 / `SUM` 17 / `AVG` 3.4（小さすぎる値） | 「今月これだけ？」と**疑う余地がある** |
| **`0`** | **「該当なし」という完結した答えに読める。しかもダッシュボードで `0` は平常の値** |

**B95 §7.1 で「平均が特に危うい」と書いたのは、桁が変わらないので気づけないという理由**だった。
**`0` はそもそも異常に見えない。**「該当なし」は正常な結果として日常的に出る値である。

**この形が B97 の代表例である。**§5 の実測（小さすぎる値）より優先して扱う。

## 5. 実測（B95 で取得済み・再掲）

`APP4147`（18 件）へ `maxRecords=5` / `truncate`。

| | 打ち切りあり | 実際 |
|---|---:|---:|
| 件数 | **5** | 18 |
| 合計 | **17** | 51 |
| 平均 | **3.4** | 2.83… |

**Pro も「平均が特に危うい」に同意**し、ダッシュボードの文脈ではより強くそう思う、としている。

> **KPI カードで最も使われる形の 1 つ**が「平均単価」「平均リードタイム」の類で、
> **桁が変わらないので誰も疑いません**。

**Pro の実測でも 1 件出ている**（v3.32.0 報告 §1 の表）。

```
SELECT ステータス, COUNT(*) … GROUP BY   maxRecords=500 → 499（誤り）・limitReached=true
```

## 6. 前例と、前例との違い

**[B72 §7.2](ksql_b72_relative_date_fullscan_exact_spec.md) が同じ判断を済ませている。**

> 既存契約を local 集計へそのまま適用すると**部分集計を成功結果として返し得る**。
> … **`SearchAbortedError`** とする。…**緩和しない**。

**違いは「誰が選んだか」**＝検索打ち切りは kintone 側の都合だが、
**`truncate` は利用者が明示的に選んだ設定**である。

**だから既存の `"truncate"` の意味は変えない。**
[B95 §4.2](ksql_b95_truncation_visibility_issue.md) で挙げた「選んだのに勝手にエラーにする」
という懸念は、**新しいモードにすれば回避できる**。**Pro もモード追加を前提に書いている。**

## 7. 調査結果（2026-07-29・codex による事実調査）

**起票時の前提が覆った。「新しい判定を作る」必要は無い。**

### 7.1 **仕組みは完成している**

| | 場所 |
|---|---|
| 型 | `CompleteInputReason`（[dmlGuard.ts:77-83](../../src/core/dmlGuard.ts#L77)）＝`DML` / `VALIDATE` / `LOCAL_ORDER` / `WINDOW_ORDER` / `STATISTICAL_AGGREGATE` / `GROUPING_SETS` |
| 判定 | `completeInputReasons(stmt)`（[dmlGuard.ts:108-145](../../src/core/dmlGuard.ts#L108)）＝AST を再帰的に走査。サブクエリ・CASE・CTE・UNION の枝まで届く |
| **上書き** | `buildCompleteInputPolicy()`（[execute.ts:2914-2933](../../src/execute.ts#L2914)）＝**理由が 1 つでもあれば `truncate` を `error` へ差し替える** |
| エラー | `FetchAllLimitError` に理由と「onLimit=truncateは使用できません。」を付けて投げ直す（[execute.ts:2936-2955](../../src/execute.ts#L2936)） |

**エンジンは既に Pro が求めた線引きを持っている。**
ローカル `ORDER BY`・window・統計集計・grouping sets は **`truncate` でもエラー**、
**素の明細は打ち切り＋警告**。**足りないのは対象だけである。**

### 7.2 **B56 が意図的に残していた**

> 既存 `SUM` / `AVG` 等の truncate 契約を互換性のため変更せず、
> **既存集計の完全入力化を別課題とし、新旧非対称は意図的**とする。
> — [ksql_b56_statistical_aggregates_spec.md](ksql_b56_statistical_aggregates_spec.md) §76-83

**B97 がその「別課題」である。**設計が本件を見越していた。

### 7.3 対象外になっているもの（コードで確認）

**`COUNT` / `SUM` / `AVG`・plain `GROUP BY`・`DISTINCT`・`UNION` の重複排除・
`JOIN`・ローカル `WHERE`・`LIMIT` / `OFFSET`** はいずれも理由に含まれない
（[dmlGuard.ts:155-169](../../src/core/dmlGuard.ts#L155)）。

### 7.4 **既存テストが「誤った挙動」を成功として固定している**

[`b72RelativeDateFullScanExactStep2.test.ts:292-330`](../../src/__tests__/b72RelativeDateFullScanExactStep2.test.ts#L292)
が `maxRecords=2` / `truncate` で次を**成功値**として固定している。

| | 期待している値 |
|---|---|
| plain `GROUP BY` + `COUNT(*)` | `[{区分:"A", c:"2"}]` |
| `DISTINCT` | `[{区分:"A"}]` |
| 通常 `SUM(金額)` | `[{total:"30"}]` |

**§4 の `0` と同じ問題である。**
**この 3 つを書き換えることが B97 の成果物**であり、
**「既存テストを書き換えたら止めて報告」の例外として仕様で明示する。**

### 7.5 エラーの主語に穴がある

`completeInputErrorPrefix()`（[execute.ts:2896-2905](../../src/execute.ts#L2896)）は
**`STATISTICAL_AGGREGATE` 単独と `GROUPING_SETS` 以外を全部「ORDER BY」と呼ぶ。**

**理由を足すだけだと、`SELECT COUNT(*)` の失敗が
「ORDER BYの正しい結果には…」と出て原因を取り違える。主語の追加が必須。**

> **既存の粗さも判明**＝**`WINDOW_ORDER` 単独でも「ORDER BY」と出る。**
> **本件では直さない**（範囲外。直すなら別課題）。

### 7.6 その他（調査で判明した事実）

- **B94 の `COUNT(*)` 単発取得は `maxRecords` / `onLimitReached` を消費しない**ため、
  本件の影響を受けない（[execute.ts:4280-4302](../../src/execute.ts#L4280)）
- **一時テーブルは既に `onLimitReached: "error"` 固定**（[execute.ts:1785-1799](../../src/execute.ts#L1785)）
- **`stopAfter` による正常停止は `onTruncate` を呼ばず `limitReached` を立てない**
  （[fetchAll.ts:118-151](../../src/api/fetchAll.ts#L118)）＝**打ち切りではないので正しい**
- **`truncate` → `error` の上書きは 1 箇所ではない**＝VALIDATE 系は engine core・
  engine library・MCP・CLI・プラグインの**各面でも**個別に固定している
  （[execute.ts:1056](../../src/execute.ts#L1056) / [query.ts:36](../../src/engine-library/query.ts#L36) /
  [tools.ts:685](../../src/mcp/tools.ts#L685) / [index.ts:1897](../../src/cli/index.ts#L1897) /
  [desktop.ts:2058](../../src/ui/desktop.ts#L2058)）。
  **本件は core の理由集合だけで効くので、4 面の変更は不要**
- `boundaryErrors.test.ts:95-105` は JOIN と plain `GROUP BY` を **"complete-input plan"** と
  呼んでいるが、**mock executor に例外を投げさせているだけで実 planner を通っていない**。
  **B97 で plain `GROUP BY` は本当に complete-input になる**ため名前と実態が一致する
  （JOIN のほうは一致しないまま）

## 8. 決めること

### 8.1 【オーナー決定 2026-07-29】**既存 `truncate` へ対象を足す**

**新しいモードは足さない。**→ [実装仕様](ksql_b97_incomplete_aggregate_failclosed_spec.md)

- **判定・配管・エラー文面をすべて再利用できる**（新規に書かない）
- **Pro が求めた線引きが `truncate` でそのまま得られる**
- **新モードだと、既存の `LOCAL_ORDER` 等（モード非依存で常にエラー）との
  一貫性を改めて決め直す必要が出る**

**既存 `truncate` 利用者の集計クエリはエラーになる**が、
**それは今まさに誤った値を返していたもの**である（§4 の `0`）。
**B78 / B79 / B86 / B90 と同じ理屈**で、移行案内つきの minor とする。

### 8.2 残る論点（仕様で決めた）

1. **原理＝「行を畳む処理」**。1 行の出力が複数の入力行についての主張になっているもの
2. **足す理由は `AGGREGATE` / `GROUP_BY` / `DISTINCT`** の 3 つ
3. **`UNION`（`ALL` でない）を `DISTINCT` に含める**＝枝をまたいで畳むので同じ原理。
   含めないと「`SELECT DISTINCT` はエラーだが `UNION` は通る」という説明できない差が残る
4. **`HAVING` に専用の理由は足さない**＝`GROUP BY` か集計が必ず伴うので二重になる
5. **`JOIN` は対象外**＝行を畳んでいない。LEFT JOIN で右が打ち切られると `NULL` が入る
   という**別の問題**はあるが、本件の原理では説明できない。**別課題として起票する価値はある**

## 9. 規模（暫定）

**1.0〜1.5 人日**と見る。判定の網羅（決めること 3）が効く。

**SemVer=minor**（新モードなら純加法）。

## 9.1 リリース後の実機確認（2026-07-29・v3.33.0・実 kintone APP4147）

**4 形すべて設計どおり。**

| SQL（`maxRecords=3` / truncate） | v3.32.0 | v3.33.0 |
|---|---|---|
| `COUNT(*) … WHERE 顧客No LIKE '%6%'` | **`0`**（真の値 3） | **エラー**（主語「集計の正しい結果」・reason `AGGREGATE`） |
| `SELECT DISTINCT 顧客No` | 部分集合 | **エラー**（主語「DISTINCT の正しい結果」・reason `DISTINCT`） |
| `SELECT 顧客No`（素の明細） | 3 行＋警告 | **3 行＋警告**（従来どおり＝**要件の本体**） |
| `COUNT(*)`（押し下げ完全・B94） | 18 | **18**（上限を使わないので無傷） |

**主語が「ORDER BY」と出ないこと**（受入 7）も実機で確認した。
**エラー文面は理由・上書きの明示・元の文言の 3 段**で、原因と対処が読み取れる。

```
集計の正しい結果には完全な候補集合が必要です。complete input reason: AGGREGATE。
onLimit=truncateは使用できません。取得件数が上限（3 件）を超えました。
WHERE 句で絞り込むか、maxRecords を引き上げてください。
```

## 10. 優先度

**急がない**（Pro は `"error"` で運用中）。

**しかも B94 でエラーになる場面自体が減っている**（絞り込みの無い `COUNT(*)` が上限に
当たらなくなったため）。**この依頼で買えるのは「明細ペインだけ行を出せるようにする」ところ。**

### 10.1 **Pro 側の K-37 が本件に依存している**

Pro は現在 `onLimitReached: "error"` で運用しているため、**§4 の `0` は表示されない**（エラーになる）。

**明細ペインのために `"truncate"` へ戻すなら、集計側の fail-closed がエンジンにあることが前提**
——という依存関係を Pro が K-37 に明記している。

**つまり本件が無い限り、Pro は `"truncate"` へ戻せない。**
「急がない」の中身は「安全側で止まったままにできる」であって、**要望が薄いという意味ではない。**
