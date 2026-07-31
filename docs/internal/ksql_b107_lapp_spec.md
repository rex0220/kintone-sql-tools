# 仕様: B107 — `LAPP_<NAME>` の日本語名対応と、ブラウザ向け公開 API の受け口

- 作成: 2026-08-01
- 対象課題: [B107](ksql_b107_lapp_engine_library_issue.md)（**§2 が測定・§6 がリスク評価・§7 が方向確定**）
- ステータス: 📋 **実装待ち**
- 分担: Claude=仕様/レビュー、codex=実装/テスト
- SemVer: **minor**。**ただし破壊的変更を 1 件含む**（§6。B86 / B89 と同じ移行案内つき minor の前例に従う）

## 1. 決めたこと（オーナー Go・Pro 合意済み）

**2 つを全面同時に入れる。**

1. **案 A＝ブラウザ向け公開 API の受け口**：`runQuery` / `runBatch` / `explainQuery` に
   `logicalApps?: Readonly<Record<string, number>>` を追加し、SQL 中の `LAPP_<NAME>` を解決する
2. **案 B＝論理名の日本語対応**：名前の文字集合を kSQL 識別子の日本語 4 範囲へ広げる。
   **CLI / MCP / browser の全面で同時**（面で同一）

```sql
SELECT c.業種, SUM(d.売上) FROM LAPP_案件管理 d
JOIN LAPP_顧客管理 c ON d.顧客No_ = c.顧客No GROUP BY c.業種
```

```ts
await runBatch(sql, { client, logicalApps: { 案件管理: 4149, 顧客管理: 4148 } });
```

## 2. 単一ソース化（**実装の前提条件**）

**名前規則（文字集合・正規化・上限・大小）を 1 モジュールに定義し、全消費者を従わせる。**

- **新規の core モジュール**（`src/core/` 配下・**`fs` などの Node API に依存しない**。
  ファイル名は任せる）に置くもの:
  - 名前の開始/継続文字の判定
  - **canonical 化関数**＝ NFC 正規化 → `toUpperCase()` → 検証（不正なら**名前入り**エラー）
  - 上限 64 UTF-16 コードユニット
  - **zod 用の `RegExp`**（判定関数と一致することをテストで固定する）
- **スキャナ本体（`collectAppProfileTokens` / `normalizeSqlAppProfiles`）も
  `src/node/appProfiles.ts` から core へ移し、`fs` 非依存にする。**
  `src/node/appProfiles.ts` は re-export して既存の import を壊さない
  （`parseTokenMap` / `parseTokenFile` など Node 専用のものは node 側に残す）
- **消費者を単一ソースへ**:
  | 消費者 | 現在 | 変更 |
  |---|---|---|
  | スキャナの `isAsciiLogicalNameStart/Continue` | 独自定義 | 共有判定へ |
  | `src/node/config.ts` の `LOGICAL_APP_NAME_RE` | 独自 regex | 共有 canonical 化へ |
  | `src/mcp/schemas.ts:14` の zod regex | 独自 regex | 共有 `RegExp` へ |
  | engine-library の新オプション検証 | （新規） | 共有 canonical 化 |
- **`src/lexer/lexer.ts` は触らない。**`isJapanese` の 4 範囲は**値を参照して同じ範囲を定義**する
  （lexer からの import が bundle 構成上自然ならそれでもよい。判断は任せる）

## 3. 名前規則（案 B）

| | 規則 |
|---|---|
| 開始文字 | `[A-Za-z]` **または** 日本語 4 範囲（U+3040-30FF / U+3400-9FFF / U+F900-FAFF / U+FF01-FF60） |
| 継続文字 | 開始文字 ＋ `[0-9_]` |
| **含めない** | **半角 `$`（サブテーブル区切り）と半角 `@`（profile 区切り）**。※識別子集合の流用に注意——`isSqlIdentContinue` には `$` が入っている |
| 上限 | **64 UTF-16 コードユニット**（`LAPP_` の後の名前部） |
| 正規化 | **両側 NFC**＝SQL 中の名前（スキャン時）と、config / `logicalApps` のキー（読み込み時）の両方 |
| 大小 | **`toUpperCase()` をそのまま**＝ASCII と全角英字（`ａ`→`Ａ`）に効き、かな・漢字は不変 |
| キーの衝突 | **canonical 化後に重複するキーはエラー**（例: `orders` と `ORDERS`、NFD と NFC の同名） |

**quirk（文書化と試験で固定するもの）**

- **全角 `＄`（U+FF04）・`＠`（U+FF20）・中黒 `・`・長音 `ー` は名前の文字**
  （`LAPP_案件＄明細` は「案件＄明細」という 1 つの名前。半角 `$` / `@` だけが区切り）
- 上限超過・不正な開始文字は**トークン不成立**＝従来どおりパーサのエラー経路へ
  （現行の `return null` の挙動を変えない）

## 4. engine-library の受け口（案 A）

- `RunQueryOptions` / `RunBatchOptions` / `explainQuery` の options に
  **`logicalApps?: Readonly<Record<string, number>>` を純加法で追加**
  - キー＝共有 canonical 化で検証（不正キーは**キー名入り**エラー）
  - 値＝正の安全整数（`options.ts` の既存 assert の流儀に合わせる）
