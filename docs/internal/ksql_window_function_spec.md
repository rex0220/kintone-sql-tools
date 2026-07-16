# 仕様案: ウィンドウ関数サブセット `ROW_NUMBER` / `RANK` / `DENSE_RANK`（B17）

- 作成日: 2026-07-16
- 位置づけ: [主要 RDB 機能比較評価](ksql_sql_feature_comparison_evaluation.md) §3 T1-1 で「**最大の欠落**」と評価した機能。
- ステータス: **仕様案 R1（codex レビュー前）。未実装。**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md)

---

## 0. 先に訂正: 「1 文になる」は誤り。正しくは「**不可能 → 可能**」

比較評価 §3 T1-1 で次のように書いたが、**実機で確認したところ誤りだった**:

```sql
-- 評価文書に書いた「ウィンドウ関数があれば1文」  ← kSQL では動かない
SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY 顧客ID ORDER BY 受注日 DESC) AS rn FROM APP300) WHERE rn = 1;
```

**kSQL は派生テーブル（`FROM (SELECT …)`）に非対応**（実測: `ParseError: フィールド名またはテーブル名が必要です`）。よって B17 を入れても 1 文にはならず、**一時テーブル経由の 2 文**になる:

```sql
CREATE TEMP TABLE #ranked AS
SELECT 顧客ID, 受注日, 金額, ROW_NUMBER() OVER (PARTITION BY 顧客ID ORDER BY 受注日 DESC) AS rn
FROM APP300;

SELECT 顧客ID, 受注日, 金額 FROM #ranked WHERE rn = 1;
```

ただし**価値は下がらない。むしろ評価より大きい**。現状の `MAX()` 回避策は「最新行の**他列**が取れない」と書いたが、実機で確認した結果それは**回避不能**だった:

- **派生テーブル非対応**（上記）
- **JOIN が複合キー結合に非対応**（実測: `ON a.業種 = t.業種 AND a.顧客No = t.最新No` → `ParseError`（`AND` で落ちる）。JOIN は**単一等値のみ**）

`MAX()` で「グループごとの最大値」を出しても、**その値を持つ行へ結合して他列を取る手段がない**（結合には `(グループキー, 最大値)` の複合等値が要る）。したがって:

> **「各グループの最新 1 件を、その行の全列とともに取得する」は、現状の kSQL では表現できない。** B17 はこれを初めて可能にする。

## 1. 課題

主要 RDB がすべて持つウィンドウ関数が無く、次の定番が書けない:

| ユースケース | 現状 |
|---|---|
| **各顧客の最新受注 1 件（金額なども含む全列）** | **表現不可能**（§0） |
| 売上ランキング（同順位・順位飛ばし） | 表現不可能 |
| グループ内の連番付与 | 表現不可能 |

`MAX()` + `GROUP BY` で取れるのは「グループキーと最大値だけ」であり、その行の他の列は取れない。

## 2. 現状（コード裏取り済み）

### 2.1 FULL_SCAN のパイプライン

