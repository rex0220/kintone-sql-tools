# CLI `APP@profile` 実装手順書（二段Mapキャッシュ版）

## 1. 目的

`cli-ksql` で `APP@profile` を扱う際に、同一 `appId` を profile 混在で参照してもキャッシュ衝突しない実装にする。

例:

- `APP100@dev`
- `APP100@guest`
- `APP100`（既定profile）

## 2. 方針

`execute.ts` の app単位キャッシュを、以下の二段 `Map` に変更する。

- `Map<context, Map<appId, value>>`

ここで `context` は:

- CLI: SQLごとに解決された context 名（mapped app束縛を含む）
- Plugin: 固定値（例: `plugin-default`）

## 3. 変更対象

1. `src/execute.ts`
- キャッシュ定義
- キャッシュ参照/格納ヘルパー
- `execute` オプションに `cacheContext` を追加

2. `src/cli/index.ts`
- `execute(...)` 呼び出し時に `cacheContext` を渡す
- `APP@profile` なし時は既定profile名を渡す

3. （必要に応じて）`src/ui/desktop.ts`
- `execute(...)` 呼び出し時に固定 `cacheContext` を渡す  
  または未指定時既定値利用

4. テスト
- `src/__tests__/execute.test.ts`（キャッシュコンテキストの回帰防止）
- `src/cli/__tests__/index.test.ts` / e2e（profile混在ケース）

## 4. 実装ステップ

## Step 1: `ExecuteOptions` に `cacheContext` を追加

対象: `src/execute.ts`

1. `ExecuteOptions` に `cacheContext?: string` を追加
2. 実行中に `const ctx = options.cacheContext ?? "default";` を解決

## Step 2: キャッシュを二段Mapに変更

対象: `src/execute.ts`

現状（単層）:

- `Map<number, ...>`

変更後（二層）:

- `Map<string, Map<number, ...>>`

対象キャッシュ:

1. `fieldTypeCache`
2. `optionOrderCache`
3. `sortKindCache`
4. `fieldInfoCache`

## Step 3: 共通ヘルパー導入

対象: `src/execute.ts`

以下のようなヘルパーを追加する。

1. `getScoped(cache, ctx, appId)`
2. `setScoped(cache, ctx, appId, value)`
3. `getOrCreateScope(cache, ctx)`

目的:

- 参照/格納ロジックを1箇所に集約
- 4種キャッシュの実装重複を減らす

## Step 4: 各キャッシュ利用関数のシグネチャ更新

対象: `src/execute.ts`

変更対象関数（例）:

1. `getFieldsCached(appId, client)` -> `getFieldsCached(appId, client, ctx)`
2. `getFieldTypeMap(appId, client)` -> `getFieldTypeMap(appId, client, ctx)`
3. `getOptionOrderMapByApp(appId, client)` -> `getOptionOrderMapByApp(appId, client, ctx)`
4. `getSortKindMapByApp(appId, client)` -> `getSortKindMapByApp(appId, client, ctx)`

呼び出し側から `ctx` を渡す。

## Step 5: `execute` 内の呼び出し伝播

対象: `src/execute.ts`

1. `execute(...)` 冒頭で `ctx` を解決
2. 上記4関数に `ctx` を渡す
3. `SELECT/INSERT/UPDATE/UPSERT/DESCRIBE` の全経路で同じ `ctx` が使われることを確認

## Step 6: CLI から `cacheContext` を渡す

対象: `src/cli/index.ts`

1. 既定実行時:
- `cacheContext = selectedProfileName` を `execute(..., { ... })` に付与

2. `APP@profile` 実装済みの場合:
- SQLごとに解決された束縛情報（`mappedAppId -> appId@profile`）を context へ反映して付与

3. plugin 側は固定:
- `cacheContext = "plugin-default"`

## Step 7: テスト追加・更新

### 単体

対象: `src/__tests__/execute.test.ts`

1. 同一 `appId` で `cacheContext` が異なる場合、キャッシュが混在しないこと
2. `cacheContext` 未指定時は `"default"` で従来互換

### CLI

対象: `src/cli/__tests__`

1. profile違いの連続実行（REPL想定）で誤ったフィールド情報再利用が起きないこと
2. `APP@profile` なしは既定profile文脈になること

## 5. 受け入れ基準（DoD）

1. 同一プロセス内で `APP100@dev` 実行後に `APP100@guest` を実行してもキャッシュ衝突しない
2. 既存ケース（profile未使用）は従来どおり動作する
3. 既存テストが通り、追加テストが通る

## 6. リスクと対策

1. `cacheContext` 渡し漏れ
- 対策: 主要関数のシグネチャを必須化し、コンパイルエラーで検出

2. メモリ増加（context数ぶんキャッシュが増える）
- 対策: 必要なら将来 `context` ごとのクリア関数を追加

3. CLIとPluginの context 命名ぶれ
- 対策: 定数化（例: `DEFAULT_CACHE_CONTEXT`, `PLUGIN_CACHE_CONTEXT`）
