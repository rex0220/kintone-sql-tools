# B130 codex 実装報告（2026-08-06）

## 結果

**完了。** R3 に従い、`DESCRIBE` / `DESC` の末尾へ「値の由来」4列を追加した。

```text
フィールドコード | ラベル | タイプ | ルックアップ | コピー元 | 重複禁止 | 計算式
```

- 失敗テストを先に追加し、未実装時に `lookup: null`、`unique`、`expression`、公開型の4フラグが未定義でコンパイル失敗することを確認した
- 最終 `npm test`: **成功**
  - 通常: **225 suites / 5,426 tests / 22 snapshots passed**
  - CLI subprocess: **2 suites / 26 tests passed**
  - 合計: **227 suites / 5,452 tests passed**
- `npm run build`: **成功**（plugin / CLI / MCP / MCPB / engine）
- `npm run mcp:smoke`: **成功**
- `npm run mcp:pack-smoke`: **成功**
- `npm run engine:declaration-smoke`: **成功**
- 運用制約どおり **kSQL MCP と実機 API は実行していない**

## 変更ファイルと内容

### 実装

- `src/core/formFieldInfo.ts`
  - `FormFieldProperty.lookup` を `null` 許容に変更
  - `unique` / `expression` を追加
  - `hasLookup` は値ではなく `lookup` キーの存在で判定
  - `isLookupCopyTarget` は既存 `collectLookupCopyFields` の集合で判定
  - `isUnique` は `unique === true` で判定
  - `isCalculated` は `type === "CALC"` または非空 `expression` で判定
  - 公式 client の正規化では4フラグを常に boolean で埋める
- `src/execute.ts`
  - 公開型 `KintoneFieldInfo` に4フラグを optional で追加
  - `executeDescribe` を7列へ拡張し、`=== true` のときだけ文字列 `YES`、それ以外は空文字を返す
  - R3 §4.2-9 に従い、通常 UNION と CTE 内 UNION の両経路で左右の列数不一致を `ArgumentError` にした。同じ列数の位置対応は従来どおり
- `src/engine-library/publicTypes.ts`
  - npm BYO client 向け公開型 `ReadonlyFieldInfo` に4フラグを optional で追加
  - 省略時は DESCRIBE が空文字へ fallback する契約をコメントに追記

### 新規テスト

- `src/__tests__/b130DescribeFlags.test.ts`（6 tests）
  - トップレベルとサブテーブル子の4フラグ導出
  - `lookup: null` をルックアップとして検出
  - 空 `expression` の非計算判定、`CALC` / 非空 `expression` の計算判定
  - `unique === true` とプロパティ欠落の区別
  - システムフィールドの4フラグ false
  - 既存3列を維持した7列直接 DESCRIBE、全値 string
  - CTE `SELECT *` の7列、新列の WHERE 参照
  - 7列対3列 UNION の列数不一致
  - JOIN 同名列の修飾参照
  - 0行 BYO DESCRIBE の7列 schema、BYO フラグ欠落時の4空文字

### 説明文・文書

- `src/mcp/index.ts`: `ksql_describe_app` に lookup / lookup copy target / unique / calculated を明記
- `scripts/mcp-smoke.mjs` / `scripts/mcp-pack-smoke.mjs`: 同じ4語を固定
- `src/mcp/__tests__/metadataTools.test.ts` / `src/mcp/__tests__/tools.test.ts`: 説明文追従
- `docs/ksql_language_reference.md`
  - §13 の DESCRIBE 例を実在する日本語列名へ修正
  - §14 の DESCRIBE 列表を7列へ修正し、例も日本語列名へ修正
  - SHOW APPS の誤列表はスコープ外（B136）のため変更していない
- `CHANGELOG.md`
  - 3列から7列への `SELECT *` の互換性影響
  - 既存3列を列挙する移行例
  - JOIN 同名列、UNION / `INSERT ... SELECT` の注意を追記

### 形式的追従だけを行った既存テスト・スナップショット

- `src/core/__tests__/b65GroupByConsumerAllowlist.test.ts`
  - `KintoneFieldInfo` への8行追加による `.groupBy` 行番号の 2881 / 2920 → 2889 / 2928 のみ更新
- `scripts/fixtures/engine-public-exports.snapshot.json`
  - `ReadonlyFieldInfo` の公開 optional 4プロパティを追加
- MCP 説明文の既存 key 配列（上記2テストと2 smoke）
  - 実装説明文と同じ語の存在検査だけを追加

### ビルド生成物

フルビルドにより `prod/js/desktop.js`、`prod/js/config.js`、`dist/ksql-plugin-v3.48.0.zip`、`dist-cli/`、`dist-mcp/`、`dist-mcpb/`、`dist-engine/` を再生成した。

## R3 §4 受入結果

