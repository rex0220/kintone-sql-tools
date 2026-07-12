# 論理アプリ参照（LAPP_）実装計画

- 作成日: 2026-07-12
- 対象仕様: `docs/internal/ksql_logical_app_id_mapping_spec.md`（R8・実装着手可能）
- 対象: Node.js runtime を利用する CLI / MCP（プラグインは非対象）
- ステータス: **Codex 計画レビュー承認済み・工程0（baseline 固定）へ進行可**
- 更新履歴:
  - 2026-07-12 R3: Codex R2 追加指摘反映。snapshot 共有を2層コンテキストへ分離（§5.1）。層1 `ResolvedSqlContext` は不変 config snapshot（token/password なし）を保持し validation surface へ返す。層2 `ResolvedRuntimeContext` は層1 から token を解決し runtime 内部専用に保持、token 値を payload/EXPLAIN/cacheContext/ログ/エラーへ露出させない。受け入れ条件 #8b を追加
  - 2026-07-12 R2: Codex レビュー反映。①validation/実行の binding/config snapshot 共有（`ResolvedSqlContext` §5.1）を高指摘として追加 ②`AppBinding` を必須 `source` の discriminated union へ（§5-2）③resolver を config 層 factory `AppResolutionContext`（`resolveLogicalApp` は throw・`assertPhysicalAppAllowed`）へ（§5-1）④EXPLAIN は `mappedAppId` 非表示・payload 限定を明記（§5-5）
  - 2026-07-12 R1: 初版

## 0. 目的と本書の位置付け

本書は仕様 R8 を実装へ落とすための工程分割・担当分担・「仕様 → コード → テスト」対応表・受け入れ条件チェックリストを定める。仕様本文の意思決定は変更しない。仕様と実装が食い違う場合は仕様 R8 を正とし、逸脱が必要なら本書を更新してから着手する。

## 1. 担当分担

| 工程 | 担当 |
|---|---|
| 計画作成 | Claude |
| 計画レビュー | Codex |
| 実装 | Codex |
| 実装レビュー | Claude |

補足の進め方:

1. Claude が計画と「仕様 → コード → テスト」対応表を作成（本書）
2. Codex がコードを読み、計画をレビュー（特に §5 の signature 変更方針）
3. 計画修正後に §3 の baseline テストを固定
4. Codex が §6 の小さい工程単位で実装・検証
5. Claude が各工程を仕様 R8 へ直接突合（§7 対応表・§8 受け入れ条件）
6. token・認可工程（工程 C）は Codex も再レビュー
7. 最後に §8 の全受け入れ条件を両者で確認

## 2. 現状コードと R8 のギャップ

実装着手前に、現行実装が R8 の前提とどう異なるかを固定する。これが工程分割の根拠になる。

| 観点 | 現状 | R8 要求 | 影響工程 |
|---|---|---|---|
| binding 型 | `Map<number, { appId; profile }>`（`appProfiles.ts:6`） | `source` / `logicalName` / `mappedAppId` を追加（§8.1） | A, B |
| normalize 入力 | `normalizeSqlAppProfiles(sql, defaultProfile)`（`appProfiles.ts:190`） | profile ごとの `logicalApps` / `allowPhysicalAppRefs` を解決に要するため config 由来の resolver を注入 | A, B |
| scanner | `APP<digits>` のみ認識（`tryParseAppProfileToken` `appProfiles.ts:87`） | `LAPP_<NAME>` を別 source として認識、rewrite、offset map 生成（§8.1） | B |
| offset map | なし（cursor で逐次 rewrite のみ `appProfiles.ts:220-234`） | `SqlRewriteSegment[]` を必須生成し元 SQL 診断を復元（§8.1・§17-14） | B |
| token 要求導出 | `extractAppIds(sql)` → 物理 ID 集合（`runtime.ts:102`）、mapped→realAppId fallback `?? mappedAppId`（`runtime.ts:161`） | mapped ID 集合を binding から解決。logical binding 欠落は fail closed（§8.3・§14.7-1,4） | C |
| 物理参照制限 | なし | `allowPhysicalAppRefs` を rewrite 前 source で判定（§6.4・§9.3・§14.7-3） | D |
| CLI/MCP 共通化 | normalize は共通だが token 導出は CLI（`index.ts:1660-`）と runtime（`runtime.ts:121-`）に二重 | scanner/resolver/allocator/token 導出/cacheContext を `src/node/` の純粋共通実装へ統一（§8-8・§14.7-2） | C, E |
| validation/実行の snapshot | validate と runtime が config を独立に読み直し再 normalize（`runtime.ts:71` / `tools.ts:189` / `index.ts:1501`） | 1つの `ResolvedSqlContext` を validation→runtime へ受け渡し再解決しない（§11・§5.1） | C, E |
| DELETE 明示 profile | `hasProfileSyntax && DELETE` で一律拒否（`index.ts:1620`） | 論理参照でも rewrite 前の明示 `@profile` 有無で判定（§11.1） | E |

