# B10 バッチ変数の後続機能（`NULL` 代入 / SELECT 列 `@var`）の再評価

- 作成日: 2026-07-19
- ステータス: **評価 R1**。台帳 B10（優先低・棚上げ）の再検討。**結論＝B10 を 2 部に分割し、Part A（NULL 変数）は「設計上解決済み＝作らない」、Part B（SELECT 列 `@var`）は「小さな純後続・実需次第で着手可」**。
- 分担: Claude=評価/仕様・Codex=実装/テスト
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B10
- 前提: [バッチ変数 Phase 1a](ksql_batch_variables_phase1a_spec.md)（§6 スコープ外の 2 項目）・1b/1c は実装済み
- 関連: [横断: 文字列の扱い](ksql_string_semantics.md)（v3.0.0 の空セル/型付き比較）

## 1. 背景：B10 の 2 部構成と「NULL 前提の陳腐化」

B10 は Phase 1a §6 でスコープ外とした 2 つの後続項目：

- **Part A**：バッチ変数への **`NULL` 代入**（`SET @x = NULL`）と変数 null の意味論。
- **Part B**：**SELECT 列での `@var` 参照**（`SELECT @x AS c`）。

棚卸し（2026-07-18）で判明した点＝**Part A を 1a で外した根拠「現行言語に `IS NULL` 構文なし」は陳腐化**。v3.2.0 で `NULL` トークンとフィールドの `IS NULL`/`IS NOT NULL`（`NullCheckExpr`）は実装済み。よって「構文が無いから」でなく、**「変数に null 値を持たせる意味論を作るか」**へ論点を絞って再評価する。

## 2. 現状（コード＋実機で確認・2026-07-19）

| 項目 | 現状 | 根拠 |
|---|---|---|
| `SELECT @x AS c`（Part B） | **ParseError**（列位置で `@var` 非受理） | 実機「フィールド名またはテーブル名が必要です」 |
| `SET @x = NULL`（Part A） | **ParseError**（明示拒否） | [parser.ts:296](../../src/parser/parser.ts)「SET の右辺で NULL は使用できません」 |
| フィールド `IS NULL` | 動作＝**空セル**にマッチ（kintone の null 相当は空文字） | 実機 `文字列MIN IS NULL`→空セル 7 件 |
| `SET @e = ''`＋`WHERE f = @e` | 空セルにマッチ（`IS NULL` と同結果 7 件） | 実機確認 |
| リテラル列 `'タグ' AS c` / `123 AS n` | **動作**（文字・数値とも） | 実機確認 |
| `VarValue` の null バリアント | **無し**（`string | number` のみ） | [execute.ts:745](../../src/execute.ts) |
| 変数解決 | 実行前に `VARIABLE` ノードを STRING/NUMBER リテラルへ置換 | [execute.ts:1199](../../src/execute.ts) |

## 3. Part A：変数への `NULL` 代入 — 評価「作らない（設計上解決済み）」

- **kSQL には値としての NULL が無い**。空セルは空文字で表し、v3.0.0（B26）で型付き比較の固定バンドに「空セル」を明示位置づけした。codex も「空値は SQL の `NULL`/`UNKNOWN` ではなく空文字として処理」と裏取り。フィールドの `IS NULL` も「値が空か」を見るだけで、SQL の 3 値論理（UNKNOWN 伝播）は導入していない。
- **実需は既存機能で満たせる**：空判定・空代入は **`SET @e = ''`** で足りる（実機で `WHERE f = @e` が `IS NULL` と同結果）。空を書き戻すのも空文字で行う。
- **導入コストと副作用**：変数 null を作るには `VarValue` に null バリアントを足し、WHERE 等値・算術・`CONCAT`・`IS NULL`・置換の各経路で「変数 null」の意味論を定義する必要がある（codex #2 の「独立機能」）。しかも**フィールドは null 値を持たない（空文字）のに変数だけ持つ**という**二層の不整合**を生む。得られるのは `SET @e=''` で代替できる薄い利便性。
- **提言**：**Part A は実装しない＝「空文字が kSQL の null」**を仕様として明記し、B10 の NULL 部分はクローズ。1a §6 の該当行を「構文が無い（誤）」から「値 NULL を持たない設計・`SET @e=''` で代替」へ書き直す。

