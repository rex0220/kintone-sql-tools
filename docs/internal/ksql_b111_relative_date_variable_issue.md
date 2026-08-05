# B111 変数に相対日付関数トークンを束縛する（`DECLARE` 側で宣言する形）

- 起票: 2026-08-02
- ステータス: ✅ **完了（v3.39.0 でリリース）**（2026-08-02・受入 §7.8 の 9 点を実測確認）。**Pro は同日に取り込み・バー連携まで実装**（[報告 2026-08-02d](../../../ksql-dashboard-pro/docs/internal/kSQLエンジンへの連絡-20260802d-送付版.md)）＝仕様は §7
- 出典: [Pro の相談 2026-08-02c](../../../ksql-dashboard-pro/docs/internal/kSQLエンジンへの連絡-20260802c-送付版.md)（K-6 変数コントロールバー・**急ぎではない**が、利用者に教える SQL の形が変わるためリリース前に方向だけ求められた）
- 関連: B67 / B72 / B75（相対日付関数）/ 変数 Phase 1a〜1c（[batch-variables](ksql_batch_variables_phase1a_spec.md) は memory）/ B102（DML fail-closed の前例）

## 1. 依頼の内容

変数の値が**ホワイトリストの相対日付関数トークン**（`THIS_MONTH()` / `FROM_TODAY(-1, MONTHS)` 等）に
一致する場合、文字列ではなく**関数として束縛して押し下げてほしい**。

```sql
SELECT ... FROM APP4149 WHERE 受注予定日 = @period;
-- variables: { period: "THIS_MONTH()" } → 受注予定日 = THIS_MONTH() として押し下げ
```

Pro の狙い＝①SQL が単一条件になる ②**日時フィールドの終端取りこぼしが消える**
③「今」の基準が kintone サーバー（利用者の TZ 設定）に一致する ④`FROM_TODAY` で
ローリング窓をプリセットにできる。

## 2. 実測（2026-08-02・MCP v3.38.0 / CLI）

### 2.1 依頼文の前提が 1 つ成り立たない

「現行でも `NOW()` / `TODAY()` は既定値に書ける、の拡張」という前提は成立しない。

```
DECLARE @period = THIS_MONTH();   → ParseError（DECLARE 右辺で相対日付関数は使えない）
DECLARE @period = TODAY();        → 通る。ただし別物
```

**`TODAY()` は綴りが同じで意味が 2 つある**（位置で決まる）:

| 書き方 | 実際の kintone クエリ |
|---|---|
| `WHERE 受注予定日 = TODAY()` | `受注予定日 = TODAY()`（**サーバー評価**・B67 の押し下げ） |
| `DECLARE @p = TODAY(); WHERE 受注予定日 = @p` | `受注予定日 = "2026-08-02"`（**クライアント評価のリテラル**） |

拡張の出発点ではなく、**既存の罠**（既定値に書くと静かにホスト時計・ホスト TZ 基準になる）。
**§6 の文書化候補。**

### 2.2 実害（日時フィールドの終端取りこぼし）は engine 変更なしで解決できる

APP4149 実データ（全 20 件・最終作成 `2026-07-14T06:04:00Z`）:

```
作成日時 <= '2026-07-14'             → 18 件（ご指摘のとおり取りこぼす）
作成日時 <= '2026-07-14T23:59:59Z'   → 20 件（正しい）
```

**RFC3339 文字列は `variables` 経由でもそのまま `EXACT_PUSHDOWN` で通る**（EXPLAIN 確認）。
→ **Pro の MVP は「日時フィールドでは使えない」という制限なしにリリースできる。**

### 2.3 相対日付関数は日時フィールドでも効く

`作成日時 = THIS_MONTH()`（CREATED_TIME）→ `EXACT_PUSHDOWN`。拡張の価値自体は本物。

## 3. 方向（回答済み・オーナー承認）

**採用の方向で検討する。ただし「値が関数になる」形は採らない。**

### 3.1 なぜ暗黙解釈を採らないか

- **値束縛の保証は「値は決して code にならない」こと**で、これが閲覧者入力を安全にしている。
  暗黙解釈はこの保証を壊す
- **DML 面で fail-open になる**＝`DELETE FROM APPn WHERE 日付 = @period` が、注入値ひとつで
  単日削除から年間削除に変わりうる。**B102（`PRIMARY_ORGANIZATION()` を DML で fail-closed に
  した件）と同じ形**
- グローバルな opt-in フラグも採らない＝同じ SQL がフラグで意味を変えるのは、
  **B107 で却下した「定義済みのときだけ解決」と同じ形**

### 3.2 採る形＝SQL 側で宣言する（Pro 案の後者「値の型注釈」）

```sql
DECLARE @period RELATIVE_DATE = THIS_MONTH();   -- 構文は要検討
SELECT ... FROM APP4149 WHERE 受注予定日 = @period;
```

