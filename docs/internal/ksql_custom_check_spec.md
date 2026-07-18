# B37 DML カスタムチェック（行レベル業務ルールの #err 隔離）仕様

- 作成日: 2026-07-18
- ステータス: **仕様 R7・実装着手可**（R6 の codex 最終差分レビューで重大#1 INSERT/UPSERT SELECT＝**解消済み**・唯一の残 blocker だった重大#2 B38 `ScalarValueExpr` は [B38 spec R4](ksql_concat_operator_spec.md) §3.1.1 の非破壊加法方針で確定。非 blocker 2 点（VALIDATE 経路の列数チェック [execute.ts:3886]・`s` は FROM 宣言 alias）も反映。実装順は B38→B37）
- 分担: Claude=仕様/観点・Codex=実装/テスト
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B37（**B38 を先行**・束ねて次リリース）
- 関連: [B38 スカラー値式＋`||`](ksql_concat_operator_spec.md)（B37 が依存）、[B12 VALIDATE ONLY / ON ERROR SKIP](ksql_validate_only_implementation_plan.md)、[B29 数値精度](ksql_number_precision_semantics_spec.md)、横断: [文字列の扱い](ksql_string_semantics.md)、レシピ R6

## 1. 目的

ユーザー定義の**行レベル業務ルール**を DML に付与し、条件に該当した行をカスタムメッセージ付きで Tier-0 の `#err` へ隔離する。列間関係（`数値1 > 数値2`）・既存値照合（「新値 ≤ 既存上限」「減額不可」）を DDL なし・1 文で書く。他 RDB との比較は §11。

## 2. 構文

DML のソース（`VALUES` / `SELECT` / `SET` / `FROM`）と `ON DUPLICATE (...)` の後、処分節（`VALIDATE ONLY` / `ON ERROR SKIP INTO #err`）の**前**に、**1 つ以上の `CHECK` ブロック**を置く。

```text
<INSERT|UPSERT|UPDATE ...本体...> [ON DUPLICATE (...)]
CHECK
  WHEN <条件式> THEN <メッセージ式>
  [ WHEN <条件式> THEN <メッセージ式> ... ]
[ CHECK ... ]
[ VALIDATE ONLY | ON ERROR SKIP INTO #err [REJECT LIMIT n] ]
```

例:

```sql
-- INSERT SELECT: CHECK は元 SELECT の出力列を参照
INSERT INTO APP123 (数値1, 数値2)
SELECT 数値1, 数値2, 数値3 FROM APP999
CHECK
  WHEN 数値1 IS NULL THEN '数値1 未入力エラー'
  WHEN 数値1 > 数値2  THEN '数値1=' || 数値1 || ' が 数値2=' || 数値2 || ' 超過'
CHECK
  WHEN 数値3 > 100 THEN '数値3=' || 数値3 || ' が上限超過'   -- 数値3 は末尾の CHECK 専用列（挿入されない）
ON ERROR SKIP INTO #err

-- UPDATE FROM: 修飾で target(更新前)/source(新値) を識別
UPDATE APP100 SET 金額 = s.金額 FROM #src s WHERE APP100.$id = s.k
CHECK
  WHEN s.金額 < APP100.金額 THEN '減額は不可（旧=' || APP100.金額 || ' 新=' || s.金額 || '）'
ON ERROR SKIP INTO #err
```

- `CHECK` は**ソフトキーワード**。`CHECK` の直後が `WHEN` のときだけこの構文（§7.1 の境界規則・2 トークン先読み）。`WHEN`/`THEN` は既存 CASE トークン（新規予約語なし）。
- `CHECK` 直後に `WHEN` 最低 1 つ（0 個は ParseError）。`WHEN` の区切りは `WHEN`。次の `CHECK` で新グループ。
- `<メッセージ式>` は **B38 のスカラー値式**（`||`/`CONCAT`/フィールド/`@var`/算術/リテラル）。結果を文字列化して `$err_message` にする。

