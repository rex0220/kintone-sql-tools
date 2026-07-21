# B51 — 複数 CTE の CTE 間 JOIN が誤結果を返す

- 起票日: 2026-07-21
- ステータス: **root-cause 特定・実データ検証済み・修正方針 R1・実装着手可（2026-07-21・codex 調査→Claude 検証・fix ブランチ fix/b51-cte-join-alias）**
- 種別: バグ（正しさ・silent wrong results）
- 優先度: **高**（結果が静かに壊れる＝誤ったデータで判断/書き戻しの危険）
- 発見の経緯: B6（外部結合の KLIKE 押し下げ）の回避策検討で「一時テーブルの代わりに WITH でも同様にできるのでは？」という問いを実データで検証したところ、WITH（複数 CTE の CTE 間 JOIN）が KLIKE と無関係に誤結果を返すことが判明。

## 症状

**2つ以上の CTE を定義し、CTE 同士を JOIN すると、左 CTE の投影列が空になり、行が重複し、行数も誤る。** 右 CTE の列は正しい。LEFT JOIN では未一致行（NULL 埋め対象）も消える。同一論理を一時テーブル（`CREATE TEMP TABLE`）で書くと正しい結果になるため、CTE 間 JOIN の実行経路固有の不具合。

## 最小再現（本番 kintone・APP730・CLI v3.10.0）

```sql
WITH a AS (SELECT レコード番号 AS aid FROM APP730 WHERE レコード番号 IN (1,2,3)),
     b AS (SELECT レコード番号 AS bid, 郵便番号 AS bzip FROM APP730 WHERE レコード番号 IN (1,2))
SELECT a.aid, b.bid, b.bzip FROM a INNER JOIN b ON a.aid = b.bid
```

- 期待: 2 行（aid/bid=1,2・bzip あり）。
- 実際: **4 行**・`a.aid` が**空**・各行が 2 倍重複。
  ```
  aid,bid,bzip
  ,1,5008334
  ,2,5020834
  ,1,5008334
  ,2,5020834
  ```

### LEFT JOIN でも同様（未一致行が消える）

```sql
WITH a AS (SELECT レコード番号 AS aid, 都道府県 AS apref FROM APP730 WHERE レコード番号 IN (1,2,3)),
     b AS (SELECT レコード番号 AS bid, 郵便番号 AS bzip FROM APP730 WHERE レコード番号 IN (1,2))
SELECT a.aid, a.apref, b.bzip FROM a LEFT JOIN b ON a.aid = b.bid
```
- 期待: 3 行（1,2 は bzip あり・3 は NULL）。
- 実際: 4 行・`a.aid`/`a.apref` 空・3（未一致）欠落・重複。

## 対照（同一論理を一時テーブルで＝正しい）

```sql
CREATE TEMP TABLE #a AS SELECT レコード番号 AS aid, 都道府県 AS apref FROM APP730 WHERE レコード番号 IN (1,2,3);
CREATE TEMP TABLE #b AS SELECT レコード番号 AS bid, 郵便番号 AS bzip FROM APP730 WHERE レコード番号 IN (1,2);
SELECT a.aid, a.apref, b.bzip FROM #a a LEFT JOIN #b b ON a.aid = b.bid
```
- 実際: **正しい** 3 行（`1,岐阜県,5008334` / `2,岐阜県,5020834` / `3,岐阜県,`（NULL））。

## 観察・切り分け

- **KLIKE とは無関係**（KLIKE を含まない `IN` フィルタでも再現）。
- **左 CTE の列だけが空**（`a.aid`/`a.apref`）・右 CTE の列は正しい → CTE 間 JOIN での**左辺 CTE 行の列投影 or 別名解決**が疑わしい。
- **行の重複・LEFT 未一致行の欠落** → JOIN の**カーディナリティ/マッチング**も壊れている（左キーが空になり join 条件が誤評価されている可能性）。
- 一時テーブル版は正しい → 実体化テーブルの JOIN 経路は健全で、**CTE（特に複数 CTE の CTE 間 JOIN）の実行経路**に固有。
- 単一 CTE の実アプリ JOIN はインライン化で別経路になり得る（本 issue は複数 CTE の CTE 間 JOIN に焦点）。

## 影響

- **silent wrong results**（エラーにならず誤った行/列を返す）。誤ったデータで判断したり、`UPDATE ... FROM` / 書き戻しに使うと誤書き込みにつながり得る（最も警戒すべき事象）。
- 回避策: **CTE 間 JOIN を一時テーブル（`CREATE TEMP TABLE ... AS SELECT`）に置き換える**（実データで正しさ確認済み）。B6 の KLIKE 外部結合回避策も一時テーブルを使う（WITH は本 issue のため不可）。