**核心リスク**: 認可・token 経路（工程 C）。物理 ID を engine appIds へ混ぜる／単一 token へ fallback する現行挙動は R8 で禁止。変更行数以上に高リスクのため Codex 再レビュー対象とする。

## 3. 先に固定する baseline テスト（工程 0）

実装前に、既存挙動の回帰検知網を固定する。ここは新機能を足さず、現状の green を保証するだけ。仕様 §16.4 に対応。

- `APP@profile` 正規化・mapped ID 割当（`appProfiles` 単体）
- tokenMap / userpass / single token の各解決（`runtime` / `cli`）
- SELECT / JOIN / batch / DML / subtable
- 文字列・コメント中の APP 抽出を認可へ混入させない（`extractAppIds`）
- `DELETE + @profile` の CLI 拒否 / MCP 許可
- config 未設定時の既存フロー

対象テストファイル（現存）: `src/node`・`src/cli/__tests__/index.test.ts`・`src/mcp/__tests__/tools.test.ts`・`src/__tests__/execute*.test.ts`。

**ゲート**: 工程 0 が全 green になるまで工程 A 以降へ進まない。以降の各工程は「この baseline を割らない」ことを最低条件とする。

## 4. 工程一覧（仕様 §19 推奨順に対応）

| 工程 | 内容 | 仕様 | 主担当 | レビュー |
|---|---|---|---|---|
| 0 | baseline テスト固定 | §16.4 | Codex | Claude |
| A | `logicalApps` schema・検証・共通 resolver（純粋関数） | §6・§19-1 | Codex | Claude |
| B | scanner 拡張・offset map・共有 allocator・binding 拡張 | §5・§8.1・§8.2・§19-2 | Codex | Claude |
| C | binding 由来 token 要求導出・routing・tokenMap・cacheContext | §8.3・§8.4・§19-3 | Codex | **Codex+Claude** |
| D | validation / EXPLAIN 可視化・`allowPhysicalAppRefs` 判定・エラー | §9・§19-4 | Codex | Claude |
| E | MCP query/mutate/saved query・CLI 接続・DELETE ガード | §10・§11・§19-5,6 | Codex | Claude |
| F | 公開ドキュメント・sample・回帰テスト仕上げ | §15.5・§19-7 | Codex | Claude |

各工程は独立に `build` + 対象テストを通す。工程 A → F は依存順で、飛ばさない。保存クエリ値パラメータ化とは同時実装しない（§19 末尾）。

## 5. 設計上の要決定点（Codex 計画レビューで確定）

実装着手前に確定させる。仕様 §18 の未決事項に対応。**Codex 計画レビュー（2026-07-12）で下記のとおり確定済み**。

1. **resolver 注入方式**: `normalizeSqlAppProfiles` へ config を直渡ししない。config snapshot を閉じ込めた共通コンテキストを注入し、CLI/MCP それぞれでコールバックを組み立てない。**config 層に factory を1つ置く**（§14.7-2 の共通実装を保証）。

   ```ts
   interface AppResolutionContext {
     // 未定義論理名・未知 profile は throw（ArgumentError）。undefined を返さない
     resolveLogicalApp(name: string, profile: string): number;
     // allowPhysicalAppRefs:false の profile で物理参照が来たら throw
     assertPhysicalAppAllowed(profile: string): void;
   }
   ```

   `number | undefined` を返す形は採らない。未定義名のエラー化・未知 profile・`allowPhysicalAppRefs` の責務が呼び出し側へ分散するため、resolver 内へ閉じ込める。