- **入口（`guardRunQuerySql` / `prepareExplainQuerySql` / batch の同位置）で共有 normalize を実行**:
  | 入力 | 挙動 |
  |---|---|
  | `LAPP_X` があり、`logicalApps` に定義あり | **解決して実行** |
  | `LAPP_X` があり、未定義（オプション無し含む） | **名前入りエラーで取得前に停止**（文言は `logical app LAPP_X is not defined` の系。形は任せる） |
  | **`@profile` 接尾辞**（`LAPP_X@p` / `APPn@p`） | **明確なエラー**（browser に profile の概念が無い旨） |
  | `LAPP_` を含まない SQL | **挙動・エラー文言とも従来と完全同一**（オプションの有無によらず） |
- **診断の併記**＝解決した `LAPP_X -> APPnnnn` の対応を engine-library のエラー整形へ配線し、
  解決後のエラーからも論理名が読めるようにする。
  **自然な縫い目が無いと判断したら、黙って広げず、止めて報告すること**
- **公開型は純加法**（declaration snapshot の差分が `logicalApps` の追加だけであること）

## 5. CLI / MCP（案 B の波及）

- スキャナ共有化により日本語名が自動で有効になる
- config の `logicalApps` キー＝読み込み時に canonical 化（§3）。**既存の ASCII 大文字キーは不変**
- MCP の `kintoneMetadataAppRef`（`schemas.ts:14`）が日本語名を受ける
- **変えないもの**: `@profile` の意味・`$サブテーブル`・CLI の `DELETE FROM LAPP_X@prod` 拒否・
  `allowPhysicalAppRefs`・仮想 ID 割り当て——**既存の ASCII 挙動はすべて不変**

## 6. 破壊的変更（1 件・意図的）

**`LAPP_`＋日本語で始まる識別子（フィールド参照等）は、論理アプリ参照として予約される。**

- 従来＝正当なフィールド参照としてパースされ得た → 今後＝未定義ならエラー
- **fail-closed**（黙って意味が変わるのではなく、音が出る）
- **退避＝バッククォート**（`` `LAPP_案件` `` は従来どおり識別子。スキャナはバッククォートを
  読み飛ばす既存挙動——**テストで固定すること**）
- **「定義済みのときだけ解決する」形にしないこと**＝同じ SQL の意味が設定で変わる silent 系になる

## 7. 文書（実装に含める）

| | |
|---|---|
| `docs/ksql_language_reference.md` §1 の LAPP 節 | 名前規則を §3 の内容へ書き換え（「ASCII の範囲で」の行を置換）。**破壊的変更とバッククォート退避の移行案内**を追記。「CLI / MCP 拡張」という見出しの改題（browser も対象になる） |
| `docs/ksql_engine_library.md` | `logicalApps` オプションの説明を追加（`RunQueryOptions` の記載箇所 `:93` 付近） |
| **`KSQL_MCP_INSTRUCTIONS`** | **変更しないこと**（語数予算 `{ total: 554, catalog: 259, prose: 295 }`・段落数 6 不変）。**変更が要ると判断したら止めて報告** |

## 8. 受入条件

1. **engine-library 3 面**（`runQuery` / `runBatch` / `explainQuery`）で
   `LAPP_案件管理` ＋ `logicalApps: { 案件管理: N }` が `APPN` として動く
2. **ASCII 名も従来どおり**（上位互換）
3. **未定義名は名前入りエラーで、kintone API 呼び出し 0 回**
4. **`@profile` 接尾辞は browser で明確なエラー**
5. **`LAPP_` を含まない SQL の挙動・文言が完全不変**
6. **CLI / MCP で日本語論理名が解決される**（config の日本語キー）。既存 ASCII 挙動は不変
7. **NFD の濁点入り名と NFC の config キーが一致する**（両側 NFC）
8. **`ａ` と `Ａ` は同一視、かな・漢字は区別**
9. **バッククォート退避**＝`` `LAPP_案件` `` は識別子のまま
10. **全角 `＄` quirk**＝`LAPP_案件＄明細` は 1 つの名前（サブテーブル区切りにならない）
11. **zod の `RegExp` が共有判定関数と一致**（照合テスト）
12. **名前の文字集合定義がリポジトリに 1 箇所**（スキャナ・config・zod・engine 検証が共有を参照）
13. **公開型の差分が `logicalApps` の純加法のみ**（declaration snapshot で確認）
14. **`KSQL_MCP_INSTRUCTIONS` 不変**＝語数予算 exact 不変
15. **既存テスト全 green・snapshot 22 不変**

## 9. テスト

- 名前規則の単体（境界: 開始/継続・64 units・全角＄＠・中黒・長音・NFC・大小・不正名）
- スキャナ（日本語名 × FROM / JOIN / `$サブテーブル` / `@profile` / 文字列・コメント・バッククォート内は不変）
- config（日本語キー・NFD キーの正規化・canonical 化後の重複エラー）
- MCP schema（`LAPP_案件管理` を受理）
- engine-library（受入 1〜5・診断併記・`getRecords` 呼び出し回数で「取得前に停止」を確認）
- **破壊的変更の固定**（受入 9）

> **既存テストを書き換える必要が出たら、止めて報告すること**（機械的な追記は可・報告に列挙）。

## 10. 今回やらないこと

| | 理由 |
|---|---|
| `src/lexer/lexer.ts` の識別子規則の変更 | **フィールド識別子の意味論には触れない**。今回は LAPP 名前規則だけ |
| サロゲート拡張漢字（U+10000 以上）の名前 | **kSQL 識別子自体が対象外**（lexer と一致）。広げない |
| browser への `@profile` / 複数マッピング | profile は Node の概念。1 面のみ |
| `release/README.txt`・`docs/internal/ksql_*.md`・版数 | リリース時にこちらで書く |
| Pro の確認事項への返信 | 仕様確定後にこちらで送る |