### §4.1 出力

| 受入 | 結果 |
|---|---|
| 7列、ルックアップ `YES` | **単体テスト成功** |
| コピー先 `コピー元 = YES`、空 `expression` は `計算式 = ""` | **単体テスト成功** |
| `CALC` は `計算式 = YES` | **単体テスト成功** |
| `unique === true` は `YES`、欠落は空文字 | **単体テスト成功** |
| システムフィールドは4つとも空 | **正規化フラグ4 false を単体テストで確認** |
| `lookup: null` でも `ルックアップ = YES` | **単体テスト成功** |
| サブテーブル子へ同じ判定 | **単体テスト成功** |
| 全行・全列 string | **B130 テストと既存 engine-library acceptance が成功** |
| APP4228 / APP4229 実機 | **未実施**。依頼書の「kSQL MCP を叩かない」に従い、同じ形の fixture で固定した |

### §4.2 回帰

| # | 受入 | 結果 |
|---:|---|---|
| 1 | 既存3列の名前・順序・値 | **成功**。新列は末尾のみ |
| 2 | CTE から `フィールドコード` を参照 | **既存 B86 テストを含む全テスト成功** |
| 3 | `ksql_describe_app` が同じ SQL を組み立てる | **`tools.test.ts` 成功** |
| 4 | MCP smoke / pack smoke | **両方成功** |
| 5 | engine-library acceptance | **成功** |
| 6 | CTE 下流で新列を WHERE 参照 | **B130 テスト成功** |
| 7 | 直接 / CTE の `SELECT *` が7列 | **B130 テスト成功** |
| 8 | 0行 BYO DESCRIBE でも7列 | **B130 テスト成功** |
| 9 | UNION 列数不一致 | **B130 テスト成功**。実装前は空文字で補完して成功していたため両実行経路を修正 |
| 10 | JOIN 同名列の `d.ルックアップ` | **B130 テスト成功** |
| 11 | BYO フラグ欠落時の空文字 fallback | **4列すべてで B130 テスト成功** |

## 仕様と違えた箇所・仕様内で見つけた不整合

実装結果は依頼書と R3 §2 / §3 / §4 の4列仕様に合わせた。意図的に仕様と違えた箇所はない。

ただし、R3 内には4列化前の記述が残っている。

1. §3.3 の「新しい3フラグ」、§3.4 の「新3列」、§4.2-11 の「3列とも」は4列仕様と不一致。依頼書の訂正と R3 §2.1 を優先して **4つすべて**実装・検証した
2. §4.3 末尾の「`仕入先` がルックアップのコピー先であることは依然 describe から見えない」は、R3 §2.3 と §4.1 の `コピー元 = YES` に反する。`コピー元` 列を出す確定仕様を優先した
3. §4.2-9 の UNION 列数不一致は現行実装では検出されず、右辺不足列を空文字補完していた。受入条件を満たすため、左右の列数を明示検査するよう修正した

## 仕様が決まっていなかった箇所（R3 §6）

1. `lookup` が空 object で来る実例は未確認。キー存在判定なので、来た場合も `ルックアップ = YES` になる
2. `CALC` 以外で非空 `expression` が来る実例は未確認。仕様どおり型に依存せず非空文字列なら `計算式 = YES` にした
3. 説明文は4か所で同じ語になるよう **`lookup, lookup copy target, unique, and calculated fields`** とした。既存の `field code` / `label` / `type` は維持した

## 罠10: 権限不足時のコピー元の穴

確認結果は R3 の注記どおり。`collectLookupCopyFields` は `field.lookup?.fieldMappings` を走査するため、`lookup: null` では mappings を得られずコピー先集合を作れない。

- ルックアップ本人: キー存在判定により `ルックアップ = YES`
- コピー先: mapping が取得できないため `コピー元 = ""` になり得る
- 既存 `writable` も同じ集合を使うため、同じ条件で `writable: true` と誤判定し得る

本件では仕様どおり作り込んでいない。別課題候補。

## 既存テストへの影響 / 未実施

- 最初の `npm test` は、実装による行番号ずれだけで `b65GroupByConsumerAllowlist.test.ts` が1件失敗した。形式的な期待行番号2件を更新後、全件成功
- `mcp:pack-smoke` の初回は `ReadonlyFieldInfo` 公開プロパティ snapshot が新4項目を検知して失敗した。公開型追加に追従後、declaration smoke と pack smoke は成功
- 既存テストの意味論的な期待値は変更していない
- 実機 APP4228 / APP4229 は未実施
- kSQL MCP は未実施
- 開始時、依頼書を読み切る前に確認コマンドへ `git status --short` を含めてしまった。読み取り1回のみで変更はないが、「git 操作は一切しない」制約からの逸脱。以後 git コマンドは実行していない
