# 課題: extractAppIds がコメント・文字列リテラル内の `APPxxxx` もトークン解決対象にする

- 作成日: 2026-07-11
- 更新履歴:
  - 2026-07-11 R1: 起票（ksql-actions の CI 教訓集 P5「kSQL は SQL コメント内の `APPxxxx` もトークン解決対象にする」の根本原因調査で発見。コード裏取り済み）
  - 2026-07-11 R2: 修正実装（`extractAppIds` を `collectAppProfileTokens` 再利用に置換 + 単体/統合回帰テスト追加）。ブランチ `fix/extract-app-ids-ignore-comments-strings`
- ステータス: **修正済み（v1.12.1）**
- 発見経緯: `C:\Users\rex02\Projects\ksql-actions\docs\ci-troubleshooting-lessons.md` P5

## 事象

SQL の**コメント**または**文字列リテラル**に `APPxxxx` 形式の文字列が含まれると、その AppID が「参照アプリ」として認可判定に混入し、profile の tokenMap に無い場合に `AuthError: token is missing for APPxxxx@profile.` で落ちる。

```sql
-- 実例（ksql-actions connectivity.sql）
-- 通知(APP4206)・死活監視(APP4207)
SELECT COUNT(*) FROM APP4205
```

`batch` profile は APP4205 のトークンしか持たないのに、**コメント内の 4206 / 4207 が拾われて** `token is missing` になった。

| SQL 中の `APP4206` の位置 | 現状の挙動 | 期待挙動 |
|---|---|---|
| `FROM APP4206`（本文・テーブル参照） | トークン要求 ✅ | トークン要求 |
| `-- ... APP4206 ...`（行コメント） | **トークン要求 ❌** | 無視 |
| `/* ... APP4206 ... */`（ブロックコメント） | **トークン要求 ❌** | 無視 |
| `WHERE 備考 = 'APP4206の件'`（文字列リテラル） | **トークン要求 ❌** | 無視 |
| `` `APP4206` ``（バッククォート識別子中） | **トークン要求 ❌** | 無視（※フィールド名等） |

コメントより **文字列リテラル**のケースの方が気づきにくく危険（例: 通知メッセージ・説明文に "APP1234" と書いただけで実行不能になる）。

## 原因（コード裏取り済み）

APP 参照を SQL から拾う経路が **2 つあり、コメント/文字列の扱いが食い違っている**。

### 経路A（正しい・コメント/文字列を除去する）

- `collectAppProfileTokens`（`src/node/appProfiles.ts:127-177`）は、文字列リテラル `'...'`・バッククォート `` `...` ``・行コメント `--`・ブロックコメント `/* */` を明示的にスキップしてから APP トークンを収集する。
- レキサ `skipWhitespaceAndComments`（`src/lexer/lexer.ts:265-312`）も同様にコメントを非トークンとして捨てる。
- → kSQL 本流は「コメント・文字列は非意味」という設計。

### 経路B（不整合・生 SQL を素の正規表現でなめる）

`extractAppIds`（`src/node/appProfiles.ts:40-44`）:

```js
export function extractAppIds(sql: string): number[] {
  const out = new Set<number>();
  for (const m of sql.matchAll(/\bAPP(\d+)\b/gi)) out.add(Number(m[1])); // 生SQL全体・コメントも文字列も除外しない
  return [...out];
}
```

- コメント除去も文字列除去もしない。
- この戻り値がそのまま「必要トークン一覧」になる:
  - `src/node/runtime.ts:102`（`extractAppIds(sql)` → `missingAppProfiles` → `:196-197` で `token is missing` 発火）
  - `src/cli/index.ts:1590`（同上）
- なお `runtime.ts:75-76` で `sql = normalizeSqlAppProfiles(...).normalizedSql` だが、正規化は経路A（コメント/文字列を飛ばす）で拾ったトークンしか書き換えないため、**コメント内 `APP4206` は正規化後も原文のまま残り**、続く `extractAppIds` の正規表現が拾ってしまう。

結論: 同一ファイル内で「コメント/文字列は非意味」という設計に `extractAppIds` だけが従っておらず、P5 はこの片肺実装の直接の帰結。SQL 標準でもコメントは非意味であり、コメント/文字列中の識別子様文字列を認可判定に使うのは静的解析として不正。**不具合と判断**する。

## 修正方針（案）

既にコメント/文字列を正しくスキップする `collectAppProfileTokens` を再利用し、2 経路を単一スキャナに統一する（最小・低リスク）。

```js
// src/node/appProfiles.ts
export function extractAppIds(sql: string): number[] {
  const out = new Set<number>();
  for (const t of collectAppProfileTokens(sql)) out.add(t.appId); // コメント/文字列/バッククォートは除外済み
  return [...out];
}
```