2. **binding 型は必須 `source` の discriminated union**（optional 追加は採らない）。`source` 必須は仕様 §8.1 の要件。`logicalName` 欠落や `source === undefined` を物理扱いする事故を型で防ぐ（fail-closed を型で担保）。

   ```ts
   type AppBinding =
     | { source: "physical"; mappedAppId: number; appId: number; profile: string }
     | { source: "logical"; logicalName: string; mappedAppId: number; appId: number; profile: string };
   ```

   消費側（runtime routing・cacheContext・formatter・validation payload）を同時更新。

3. **`allowPhysicalAppRefs` の適用範囲**: 初回は profile 単位のみ。server 全体既定は設けない（§18-1、初回スコープを狭く保つ）。判定は `AppResolutionContext.assertPhysicalAppAllowed` に集約。

4. **mapped ID allocator**: 既存 `nextVirtualAppId`（`appProfiles.ts:183`）の `usedAppIds` 集合を物理 ID・profile 混在仮想 ID・論理 mapped ID で共有（§8.2）。allocator を分けない。

5. **フィールド公開範囲（§18-3 確定）**: 正式名は §9.1 の `source`/`logicalName`/`mappedAppId`/`appId`/`profile`。ただし **`mappedAppId` の公開先は structured validation payload に限定**（R8 §8.1）。**EXPLAIN は `source`/`logicalName`/`appId`/`profile` のみ表示し `mappedAppId` を出さない**。人間向けテキスト・CLI stderr・MCP error にも内部 mapped ID を露出させない。

6. **正規化結果 `ResolvedSqlContext` の共有（後述 §5.1）**: validation で作った binding/config snapshot を runtime へ渡し、実行時に再解決しない。

## 5.1 validation と実行の binding/config snapshot 共有【高・Codex 指摘反映】

**問題**: 現行構造は validate（`mcp/tools.ts:189` `normalizeSqlForTool` / `cli/index.ts:1501`）と runtime（`runtime.ts:71` `loadOptionalKsqlConfig` → `normalizeSqlAppProfiles` 再実行）で config を独立に読み直す。config が両者の間で変わると、確認した物理アプリと実行先が食い違う。R8 §11「validation / EXPLAIN / 確認表示と実 API 呼び出しが同じ binding snapshot」に反する。

**方針**: 正規化結果を1つの値に閉じ込め、validation から runtime へ受け渡し、runtime で再解決しない。ただし token 導出には profile 設定・`tokenMap`・認証設定が要るため、binding だけの `ResolvedSqlContext` では runtime が config を再読込せざるを得ない。`configSnapshotId` は証跡でありデータではないので再読込を防げない（Codex R2 指摘）。**2層コンテキストへ分離**して解決する。

**層1: `ResolvedSqlContext`（token を持たない・validation surface へ返せる）**

```ts
interface ResolvedSqlContext {
  normalizedSql: string;
  bindings: Map<number, AppBinding>;   // mappedAppId -> binding
  cacheContext: string;
  profileName: string;
  // 再読込を防ぐため証跡でなく不変 config snapshot 自体を保持する。
  // token 値・password を含まない読取り専用ビュー（baseUrl / logicalApps /
  // allowPhysicalAppRefs / tokenMap の env 参照キー等、非秘匿の解決入力のみ）。
  configSnapshot: Readonly<ResolvedConfigView>;
}
```

- validation / EXPLAIN / 確認表示はこの層だけを使う。§5-5 の露出規則（`mappedAppId` は payload 限定・EXPLAIN 非表示）を守る。**token 値・password をこの型に含めない**。

**層2: `ResolvedRuntimeContext`（token 解決済み・runtime 内部専用）**

```ts
interface ResolvedRuntimeContext {
  sqlContext: ResolvedSqlContext;         // 同一 snapshot を包含（再 normalize しない）
  tokenByMappedApp: Map<number, string>;  // mappedAppId -> 実 token（秘匿）
  clientsByProfile: Map<string, KintoneClient>;
}
```

- runtime は **層1 の `configSnapshot` から** token・認証を解決して層2を構築する。ファイルからの config 再読込（`runtime.ts:71` `loadOptionalKsqlConfig`）と再 normalize（`normalizeSqlAppProfiles`）を廃す。
- token 解決は §8.3 の binding 起点導出（mapped ID→binding→物理 ID→`tokenMap.APP<物理>`）に従い、logical binding 欠落・物理 ID fallback・single-token fallback を禁止（§14.7-4）。
- `tokenByMappedApp` の値（token）は **validation payload・EXPLAIN・cacheContext・CLI stderr・MCP error・ログへ一切出さない**。層2は runtime プロセス内のみで保持し、外部へ返さない。エラーには論理名・物理 ID・profile のみ含める（§8.3）。