## 3. 意味論

### 3.1 グループと先勝ち

- **1 つの `CHECK` ブロック＝1 グループ**。ブロック内の `WHEN` を上から評価し、**最初に真になった `WHEN` だけ**採用してメッセージを評価し `#err` に 1 エントリ。残りは非評価（CASE と同じ先勝ち）。
- **`CHECK` ブロックどうしは独立**。1 行のカスタムエラー数はブロック数が上限。全件独立に出すなら各 `WHEN` を別ブロックへ。

### 3.2 評価行（読み取り行）契約【中核】

条件式・メッセージ式のフィールド参照は、各候補行が持つ**評価行**（書込み `payload`/`record` とは別）に解決する。`OLD`/`NEW` キーワードは導入しない。

| 操作 | 評価行 = | 参照方法・型コンテキスト |
|---|---|---|
| **INSERT/UPSERT … SELECT** | **元の SELECT 出力行** | SELECT の出力列名（別名含む）で参照。**先頭 `stmt.fields.length` 列＝書込み・残りの末尾列＝CHECK 専用**（案 b・§4.3）。型は SELECT 由来（源アプリ／B14 型メタ） |
| INSERT/UPSERT … VALUES | VALUES（挿入列にキー化） | 挿入列名。型は書込み先アプリ |
| UPDATE（通常/算術/CASE） | **更新前ターゲット行** | 非修飾 or `APP<n>.項目名`。型はターゲット。書込む新値は SET 式を書く |
| **UPDATE … FROM** | **更新前ターゲット ⋈ ソース** | **B37 専用解決（§4.3）**：`APP<n>.項目名`＝ターゲット（更新前）・`s.項目名`＝ソース（新値）は厳密解決／非修飾 `項目名` は**ターゲット単独存在時のみ**許可／source-only・両在は ParseError（既存 JOIN の非修飾フォールバックには委ねない） |

- UPDATE（非 FROM）のフィールド参照は更新前値。「SET 後の結果」を検査するには SET 式を書く（`SET 数量 = 数量 - 出庫数` なら `WHEN 数量 - 出庫数 < 0`）。UPDATE FROM は `s.項目名`＝新値・`APP<n>.項目名`＝旧値で新旧を直接書ける。
- **未知フィールド／不整合な修飾**（存在しない列・source を修飾なしで参照・同名の非修飾曖昧）は**準備段で ParseError**（空文字に落とさない）。

### 3.3 処分

既存 Tier-0 と同一。`ON ERROR SKIP INTO #err [REJECT LIMIT n]`＝隔離／`VALIDATE ONLY`＝報告／**処分節なしの素 DML**＝§8 の決定的規則で fail-fast（部分書き込みなし）。

### 3.4 組み込み検証との関係

- 組み込みフィールド検証（書込み値対象）とカスタムチェック（評価行対象）は独立に評価し両方収集。行あたり `#err` 出力順は「組み込み → カスタム（グループ順）」。
- **CHECK の有無で組み込み検証の範囲を変えない**（CHECK は追加評価のみ。素 DML で CHECK があっても省略必須列を新たに検査したりしない）。
- 評価自体が失敗する型（比較非対応型・不正関数引数）は §8 で文全体 fail-closed。

### 3.5 `#err` スキーマ

既存列を流用。カスタムチェックのペイロード列は従来どおり書込み候補値（UPDATE は `$id`＋SET 後値）で、評価行（更新前値）とは別。

| 列 | 値 |
|---|---|
| `$err_row` | 行番号 |
| `$err_field` | 空文字（ラベルは v2） |
| `$err_code` | `ERR_CHECK`（`DmlValidationErrorCode` union へ追加） |
| `$err_message` | 採用 `WHEN` のメッセージを**その行の評価行で評価**した文字列 |
| `$err_statement`/`$err_operation` | 既存どおり |