- `collectAppProfileTokens` は同ファイル内の既存関数。`extractAppIds` を宣言順で後方へ移すか、関数宣言のホイスティングに委ねる（関数宣言なので同一モジュール内なら順序非依存）。
- `@profile`（`APP100@dev`）や `$subtable`（`APP100$明細`）を含む有効な APP 参照も従来どおり AppId を取得でき、境界判定を既存トークン定義（`collectAppProfileTokens` / `tryParseAppProfileToken`）に統一できる。

### 代替案（非推奨）

正規表現側でコメント/文字列を事前除去する前処理を挟む案もあるが、除去ロジックを二重に持つことになり `collectAppProfileTokens` とドリフトする。**再利用案を採る。**

## テスト（回帰固定）

### 単体（`src/cli/__tests__/index.test.ts`）

`:25-26` の既存テスト（`extractAppIds scans SQL`）は本文参照のみなので変更不要でパスする。以下を追加:

```js
test("extractAppIds はコメント内の APPxxx を無視する", () => {
  expect(extractAppIds("-- 通知(APP4206)\nSELECT * FROM APP4205")).toEqual([4205]);
  expect(extractAppIds("/* APP4207 */ SELECT * FROM APP4205")).toEqual([4205]);
});

test("extractAppIds は文字列リテラル内の APPxxx を無視する", () => {
  expect(extractAppIds("SELECT 'APP4206の件' AS x FROM APP4205")).toEqual([4205]);
});

test("extractAppIds はバッククォート識別子内の APPxxx を無視する", () => {
  expect(extractAppIds("SELECT `APP4206` FROM APP4205")).toEqual([4205]);
});

test("extractAppIds は @profile / $subtable を含む有効な APP 参照も従来どおり拾う", () => {
  expect(extractAppIds("SELECT * FROM APP100@dev")).toEqual([100]);
  expect(extractAppIds("SELECT * FROM APP100$明細")).toEqual([100]);
});
```

> 注: 最後の `@profile` / `$subtable` ケースは修正前の正規表現でも AppId=100 を取得できるため回帰検出にはならない。境界判定を `collectAppProfileTokens` に一本化した後も有効参照が壊れないことを固定する目的で残す。

### 統合（実障害経路の固定・`src/node/__tests__/runtime.test.ts` 等）

単体テストだけだと `extractAppIds` の戻り値が `token is missing` に伝播する経路を素通しする。実際に P5 で踏んだ経路を固定するため、`createKsqlRuntime` に「**APP4205 のトークンのみを持つ profile ＋ コメント内 APP4206 を含む SQL**」を渡し、`AuthError: token is missing` を投げずにランタイムが構築されることを確認するテストを追加する:

```js
test("コメント内 APPxxx は token 要求に混入しない（P5 回帰）", async () => {
  // APP4205 のトークンのみ。コメントに APP4206 を含んでも AuthError にならない
  await expect(
    createKsqlRuntime(serverOptions, {
      sql: "-- 通知(APP4206)\nSELECT COUNT(*) FROM APP4205",
      // profile.tokenMap = { APP4205: "<token>" } 相当のセットアップ
    })
  ).resolves.toBeDefined();
});
```

（既存の runtime テストのセットアップ流儀に合わせて profile / env を用意する。ポイントは「修正前は `AuthError` で reject、修正後は resolve」を固定すること。）

## 影響・優先度

- **実害**: コメント・文字列に AppID 様文字列を書くと、その profile の tokenMap に無い限り実行不能（`token is missing`）。CI で実際に踏んだ（P5）。回避は「書かない」だが、通知文・説明のリテラルに "APPxxxx" が出るのは自然で踏みやすい。
- **後方互換性**: 誤って要求していたトークンを要求しなくなる方向のみ。新たに要求が増えるケースは無い（本文の APP 参照は従来どおり）。破壊的変更なし → **semver patch = v1.12.1** が妥当。
- **優先度**: 中（実行を止める誤検知だが、回避は容易・修正も局所）。

## 対応チェックリスト（v1.12.1）

- [ ] `src/node/appProfiles.ts` の `extractAppIds` を `collectAppProfileTokens` 再利用に置換
- [ ] `src/cli/__tests__/index.test.ts` に単体回帰テスト追加（コメント/文字列/**バッククォート**/@profile/$subtable）
- [ ] `createKsqlRuntime` の統合テスト追加（APP4205 トークンのみ＋コメント内 APP4206 → `AuthError` にならない・P5 実障害経路の固定）
- [ ] 既存テスト・型チェック・ビルド確認
- [ ] `package.json` / `package-lock.json` / `prod/manifest.json` を v1.12.1 に bump
- [ ] CHANGELOG に「コメント・文字列内 `APPxxxx` を認可判定から除外」を記載
- [ ] ksql-actions 側 `ci-troubleshooting-lessons.md` P5 に「v1.12.1 で修正済み（根本原因: `extractAppIds` の非統一）」を追記
