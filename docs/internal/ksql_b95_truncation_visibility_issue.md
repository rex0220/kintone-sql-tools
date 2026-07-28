# B95 取得上限で打ち切られたことが結果から分からない／集計が誤った数を返す

- 起票: 2026-07-29
- ステータス: 📝 **評価・起票（優先 中）**
- 出典: [Pro からの報告 2026-07-29](../../../ksql-dashboard-pro/docs/internal/kSQLエンジンへの報告-v3311-統合版.md) §9（依頼④）
- 関連: [B94 `COUNT(*)` の単発取得](ksql_b94_count_star_totalcount_issue.md) / [B72 §7.2](ksql_b72_relative_date_fullscan_exact_spec.md) / [B73 エラーの構造化](ksql_b73_error_structured_i18n_evaluation.md)

## 1. Pro からの相談

`onLimitReached: "truncate"` で実行していたところ、

> **実件数 10,228 のアプリで `SELECT COUNT(*)` が `10000` を返し**、
> KPI カードに誤った数字が大きく表示された（**警告は出るが、数字自体が誤り**）

`"error"` へ切り替えて解決したが、**`"truncate"` のまま「集計だけエラー・明細は行＋警告」に
分けたい**。しかし**結果から「打ち切られたか」を判別する手段がない。**

| 材料 | 判別に使えるか |
|---|---|
| `warnings`（`readonly string[]`） | **文言照合になる**。多言語・版数変更で壊れる |
| `metrics.fetchedRows`（`number`） | **全アプリの合算だった** |

**要望＝`QueryResult.metrics` に打ち切りの有無を構造化して足す。**

```ts
metrics: {
  …
  /** 取得上限に達したアプリ。空なら打ち切りなし */
  limitReachedApps?: readonly number[];
}
```

> Pro は「`boolean` 1 個でも足りるが、アプリ単位だと『APP912 が上限に達しました』と
> メッセージに出せる」としている。**急がない**（`"error"` で解決済み）。

## 2. Pro の観察はすべて正確（コードで確認）

