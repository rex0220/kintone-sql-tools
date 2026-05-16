# ON 条件による REST API 呼び出し増大：原因と対策

## 背景

JOIN クエリは kintone API が直接サポートしないため、FULL_SCAN モードで実行される。
各テーブルを個別に API から取得し、JavaScript 側で結合・フィルタする構成になっている。

---

## 原因：ON 最適化のチャンク分割

### ON 最適化とは

JOIN 先テーブルの全件取得を避けるため、結合キーの値セットを IN 句として API に渡す最適化。

```sql
SELECT a.顧客No, a.会社名, b.案件名
FROM APP4148 AS a
INNER JOIN APP4149 AS b ON a.顧客No = b.顧客No_
WHERE b.商談フェーズ IN ('提案中', '内示', '受注')
  AND a.顧客ランク IN ('A')
```

```
① APP4148 を全件取得（顧客ランク フィルタあり）
② ①の結果から 顧客No_ のユニーク値を収集
③ APP4149 に IN 句で絞り込みリクエスト
   → 顧客No_ in ("v1","v2",...,"v50")   ← 50件ずつチャンク
```

### チャンク上限

| 定数 | 値 | 意味 |
|---|---|---|
| `JOIN_IN_CHUNK_SIZE` | 50 | 1リクエストあたりの IN 値数 |
| `JOIN_IN_MAX_CHUNKS` | 6 | 最大チャンク数 |
| `JOIN_IN_MAX_KEYS` | 300 | ON 最適化の上限キー数 |

### 問題：キー数に比例して API 呼び出しが増える

| 顧客ランク='A' の顧客数 | ON 最適化の挙動 | API 呼び出し数（APP4149） |
|---|---|---|
| 〜50件 | 1チャンク | 1回 |
| 51〜100件 | 2チャンク | 2回 |
| 151〜300件 | 最大6チャンク | 6回 |
| **300件超** | **フォールバック（全件取得）** | **案件数 / 500 回** |

300件超でフォールバックが発生すると、APP4149 に10万件ある場合は
**200回以上の API 呼び出し**が発生する。

### 実際の API リクエスト例（300件超フォールバック時の警告）

```
JOINキーが 312 件のため ON 最適化をスキップし、JOIN先を全件取得します（上限 300 件）。
```

---

## 対策

### 案1：push-down 条件がある JOIN テーブルは ON 最適化をスキップ ✅ 実装済み

JOIN テーブルに WHERE push-down 条件がある場合、ON 最適化（IN 句チャンク）を使わず
push-down 条件のみで直接フェッチする。

```
Before: APP4148(filtered) → キー収集 → APP4149(IN×N回)
After:  APP4149(push-down のみ) ← 1回のフェッチで完結
```

**効果：** push-down 条件が絞り込める場合は API 呼び出しが大幅に減少  
**限界：** push-down 後の JOIN テーブルが大量レコードの場合は fetch 回数が増える可能性あり

---

### 案2：push-down ありの JOIN テーブルをメインと並列フェッチ ✅ 実装済み

push-down 条件がある JOIN テーブルはメインテーブルの完了を待たず、同時にフェッチ開始する。

```
Before: APP4148 fetch → (完了待ち) → APP4149 fetch（直列）
After:  APP4148 fetch ─並列─ APP4149 fetch（並列）
```

**効果：** ウォール時間を短縮（API 回数は案1と同じ、レスポンス時間が半減に近づく）

---

### 案3：フェッチ順序の動的切り替え（未実装）

push-down 後のレコード数が少ない方のテーブルを先にフェッチし、
そのキーを ON 最適化の IN 句に利用する。

```
例: 顧客ランク='A' → 5件、商談フェーズ=... → 200件
  現状: APP4148(5件) → キー5個 → APP4149(IN 1回) ← すでに効率的
  動的切替の効果は限定的

例: 顧客ランク='A' → 500件、商談フェーズ=... → 10件
  現状: APP4148(500件) → キー500個 → ON 最適化フォールバック → 全件取得
  動的切替: APP4149(10件)を先にフェッチ → キー10個 → APP4148(IN 1回) ← 大幅削減
```

**効果：** どちらの条件が弱くても最適な方向でフェッチできる  
**課題：** 実際のレコード数は取得前に不明（推定ロジックが必要）、実装コスト高

---

## 実装後の動作まとめ

### push-down 条件あり（案1+案2 適用）

```
APP4148 fetch (顧客ランク in ("A"))     ─┐
APP4149 fetch (商談フェーズ in (...))   ─┘ 並列
                                          ↓
                               JavaScript で JOIN（ON 条件）
```

| | API 呼び出し数 | 並列性 |
|---|---|---|
| v1.1.1 以前 | 1（main）+ 最大6（JOIN チャンク） | 直列 |
| v1.1.2 以降 | 1（main）+ 1（JOIN） | 並列 |

### push-down 条件なし（ON 最適化を維持）

```
APP4148 fetch → キー収集 → APP4149(IN チャンク × N 回)
```

ON 最適化の恩恵（絞り込み）が活きるため、従来通りの動作を維持する。

---

## push-down できる条件の判定基準

| 条件の種類 | push-down 可否 | 理由 |
|---|---|---|
| `a.field = value` / `!=` / `>` / `<` / `>=` / `<=` | ✅ 可 | kintone API サポート済み |
| `a.field LIKE value` | ✅ 可 | kintone API サポート済み |
| `a.field NOT LIKE value` | ✅ 可 | kintone API サポート済み |
| `a.field IN (...)` | ✅ 可 | kintone API サポート済み |
| `a.field NOT IN (...)` | ✅ 可 | kintone API サポート済み |
| `a.field IS NULL / IS NOT NULL` | ✅ 可 | kintone API サポート済み |
| `AND`（同一テーブルの条件） | ✅ 可 | 分割して各 API に適用 |
| `OR`（異なるテーブルにまたがる） | ❌ 不可 | 分離すると結果が変わる |
| `a.field = b.field`（クロステーブル） | ❌ 不可 | JOIN 後でないと評価不可 |
| `UPPER(a.field) = value` 等（関数付き） | ❌ 不可 | kintone API 非対応 |

**原則：`whereToKintone` が変換できる演算子 = push down 可**

---

## 関連ファイル

| ファイル | 役割 |
|---|---|
| `src/core/optimization/wherePredicatePushdown.ts` | push-down 条件の分離ロジック |
| `src/execute.ts` — `executeFullScanSelect` | テーブルごとの条件計算・並列フェッチ制御 |
| `src/execute.ts` — `fetchTableRecordsForFullScan` | push-down 条件を kintone query に組み込む |
| `src/execute.ts` — `tryFetchJoinRecordsBySourceKeys` | ON 最適化（push-down なし時に使用） |