**共有規約**

- 1回の解決で層1を確定 → 実行時に層1から層2を構築。CLI/MCP どちらの入口も同じ層1を経由（§14.7-2 の単一経路）。
- config 読取り（ファイル I/O）は1回だけ。runtime が独自に再読込する経路を残さない。
- validate と run は同一 config スナップショットに基づく。間で config ファイルを差し替えても、実行は層1 `configSnapshot` に従う。

工程 C（層1・層2 生成と runtime 受け渡し）・工程 E（validate → run で同一層1を使う）で実装。§8 受け入れ条件に #5b（config 差替えでも実行は snapshot 準拠）と #8b（token 値が payload/ログ/EXPLAIN へ出ない）を追加する。

## 6. 工程別の実装内容

### 工程 A — config schema・検証・共通 resolver

- `src/node/config.ts`: `KsqlProfileConfig` に `logicalApps?: Record<string, number>` と `allowPhysicalAppRefs?: boolean` を追加（§6.1）。
- config 読込時 validation（§6.2・§6.5）: 論理名 `[A-Z][A-Z0-9_]{0,63}` 正規化可否、`APP`+数字 / 数字のみ / `LAPP_` 付きキー拒否、物理 ID が正の safe integer、大文字正規化後の重複拒否、同一 profile 内での物理 ID 重複（alias 未対応メッセージ）拒否、`allowPhysicalAppRefs` の boolean 検証。
- `src/node/`（例: `logicalApps.ts` 新規）に config 層 factory: `createAppResolutionContext(config, profileName) => AppResolutionContext`（§5-1）。
  - `resolveLogicalApp(name, profile): number` — 論理名を ASCII 大文字正規化し `profiles[profile].logicalApps[NAME]` を引く。**未定義論理名・未知 profile は `ArgumentError` を throw**（§6.3、`undefined` を返さず fallback しない）。
  - `assertPhysicalAppAllowed(profile): void` — `allowPhysicalAppRefs:false` の profile で物理参照が来たら throw（§6.4・§9.3）。
  - CLI/MCP はこの factory を呼ぶだけで、コールバックを各 surface で組み立てない。

### 工程 B — scanner・offset map・allocator・binding

- `tryParseAppProfileToken` に `LAPP_` 分岐を追加。`LogicalName ::= [A-Za-z][A-Za-z0-9_]{0,63}`、`$subtable`・`@profile` を維持、ASCII 大文字正規化（§5.2）。
- `AppBinding` を必須 `source` の discriminated union へ（§5-2）。`physical` は `logicalName` を持たず、`logical` は `logicalName` 必須。optional 追加はしない。
- scanner-rewrite: `LAPP_ORDERS$明細@prod → APP<mapped>$明細`。`@profile` と `LAPP_` を除去しサブテーブル位置維持（§8.1）。
- `SqlRewriteSegment[]` を **初回実装から必須**生成（§8.1・§14.7-5）。offset map で元 SQL 位置・表記を復元。内部 mapped ID を利用者向けへ露出させない。
- allocator を物理／profile 混在仮想 ID／論理 mapped ID で共有（§8.2）。物理・論理が同一 physical+profile でも別 binding・別 mapped ID。

### 工程 C — token 要求導出・routing・cacheContext・context 共有（**高リスク・Codex 再レビュー**）

- 2層コンテキスト（§5.1）: 層1 `ResolvedSqlContext`（不変 config snapshot 保持・token なし）を1回の解決で確定し、runtime は層1の `configSnapshot` から層2 `ResolvedRuntimeContext`（token 解決込み・内部専用）を構築する。runtime が独自に `loadOptionalKsqlConfig` + `normalizeSqlAppProfiles` を再実行する現行経路（`runtime.ts:71-75`）を廃す。
- token 値（層2 `tokenByMappedApp`）を validation payload・EXPLAIN・cacheContext・ログ・エラーへ出さない（§5.1）。
- token 要求を **mapped ID 集合**から導出し、各 binding から物理 ID・profile を引いて tokenMap 検索（§8.3）。物理 ID を engine appIds へ混ぜない。
- `runtime.ts:161` の `?? mappedAppId` 物理 ID fallback、`runtime.ts:168` の single-token fallback を **logical source では禁止**。binding 欠落は API 呼び出し前に `InternalError` で停止（§8.3・§14.7-4・§16.3-12）。
- LAPP のみの SQL でも default app / single-token の偶然 fallback に依存せず正しい token 要求が立つ（§16.3-7,8）。
- routing: `routedClient` の各メソッドが binding から物理 ID・profile を解決（`runtime.ts:205-237` を binding 拡張に追従）。
- cacheContext に source・論理名・mapped ID・物理 ID・profile を安定順で含める（§8.4）。
- CLI（`index.ts:1660-`）と runtime の token 導出重複を、`src/node/` の共通 helper へ統一（§14.7-2）。