- SQL を読めば `@period` が関数トークンを持つと分かる（**隠れモードなし**）
- ホワイトリスト外の値は **API 呼び出し前に名前入りエラー**（fail-closed）
- **既存 SQL は 1 つも意味が変わらない**＝純加法。Pro の互換性懸念（`'THIS_MONTH()'` という
  文字列を検索したい利用者との衝突）が消える
- **DML では拒否**（B102 の前例）。Pro のライブラリは read-only なので影響なし

### 3.3 実装の見通し

- **変数解決は planning より前**（`resolveBatchVariableReferences` が VARIABLE ノードを
  リテラルへ差し替える）。ここで**相対日付関数の AST ノードへ差し替えれば、
  既存の B67 / B72 / B75 の押し下げ判定と fail-closed 規則がそのまま効く**
  （新しい能力判定は不要）。これが本件が安く付く理由
- **トークンの解釈は既存パーサを再利用する**＝`FROM_TODAY(n, unit)`・`THIS_MONTH([日])`・
  `THIS_WEEK([曜日])` は引数を取るので「完全一致のホワイトリスト」では足りない。
  **文法の二重管理を避ける**（B107 の単一ソース化と同じ判断）
- `DECLARE` の右辺で相対日付関数を受けられるようにする（現行は ParseError・§2.1）

## 4. やらないこと（現時点）

- 値の内容で code / data を切り替える暗黙解釈（§3.1）
- グローバルフラグによる opt-in（§3.1）
- 任意区間の関数化（トークンで表せない。Pro も 2 変数のハイブリッドで使う想定）

## 5. 優先度・進め方

**低〜中・実需待ち。** Pro には**代替手段があり**（2 変数形＋日時は RFC3339）、
リリースをブロックしない。**2 変数形は今後も動き続ける**ため、後から単一変数形へ
移っても利用者の学び直しは「任意の書き換え」で済む。

**→ 2026-08-02・オーナー決定で v3.39.0 として実装する**（B112 と同梱。上記は起票時の評価）。

## 6. 副産物（本件と独立に価値がある文書化）

`DECLARE @p = TODAY()` と `WHERE d = TODAY()` の意味の違い（§2.1）と、
**日時フィールドの境界は RFC3339 で書く**こと（§2.2）を言語リファレンスへ追記する。
B111 の実装可否によらず有効。**→ §7.6 の文書作業に含める。**

---

## 7. 仕様（2026-08-02・v3.39.0）

### 7.1 構文

```sql
DECLARE @period RELATIVE_DATE = THIS_MONTH();
SELECT ... FROM APP4149 WHERE 受注予定日 = @period;
-- variables: { period: "THIS_YEAR()" } / CLI: --var period="FROM_TODAY(-1, MONTHS)"
```

| | |
|---|---|
| 型注釈 | 変数名の直後・`=` の前に置く。**`RELATIVE_DATE` は soft keyword**（現行この位置には `=` しか来られないため曖昧さは無い。同名フィールド・別名は従来どおり使える） |
| 既定値 | **必須**（現行 `DECLARE` と同じ）。§7.2 のトークンのみ。リテラル・算術・文字列関数は**不可** |
| 注入値 | §7.2 のトークン文字列。**注釈なしの `DECLARE` の挙動は一切変えない**（従来どおり文字列束縛） |
| 名前規則 | 現行と同じ（`@[A-Za-z_][A-Za-z0-9_]{0,63}`・小文字正規化・R05 不変） |

### 7.2 受け付けるトークン（14 個）

**日付系の kintone クエリ関数だけ。**

- 引数なし: `TODAY()` / `NOW()` / `YESTERDAY()` / `TOMORROW()` / `THIS_YEAR()` / `LAST_YEAR()` / `NEXT_YEAR()`
- 引数あり: `FROM_TODAY(n, DAYS|WEEKS|MONTHS|YEARS)` / `THIS_WEEK([曜日])` / `LAST_WEEK([曜日])` /
  `NEXT_WEEK([曜日])` / `THIS_MONTH([日\|LAST])` / `LAST_MONTH([日\|LAST])` / `NEXT_MONTH([日\|LAST])`
- **不可**: `LOGINUSER()` / `PRIMARY_ORGANIZATION()`（日付ではない。後者は kintone 側が fail-open）

**解釈は既存パーサを再利用する**（引数の範囲・単位・曜日・`LAST` の検証を二重管理しない。
B107 の単一ソース化と同じ判断）。**トークン全体が消費されること**を要求し、前後に余分な字句が
あるものは受け付けない。

### 7.3 置き換えの縫い目