## 4. Part B：SELECT 列での `@var` 参照 — 評価「小さな純後続・実需次第で着手可」

- **用途**：バッチ実行の**由来ラベル付け**が主。例：
  ```sql
  SET @batch = NOW();
  INSERT INTO APP200 (バッチID, 顧客) SELECT @batch AS バッチID, 顧客 FROM #対象;
  -- あるいは監査出力に定数列を付す
  SELECT @batch AS 実行時刻, $id, タイトル FROM APP100;
  ```
  「同一バッチの全出力に同じ実行時刻/バッチ ID を付ける」は、現状**列に定数を差し込む手段が無い**（`SET @x` は WHERE/SET/ASSERT/IN 要素にしか置けない）。リテラル直書き `'2026-07-19' AS c` は可能だが、`NOW()` 由来の実行時刻や上流で決めた ID を**変数で使い回す**にはこれが要る。
- **実装規模＝小**。理由：
  1. **リテラル列は既に完全動作**（文字・数値とも・実機確認）。
  2. **変数解決は列位置でも流用可能**：`resolveVariableRefs` が `VARIABLE` を STRING/NUMBER リテラルへ実行前置換するため、列位置で `@x` を受理できれば置換後は既存の**リテラル列**になる。
  3. よって差分は主に**パーサが SELECT 列位置で `@var` を受理し、置換対象ノードを出す**こと。射影・型・エイリアスは既存経路。
- **確定すべき点（R2 候補）**：
  - 列の**型/表示**：文字変数→文字列列、数値変数→数値列（リテラル列と同じ扱い）。列名は `AS` 必須にするか（`SELECT @x` 単独の合成名を避ける）。
  - **置換フェーズと射影の噛み合わせ**：列位置の `VARIABLE` 置換ノードが `project`/`selectToKintone` のリテラル列経路にそのまま乗るか（B2 の空 SELECT 列スキーマ伝播との整合）。
  - **SIMPLE との関係**：定数列は kintone クエリに影響しない（取得後の射影）。SIMPLE のまま付与できるか。
  - **UNION/GROUP BY/DISTINCT との併用**：定数列を含む行の重複・集約の扱い。
- **提言**：**Part B は独立の小さな後続として維持**。実需（バッチ由来ラベルの列付与）が具体化したら R2（上記論点）→実装。規模は B15/B18 級の小。

## 5. 総合評価・提言

| 項目 | 評価 |
|---|---|
| Part A（NULL 変数） | **作らない**。kSQL は値 NULL を持たない設計（空文字）。`SET @e=''`＋フィールド `IS NULL` で実需充足。変数だけ null を持つのは二層の不整合 |
| Part B（SELECT 列 `@var`） | **小さな純後続**。リテラル列＋実行前置換が既にあり差分は列位置の受理が主。用途はバッチ由来ラベル |
| B10 全体 | **分割**：A クローズ（設計で解決）・B は優先低の小型後続として残す |

**提言**：
1. B10 を **Part A / Part B に分割**。
2. **Part A はクローズ**し、「空文字が kSQL の null・`SET @e=''` で代替」を 1a §6 と言語仕様に明記（NULL 前提の陳腐化を解消）。
3. **Part B は「SELECT 列の定数変数」**として優先低で維持。実需が出たら R2 で上記論点を確定して着手（小規模）。

## 6. 反映

- 台帳 B10 行：「NULL 前提が陳腐化」→「A=設計上クローズ／B=小型後続（SELECT 定数列）」へ更新。
- Phase 1a §6：NULL 行の訂正注記を「値 NULL を持たない設計・`SET @e=''` 代替」に統一（現状は「構文はあるが変数代入は拒否」まで）。
- 次段：Part B に実需が出れば R2 仕様＋codex レビュー。Part A は追加作業なし。

---

## 7. codex レビュー結果（R1・2026-07-19・訂正）

Claude が実機で裏取り済み。**Part A の方向（NULL 変数は作らない）は妥当**だが、**Part B の一部主張に誤りがあり訂正**する。Part B の設計はバンドル仕様 [ksql_batch_variable_reference_extension_spec.md](ksql_batch_variable_reference_extension_spec.md) が正式版として引き継ぐ。