`runFullScan`（[process.ts:930 付近](../../src/engine/process.ts#L930)）は次の順で処理する:

```
1. flatten → 2. join → 3. filter(WHERE) → 4. GROUP BY+集計 → 5. HAVING
→ 6. DISTINCT → 7. ORDER BY → 8. LIMIT/OFFSET
```

SQL 標準のウィンドウ評価位置は **HAVING の後・DISTINCT/ORDER BY の前**。つまり **5 と 6 の間**に差し込む。

### 2.2 再利用できる基盤: `applyOrderBy`

`applyOrderBy`（[process.ts:503](../../src/engine/process.ts#L503)）は**ウィンドウの `ORDER BY` にそのまま使える設計**:

```ts
export function applyOrderBy(
  rows: ProcessRow[], orderBy: OrderByItem[],
  optionOrders?: OptionOrderMap,      // 選択系の「選択肢の定義順」
  sortKinds?: FieldSortKindMap        // number | string
): ProcessRow[]
```

- 行ごとにソートキーを前計算 → 比較 → 並べ替え。**パーティションごとに呼べば良い**。
- **`optionOrders` が重要**: ドロップダウン等は**選択肢の定義順**で並ぶ（辞書順ではない）。ウィンドウの `ORDER BY` もこれに揃えないと、同じ `ORDER BY 業種` がトップレベルとウィンドウで**違う順序**になる。

### 2.3 **罠: ソートメタが実際にはロードされない**（B13 P1-1 と同型）

`buildOrderByMetaForSelect`（[execute.ts:2684](../../src/execute.ts#L2684)）は**トップレベル `ORDER BY` が無ければ空 Map を返す**:

```ts
if (stmt.orderBy.length === 0) {
  return { optionOrders: new Map(), sortKinds: new Map() };   // ← 早期 return
}
```

`SELECT *, ROW_NUMBER() OVER (PARTITION BY 顧客ID ORDER BY 受注日 DESC) AS rn FROM APP300` は **`stmt.orderBy.length === 0`**（トップレベルに `ORDER BY` が無い）。このままだと `optionOrders` / `sortKinds` が空になり、**ウィンドウの `ORDER BY` が数値を辞書順で並べ、選択系を定義順で並べない**。

> **`buildSortKindsForSelect` / `buildOptionOrdersForSelect` 自体は物理アプリの全フィールドを読む**（[execute.ts:2727/2694](../../src/execute.ts#L2727)）ため、**ゲートを開けさえすればウィンドウの `ORDER BY` 列も自動的に含まれる**。修正は早期 return の条件だけで済む。

### 2.4 その他

| 項目 | 現状 |
|---|---|
| 派生テーブル `FROM (SELECT …)` | **非対応**（§0・実測） |
| JOIN の複合キー結合 | **非対応**（単一等値のみ・実測） |
| ソート種別リゾルバ | v2.14.0 の `AggregateSortKindResolver`（集約用）と、ORDER BY 用 `FieldSortKindMap` が併存。**ウィンドウは ORDER BY 用を使う**（`optionOrders` が要るため） |
| 実行モード | 集約列があれば FULL_SCAN。ウィンドウ関数も**同様に FULL_SCAN 強制**が必要 |

## 3. スコープ

| 区分 | 内容 |
|---|---|
| **対象** | `ROW_NUMBER()` / `RANK()` / `DENSE_RANK()` ＋ `OVER ([PARTITION BY …] [ORDER BY …])` |
| **対象** | SELECT 列でのみ使用可。FULL_SCAN 強制。一時テーブルへ実体化して `WHERE` で絞る運用（§0 の 2 文パターン） |
| **非対象（v2）** | 集計の `OVER`（`SUM(x) OVER (…)`）・フレーム句（`ROWS BETWEEN …`）・`LAG`/`LEAD`/`NTILE`/`FIRST_VALUE` |
| **非対象（別課題）** | 派生テーブル `FROM (SELECT …)`・`QUALIFY`・複合キー JOIN |
| **非対象（v1 の制限）** | `GROUP BY` / 集計関数との併用（§4.5） |

## 4. 仕様

### 4.1 構文

```
<ウィンドウ関数>() OVER ( [PARTITION BY <フィールド> [, …]] [ORDER BY <フィールド> [ASC|DESC] [, …]] ) [AS alias]
```

- 関数は `ROW_NUMBER` / `RANK` / `DENSE_RANK` の 3 つ。**引数なし**（`ROW_NUMBER(x)` は `ParseError`）。
- `OVER` は**必須**（`ROW_NUMBER()` 単独は `ParseError`）。
- `PARTITION BY` / `ORDER BY` はともに省略可。両方省略した `OVER ()` も可（= 全行 1 パーティション・行順）。
- `PARTITION BY` のキーは**フィールド参照のみ**（`GROUP BY` と同じ規則。式・関数は v1 非対応）。
- `ORDER BY` のキーは**トップレベル `ORDER BY` と同じ規則**（`OrderByItem` を再利用）。
- `OVER`・`PARTITION` は**ソフトキーワード**として扱い、同名フィールドを壊さない（`SEPARATOR` の前例）。`ROW_NUMBER` / `RANK` / `DENSE_RANK` は**予約語**（`KLIKE` / `GROUP_CONCAT` の前例。バッククォートで回避可）。

### 4.2 評価位置

**HAVING の後・DISTINCT の前**（SQL 標準）。`WHERE` はウィンドウより前に評価されるため、**`WHERE rn = 1` のようにウィンドウ結果を同じ文で絞ることはできない**（標準どおり）。一時テーブルへ実体化して次の文で絞る（§0）。

### 4.3 意味論

| 規則 | 内容 |
|---|---|
| **パーティション** | `PARTITION BY` のキー値が等しい行が 1 パーティション。**空文字も 1 つの値**として扱う（`GROUP BY` と同じ）。省略時は全行 1 パーティション |
| **並び** | パーティション内を `ORDER BY` で並べる。**`applyOrderBy` と完全に同じ比較規則**（`optionOrders` による選択肢定義順・`sortKinds` による数値/辞書順）を使う |
| `ROW_NUMBER()` | 1 から始まる連番。**同値でも連番**（1,2,3,4） |
| `RANK()` | 同値は同順位・**次は飛ぶ**（1,1,3,4） |
| `DENSE_RANK()` | 同値は同順位・**飛ばさない**（1,1,2,3） |
| **`ORDER BY` 省略時** | 全行が同値扱い。`RANK`/`DENSE_RANK` は全行 1。`ROW_NUMBER` は**行順**（＝取得順）で連番。順序保証が要るなら `ORDER BY` を書く |
| **戻り値** | 数値（1 以上の整数）。出力は他の列と同じく文字列化される |
| **`ORDER BY` の同値** | ROW_NUMBER の同値内の順序は**入力行順**（安定ソート）。決定性が要るなら一意になるキーを `ORDER BY` に足す |

### 4.4 型メタ（B14 との連携）

- ウィンドウ関数列は**常に数値**。B14 の `inferSelectColumnMeta` で `{ sortKind: "number" }` を宣言する（一時テーブルへ実体化後の `WHERE rn = 1` / `MAX(rn)` が数値として正しく効く）。

### 4.5 `GROUP BY` / 集計との併用は v1 非対応

同一 SELECT に `GROUP BY`・集計関数・ウィンドウ関数が混在する場合は **`ParseError`** とする。

- 理由: 標準では「集約後の行に対してウィンドウを適用」だが、`PARTITION BY` / `ORDER BY` が集約の出力列（alias・合成名）を参照する解決が必要になり、面が広がる。
- **看板ユースケース（各グループ最新 1 件・ランキング・連番）はいずれも `GROUP BY` を必要としない**ため、v1 の価値は損なわれない。
- 集約結果へ順位を付けたい場合は 2 文に分ける（`CREATE TEMP TABLE #agg AS SELECT … GROUP BY …;` → `SELECT *, RANK() OVER (ORDER BY 合計 DESC) FROM #agg;`）。**一時テーブル経由なら v1 でも書ける**。

## 5. 実装差分

| 箇所 | 変更 |
|---|---|
| `src/lexer/tokens.ts` | `ROW_NUMBER` / `RANK` / `DENSE_RANK` を予約語に。`OVER` / `PARTITION` は**ソフトキーワード** |
| `src/types/ast.ts` | `WindowColumn`（`type: "WINDOW_COL"`・`func`・`partitionBy: FieldRef[]`・`orderBy: OrderByItem[]`・`alias`）を `SelectColumn` へ追加 |
| `src/parser/parser.ts` | SELECT 列で `ROW_NUMBER()` 等を検出し `OVER (…)` を解析。**`OVER` 必須**・引数なし・`PARTITION BY` はフィールド参照のみ。`GROUP BY`/集計との併用は `ParseError`（§4.5） |
| **`resolveSelectMode`** | ウィンドウ列があれば **FULL_SCAN 強制**（集約と同じ扱い。`hasAggregateColumns` に相当する `hasWindowColumns` を追加） |
| **`buildOrderByMetaForSelect`（[execute.ts:2684](../../src/execute.ts#L2684)）** | 早期 return の条件を **`stmt.orderBy.length === 0 && ウィンドウの ORDER BY も無い`** へ変更（§2.3）。**これが無いと数値が辞書順で並ぶ** |
| `src/engine/process.ts` | `applyWindow(rows, columns, optionOrders, sortKinds)` を新設し、**HAVING と DISTINCT の間**で呼ぶ。パーティション分割 → **`applyOrderBy` でパーティション内を整列** → 採番。結果を各行へ `alias`（無ければ合成名）で書き込む |
| `selectToKintone.ts` の出力列収集 | ウィンドウ列の alias / 合成名を出力列として認識（`collectSelectOutputNames`） |
| `inferSelectColumnMeta`（B14） | ウィンドウ列 → `{ sortKind: "number" }`（§4.4） |
| 言語リファレンス | 新節を追加。**派生テーブル非対応のため 2 文パターン**であることと、`WHERE` でウィンドウ結果を絞れないことを明記 |

### 5.1 採番アルゴリズム（パーティションごと）

```
sorted = applyOrderBy(partitionRows, window.orderBy, optionOrders, sortKinds)
ROW_NUMBER: 1..n を順に付与
RANK / DENSE_RANK:
  直前行と ORDER BY キーが「等しい」なら同順位
  等しさの判定は applyOrderBy の比較器と同一（cmp === 0）＝ 並びと順位の判定がズレない
  RANK       → 次の順位 = これまでの行数 + 1
  DENSE_RANK → 次の順位 = 直前順位 + 1
```

> **重要**: 同値判定に**独自の比較を書かない**。`applyOrderBy` が使う比較器（`compareSortKeys`）を共有する。別実装にすると「並びは同値なのに順位が別」といった不整合が起きる。

## 6. 受入条件

- [ ] `ROW_NUMBER() OVER (PARTITION BY k ORDER BY d DESC)` がパーティションごとに 1..n を付ける。
- [ ] `RANK` は同値で同順位・次が飛ぶ（1,1,3）。`DENSE_RANK` は飛ばない（1,1,2）。`ROW_NUMBER` は同値でも連番（1,2,3）。
- [ ] **看板**: `CREATE TEMP TABLE #ranked AS SELECT …, ROW_NUMBER() OVER (PARTITION BY 顧客ID ORDER BY 受注日 DESC) AS rn FROM APP300;` → `SELECT * FROM #ranked WHERE rn = 1` で**各グループ最新 1 件が全列付きで取れる**。
- [ ] **数値の `ORDER BY` が数値順**（`ORDER BY 顧客No DESC` で 214 が 1 位。辞書順なら `"99"` になる）＝ §2.3 のゲート修正の回帰テスト。**トップレベル `ORDER BY` が無い SELECT で確認すること**。
- [ ] **選択系の `ORDER BY` が選択肢の定義順**（トップレベル `ORDER BY` と同じ並び）。
- [ ] `PARTITION BY` 省略（全行 1 パーティション）・`ORDER BY` 省略（`RANK` は全行 1）・`OVER ()` が動く。
- [ ] `PARTITION BY` の空文字が 1 グループとして扱われる。
- [ ] ウィンドウ列がある SELECT は **FULL_SCAN**（EXPLAIN で確認）。
- [ ] B14: 実体化後の `#ranked.rn` が**数値型**（`MAX(rn)` が数値順）。
- [ ] `ROW_NUMBER(x)`（引数あり）・`ROW_NUMBER()`（`OVER` なし）は `ParseError`。
- [ ] `GROUP BY` / 集計との併用は `ParseError`（§4.5）。
- [ ] `ROW_NUMBER` 等は予約語（`` `ROW_NUMBER` `` で同名フィールド参照可）。**`OVER` / `PARTITION` は通常のフィールド名として使える**。
- [ ] 既存の `ORDER BY` / 集計 / `GROUP_CONCAT` に回帰なし。

## 7. リスク・SemVer

- **SemVer: minor**。ただし**完全な後方互換ではない**: `ROW_NUMBER` / `RANK` / `DENSE_RANK` を予約語にするため、同名フィールドを裸で参照している既存クエリは壊れ得る。`KLIKE`（v2.8.0）・`GROUP_CONCAT`（v2.15.0）と同じ前例に従い minor とし、バッククォート回避を用意して CHANGELOG に明記する。
- **リスク（ソートメタのゲート）**: §2.3 を落とすと**静かに誤った順序**（数値が辞書順）で採番される。NaN のように目立たないため、受入条件で「トップレベル `ORDER BY` 無し」の数値順を必ず固定する。
- **リスク（比較器の二重実装）**: §5.1 のとおり `applyOrderBy` の比較器を共有する。独自実装すると並びと順位がズレる。
- **リスク（性能）**: パーティションごとのソートで O(N log N)。FULL_SCAN 前提（既に全件 JS 保持）なので新たな API コストは無い。
- **リスク（利用者の期待）**: `WHERE rn = 1` が同じ文で書けない（標準どおりだが、派生テーブルが無いぶん驚きが大きい）。言語リファレンスで 2 文パターンを明示する。

## 8. スコープ外・後続

- **集計の `OVER`**（`SUM(x) OVER (PARTITION BY …)`）とフレーム句（`ROWS BETWEEN …`）: 累計・移動平均。v2。
- **`LAG` / `LEAD`**（前月比）・`NTILE` / `FIRST_VALUE` / `LAST_VALUE`。
- **派生テーブル `FROM (SELECT …)`**: これが入ると本機能が 1 文で書けるようになる（§0）。**独立した価値が大きい別課題**として起票候補。
- **`QUALIFY`**（ウィンドウ結果での絞り込み専用句）: Snowflake 等にはあるが MySQL/Oracle/SQL Server には無いため優先度低。
- **`GROUP BY` との併用**（§4.5）。