- `REJECT LIMIT` は**「1 つ以上のエラーを持つ候補行数」**で数える（エントリ数でない）。

## 4. 参照スコープ（v1・単一評価行）

### 4.1 条件式

既存 `WhereExpr`。比較・`BETWEEN`・`IN`・`AND`/`OR`/`NOT`・`IS NULL`・算術・スカラー/文字列関数・リテラル・`@var`・`||`。**修飾参照可**（`APP<n>.項目名`・`s.項目名`＝§3.2）。サブクエリ・集約・他テーブル参照（評価行に無いもの）は準備段で ParseError。

### 4.2 メッセージ式（B38 依存）

`CheckMessageExpr` は **B38 が新設する再利用スカラー値式（`parseScalarValueExpr`）**を用いる（既存 `parseCaseResult` は `@var` 不可・`parseSqlValue`/`parseFieldValue` は非対称なため流用不可）。許可: リテラル・フィールド参照（評価行・修飾可）・`@var`・スカラー/文字列関数（`CONCAT` 等・**引数に `@var` 可＝B38 で拡張**）・算術・`||`。非許可（v1）: 集約・サブクエリ・配列・ネスト `CASE`。結果は文字列化（数値・空は空文字）。

### 4.3 フィールド解決

- **INSERT/UPSERT SELECT（案 b）**: 現行の列数一致（**通常実行 [execute.ts:4248](../../src/execute.ts)・VALIDATE/ON ERROR SKIP 経路 [execute.ts:3886](../../src/execute.ts) の両方**）を **`columns.length >= stmt.fields.length`** へ変更。**先頭 `stmt.fields.length` 列を位置対応で書込み**、**残りの末尾列は CHECK 専用**（書込みしない）。CHECK は SELECT 出力列名（別名含む）で参照。未知列＝SELECT 出力に無い＝ParseError。**CHECK を持つ INSERT/UPSERT SELECT では SELECT 出力名を一意必須**（重複名・重複別名は準備段 ParseError＝`ProcessRow` キーで区別できないため）。列数 < 挿入列数は従来どおりエラー。型は SELECT 由来（源アプリ／B14 型メタ）。
- **INSERT/UPSERT VALUES**: 挿入列名で参照・書込み先型。
- **UPDATE/UPDATE FROM（B37 専用解決）**: 非修飾は**ターゲット単独存在時のみ**許可。`APP<n>.項目名`＝ターゲット（更新前）・**`<source_alias>.項目名`＝ソース**（`<source_alias>` は `FROM … <alias>` で宣言した名前＝`s`/`t`/`e` 等の任意 alias。固定文字ではない）は厳密解決。**source-only の非修飾参照・両在の非修飾は ParseError**。準備段で**ターゲット/ソース両スキーマに対し参照を検証**し、評価器（`resolveFieldRef` の非修飾フォールバックで空文字化・[evalFunc.ts:568](../../src/engine/evalFunc.ts)）には正当性判定を委ねない。
- **参照フィールド収集**は条件式・メッセージ式の**両 AST を完全再帰走査**する専用収集器を新設（既存 `collectConditionFields` は左辺のみで流用不可）。左右・算術・関数引数・`IN`・`NULL_CHECK`・`||`/`CONCAT`・`@var` の全項を網羅。UPDATE 系ではこの集合を GET の `fields` に union（§6.2）。

## 5. 型と比較

- 比較は既存の型付き canonical 比較（B26／B9）。`evalWhere` に**評価行の型コンテキストに対応した型 resolver を必ず渡す**（§3.2 の経路別＝SELECT 由来／書込み先／ターゲット／target⋈source）。渡さないと文字列比較になる。
- v1 対応型: NUMBER・文字列系・正規化済み日付時刻。比較モードは**左辺型優先**。NUMBER 左辺は固定バンド（空セル<−Inf<有限<+Inf<"NaN"<その他）、`IS NULL` は空セル。
- 非対応複合型（CHECK_BOX/MULTI_SELECT/USER_SELECT 等）を比較に用いたら**準備段で ParseError**（静かに誤判定しない）。
- 算術は binary64（B29 v1 と同じ制限）。