## Root-cause（codex 調査・Claude 実データ検証済み 2026-07-21）

**核心＝実体化ソース（CTE/一時テーブル）参照が明示 alias を持たないと `alias: null` になり、JOIN で識別子衝突と修飾キー欠落を起こす。**

1. パーサは物理アプリには**テーブル名を既定 alias** にするが、CTE/一時テーブルは明示 alias がないと `alias: null` のまま（[parser.ts:1823](../../src/parser/parser.ts#L1823)）。
2. 最終 JOIN で CTE 行を `tables` Map に `stmt.from.alias`/`join.table.alias` をキーで格納（[execute.ts:3577](../../src/execute.ts#L3577)）→ `FROM a JOIN b`（暗黙 CTE 名）は両方 `null` → `tables.set(null, a)`→`tables.set(null, b)` で **a が b に上書き**（メイン・右辺とも b）。
3. alias が null なので `flatten`（[process.ts:78](../../src/engine/process.ts#L78)）が修飾キー `a.aid` を作らず bare キーのみ。`applyJoin` は ON の `a.aid`/`b.bid` を要求するが欠落→`?? ""`（[process.ts:109](../../src/engine/process.ts#L109)）で**全行が空文字一致→`b×b` 直積**（実測「期待2行→4行」に一致）。
4. 投影で `a.aid`→修飾も bare も未発見で空、`b.*`→bare が存在し正常（`resolveFieldRef` フォールバック [evalFunc.ts:599](../../src/engine/evalFunc.ts#L599)）。LEFT 未一致行が消えるのは左入力が上書き後の b・かつ全行空文字一致で未一致分岐に入らないため。

**確定した予測（実データ検証済み）**: CTE JOIN に明示 alias を付けると正常になる。
```sql
-- 正常（回避策）: FROM a AS a LEFT JOIN b AS b ON a.aid = b.bid → 3行（未一致は NULL）
```
一時テーブルが正しく見えたのは、比較 SQL が `FROM #a a LEFT JOIN #b b` と明示 alias 付きだったため（temp は `#a.col` 修飾が構文上できず alias 必須＝構造的に B51 を回避）。「CTE と temp の実体化方式の差」ではない。

**関連2欠陥**:
- **①（別 root-cause）**: 単一 CTE＋列別名・JOIN なしの `unknown field code(s): aid`＝`canInlineSingleCte`/`buildInlinedQuery`（[cteInlining.ts:18](../../src/core/cteInlining.ts#L18)）が CTE 出力別名（`aid→レコード番号`）を物理フィールドへ写像しないため。**schema 対応インライン化 or 別名/式ありCTEをインライン不可にする**別パッチ（B52 候補）。error で返る（silent でない）。
- **②（B51 と同系統）**: 単一 CTE→実アプリ JOIN の不一致は左 CTE alias null が原因（本体修正で解消）。

## 修正方針（R1）

1. **effective alias 導入**: CTE/一時テーブル参照は `effectiveAlias = table.alias ?? table.cteName` を実行経路全体で共有（`tables.set`・`runFullScan` のメイン/JOIN alias・JOIN ON の修飾解決・WHERE/SELECT/ORDER BY/GROUP BY の列解決・メタデータ）。明示 alias 優先。パーサで単純に `alias=cteName` にすると `SELECT * FROM c` で修飾列露出のリスク→**実行時に「識別用 alias」と「出力列の見せ方」を分ける**。
2. **fail-closed**: `tables.set` 前に effective alias 衝突検査・`cteCache` miss を空配列でなく明確なエラーに。
3. **applyJoin の欠落キー**: 「空文字値」と「キー不存在」を区別し、非空入力で ON 参照列が構造的に無ければ**明確なエラー**（silent wrong results の増幅を止める）。0行テーブルは保存済み `columns` で検証。
4. **①（別パッチ）**: schema 対応インライン化、短期は別名/式ありCTEをインライン不可に。B51 本体（silent 修正）と分けてよい。

## 次アクション

1. root-cause 調査（複数 CTE の CTE 間 JOIN の列投影・別名解決・JOIN カーディナリティ・CTE インライン化/実体化の分岐）。codex 調査→仕様/修正計画→実装→レビュー→実データ再現の pass/fail 固定→リリース。
2. 少なくとも**誤結果を返す代わりに明確なエラー**にする（silent wrong results の即時緩和）か、正しく実行できるよう修正する。
3. 単一 CTE・INNER/LEFT/RIGHT・別名有無・同一アプリ/別アプリ・列衝突有無の直積で再現範囲を確定（実データで全件流す）。