### 工程 D — validation / EXPLAIN・物理参照制限・エラー

- validation payload に `source`/`logicalName`/`mappedAppId`/`appId`/`profile`（§9.1）。物理は `source:"physical"`・`logicalName` なし。**`mappedAppId` を出すのは structured validation payload のみ**（§5-5）。
- EXPLAIN に app source / logical app / profile / physical app、DML target 表示（§9.2）。**EXPLAIN には `mappedAppId` を出さない**（`source`/`logicalName`/`appId`/`profile` のみ）。人間向けテキスト・CLI stderr・MCP error にも内部 mapped ID を露出させない。
- `allowPhysicalAppRefs:false` を binding の `source` で判定（§9.3・§14.7-3）。rewrite 後 `APP<id>` の再走査で判定しない。
- エラー文言（§9.3）: 未定義論理名・未知 profile・禁止物理参照を parse 後 / API 前に拒否。利用者向けに元 `LAPP_` 表記を表示。

### 工程 E — MCP / CLI 接続・DELETE ガード

- MCP validate/explain/query/mutate/saved query で同一 resolver（`normalizeSqlForTool` `tools.ts:189` 経由）・structured binding・DML resolved target（§10・§15.4）。
- **validate → run で同一 `ResolvedSqlContext` を使う**（§5.1）。validate が返した binding と実行 route 先が一致し、間で config を差し替えても実行は snapshot に従う。runtime 側で再 normalize しない。
- CLI 診断表示に論理名 → 物理 ID を追加（`formatResolvedAppProfiles` 拡張）。
- CLI DELETE 制約（`index.ts:1620`）を rewrite 前 `hasExplicitProfile` 相当情報で判定。正規化後に `@profile` が消えた SQL だけで回避されないこと（§11.1）。resolver は複製しない。

### 工程 F — ドキュメント・回帰

- `docs/cli_app_profile_spec.md`・`docs/ksql_language_reference.md`・`docs/ksql_cli_tutorial.md`・`docs/ksql_mcp_server_spec.md`・`README.md`・config sample（§15.5）。
- 回帰テスト仕上げ（§16.4）。

## 7. 仕様 → コード → テスト対応表