## 6. 検証位置と全 DML 経路

### 6.1 共通

- カスタムチェックは Tier-0 の候補行検証（`validateDmlCandidates` 相当）へ組み込み、**評価行**に対して既存 `evalWhere`（条件）・B38 スカラー値式評価（メッセージ）を用いる。
- **素 DML（処分節なし）で CHECK があるとき**は、現行 `assertValidDmlRecords` の**最初のエラーで即 throw する経路とは別に**（[execute.ts:3672](../../src/execute.ts)）、**`targetFields` だけの組み込み検証結果と CHECK 結果を全行分収集する専用経路**を通す（後続行の評価器例外を観測するため早期 throw と両立しない）。全行評価後に §8 の規則で throw。§3.4 のとおり**組み込み検証範囲は変えない**（`targetFields` のみ・省略必須列を新たに見ない）。**CHECK が無い素 DML は現行の早期 throw を維持**。

### 6.2 評価行の供給（経路別）

| 経路 | 評価行の作り方 |
|---|---|
| INSERT/UPSERT VALUES | VALUES を挿入列コードでキー化 |
| INSERT/UPSERT SELECT | **SELECT 出力行をそのまま評価行に**（位置対応の書込みとは別に、SELECT 列名で保持。B14 型メタも保持） |
| UPDATE 通常 | GET `fields` へ `$id`＋CHECK 参照列を union し、取得レコードを候補へ保持（現状 `$id` のみ・[dmlToKintone.ts:147](../../src/converter/dmlToKintone.ts)・`resolveDmlTargetIds` が ID へ縮退するのを止める） |
| UPDATE 算術/CASE | 既取得の既存レコードを PUT 変換後に**捨てず** ID 対応で候補へ保持（＋不足列を fields に union） |
| UPDATE … FROM | `matched.{target, source}` を評価行に（target=更新前・source=新値・修飾で解決） |

- 「取得フェーズは増やさない」＝既存の対象取得リクエストに列を足すだけ（UPDATE FROM は元々ソースキーをチャンク化して複数クエリ・[execute.ts:4046](../../src/execute.ts)）。

### 6.3 対応マトリクス

| DML | 値の経路 | 通常書込み | VALIDATE ONLY | ON ERROR SKIP |
|---|---|---:|---:|---:|
| INSERT | VALUES / SELECT | 対象 | 対象 | 対象 |
| UPSERT | VALUES / SELECT（create/update） | 対象 | 対象 | 対象 |
| UPDATE | SET（通常/算術/CASE） | 対象 | 対象 | 対象 |
| UPDATE | UPDATE … FROM（target⋈source） | 対象 | 対象 | 対象 |

- **サブテーブル DML は CHECK 非対応**：`subtableCode && checkGroups.length > 0` を **VALIDATE ONLY/ON ERROR SKIP だけでなく素 DML でも ParseError**（現状 subtable 拒否は処分節限定・[parser.ts:2025](../../src/parser/parser.ts)）。
- 全 surface（CLI/MCP/plugin）で同一判定。

## 7. パーサ・AST

### 7.1 CHECK-WHEN 境界

- DML ソース SELECT 終端の `tryParseImplicitAlias`（[parser.ts:1435](../../src/parser/parser.ts)・現状 `VALIDATE ONLY` を例外化）に、**`CHECK`＋`WHEN` の 2 トークン先読み**を alias 消費させない例外として追加。`CHECK` 単独（後ろが `WHEN` でない）は従来どおり alias/フィールド可。
- 処分節パーサ **`parseDmlControlSuffix`**（[parser.ts:2227](../../src/parser/parser.ts)・R4 の `parseValidationSuffix` は誤記）の**直前**に `CHECK` ブロック群を解析。UPSERT は `ON DUPLICATE (...)` の後。