**`resolveBatchVariableReferencesInternal`（`src/execute.ts:2023-2040`）で、`VARIABLE` ノードを
`STRING` / `NUMBER` ではなく `KINTONE_FUNC` ノード（`RelativeDateFunction` / `LegacyKintoneFunction`）へ
差し替える。** 変数解決は planning より前なので、**既存の B67 / B72 / B75 の押し下げ判定・
capability 判定・fail-closed 規則がそのまま効く**（新しい判定を足さないこと）。

### 7.4 配置制限（**静的・API 呼び出し前**）

`RELATIVE_DATE` 変数は、**相対日付関数そのものが書ける位置だけ**で使える。

| | |
|---|---|
| 使える | **WHERE の比較右辺**（A01 相当）と **BETWEEN の境界** |
| 使えない | HAVING / CHECK / CASE・IF 条件 / KLIKE 右辺 / IN リスト要素 / SELECT 定数列 / UPDATE SET 値 / ASSERT / 算術オペランド（A02〜A14 の残り全部） |

- 違反は **`src/core/batch.ts` の参照収集（:160 付近）で静的に検出**し、**名前入りエラー**で
  バッチ実行前に停止する（kintone API 呼び出し 0 回）。
  **現行の `kind`（scalar / select-column / array-in-list）では位置を判別できない場合、
  収集側に文脈を持たせること。自然な縫い目が無いと判断したら、黙って広げず止めて報告すること**
- 実行時に `KINTONE_FUNC` ノードが想定外の位置へ到達しないことを、この静的検査で保証する

### 7.5 DML は fail-closed

**`RELATIVE_DATE` 変数は DML（`UPDATE` / `DELETE` / `INSERT ... SELECT` の source /
`UPSERT` / `VALIDATE`）では使用できない。** 名前入りエラーで実行前に停止する。

- 理由＝**注入値ひとつで対象範囲が変わる**（`DELETE ... WHERE 日付 = @period` が単日→年間）。
  B102（`PRIMARY_ORGANIZATION()` の DML 拒否）と同じ判断
- **SQL に直接書いた相対日付関数の DML での扱いは一切変えない**（whole-WHERE exact の形は従来どおり可）

### 7.6 文書（実装に含める）

| | |
|---|---|
| `docs/ksql_language_reference.md` の変数節（§「外部パラメータ注入」付近） | `DECLARE @x RELATIVE_DATE` の規則（§7.1〜7.5）を追加。**配置制限と DML fail-closed を明記** |
| 同 §「大文字・小文字」の近く or 変数節 | **`TODAY()` の位置による意味差**（§2.1 の表）を明記＝DECLARE 右辺（注釈なし）はクライアント評価のリテラル、WHERE 右辺はサーバー押し下げ |
| 同 日付フィールドの節 | **日時フィールドの境界は RFC3339 で書く**（§2.2 の実測。日付リテラルはその日の 0:00 と解釈される） |
| `docs/ksql_engine_library.md` | `variables` に `RELATIVE_DATE` 変数を渡せること（read-only なので DML 制限は無関係） |

### 7.7 やらないこと

- **注釈なし変数の挙動変更**（暗黙解釈は採らない・§3.1）
- グローバルな opt-in フラグ
- `KSQL_MCP_INSTRUCTIONS` の変更（語数予算 `{ total: 554, catalog: 259, prose: 295 }`・段落数 6 不変）
- 公開型の変更（`variables` は現行どおり `Record<string, string>`。**declaration snapshot 差分 0**）
- 任意区間の関数化・`LOGINUSER()` 等の非日付関数

### 7.8 受入条件

1. `DECLARE @p RELATIVE_DATE = THIS_MONTH(); SELECT ... WHERE 受注予定日 = @p` が
   `受注予定日 = THIS_MONTH()` として **EXACT_PUSHDOWN** される（EXPLAIN で確認）
2. `variables: { p: "THIS_YEAR()" }` の注入で `受注予定日 = THIS_YEAR()` になる
3. `FROM_TODAY(-1, MONTHS)` / `THIS_MONTH(LAST)` / `THIS_WEEK(MONDAY)` など**引数つきも通る**
4. **ホワイトリスト外**（`'2026-08-01'` / `LOGINUSER()` / `THIS_MONTH` / `THIS_MONTH() AND 1=1`）は
   **名前入りエラーで、kintone API 呼び出し 0 回**
5. **配置違反**（SELECT 定数列・UPDATE SET・HAVING・IN リスト等）は静的エラー・API 0 回
6. **DML で使うと fail-closed**（`DELETE ... WHERE 日付 = @p` がエラー・mutation 0）
7. **注釈なし `DECLARE` の挙動が完全不変**（`DECLARE @p = TODAY()` は従来どおりリテラル）
8. 日時フィールドでも押し下げが効く（`作成日時 = @p`）
9. 既存テスト全 green・snapshot 22 不変・語数予算 exact 不変・**declaration snapshot 差分 0**