### P1（訂正）
1. **「式内 @var は不可」は誤り＝既に回避策がある**。`SELECT CONCAT(@x,'') AS c` / `SELECT @x || 'Y' AS c` は**現状で動く**（実機: `@b||'Y'`→`XY`・`CONCAT(@b,'-',@n)`→`X-5`）。`@var` が式（`ScalarValueExpr` の関数引数・`||`）内なら実行前置換が効くため。→ **B10-B の未実装部分は「裸の `SELECT @x AS c`」と「数値型を保持した定数列」に限定**。「不可能→可能」ではなく**構文簡略化＋型保持**。価値は評価初稿より小さい。
2. **「`resolveVariableRefs` 後は既存リテラル列になる／差分は主にパーサ」は誤り**。`resolveVariableRefs`（[execute.ts:1199](../../src/execute.ts)）は `VARIABLE` 子ノードを `STRING`/`NUMBER` へ置換するだけで**親の列ノードは変換しない**。`LITERAL_COL`（[ast.ts:194](../../src/types/ast.ts)）や `ARITH_COL`（[ast.ts:292](../../src/types/ast.ts)）へは変わらず、`project()` は各列種別を別処理（[process.ts:738/757/781](../../src/engine/process.ts)）。`SCALAR_VALUE_COL` の列メタは中身が数値でも**一律 string**（[execute.ts:2453](../../src/execute.ts)・ORDER BY 用意味型も string [process.ts:1049](../../src/engine/process.ts)）。→ **「数値変数→数値列」はタダでは成立しない**。専用の変数列ノードを作って解決時に親ごと `LITERAL_COL`/`ARITH_COL` へ変換するか、`SCALAR_VALUE_COL` に数値/文字列メタ推論を全消費箇所へ足す設計が要る（R2 で確定）。
3. **規模「B15/B18 級」は過小**。Part B は SELECT 列パース＋AS 規則・親ノード変換・列メタ（文字/数値）・ORDER BY/HAVING alias 意味型・空結果スキーマ・UNION 型統合・SELECT-based DML・FROM なし・EXPLAIN/静的参照解析・SIMPLE/FULL_SCAN 両テストを横断。→ **小〜中規模**（単一ホットスポットではない）。

### P2（改善・確定できた点）
- **AS は v1 で必須**にすべき。裸 `SELECT @x` は合成列名が実行値由来（`'abc'`/`123`）になる（[process.ts:931](../../src/engine/process.ts)）→ `SELECT @x AS c` のみ受理。
- **B2 空 SELECT 列スキーマは AS 付き列なら既存経路で成立**（`computeOutputKeys`/`computeExplicitOutputKeys` [process.ts:703/818](../../src/engine/process.ts)）→「要確認」でなく「0 行でも列保持・`SELECT *, @x AS c` は明示列復元・temp/CTE の `MaterializedTable.columns` にも保存」と明記可。
- **SIMPLE 維持は正しい**（`resolveSelectMode` は非集約 `SCALAR_VALUE_COL` を FULL_SCAN 条件にしない [selectToKintone.ts:67](../../src/converter/selectToKintone.ts)・取得フィールドも増えない [同:225](../../src/converter/selectToKintone.ts)）。ただし「SIMPLE 維持」と「数値意味型維持」は別問題（上 P1-2）。
- **Part A**: `SET @e=''` = `IS NULL` はスカラー値で裏取り済（[scalarCompare.ts:159](../../src/core/scalarCompare.ts)）。ただし**「すべての空セル＝空文字」は誤り**（複数値は `[]`）→ Part A の結論は**スカラー値に限定**して記述。NULL 伝播は「存在しない」でなく「現行言語が採用していない」（算術 `Number("")`・`CONCAT` 空連結・`COALESCE`/`NULLIF`/`ISNULL` が `""` を null 相当）と表現する。

### 総合判定（codex）
Part A「独立変数 null は作らない」は妥当（スカラー値に限定して記述）。Part B「優先低の独立後続」も妥当だが、**式内 @var の回避策があり実需は初稿より小・型/メタ配管は初稿より大**。規模は小〜中。実装着手は R1 からは不可、**AS 必須・AST 表現・数値意味型・既存式内変数との差分・テスト行列を R2 で確定してから**。