### 7.2 AST

- optional `checkGroups?: CheckGroup[]` を **5 形**（`InsertStatement`/`InsertSelectStatement`/`UpsertStatement`/`UpsertSelectStatement`/`UpdateStatement`・[ast.ts:562](../../src/types/ast.ts)）へ追加。
  - `CheckGroup = { rules: CheckRule[] }`／`CheckRule = { condition: WhereExpr; message: ScalarValueExpr }`（`ScalarValueExpr` は B38 新設）。
- CHECK 参照フィールドの完全走査収集器（§4.3）。
- エラー: `CHECK` 後 `WHEN` 0 個／未知・不整合修飾参照／非対応型比較／サブテーブル＋CHECK → 準備段で明示エラー。

## 8. エラー規則・fail-fast

- **通常の検証エラー**（組み込み・`ERR_CHECK`）は全候補を評価してから収集（既存 `validateDmlCandidates` 構造）。素 DML では**行番号昇順で最初のエラー行**を、行内は「組み込み優先→グループ順の最初」で 1 件 throw（決定的）。
- **評価器自体の例外**（比較非対応型・不正関数引数・メッセージ式型不整合）は隔離対象の `ERR_CHECK` に**しない**。準備段で検出可＝ParseError、実行時＝**全候補評価後、評価器例外が 1 件でもあれば通常エラーより優先して文全体を fail-closed**（複数行時の優先＝R4 再レビュー中#4）。
- **複数の評価器例外があるときの報告は決定的順で 1 件選ぶ**：行番号昇順 → グループ順 → `WHEN` 順 → 条件→メッセージの順で最初の例外（R5 再レビュー軽微#6）。
- `ON ERROR SKIP`/`VALIDATE ONLY` でも評価器例外は同様に fail-closed（行隔離にしない）。

## 9. SemVer・実装順序・文書

- **minor**（純加法・`CHECK` 節が無い文は従来どおり）。`CHECK` は新ソフトキーワード（新規予約語なし）。
- **実装順序（B38 ゲート）**: **B38（スカラー値式＋`||`＋関数引数 `@var`）を先に確定・実装**してから B37 を実装（B37 のメッセージ/条件が `ScalarValueExpr` に依存）。B37 の基礎テストは `CONCAT` でも成立させ、`||` 統合は別枠。B38+B37 を 1 リリース。
- 言語リファレンス・レシピ R6・CHANGELOG・台帳 B37 を同期。

## 10. 受入条件（テスト化）

- **グループ**: 先勝ち（数値1 未入力→「未入力」のみ）／複数ブロック独立で 2 エントリ／順序（組み込み→グループ順）。
- **評価行**:
  - **INSERT SELECT（案 b）**: SELECT 3 列・挿入 2 列で、先頭 2 列が書込み・**3 列目（`数値3`）は CHECK 専用**で参照できる（書込みされない）。SELECT 列数 < 挿入列数は従来どおりエラー。SELECT 別名参照可。未知列は ParseError。**CHECK 付き SELECT で出力名重複は準備段 ParseError**。
  - UPDATE 通常で `金額 > @新金額`（金額=更新前）＝減額検出・`金額 * 1.1 > 上限額`（両方更新前・上限額は非 SET 列も取得）・`WHEN 数量 - 出庫数 < 0` と `WHEN 数量 < 0` で結果が異なる。
  - **UPDATE FROM で `s.金額 < APP100.金額`（新値<旧値）＝減額**・source を非修飾で参照は ParseError・**非修飾はターゲット単独存在時のみ許可・両在の非修飾は ParseError**（B37 専用解決・JOIN のフォールバックに委ねない）。