| 仕様節 | 実装対象（ファイル / 記号） | テスト（§16 番号） |
|---|---|---|
| §6.1 `logicalApps` / `allowPhysicalAppRefs` | `config.ts` `KsqlProfileConfig` | §16.1-1,6 |
| §6.2 禁止キー | `config.ts` validation | §16.1-2 |
| §6.5 設定検証 | `config.ts` validation | §16.1-3,4,5 |
| §6.3 解決規則 / fallback 禁止 | `src/node/logicalApps.ts` resolver | §16.2-2,3 |
| §5.2 `LAPP_` 構文・ASCII 正規化 | `appProfiles.ts` `tryParseAppProfileToken` | §16.2-2,13 |
| §5.1 物理参照不変 | `appProfiles.ts`（既存分岐維持） | §16.2-1 |
| §8.1 binding 型 / source / logicalName | `appProfiles.ts` `AppBinding` | §16.2-9,12 |
| §8.1 rewrite | `appProfiles.ts` `normalizeSqlAppProfiles` | §16.2-11 |
| §8.1 offset map | `appProfiles.ts` `SqlRewriteSegment` | §16.2-14,15 |
| §8.1 scanner skip | `collectAppProfileTokens`（文字列/コメント/backtick） | §16.2-8 |
| §8.2 共有 allocator | `appProfiles.ts` `nextVirtualAppId` / `usedAppIds` | §16.2-10 |
| §8.2 物理・論理 別 binding | `appProfiles.ts` | §16.2-9 / §16.3-9 |
| §8.3 token 要求導出 / fail closed | `runtime.ts` token ループ・共通 helper | §16.3-7,8,12 |
| §8.4 cacheContext | `appProfiles.ts` `buildCacheContext` | §16.3-3 |
| §11・§5.1 validation/実行 snapshot 共有 | 層1 `ResolvedSqlContext`（config snapshot 保持）→ 層2 `ResolvedRuntimeContext` | §16.3-5,6 + 新規（config 差替えでも実行は snapshot 準拠） |
| §5.1・§13 token 秘匿 | 層2 `tokenByMappedApp`（payload/ログ/EXPLAIN 非露出） | 新規（token が外部出力へ出ない） |
| §6.3・§6.4 resolver factory | `src/node/logicalApps.ts` `AppResolutionContext` | §16.1-2 / §16.2-3,4 |
| §9.1 validation 出力（mappedAppId は payload 限定） | `mcp/tools.ts` `validate` `appBindings` | §16.3-4 |
| §9.2 EXPLAIN（mappedAppId 非表示） | `mcp/tools.ts` `explain` / CLI dry-run plan | §16.3-4,5 / §16.2-15 |
| §9.3 `allowPhysicalAppRefs` source 判定 | validation 経路（CLI/MCP 共通） | §16.2-4 |
| §11.1 DELETE 明示 profile | `cli/index.ts:1620` DELETE ガード | §16.3-10,11 |
| §10 保存クエリ | `mcp/tools.ts` saved query 経路 | §16.3-6 |
| §12 後方互換 | 全経路（物理 SQL 不変） | §16.4 |

## 8. 受け入れ条件チェックリスト（仕様 §17 = R8）

両者で最終確認する。各項目に「確認テスト」「担当」を紐付ける。

| # | 受け入れ条件（§17 要約） | 主な確認 | 突合 |
|---|---|---|---|
| 1 | `APP899@prod` が logicalApps 有無に関わらず物理 899 | §16.2-1 | Claude |
| 2 | 論理解決は `LAPP_` のみ | §16.2-2 | Claude |
| 3 | config キー `APP899`/`899`/`LAPP_ORDERS` 拒否 | §16.1-2 | Claude |
| 4 | 未定義論理名を fallback せずエラー | §16.2-3 | Claude |
| 5 | validation/EXPLAIN/DML 確認で解決先可視 | §16.3-4,5 | Claude |
| 5b | validate と実行が同一 snapshot（config 差替えでも実行は snapshot 準拠） | §5.1 新規テスト | **Codex+Claude** |
| 8b | token 値が validation payload / EXPLAIN / cacheContext / ログ / エラーへ出ない | §5.1 新規テスト | **Codex+Claude** |
| 6 | 同一 `LAPP_ORDERS` を profile 差で共有 | §16.2-5 | Claude |
| 7 | `allowPhysicalAppRefs:false` で fail closed | §16.2-4 | Claude |
| 8 | token/cache/routing が物理 ID・profile で分離 | §16.3-1,2,3 | **Codex+Claude** |
| 9 | 既存 `APPxxx` SQL に回帰なし | §16.4 | Claude |
| 10 | 旧バージョンが新構文を誤 route せず parse error | 後方互換（設計確認） | Claude |
| 11 | token 要求が binding 由来・LAPP のみでも認可漏れなし | §16.3-7,8 | **Codex+Claude** |
| 12 | CLI/MCP が同一 scanner/resolver/allocator/binding/token 導出 | §16.3-6 | **Codex+Claude** |
| 13 | DELETE 明示 profile 制約が surface 別に維持 | §16.3-10,11 | Claude |
| 14 | offset map で元 SQL 診断・内部 mapped ID 非露出 | §16.2-14,15 | Claude |
| 15 | `allowPhysicalAppRefs` 保証範囲が kSQL SQL surface 限定 | 設計・ドキュメント確認 | Claude |
| 16 | logical binding 欠落時に fallback しない | §16.3-12 | **Codex+Claude** |

## 9. 完了条件

1. §3 baseline を含む全既存テストが green
2. §7 対応表の全新規テストが green
3. §8 受け入れ条件 16 項目を両者確認済み（#8,11,12,16 は Codex 再レビュー済み）
4. §6.F ドキュメント更新済み
5. 仕様 R8 との差分ゼロ（差分があれば本書 or 仕様を更新）