| Pro の主張 | 確認 |
|---|---|
| 判定は**アプリ単位** | ✅ [`fetchAll`](../../src/api/fetchAll.ts#L123) が `allRecords.length > maxRecords` を**取得ごと**に判定 |
| `fetchedRows` は**合算** | ✅ [execute.ts:819](../../src/execute.ts#L819) が client wrapper で `metrics.fetchedRows += res.records.length` |
| 判別手段が**文言しかない** | ✅ `onTruncate` は**警告文字列を組み立てるだけ**（[3103](../../src/execute.ts#L3103) / [4933](../../src/execute.ts#L4933)） |

```ts
// execute.ts:4933 — 打ち切りを検出しているが、警告文にするだけ
const onTruncate = (max: number): void => {
  warnings.add(`取得上限（${max} 件）に達したため、${max} 件で打ち切って表示しています。`);
};
```

### 2.1 アプリ ID は**その場で手に入る**

`onTruncate` の引数は `max` だけだが、**呼び出し側は対象テーブルを知っている**
（[`fetchTableRecordsForFullScan`](../../src/execute.ts#L4930) は `table` を受け取り `table.appId` を持つ）。

**深い配管は要らない。**コールバックで拾って集めるだけで `limitReachedApps` は作れる。

## 3. **より重い問題＝集計が誤った数を黙って返す**

**Pro の症状の本体はこちら。**`10,228` 件のアプリで `COUNT(*)` が `10000` を返した。

**`COUNT(*)` は「完全な入力」の強制対象に入っていない。**

```ts
// dmlGuard.ts:85 — 強制対象は統計集計だけ
const STATISTICAL_AGGREGATES = new Set([
  "STDDEV_POP", "STDDEV_SAMP", "VAR_POP", "VAR_SAMP", "MEDIAN", "MODE",
]);
```

`STDDEV` などは**打ち切られた入力では意味を成さない**として fail-closed になっているが、
**`COUNT` / `SUM` / `AVG` は素通り**する。

### 3.1 B94 が直すのは一部だけ

[B94](ksql_b94_count_star_totalcount_issue.md)（未リリース）で
`COUNT(*)` は `maxRecords` を適用せず 1 リクエストで数えるようになったが、
**適用条件を外れる形では従来どおり全件取得**であり、**打ち切られた入力を数える経路は残る。**

- BYO クライアントが `totalCount` を返さない／不正値（フォールバック）
- `JOIN` を含む
- `GROUP BY` / `HAVING` / `DISTINCT` / `LIMIT` / `OFFSET`
- CTE・一時テーブル・サブテーブル仮想テーブル由来
- **`SUM` / `AVG` など `COUNT(*)` 以外の集計**（B94 の対象外）

### 3.2 判断の前例は既にある

[B72 §7.2](ksql_b72_relative_date_fullscan_exact_spec.md) は、打ち切りについてこう決めている。

> 既存契約を local 集計へそのまま適用すると**部分集計を成功結果として返し得る**。
> … **`SearchAbortedError`** とする。…**緩和しない**。

**同じ理屈が `maxRecords` の打ち切りにも当てはまる。**
違うのは、**検索打ち切りは kintone 側の都合**であるのに対し、
**`truncate` は利用者が明示的に選んだ**という点。**ここが判断の分かれ目になる。**

## 4. 対応案

### 4.1 案 A — Pro の要望どおり `metrics` へ構造化して足す

`limitReachedApps?: readonly number[]` を `QueryMetrics` へ純加法で追加。

- **Pro が求めているものそのもの**
- **`code` を変えない**ので [B73](ksql_b73_error_structured_i18n_evaluation.md) の制約に触れない
- 実装は浅い（§2.1）
- **ただし「誤った数が返る」ことは直らない。**利用者が自分で分岐する必要がある

### 4.2 案 B — 打ち切られた入力の集計を fail-closed にする

`COUNT` / `SUM` / `AVG` などを、統計集計と同じ「完全な入力」強制の対象にする。

- **根本的**。KPI に誤った数が出ることが構造的に無くなる
- **ただし挙動の変更**＝`truncate` を選んだ利用者の集計クエリが失敗するようになる
- **`truncate` は利用者が明示的に選んだもの**なので、
  「選んだのに勝手にエラーにする」と受け取られ得る

### 4.3 案 C — A と B の併用（推奨）

**まず案 A を出し、案 B は別途 判断する。**

理由:

- **案 A は純加法で、誰も困らない。**Pro は今日すぐ使える
- **案 B は契約変更**で、Pro 以外の利用者にも影響する。**単独で評価すべき**
- **B94 が既に一部を解消している**ので、案 B の残り範囲を測ってから決めたほうがよい

## 5. 決めること（案 A）

1. **`boolean` か アプリ ID の配列か。**Pro は「`boolean` でも足りるが、アプリ単位だと
   メッセージに出せる」としている。**アプリ ID はその場で手に入る**（§2.1）
2. **バッチでの形。**`runBatch` の各 `results[]` に載せるか、バッチ全体か
   （**metrics は文別計測ではなくバッチ全体集計**という既存の注意書きがある）
3. **カーソル経路でも同じ情報が取れるか**（本調査では未確認）
4. **MCP / CLI の envelope にも出すか**（Pro はライブラリ利用者だが、MCP でも同じ問題は起きる）

## 6. 規模

- 案 A（実装＋テスト＋公開型の追加）: 0.5〜0.75 人日
- 案 B（評価のみ）: 0.25 人日

**案 A は SemVer=minor（純加法）。**

## 7. 優先度の根拠

**Pro は急いでいない**（`"error"` で解決済み）。

一方で **§3 は silent wrong result** であり、**KPI という最も目に付く場所に誤った数字が出た**
という実例がある。**B78 / B79 / B86 と同じ系列**として扱うべきかを、案 B で判断する。

### 7.1 実測（2026-07-29・実 kintone APP4147・18 件）

**`COUNT` / `SUM` / `AVG` の 3 つとも誤った値を返す。**警告は 1 行だけ。

```
SELECT COUNT(*) AS 件数, SUM(顧客No) AS 合計, AVG(顧客No) AS 平均 FROM APP4147
```

| | `maxRecords=5`（truncate） | 実際（`maxRecords=1000`） |
|---|---:|---:|
| 件数 | **5** | 18 |
| 合計 | **17** | 51 |
| 平均 | **3.4** | 2.8333… |

warnings: `取得上限（5 件）に達したため、5 件で打ち切って表示しています。`

**平均が特に危うい。**件数と合計は「少ないな」と気づく余地があるが、
**平均は値域が変わらないため、誤っていても見た目に違和感が無い。**