- **列収集**: `数値1 > 数値2` の右辺 `数値2`・メッセージだけで参照する列・ネスト関数内の列が GET に含まれる。
- **メッセージ式（B38）**: `'x=' || 数値1`・`CONCAT('x=', 数値1)`・`CONCAT('v=', @var)`（@var 引数）が評価される。集約/サブクエリ/配列は ParseError。
- **型**: NUMBER 比較／テキスト辞書順／`IS NULL`／NUMBER×テキスト（左辺型優先）／非対応複合型比較は ParseError。
- **パーサ境界**: `FROM APP999 CHECK WHEN …` が解析可・`... AS CHECK`（後ろが WHEN でない）は従来 alias。
- **fail-fast（中#7/#4）**: 素 DML の決定的 throw／**評価器例外は全候補評価後に通常エラーより優先し文全体 fail-closed**。
- **#err 新旧分離（中#6）**: UPDATE 違反行を 1 つの `SELECT * FROM #err` で「対象列＝SET 後値」「メッセージ埋め込み同名フィールド＝更新前値」を観測。
- **サブテーブル**: `subtableCode`＋CHECK は素 DML でも ParseError。
- **処分**: `VALIDATE ONLY` 書込み 0／`ON ERROR SKIP` 隔離＋合格書込み／`REJECT LIMIT` はエラー行数。
- 全 DML（INSERT VALUES/SELECT・UPSERT VALUES/SELECT・UPDATE 通常/算術/CASE・UPDATE FROM）× 3 処分／UPSERT は `ON DUPLICATE (...) CHECK …` 順／取得フェーズ不増／`CHECK` 同名フィールド（バッククォート）非回帰／surface 一致。

## 11. 他 RDB との比較（prior art）

B37 相当の「1 文・DDL 不要・条件＋カスタムメッセージ＋不良行だけ隔離」を全部まとめた等価物は主要 RDB にほぼ無く、3 つの別々の仕組みに分かれる。

| B37 の要素 | 他 RDB の相当 | 主な違い |
|---|---|---|
| 条件（成り立つべき） | **CHECK 制約**（PG・MySQL 8.0.16+・Oracle・SQL Server） | DDL・違反で文全体中断・カスタムメッセージ無し・「満たすべき」向き |
| 条件＝エラー＋メッセージ＋新旧値 | **BEFORE トリガーの RAISE/SIGNAL**（PG・MySQL・Oracle・SQL Server） | DDL・違反で中断（隔離しない）。NEW/OLD＋補間は B37 と同発想 |
| 不良行だけ隔離＋続行＋上限 | **Oracle `LOG ERRORS INTO 表 REJECT LIMIT n`**（最も近い） | メッセージは制約/ORA エラーで任意文言でない |
| バルクロードの隔離 | SQL*Loader BAD/DISCARD・SQL Server `BULK INSERT ERRORFILE`・PG17 `COPY ON_ERROR ignore` | ロード専用 |
| グループ＝先勝ち/独立 | トリガーの `IF … RAISE; ELSIF …; END IF`＋別 `IF` | B37 のグループ化はトリガー手続きそのもの |

kSQL の `ON ERROR SKIP INTO #err REJECT LIMIT`（B12）は Oracle `LOG ERRORS … REJECT LIMIT` と同系譜。B37 はそこへトリガー風の条件＋任意メッセージをインラインで足す。**kintone はトリガー・CHECK 制約・ストアドを持たない**（[RDB 比較評価](ksql_sql_feature_comparison_evaluation.md) で「原理的に対象外」）ため、B37 はそのトリガー相当をクライアント層で再現する点に意義がある。

## 12. v2 候補（対象外）

- UPSERT の更新分岐での既存レコード値照合（新値中心の v1 とは別コンテキスト）。
- 他テーブル/サブクエリ参照・相関/集約チェック・行をまたぐ検査。
- チェックへのラベル/カスタムコード（`$err_field`/`$err_code`）。
- メッセージ式のネスト `CASE`・配列。
