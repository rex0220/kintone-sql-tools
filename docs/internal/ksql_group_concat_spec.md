# 仕様案: 文字列集約 `GROUP_CONCAT`（B16）

- 作成日: 2026-07-16
- 位置づけ: [主要 RDB 機能比較評価](ksql_sql_feature_comparison_evaluation.md) §4 で**最優先（効果大／コスト小）**と評価した機能。B12 の `#err` メッセージ集約の本命。
- ステータス: **仕様案 R2（codex レビュー反映済み・実装着手可）。未実装。**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md)

---

## 0. 先に訂正: **B16 は B14 に依存しない**

比較評価 §4 と台帳で「**B16 は B14 が前提**」としていたが、**コードを読んだ結果これは誤り**だった。

`evalAggregate`（[process.ts:293-311](../../src/engine/process.ts#L293)）は各行の値を**生の文字列として収集**する:

```ts
const strValues: string[] = [];
for (const row of rows) {
  if (arg.type === "FIELD_REF") {
    const raw = row[arg.field];
    if (raw === undefined || raw === "") continue;
    strVal = raw;                       // ← 生の文字列
  } else { ... }
  strValues.push(strVal);
}
const eff = distinct ? [...new Set(strValues)] : strValues;   // string[]
```

`GROUP_CONCAT` は `eff.join(separator)` で完結し、**型メタ（`sortKind`）を一切参照しない**。`MIN`/`MAX` が型メタを要したのは「数値順か辞書順か」を決める必要があったからで、連結にはその判断が無い。

したがって:

- **B16 は B14 なしでも `#err` を含む一時テーブルで動く**。
- B14 と B16 は**独立**しており、「片方だけでは成果が出ない」も**誤り**（B14 単体で temp のテキスト `MIN`/`MAX` が成立することは実機確認済み。B16 単体でも `GROUP_CONCAT` は全経路で動く）。
- v2.15.0 で束ねる判断自体は「同じ集約領域・1 回の実機で検証できる」という**利便性の理由なら妥当**だが、**依存関係を理由にしてはいけない**。→ §9 で台帳・評価文書を訂正する。

## 1. 課題

1 対多の値を 1 行へ連結する手段が無い。主要 RDB はすべて持つ（MySQL `GROUP_CONCAT` / Oracle `LISTAGG` / SQL Server `STRING_AGG`）。

**看板ユースケース**（B12 の書き戻し）: 1 ソース行に複数の検証エラーがあると `#err` は複数行になる。現在は `MIN($err_message)` で**代表 1 件**しか書き戻せない（B13＋B14 で `NaN` は解消したが、他のエラーは捨てている）。本来は**全メッセージを連結**したい。

```sql
-- 現状（B14 まで）: 代表 1 件のみ
SELECT 顧客コード, MIN($err_message) AS エラー内容 FROM #err GROUP BY 顧客コード;
-- → 'タイトル は必須です'（「文字列MIN は 3 文字以上…」等は失われる）

-- B16 後: 全件を連結
SELECT 顧客コード, GROUP_CONCAT($err_message SEPARATOR ' / ') AS エラー内容 FROM #err GROUP BY 顧客コード;
-- → 'タイトル は必須です / 文字列MIN は 3 文字以上で指定してください'
```

他にも「顧客ごとの担当者一覧」「明細の商品名連結」など 1 対多の表示全般に効く。

## 2. 現状（コード裏取り済み）

| 箇所 | 現状 |
|---|---|
| `AggregateFunc`（`src/types/ast.ts`） | `COUNT` / `SUM` / `AVG` / `MAX` / `MIN` |
| `tryAggregateFunc`（[parser.ts:1224-1234](../../src/parser/parser.ts#L1224)） | TokenKind → `AggregateFunc` の写像。5 種のみ |
| `parseAggregateRef`（[parser.ts:1237](../../src/parser/parser.ts#L1237)） | `DISTINCT` と引数（`WildcardColumn \| ArithNode`）を読む |
| `evalAggregate`（[process.ts:280](../../src/engine/process.ts#L280)） | 生文字列収集（§0）→ `COUNT` は件数 → `MIN`/`MAX` は型メタで分岐 → 残りは `Number()` 化 |
| `aggregateSyntheticName`（[selectToKintone.ts:660-667](../../src/converter/selectToKintone.ts#L660)） | **`func` の型が `"COUNT" \| "SUM" \| "AVG" \| "MAX" \| "MIN"` とハードコード**。`AggregateFunc` を広げるとここも要修正 |
| 実行モード | 集約列があれば FULL_SCAN（`hasAggregateColumns`）。`GROUP_CONCAT` も自動的に FULL_SCAN |
| 列型メタ（B14） | `inferSelectColumnMeta` の `AggregateColumn` 分岐に `GROUP_CONCAT` → `string` を足す |

## 3. 構文

MySQL 互換のサブセットを採る（kSQL は `LIMIT` / `DATE_FORMAT` / `FORMAT` など MySQL 寄り）。

```
GROUP_CONCAT([DISTINCT] <引数> [SEPARATOR '<文字列>'])
```

- **既定の区切り文字は `,`**（MySQL 準拠）。
- `SEPARATOR` は**ソフトキーワード**（`VALIDATE ONLY` / `ON ERROR SKIP` / `DECLARE` と同じ扱い）。既存の `SEPARATOR` という名前のフィールドを壊さない。
- 区切り文字は**文字列リテラルのみ**（バッチ変数・式は不可＝v1）。空文字 `SEPARATOR ''` は連結なし。
- `GROUP_CONCAT` は**予約語**にする。同名フィールドはバッククォート（`` `GROUP_CONCAT` ``）で参照（`KLIKE` と同じ前例）。

```sql
SELECT 顧客ID, GROUP_CONCAT(担当者) AS 担当者一覧 FROM APP100 GROUP BY 顧客ID;
SELECT 顧客ID, GROUP_CONCAT(DISTINCT 業種 SEPARATOR ' / ') AS 業種 FROM APP100 GROUP BY 顧客ID;
SELECT GROUP_CONCAT(会社名) AS 全社名 FROM APP100;              -- GROUP BY なし = 全行 1 グループ
```

## 4. 意味論

| 規則 | 内容 |
|---|---|
| **戻り値** | 常に **文字列**。型メタに依存しない（§0） |
| **収集** | 既存の集約収集規則をそのまま使う（[process.ts:293](../../src/engine/process.ts#L293)）。**空文字はスキップ**（`COUNT(field)` / `MIN` / `MAX` と同じ。MySQL が NULL を無視するのと整合） |
| **順序** | **収集順**（＝WHERE / JOIN 適用後の行順）。MySQL も `ORDER BY` 無指定時は順序を保証しない。安定順序が要るなら v2（§9） |
| `DISTINCT` | 既存の文字列レベル重複除去（[:311](../../src/engine/process.ts#L311)）。**初出順を保持** |
| **空グループ** | **`""`（空文字）**。B13 の文字列空グループと同じ（MySQL は NULL だが kSQL に NULL は無い） |
| **引数** | 直接フィールド参照が主用途。算術式は既存規則どおり数値評価して文字列化（`GROUP_CONCAT(金額 * 2)` → `"200,400"`）。**文字列関数の引数は非対応**（§9） |
| **長さ** | **上限なし・切り捨てなし**。MySQL の `group_concat_max_len` による**暗黙の切り捨ては採用しない**（サイレントなデータ欠落は本プロジェクトの方針に反する＝B1 で `truncate` を排したのと同じ理由）。長すぎる結果は書き込み時に B12-A の検証（`ERR_LENGTH_MAX`）が捕捉する |

### 4.1 消費 3 経路（B13 の M1-1 と同型）

| 経路 | 挙動 |
|---|---|
| 直接集約列 | `String(...)` 化して出力＝そのまま文字列 |
| 集約算術式（`evalAggArithExpr`） | `Number(GROUP_CONCAT(...))` → **`NaN`**（連結を算術に混ぜるのは無意味。B13 の `MIN(text)+1 → NaN` と同じ扱い） |
| 文字列関数内（`resolveAggInStringFuncArg`） | string 結果 → `STRING` ノード → `UPPER(GROUP_CONCAT(x))` が動く（B13 で配線済み） |

## 5. 実装差分

| 箇所 | 変更 |
|---|---|
| `src/types/ast.ts` | `AggregateFunc` に `"GROUP_CONCAT"` を追加。`AggregateRef` / `AggregateColumn` に `separator?: string`（未指定 = `,`）を追加 |
| `src/lexer/tokens.ts` | `GROUP_CONCAT` トークン（予約語）。`SEPARATOR` は**ソフトキーワード**として扱う |
| `parser.tryAggregateFunc`（1224） | 写像に `GROUP_CONCAT` を追加 |
| `parser.parseAggregateRef`（1237） | ①引数の後に `SEPARATOR` があれば文字列リテラルを 1 つ読む。`GROUP_CONCAT` 以外に `SEPARATOR` が付いたら `ParseError`<br>②**`GROUP_CONCAT(*)` / `GROUP_CONCAT(DISTINCT *)` は `ParseError`**（§5.1） |
| **`parser` の `AggregateColumn` 構築（[parser.ts:765-771](../../src/parser/parser.ts#L765)）** | **`separator: ref.separator` を明示的にコピーする**。現在は `func`/`distinct`/`arg`/`alias` を個別にコピーしており、**足すだけでは `separator` が落ちる**（§5.2） |
| `evalAggregate`（280） | 引数に `separator?: string` を追加。`COUNT` の直後に `if (func === "GROUP_CONCAT") return eff.join(separator ?? ",")`。**型メタ分岐より前**（`sortKind` を参照しない） |
| **`evalAggregate` の呼び出し 3 経路** | **すべて `separator` を渡す**（§5.2）。[process.ts:247](../../src/engine/process.ts#L247)（直接列）／[:371](../../src/engine/process.ts#L371)（集約算術 `evalAggArithExpr`）／[:869](../../src/engine/process.ts#L869)（文字列関数内 `resolveAggInStringFuncArg`） |
| `aggregateSyntheticName`（[selectToKintone.ts:660](../../src/converter/selectToKintone.ts#L660)） | `func` のハードコード union を `AggregateFunc` へ置換。合成名は `GROUP_CONCAT(x)` / `GROUP_CONCAT(DISTINCT x)`（**区切り文字は合成名に含めない**＝同じ列を別区切りで 2 つ書くときは alias 必須） |
| **`isAggregateSyntheticName`（[selectToKintone.ts:687](../../src/converter/selectToKintone.ts#L687)）** | 正規表現 `/^(COUNT\|SUM\|AVG\|MAX\|MIN)\(/i` に **`GROUP_CONCAT` を追加**（もう 1 箇所のハードコード） |
| `inferSelectColumnMeta`（B14・execute.ts） | `AggregateColumn` 分岐に `GROUP_CONCAT` → `{ sortKind: "string" }` |

### 5.1 `GROUP_CONCAT(*)` は `ParseError`（R2 で追加）

`parseAggregateRef`（[parser.ts:1244](../../src/parser/parser.ts#L1244)）は**すべての集約関数で `*` を受理**する:

```ts
if (this.consume(TokenKind.STAR)) { arg = { type: "WILDCARD" }; }
```

一方 `evalAggregate`（[:288-290](../../src/engine/process.ts#L288)）は `COUNT` 以外のワイルドカード集約を **`0` で返す**:

```ts
if (arg.type === "WILDCARD") return func === "COUNT" ? rows.length : 0;
```

このままだと `GROUP_CONCAT(*)` が**静かに数値 `0`** を返す（文字列を返す約束にも反する）。MySQL も `GROUP_CONCAT(*)` は構文エラーなので、**`GROUP_CONCAT(*)` と `GROUP_CONCAT(DISTINCT *)` はパーサで `ParseError`** とする（`SUM(*)`/`MIN(*)` 等の既存挙動は本仕様では変えない＝別課題）。

### 5.2 `separator` の伝播（R2 で追加）

AST に足すだけでは届かない。**2 箇所で明示的に運ぶ**必要がある:

1. **`AggregateRef` → `AggregateColumn`**（[parser.ts:765-771](../../src/parser/parser.ts#L765)）: 現在は `func`/`distinct`/`arg`/`alias` を個別にコピーする実装なので、`separator: ref.separator` を追加しないと**直接集約列で区切り文字が落ちる**。
2. **`evalAggregate` の呼び出し 3 経路**: いずれも `func`/`distinct`/`arg` を個別に渡しており、`separator` も渡さないと落ちる。
   - [process.ts:247](../../src/engine/process.ts#L247) 直接列（`applyGroupBy`）
   - [process.ts:371](../../src/engine/process.ts#L371) 集約算術（`evalAggArithExpr` の `AGG_REF` 分岐。※結果は `Number()` 化され `NaN` になるが、経路としては渡す）
   - [process.ts:869](../../src/engine/process.ts#L869) 文字列関数内（`resolveAggInStringFuncArg`）

受入条件で **`UPPER(GROUP_CONCAT(f SEPARATOR ' / '))` が区切り文字を保つ**ことを固定し、伝播漏れを検出する。
| 言語リファレンス §8 | 集計関数表に追加。順序・空値・長さ・区切り文字を明記 |
| B12 レシピ（`ksql_on_error_skip_isolation_spec.md` §6・roadmap） | `DISTINCT`＋定数フラグの回避策を **`GROUP_CONCAT($err_message SEPARATOR ' / ')`** へ戻す |

## 6. 受入条件

- [ ] `GROUP_CONCAT(f)` が既定区切り `,` で連結する。
- [ ] `SEPARATOR ' / '` が効く。`SEPARATOR ''` は区切りなし。
- [ ] `DISTINCT` が重複を除去し**初出順**を保つ。
- [ ] **空文字値はスキップ**（`COUNT(field)` と同じ母集合）。
- [ ] **空グループは `""`**（NaN でも `0` でもない）。
- [ ] `GROUP BY` あり／なし（全行 1 グループ）の双方で動く。
- [ ] **一時テーブル / CTE でも動く**（型メタ不要＝§0）。**B14 の有無に関わらず**同じ結果。
- [ ] `GROUP_CONCAT($err_message SEPARATOR ' / ')` が `#err` の全メッセージを連結する。
- [ ] `UPPER(GROUP_CONCAT(f))` が文字列として動く。`GROUP_CONCAT(f) + 1` は `NaN`。
- [ ] **`UPPER(GROUP_CONCAT(f SEPARATOR ' / '))` が区切り文字を保つ**（`separator` の伝播漏れ検出＝§5.2）。直接列でも `SEPARATOR` が効く。
- [ ] **`GROUP_CONCAT(*)` / `GROUP_CONCAT(DISTINCT *)` は `ParseError`**（静かに `0` を返さない＝§5.1）。
- [ ] `HAVING` / `ORDER BY` / 後段 SELECT / UNION で alias 参照できる。
- [ ] B14 の列型メタで `GROUP_CONCAT` 列が `string` になる（temp へ実体化後も `MIN` 等が辞書順で効く）。
- [ ] `GROUP_CONCAT` 以外の集約に `SEPARATOR` を付けたら `ParseError`。
- [ ] `GROUP_CONCAT` は予約語。`` `GROUP_CONCAT` `` で同名フィールドを参照できる。
- [ ] **長さで切り捨てない**（長い結果もそのまま返る）。
- [ ] `COUNT`/`SUM`/`AVG`/`MIN`/`MAX` に回帰なし。

## 7. リスク・SemVer

- **SemVer: minor**。ただし「完全な後方互換」ではない（R2 で訂正）。**`GROUP_CONCAT` を予約語にするため、同名フィールドを裸で参照している既存クエリは壊れ得る**＝厳密には構文互換性リスクがある。それでも **`KLIKE`（v2.8.0）で予約語を追加した際に minor とした前例**があり、①バッククォート（`` `GROUP_CONCAT` ``）で回避可能②同名フィールドの実在可能性が低い、ことから**既存方針に従い minor** とする。CHANGELOG に予約語追加を明記する。
- **リスク（`SEPARATOR` のソフトキーワード）**: 既存フィールド名 `SEPARATOR` と衝突しないことをテストで固定する。
- **リスク（長さ）**: 巨大グループで長大な文字列が生成され得る。一時テーブルは 1 万行上限があり JS 文字列としては扱えるが、**書き込み先の maxLength 超過は B12-A の検証で捕捉**される。切り捨てはしない（§4）。
- **リスク（順序）**: 収集順のため、同じデータでも取得順が変われば連結順が変わり得る。`DISTINCT` 併用時も初出順。**安定順序が要る用途は v2 の `ORDER BY` 待ち**と明記する。

## 8. B12 レシピの完成形

B14（temp 列型メタ）＋B16（本仕様）が揃うと、B12-B の実機確認で見つかった問題（`MIN($err_message)` が `NaN`）に始まる一連が完結する:

```sql
UPSERT INTO APP4219 (顧客コード, 顧客名, 住所, 電話番号)
SELECT 顧客コード, 顧客名, 住所, 電話番号 FROM #tgt
ON DUPLICATE (顧客コード)
ON ERROR SKIP INTO #err REJECT LIMIT 100;

-- 業務キー単位に 1 行化しつつ、全エラーメッセージを連結
CREATE TEMP TABLE #err_summary AS
SELECT 顧客コード, GROUP_CONCAT($err_message SEPARATOR ' / ') AS エラー内容
FROM #err GROUP BY 顧客コード;

UPDATE APP4220 SET 処理ステータス = 'エラー', エラー内容 = e.エラー内容
FROM #err_summary e WHERE APP4220.顧客コード = e.顧客コード;
```

> なお `GROUP BY 顧客コード` 自体は型メタを要さないため、**このレシピは B14 が無くても成立する**（§0）。B14 は同じ `#err` に対する `MIN`/`MAX` の正しさを担保する別の価値。

## 9. スコープ外・後続

- **`ORDER BY` 内包**（`GROUP_CONCAT(x ORDER BY y)`）: 安定順序が要る用途向け。v1 は収集順。
- **区切り文字への式・バッチ変数**（`SEPARATOR @sep`）: v1 は文字列リテラルのみ。
- **文字列関数の引数**（`GROUP_CONCAT(UPPER(x))`）: 既存の集約収集は非 `FIELD_REF` を**数値評価**する（[process.ts:303](../../src/engine/process.ts#L303)）ため `NaN` でスキップされる。これは `MIN(UPPER(x))` も同じ**既存の制限**であり、本仕様では変えない（別課題）。
- **`LISTAGG` / `STRING_AGG` の別名**: 追加しない（MySQL 系に統一）。
- **文書の訂正**（本仕様と同時に実施）: 比較評価 §4 と台帳の「B16 は B14 が前提」を削除し、**両者は独立**である旨へ改める（§0）。
