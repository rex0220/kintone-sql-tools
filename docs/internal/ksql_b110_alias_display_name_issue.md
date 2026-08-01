# B110 SELECT 別名の表示表記（大文字小文字）を `columns` メタで保持する

- 起票: 2026-08-02
- ステータス: 🔧 **対応中（案 B 確定・オーナー承認済み）**
- 出典: [Pro の相談 2026-08-02](../../../ksql-dashboard-pro/docs/internal/kSQLエンジンへの連絡-20260802-送付版.md)（K-96・**急ぎではない**＝表ペインは見出し上書きで回避可・グラフの凡例だけ回避不能）
- 関連: B69（engine ライブラリの列メタ＝今回の受け皿）/ B2（0 行 SELECT の列名＝AST 由来の列名決定）

## 1. 事象（実測 2026-08-02・MCP v3.37.1 で再現）

**SELECT 別名の ASCII 英字が、結果列名で小文字に正規化される。バッククォートでも保持されない。**

```
SELECT $id AS ランクA, $id AS B, $id AS `ランクC` FROM APP4149 LIMIT 1
→ columns: ["ランクa", "b", "ランクc"]
```

Pro のダッシュボードでは列名がそのまま表の見出し・グラフの凡例になるため、
利用者が `AS ランクA` と書いたのに「ランクa」と表示される（実利用者からの報告あり）。

## 2. 原因と文書状況

- **原因＝parse 時の破棄**: `parseAliasName()`（`src/parser/parser.ts:3928`）が
  `toLowerCase()` してから AST へ入れるため、**書かれた表記は AST に残らない**。
  IDENT / BIDENT（バッククォート）とも同じ経路で、退避手段が無い。
  `toLowerCase()` は全角英字（`Ａ`→`ａ`）にも効く
- **呼び出し 15 箇所はすべて SELECT 列の別名**（`parseSelectColumn` / `parseWindowColumn`）。
  テーブル別名は別経路（`parseIdentifier`）で今回の対象外
- **文書に記載なし**: 言語リファレンス §1「大文字・小文字」はキーワードとフィールドコードのみ。
  別名の小文字化は**未記載の暗黙挙動**だった

## 3. 決定（2026-08-02・オーナー「B でOK」）

**案 B＝非破壊。返る列名（行キー・`columns[].name`）は現行の小文字のまま変えず、
`columns` メタに表示用の `displayName`（SQL に書かれた表記）を純加法で追加する。**

- 案 A（行キーごと表記保持）は不採用＝小文字キーで結果を読む既存利用者への破壊的変更
- Pro も非破壊代替として同じ形を挙げており、表の見出し・グラフの凡例に `displayName` を
  使う追従は小改修と明言済み

## 4. 仕様

### 4.1 変更点

| 箇所 | 変更 |
|---|---|
| `src/parser/parser.ts` の `parseAliasName()` | 正規形（小文字・現行）に加えて**書かれた表記**を返す。AST の SELECT 列ノードへ optional な表記プロパティ（名前は任せる。例: `aliasDisplay`）を追加。**正規形の `alias` の型・値は一切変えない** |
| 列名決定（B2 の AST 由来の列名ロジック） | 列名（正規形）の決定は不変。**表記だけを列メタへ渡す** |
| `src/execute.ts` の `MaterializedColumnMeta` | `readonly displayName?: string` を追加（B69 の受け皿に相乗り） |
| `src/engine-library/resultMapping.ts` の `toPublicColumn` | メタの表記を `displayName` として出す |
| `src/engine-library/publicTypes.ts` の `QueryColumn` | `displayName?: string` を**純加法**で追加（公開型は optional。必須にしない） |

### 4.2 表記の決定規則

| 列 | `displayName` |
|---|---|
| 明示的な別名あり（`AS ランクA` / `AS `ランクC`` / キーワード別名 `AS AVG`） | **書かれたとおり**（バッククォートは剥がした中身。`ランクA` / `ランクC` / `AVG`） |
| 別名なし（フィールド参照・式・集計の合成名） | **`name` と同一**（フィールドコードは元々表記保持。合成名は現行のまま） |
| `*` / passthrough（`SELECT * FROM #t` 等） | 元テーブルの列メタに表記があれば**引き継ぐ**。無ければ `name` と同一 |
| UNION | 列名は第 1 枝由来（現行）。表記も**第 1 枝の SELECT リスト**から |
| 明示参照の再選択（`SELECT ランクa FROM #t`） | **その位置に書かれた表記**（`ランクa`）。内側の定義の表記は引き継がない |

- 照合（重複検査・ORDER BY / HAVING / UNION の列合わせ・CTE / temp テーブルの列解決）は
  **現行の小文字正規形のまま一切変えない**
- `displayName` は列メタが捕捉される経路（`captureColumnMeta`）で常に埋める。
  型は optional のまま（公開型への必須プロパティ追加は破壊的変更のため）

### 4.3 やらないこと

- 行データのキー・`columns[].name` の変更（案 A）
- MCP の応答形の変更（`columns` は `string[]` のまま。読み手は LLM で表示表記の実需が薄い）
- CLI / プラグインの出力変更
- `KSQL_MCP_INSTRUCTIONS` の変更（語数予算 `{ total: 554, catalog: 259, prose: 295 }`・段落数 6 不変）
- 別名の照合規則・重複検査の変更

### 4.4 受入条件

1. engine ライブラリで `SELECT $id AS ランクA` の `columns[0]` が
   `{ name: "ランクa", displayName: "ランクA", ... }` になる（行キーは `ランクa` のまま）
2. バッククォート別名・キーワード別名・全角英字別名（`Ａ`→name `ａ` / display `Ａ`）も表記保持
3. 別名なしの列は `displayName === name`
4. 0 行 SELECT でも `columns` メタに `displayName` が付く（B2 系）
5. UNION は第 1 枝の表記。passthrough は引き継ぎ
6. **公開型の差分が `QueryColumn.displayName?` の純加法のみ**（declaration snapshot の差分で確認）
7. ORDER BY / HAVING / 重複検査・UNION 列合わせの挙動が完全不変
8. 既存テスト全 green・snapshot 22 不変・語数予算 exact 不変・bundle guard green

### 4.5 テスト

- parser: 別名の正規形＋表記の両取り（ASCII・全角英字・バッククォート・キーワード・日本語のみ）
- engine-library: 受入 1〜5（`columnMeta.test.ts` の流儀に合わせる）
- declaration snapshot: 受入 6

> **既存テストを書き換える必要が出たら、止めて報告すること**（機械的な追記は可・報告に列挙）。

## 5. 文書（実装に含める）

| | |
|---|---|
| `docs/ksql_language_reference.md` §1「大文字・小文字」 | 「SELECT 別名の英字（全角含む）は結果列名で小文字へ正規化される。バッククォートでも保持されない」を追記（**採否によらず現状の明文化**） |
| `docs/ksql_engine_library.md` | `QueryColumn` の説明箇所へ `displayName` の行を追加（書かれた表記・表示用・照合は `name`） |

## 6. 優先度・版

**中**（Pro の実利用者からの見え方報告あり・回避はグラフ凡例のみ不能）。
公開型の純加法を含むため **minor**（版はオーナー判断）。
