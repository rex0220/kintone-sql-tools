# 仕様案・効果評価: バッチ変数 Phase 1a（`SET @x = <スカラー式>`）

- 作成日: 2026-07-14
- 更新履歴:
  - 2026-07-14 R1: 初版（ドラフト）。外部提案 `kSQL仕様案_バッチ変数.md` の Phase 1a を現行コードへ接地
  - 2026-07-14 R2: codex レビュー反映（7点）。①SET RHS に専用 `ScalarExpr` を定義（現行 AST では表現不能：算術 `+` は数値加算・文字列関数引数に `NOW()` 不可）。②**NULL を 1a から除外**（現行言語に `NullLiteral` なし・`@x IS NULL` 構文もなし → 後続機能）。③変数解決を**実行前 AST 置換**へ（既存スカラーサブクエリ [execute.ts:2861](../../src/execute.ts#L2861) と同設計。`VarValue` は判別 union）。④`@` 曖昧性は **High → 設計で解決可能**（Node は正規化が APP/LAPP 起点で `@var` 非検出・lexer は生 `@` がエラー・プラグインは @profile 非対応。検証済み）。⑤**単文 `SET` はエラー**。⑥**SET 失敗は `continueOnError` に関わらずバッチ停止**。⑦**結果メタへの `variables` 公開は 1a では見送り**（1c のマスキング仕様と同時に）
  - 2026-07-14 R2 実装: Phase 1a を実装。#10 の関数引数 `KINTONE_FUNC` 拡張は 1a では見送り、後続へ確定
  - 2026-07-14 R3（実装レビュー反映）: **`LOGINUSER()` は SET RHS で不可**（`resolveKintoneFunc` が常に空文字 → サイレント空値の罠）。`parseScalarExpr` で明示拒否し、parser/execute 回帰テストを追加済み。言語リファレンスも修正済み（LOGINUSER 削除・`APP_差分`→`APP100`・上限 64 と最大20文の関係・`SET` 右辺の変数参照不可/`+`=数値/`CONCAT`）
  - 2026-07-14 R4（IN 要素対応を追加・v2.1.0 同梱）: 実機検証でチェックボックス/複数選択フィールド（`=` 不可・`in` 必須）の需要が判明。**`WHERE k IN (@a, @b)` のように IN リスト要素へスカラー変数を書けるように**する（§2.6）。AST の `InList.values` に `VariableRef` を追加し `parseInValues` が `VARIABLE` を受理するだけ（静的解析・実行前置換は既に汎用で対応）。**`IN (@list)` の配列展開（1 変数＝複数値）は別物で後続**（配列型が必要・§6）
- ステータス: **v2.1.0 でリリース済み**（Phase 1a ＋ R4 の IN 要素対応 `WHERE k IN (@a, @b)`）。実機確認済み（2026-07-16）。**配列展開 `IN (@list)`（1 変数＝複数値）は本書では対象外・後続**（配列型が必要・§6・台帳 B3）
- 対象バージョン: **v2.1.0（リリース済み・後方互換・加算的）**
- 位置づけ: post-2.0 バッチ機能ロードマップの最初の一手（改善案 Phase 1）。1b（スカラーサブクエリ代入）・1c（`DECLARE` + 外部パラメータ）は本書のスコープ外・後続
- 全体提案: `C:\Users\rex02\Projects\ksql-batch\kSQL仕様案_バッチ変数.md`（本書はその Phase 1a のみを実装仕様化）

---

## 1. 背景・目的

バッチ（`;` 区切りの複文）実行で、値を一度定義して全ステートメントから参照する仕組みを入れる。Phase 1a は最小サブセット（リテラル・関数・算術式の代入のみ。サブクエリ・外部注入は後続）。

主な動機:
1. **時刻の固定**: 現状 `NOW()` は文ごとに評価される（[evalWhere.ts:214-230](../../src/engine/evalWhere.ts#L214) `resolveKintoneFunc`）。`SET @now = NOW()` で開始時刻を固定すれば事後検証（`処理日時 = @now` 突合）が厳密になる。**NOW() 自体の意味は変えない**ため後方互換。
2. **バッチ ID / 条件値の共通化（DRY）**: `@batch_id`・対象日付・ステータス値を複数文へ重複記述せず、修正漏れを排除。
3. **1b/1c の土台**: 保存クエリのパラメータ化（1c）へ最小コストで接続できる基盤。

現状、複文（temp table 等）の基盤は既にある（[core/batch.ts](../../src/core/batch.ts) `analyzeBatch` / [execute.ts:406](../../src/execute.ts#L406) `executeBatch` が文間で `tempTables` Map を引き回す）。**変数表はこの Map と並置するだけ**で実行モデルへの影響は小さい。

---

## 2. 仕様（Phase 1a）

### 2.1 構文

```sql
SET @name = <ScalarExpr> ;
```

- 変数名: `@` + 識別子（英数・アンダースコア、最大 64 文字）。**小文字へ正規化**して保持（大文字小文字を区別しない）。
- `SET` は既存の予約トークン（[tokens.ts:196](../../src/lexer/tokens.ts#L196)、UPDATE の SET と同一トークン）。**文頭の `SET` は変数代入、UPDATE 内部の SET は従来どおり**（別経路）。

**`<ScalarExpr>`（SET RHS 専用・フィールド参照なし）**: 現行 AST では「リテラル・関数・算術式」をそのままは表現できない（codex #1・後述 §3.2）。SET RHS 用に**フィールド参照を含まない専用式型**を定義する:

```ts
type ScalarExpr =
  | StringLiteral
  | NumberLiteral
  | KintoneFunction          // TODAY() / NOW() のみ（LOGINUSER() は不可・下記）
  | StringFuncExpr           // CONCAT / DATE_FORMAT / UPPER 等（既存の文字列・数値関数）
  | ScalarArithExpr;         // フィールド参照を含まない算術（数値）
```

- **`LOGINUSER()` は SET RHS で不可（R2 実装レビューで判明・R3 で修正済み）**: `resolveKintoneFunc`（[evalWhere.ts:214-230](../../src/engine/evalWhere.ts#L214)）は `LOGINUSER` に**常に空文字**を返す（JS 側で解決不能）。サイレントに空値を保存しないよう、`parseScalarExpr` で **`LOGINUSER()` を明示拒否**し、parser/execute 回帰テストで固定した。実行環境共通のログインユーザー解決手段が設計できた段階で後続対応。
- **`+` は数値加算**。文字列連結は **`CONCAT()` のみ**（現行 `evalArithExpr` の `+` は数値・[evalFunc.ts:19-32](../../src/engine/evalFunc.ts#L19)）。R1 例の `'B' + FORMAT(NOW(), ...)` は成立しないため撤回。
- **スカラーサブクエリ `SET @x = (SELECT ...)` は Phase 1b**（1a では明示パースエラー）。
- **SET RHS 内での他変数参照（`SET @b = @a + 1`）は 1a では禁止**と明記（実装を小さく保つ・codex 推奨）。
- **関数引数に `NOW()`/`TODAY()` を渡す形（`CONCAT('B', DATE_FORMAT(NOW(), 'YYYYMMDD'))` 等）は、現行 `StringFuncArg` が `KINTONE_FUNC` を受理しない**（[evalFunc.ts:285-294 evalStringFuncArg](../../src/engine/evalFunc.ts#L285)）。整形済みバッチ ID が要る場合は `StringFuncArg` に `KintoneFunction` を追加する小改修が必要。**1a では素の `SET @batch_id = NOW()`（ISO 文字列）までとし、整形 ID は後続へ回す**。

### 2.2 参照できる位置（Phase 1a）

`@name` は**値（リテラル）が書ける位置**で参照可能:

- WHERE 右辺の値（`parseSqlValue` 経由）
- UPDATE の SET 値（[parser.ts:1865-1901](../../src/parser/parser.ts#L1865)）
- ASSERT のオペランド（[parser.ts:400-445](../../src/parser/parser.ts#L400)）
- **IN リスト要素**（`WHERE k IN (@a, @b, 'c')`。§2.6・R4 で追加）

> **対象外（後続サブフェーズ）**: `IN (@list)` の**配列展開**（1 変数が複数値を持つ・全体提案 §10）、LIMIT / OFFSET、SELECT 句の定数列（`SELECT @x AS c`）。

### 2.3 セマンティクス

| 規則 | 内容 |
|---|---|
| 評価タイミング | `SET` 文の**実行時に一度だけ**評価し、以後は定数。`SET @now = NOW()` はその文の実行時刻で固定 |
| 型 | 代入値から決定: **number**（数値リテラル・算術結果）/ **string**（文字列・文字列関数・日付系関数の結果）。**1a では `null` を扱わない**（下記） |
| 比較 | 参照時は型付き値として既存の比較規則に従う（v2.0.0 準拠: `=`/`!=` は文字列一致、`>`/`<` は両辺数値化可能なら数値）。日付は ISO 文字列比較（kintone 日付と整合） |
| NULL | **1a では対象外**。~~現行言語に `NullLiteral` はなく、`@x IS NULL` 構文も無い~~ → **【2026-07-18 訂正・B10】この根拠は陳腐化**。v3.2.0 では `NULL` トークン（`tokens.ts:90`）と `IS NULL`/`IS NOT NULL` 述語（`NullCheckExpr`・`parser.ts:1590` 付近）が**フィールドに対しては実装済み**。ただし**変数への NULL 代入は今も拒否**（`parseScalarExpr` が SET/DECLARE RHS で NULL を拒否・`parser.ts:288` 付近）で、`VarValue` に null バリアントも無い。kintone の null 相当は空文字で処理（`SET @empty = ''` で概ね代替可）。**B10 の NULL 部分を再評価する際は「フィールドの IS NULL は既にある／不足しているのは変数への NULL 代入＋変数 null の意味論」に論点を絞り、仕様の前提文を書き直すこと**。SELECT 列での `@var` 参照（`SELECT @x AS c`）は前提不変（変数列型が未実装）で純粋な後続拡張 |
| 再代入 | **不可（validate 静的エラー）**。上限（§下）とは別エラー。バッチ定数として小さく保つ |
| 未定義参照 | **validate 静的エラー**（タイプミスを実行前に検出）。バッチ内で先行する `SET` が無い `@name` 参照はエラー |
| スコープ | 1 バッチ実行内（temp table と同一ライフサイクル）。バッチをまたがない。**単文 `SET`・単文での `@ref` はエラー**（§2.4） |
| SET 失敗時 | **`continueOnError` に関わらずバッチ停止**（§2.5）。静的に定義済みなのに実行時 Map に値が無い状態を作らない |
| 上限 | 1 バッチ **64 個**（定義総数で数える。再代入とは別エラー）。temp table 枠（[batch.ts:25](../../src/core/batch.ts#L25) `MAX_TEMP_TABLES=16`）とは別枠 |
| 束縛方式 | 値としてバインド（文字列連結ではない）。**SQL インジェクションは構造的に発生しない** |
| 制限 | 変数に入るのは**値のみ**。アプリ ID・フィールドコード・演算子など識別子のパラメータ化は不可 |

### 2.4 単文実行での扱い（エラーに統一・codex #5）

現行 `execute()` 単文経路は `analyzeBatch` を通らず `SET_VARIABLE` 用の結果型も無い。`analyzeBatch` は単文一時テーブルを明示的に拒否している（[batch.ts:141](../../src/core/batch.ts#L141)）ので、変数も同じ方針で統一する:

- **単文 `SET` → エラー**（例 `ArgumentError: SET variable requires a batch.`）。
- **単文での `@ref` → 未定義参照エラー**。
- `SET` を許可するのは **2 文以上のバッチのみ**。

「未使用警告付き no-op」は、警告 API・単文結果型まで増やす割に利用価値が無いため採らない。

### 2.5 利用例（時刻固定・バッチ ID）

```sql
SET @now = NOW();          -- バッチ内時刻を固定（ISO 文字列）
SET @batch_id = NOW();     -- バッチ ID として ISO タイムスタンプをそのまま利用（1a の範囲）

UPDATE APP_差分
SET 処理ステータス = '処理済', 処理日時 = @now, バッチID = @batch_id
WHERE 処理ステータス = '未処理';
```

効果: 事後検証が `WHERE バッチID = @batch_id` の完全一致になり、`処理日時 >= TODAY()` のような近似条件が不要になる。

> **整形/接頭辞付きバッチ ID**（`'B' + 日時` 等）は §2.1 のとおり `CONCAT` + `StringFuncArg` への `KintoneFunction` 追加が要るため、1a では扱わず後続へ回す。
> **`ASSERT @cnt BETWEEN 1 AND 10000`（件数ゲート）** の `@cnt` は `SET @cnt = (SELECT COUNT(*) ...)` を要し **Phase 1b**。1a では ASSERT オペランドに `@var` を書ける準備（§2.2）はするが、件数を入れる SET 自体は 1b。

**SET 失敗時（codex #6）**: read-only バッチでは `continueOnError` が許可されるが、SET 評価が失敗した場合は**後続を続行せずバッチ停止**する（`continueOnError` の値に関わらず）。temp table の `dependsOn` skip（[execute.ts:453](../../src/execute.ts#L453)）のような依存グラフを変数へ広げるより、1a は「SET 失敗＝常に停止」が簡潔。

### 2.6 IN リスト要素での変数参照（R4・v2.1.0 同梱）

チェックボックス/複数選択フィールドは kintone で `=` を使えず `in` が必要（`WHERE 顧客ランク IN ('A')`）。**IN リストの各要素にスカラー変数を書けるようにする**:

```sql
SET @rank = 'A';
SELECT 顧客No FROM APP4148 WHERE 顧客ランク IN (@rank);          -- 単一
-- 混在も可
SET @a = 'A'; SET @b = 'B';
SELECT 顧客No FROM APP4148 WHERE 顧客ランク IN (@a, @b, 'C');
```

- **各要素は独立したスカラー変数（またはリテラル）**。`IN (@a, @b)` は「@a と @b の 2 値」。混在（`IN (@a, 'b', 5)`）可。`NOT IN` も同様。
- **`IN (@x)` は Phase 1a では常に「スカラー 1 要素」**（codex #1）。1a には**配列値を作る代入構文が無い**ため、`IN (@x)` が「1 変数＝複数値」に化けることは構文上あり得ない。将来、配列型変数を導入する際に「同じ `IN (@x)` 構文で展開するか、別構文にするか」を決める（それまで曖昧さは生じない）。
- 型: 変数の型（string / number）に従って解決。kintone `in` の型混在の扱いはリテラル IN と同じ（新規の懸念なし）。
- 変数は NULL を取らない（1a）ため IN 内 NULL の問題は生じない。

**実装（極小）**:
1. AST: `InList.values` を `(StringLiteral | NumberLiteral | VariableRef)[]` に（[ast.ts:475-478](../../src/types/ast.ts#L475)）。
2. パーサ: `parseInValues`（[parser.ts:1646](../../src/parser/parser.ts#L1646) から呼ばれる）に `VARIABLE` トークン受理を追加（`{ type:"VARIABLE", name: slice(1).toLowerCase() }`）。
3. **静的解析・実行前置換は無改修**: `collectVariableRefs`（[batch.ts](../../src/core/batch.ts) の汎用走査）が IN 内の `VariableRef` を検出、`resolveVariableRefs`（[execute.ts:709](../../src/execute.ts#L709) の汎用置換）が IN 内をリテラルへ置換。よって未定義参照・前方参照・上限などの検査、値の置換は自動で効く。
4. **後段は置換後リテラル前提＋防御ガード**: `convertInList`（[whereToKintone.ts](../../src/converter/whereToKintone.ts)）と `evalOp` の IN 評価（[evalWhere.ts:91-99](../../src/engine/evalWhere.ts#L91)）は、実行前置換で `VariableRef` が消えている前提で動く。**両者に「未置換 VARIABLE があれば例外」ガードを追加**（正常系では到達しない fail-loud）。
   - **`evalOp` のガードは比較の前にリスト全体を事前走査する（codex #2）**。`evalOp` の IN は `.some(...)`、NOT IN は `.every(...)` で**短絡評価**するため、コールバック内で VARIABLE を検出すると `IN ('一致値', @unresolved)` のように先頭一致で `some` が止まり `@unresolved` を見逃す。`const bad = right.values.find(v => v.type === "VARIABLE"); if (bad) throw ...;` を **IN / NOT IN 共通の事前ガード**として `some`/`every` の前に置く。

**テスト（経路別に固定・codex 要件）**:
- parser: 単一 `IN (@a)` / 混在 `IN (@a, 'b', 5)` / `NOT IN (@a, @b)`。
- 静的解析: IN 内の**未定義参照・前方参照**がエラー、`referencedBy` に IN 参照が乗る。
- SIMPLE: kintone クエリが `顧客ランク in ("A","B")` になる（置換後リテラル）。
- FULL_SCAN: `IN` / `NOT IN` の JS 評価が正しい（短絡ケース含む）。
- 防御: **未置換 `VARIABLE` を含む手組み AST**を `convertInList` / `evalOp` に渡すと必ず例外（事前ガード）。
- `IN (@x)` がスカラー 1 要素として成功。
- **配列風の SET 代入**（`SET @l = ('A','B')` 等）は拒否される（1a に配列代入構文が無い）。

---

## 3. 実装スケッチ（接地点）

### 3.1 lexer と `@` 曖昧性（High → 設計で解決可能・検証済み）

- `@name` を新トークン（例 `VARIABLE`）として読む分岐を追加。`#temp` の `readHashIdent`（[lexer.ts:237](../../src/lexer/lexer.ts#L237)）と対称。名前は **`@[A-Za-z_][A-Za-z0-9_]{0,63}`**、小文字へ正規化。
- **`APPxxx@profile` との混同は起きない（コード検証済み・codex #4）**。lexer で直前トークンを見る繊細な設計は不要:
  1. **Node（CLI/MCP）**: `@profile` は parse 前に `normalizeSqlAppProfiles`（[runtime.ts:107](../../src/node/runtime.ts#L107)）で正規化・除去され **lexer に届かない**。しかもそのスキャナは **`APP` / `LAPP_` 識別子を起点**に、その直後に密着した `@profile` だけを消費する（[appProfiles.ts:145-179](../../src/node/appProfiles.ts#L145) が `slice=="APP"`/`"LAPP_"` を確認してから line 176 の `@` を読む。[collectAppProfileTokens:200-241](../../src/node/appProfiles.ts#L200) は各位置で試行するが APP/LAPP 以外は null）。→ `@now` のように APP/LAPP に密着しない `@name` は**検出対象外**で触られず、`SET @now=...` と `FROM APP123@dev` が同一バッチに混在しても分離される。
  2. **現状 lexer は生の `@` を「予期しない文字」エラー**にする（[lexer.ts:89](../../src/lexer/lexer.ts#L89)）。→ `@name` に意味を与えるのは**今エラーの入力に意味を付けるだけ**で後方互換を壊さない。
  3. **プラグイン**: `@profile` 非対応（前処理を通さず core を直呼び [ui/desktop.ts:1929](../../src/ui/desktop.ts#L1929)）。`APP123@dev` は現状もエラーで、`@name` 導入後もエラーのまま（メッセージが変わるだけ）。正当なプラグイン SQL に無影響、かつ `@name` 変数はプラグインでも使える。
- **入口契約を明文化**: 「**core parse（`parseSqlStatement(s)`）は `@profile` 正規化済み SQL を前提とする**」。正規化を通さず core を直呼びする経路（現状プラグインのみ）では `@profile` は使えない。profile と変数が同居する SQL を**全入口で回帰テスト**する（不変条件: スキャナは APP/LAPP 起点）。
- （軽微）変数名を profile 名と同綴り（例 `@prod`）にしても token レベルで衝突しない（profile は正規化で消えている）。可読性の注意をドキュメントに添える。

### 3.2 parser / AST

- 新 AST: `SetVariableStatement { type: "SET_VARIABLE"; name: string; expr: ScalarExpr }`（`ScalarExpr` は §2.1・フィールド参照なし）。`Statement` union（[ast.ts:10](../../src/types/ast.ts#L10)）に追加。
- 文頭ディスパッチ（[parser.ts:216 parseStatement](../../src/parser/parser.ts#L216)）に `case TokenKind.SET: return this.parseSetVariable()` を追加。UPDATE 内 SET は `parseUpdate`（:1836）が消費するため非干渉。
- `SqlValue` union（[ast.ts:398](../../src/types/ast.ts#L398)）に `VariableRef { type: "VARIABLE"; name: string }` を追加し、以下で受理:
  - `parseSqlValue`（[parser.ts:1489](../../src/parser/parser.ts#L1489)）に `VARIABLE` トークン分岐。
  - UPDATE SET 値（[:1865-1901](../../src/parser/parser.ts#L1865)）に `@var` 受理を追加（現状は「フィールド参照のみ不可」エラー :1901 の手前で変数を通す）。
  - ASSERT オペランド（[:420-445](../../src/parser/parser.ts#L420)）に `@var` 受理を追加。
- **`ScalarExpr` 用の専用パース**が要る（現行の `parseArithAddSub` はフィールド参照を葉に許し `+` が数値のため、そのままでは使えない）。関数引数への `NOW()`/`TODAY()` は 1a では対象外。
- RHS がスカラーサブクエリの `SET @x = (SELECT ...)` は **1a では明示エラー**（「スカラーサブクエリ代入は将来対応（Phase 1b）」）。

### 3.3 変数解決（実行前 AST 置換・codex #3）

**評価器へ `variables` を渡す方式は不十分**。WHERE は kintone クエリ変換（[whereToKintone.ts:179](../../src/converter/whereToKintone.ts#L179)）と FULL_SCAN の JS 評価（[evalWhere.ts:175](../../src/engine/evalWhere.ts#L175)）の 2 経路を通り、UPDATE SET も DML コンバータが AST を直接変換する（[dmlToKintone.ts:140,166](../../src/converter/dmlToKintone.ts#L140)）。各経路に `variables` 参照を差し込むのは広く危険。

**採用: 実行前 AST 置換**（既存のスカラーサブクエリと同設計・[execute.ts:2861](../../src/execute.ts#L2861) が実行前に `StringLiteral` へ置換してコンバータ変更を回避しているのと同じ）:

```text
SET 実行            → Map に型付き値を保存
後続文の実行直前     → AST 中の VariableRef を StringLiteral / NumberLiteral へ置換
                     （既存の executeParsedStatement / コンバータへは置換後 AST を渡す）
```

- **変数表**: `variables: Map<string, VarValue>` を `executeBatch`（[execute.ts:436](../../src/execute.ts#L436) の `tempTables` Map と並置）で生成し引き回す。型は**判別 union**:

```ts
type VarValue =
  | { type: "string"; value: string }
  | { type: "number"; value: number };
```

（R1 の `{ value: string }` 固定は number タグと実値が食い違うため訂正。）

- `SET_VARIABLE` 実行: RHS（`ScalarExpr`）を評価（`evalArithExpr` / `evalStringFunc` / `resolveKintoneFunc`、空行コンテキスト）し、型を決めて Map に格納。number は `NumberLiteral`、string は `StringLiteral` へ置換する。

### 3.4 静的検査（validate）

- `analyzeBatch`（[batch.ts:133](../../src/core/batch.ts#L133)）に変数解析を追加:
  - 各文の `@name` 参照を収集（temp table 参照 [batch.ts:107 collectRefs](../../src/core/batch.ts#L107) と同様の走査）。
  - **未定義参照**（先行 SET が無い）→ エラー。
  - **再代入**（同名 `SET` の重複）→ エラー。
  - **未使用変数** → 警告。
  - 上限（64・定義総数）超過 → エラー（再代入とは別エラー）。
  - **単文実行の `SET` / `@ref`** → エラー（§2.4）。
- validate 結果に `variables: [{ name, referencedBy: [文index] }]` を追加（全体提案 §6 の縮小版。`declared`/`hasDefault` は DECLARE=1c 用のため 1a では不要）。

### 3.5 結果メタデータ（1a では非公開・codex #7）

- **実行結果への `variables` 公開は 1a では見送る**。`BatchExecuteResult`（[execute.ts:380](../../src/execute.ts#L380) の `statements`/`analysis`/`metrics`）へ生の変数値を足すと CLI・MCP・UI・将来の外部パラメータ機密マスクまで API 契約になるため、**必要性が確認された段階で 1c のマスキング仕様と同時に導入**する（バッチ ID 回収の需要が出てから）。

---

## 4. 効果評価

### 4.1 メリット

- **時刻固定**が可能になり、バッチの事後検証が厳密化（近似条件の排除）。NOW() の意味は不変で後方互換。
- 条件値・バッチ ID の DRY 化で修正漏れバグを排除。
- 静的検査（未定義参照・再代入・タイプミス検出）が実行前に効く＝品質向上。
- **1b/1c（保存クエリのパラメータ化）への最小の足場**。候補中最大の汎用リターンへ段階接続。
- 後方互換（加算的）。既存 SQL の挙動は不変。

### 4.2 コスト・リスク

- lexer（`@` トークン）/ parser（新文型 `SET_VARIABLE`＋専用 `ScalarExpr`＋3 値位置）/ 実行（変数 Map＋**実行前 AST 置換**）/ validate（変数解析）に手が入る。
- `@` 曖昧性は §3.1 のとおり**設計で解決可能**（Node 正規化が APP/LAPP 起点・lexer は生 `@` がエラー・プラグインは @profile 非対応）。入口契約の明文化と profile+変数 同居の回帰テストで担保。
- **専用 `ScalarExpr` の定義**（現行算術式が使えない・codex #1）と**実行前置換**（codex #3）が、R1 見積りより手数を増やす主因。
- 型表現（string/number）と v2.0.0 比較規則（`=` 文字列 / `>` 数値）の整合を要確認（例: `SET @n = 1` を `WHERE 個数 = @n`）。
- プラグイン（`prod/js/desktop.js`）へ波及するため全成果物再ビルド。

### 4.3 規模感

- R1 の「小〜中」から、専用 `ScalarExpr`・実行前置換・NULL 除外・単文エラー・SET 失敗停止・結果メタ非公開の確定を織り込み、**妥当に中規模**（codex 総評）。1b（サブクエリ代入・実行エンジン連携）・1c（MCP/CLI インターフェース・機密マスク）は分離。

---

## 5. リリース方針

- **v2.1.0**（minor・後方互換）。CHANGELOG は **Added**（`SET @var` バッチ変数）。破壊的変更なし。
- 言語リファレンスにバッチ変数の節を追加。プラグイン再ビルド必須。

---

## 6. スコープ外（後続フェーズ・将来）

- **Phase 1b**: `SET @x = (SELECT ...)` スカラーサブクエリ代入（0 行=NULL、2 行以上=実行時エラー）。実行エンジン連携。
- **Phase 1c**: `DECLARE @param [DEFAULT ...]` + 外部注入（保存クエリのパラメータ化、MCP/CLI インターフェース変更、機密マスク）。
- LIMIT/OFFSET・SELECT 定数列での `@var` 参照。（IN リスト要素は §2.6・R4 で対応済み）
- **`IN (@list)` の配列展開**（1 変数が複数値を持つ）。配列型 `VarValue`・`SET @l=(...)` 代入構文・展開ロジックが必要（全体提案 §10）。
- **NULL**（`NullLiteral` AST・`@x IS NULL` 構文・kintone 空値との対応・WHERE/UPDATE/ASSERT での null 意味論）を独立機能として（codex #2）。
- 整形/接頭辞付きバッチ ID（`CONCAT` + `StringFuncArg` への `KINTONE_FUNC` 追加）。
- 再代入（可変変数）、識別子のパラメータ化。

---

## 7. テスト観点（実装時）

- `SET @x = 'a'` / 数値 / `ScalarArithExpr`（数値算術）/ `NOW()` / `TODAY()` / 文字列関数 の各代入と、WHERE・UPDATE SET・ASSERT での参照。
- `SET @now = NOW()`（時刻固定）: 同一バッチ内の複数文で同じ値になる（文ごとに揺れない）。
- 型整合: `SET @n = 1` を `WHERE 個数 = @n`（数値一致）/ `SET @s = '完了'` を `WHERE 状態 = @s`（文字列一致）。number/string 置換が正しい SqlValue になる。
- 実行前置換: WHERE の SIMPLE 変換・FULL_SCAN 評価・UPDATE SET コンバータのいずれでも、置換後 AST が正しく処理される。
- 静的エラー: 未定義参照 / 再代入 / 上限（64）超過 / **単文 `SET` / 単文 `@ref`**。警告: 未使用変数。
- スカラーサブクエリ代入 `SET @x = (SELECT ...)` → 1a では明示エラー。SET RHS 内の他変数参照 `SET @b = @a` → エラー。
- **SET 失敗 → `continueOnError` に関わらずバッチ停止**。
- **profile + 変数 同居の全入口回帰**: `SET @now=NOW(); UPDATE ... FROM APP123@dev ...` が Node（CLI/MCP）で `@now`=変数・`APP123@dev`=profile と正しく分離。プラグインで `@name` 変数が動き `APP123@dev` は従来どおりエラー。
- `+` は数値加算（`SET @x = 1 + 2` → 3）、文字列連結は `CONCAT` のみ。

---

## 8. 設計判断（codex 推奨回答を反映・R2）

| # | 項目 | 方針（確定/推奨） |
|---|------|-------------------|
| 1 | `@` トークン規則 | 前処理後の `@[A-Za-z_][A-Za-z0-9_]{0,63}`、名前は小文字正規化。lexer は直前トークンを見ない（§3.1・**解決**） |
| 2 | `@name` 解決方式 | **文実行直前の型付きリテラル AST 置換**（§3.3・**確定**） |
| 3 | 単文 `SET` | **エラー**（§2.4・**確定**） |
| 4 | 変数上限 | **64**。定義総数で数え、再代入とは別エラー（**確定**） |
| 5 | 参照位置の 1a スコープ | **WHERE 右辺 / UPDATE SET 直接値 / ASSERT 直接オペランド / IN リストのスカラー要素（R4 で追加・§2.6）**。`IN (@list)` の配列展開は後続（**確定**） |
| 6 | 型表現 | **string / number のみ**。date/time/datetime は string 一括。**null は後続**（§2.3・**確定**） |
| 7 | SET RHS からの変数参照 | **1a では禁止**（実装を小さく保つ・**確定**） |
| 8 | SET 失敗 | **常にバッチ停止**（§2.5・**確定**） |
| 9 | 結果メタの `variables` | **1a では非公開**（§3.5・1c のマスキングと同時に・**確定**） |
| 10 | 関数引数への `NOW()`/`TODAY()` | **1a では見送り**。当面は素の `NOW()` とし、整形バッチ ID と合わせて後続へ（**確定**） |

全項目を R2 実装で確定。整形バッチ ID のための関数引数拡張は後続スコープとする。
