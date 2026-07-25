# 引き継ぎ: QueryColumn 列メタ公開(v3.22 想定)

> 作成: 2026-07-25、ksql-dashboard-pro 側の Claude セッションより。
> 依頼元仕様: `c:\Users\rex02\Projects\ksql-dashboard-pro\docs\plans\M1-1エンジン改修見積.md`
> (kSQL Dashboard Pro の Phase 1 が本改修を前提とする。ゲート判定 G2 =「通常実施」)

## 1. 目的

`runQuery()` の `QueryResult.columns` に列メタを**後方互換の追加**として公開する:

```ts
interface QueryColumn {
  name: string;
  valueType: "string";      // 既存(維持)
  fieldType?: string;       // 元フィールド型 or 導出型(NUMBER / DROP_DOWN / KSQL_NUMBER 等)
  sortKind?: "number" | "string";
  sourceApp?: number;       // 単純フィールド参照列($id 等システム列含む)のみ
}
```

Pro 側の用途: 型別ソート比較器(§4.9)、フォーマット自動初期化(§4.8)、$id からのレコード遷移(§4.6)。

## 2. 実施済みの変更(**未コミット** — 本リポジトリの working tree にあります)

既存の `inferSelectColumnMeta` / `MaterializedColumnMeta` 機構(CTE/一時テーブル用)を
トップレベル SELECT に開放する方式。変更ファイル:

| ファイル | 変更 |
| :--- | :--- |
| `src/execute.ts` | ① `ExecuteOptions.captureColumnMeta?: boolean` 追加 ② `executeParsedStatement` の SELECT/UNION/WITH 分岐で伝搬 ③ `executeUnion` に captureColumnMeta 引数追加 + `mergeUnionColumnMeta` 適用 ④ `getSelectColumnMeta()` エクスポート・`MaterializedColumnMetaMap` を export 化 ⑤ `systemColumnMetaWithSource()` 新設 — inferSelectColumnMeta 内の `systemColumnMeta` 呼び出し 3 箇所を置換($id に sourceApp を付与) |
| `src/engine-library/publicTypes.ts` | `QueryColumn` に 3 フィールド追加 |
| `src/engine-library/query.ts` | `captureColumnMeta: true` を execute へ付与、`toPublicColumn()` でマップ(`fieldType ?? semantics.fieldType`、`semantics.source?.appId`) |
| `src/engine-library/__tests__/columnMeta.test.ts` | 新規テスト 4 件(**現状 4 件とも失敗** — §3 参照) |

## 3. テスト失敗の所見(要調査・判断)

`npx jest src/engine-library/__tests__/columnMeta.test.ts`

1. **単純 SELECT で列メタが空** — 仮説: `inferSelectColumnMeta` 冒頭の
   `if (selectNeedsSourceColumnMeta(stmt))` ゲートで physicalInfos が未取得のまま。
   inferSelectColumnMeta はメタ要求時のみ呼ばれるため、**無条件で physicalInfos を取得してよい**
   可能性が高い(getFieldsCached はキャッシュ済み)。`selectNeedsSourceColumnMeta` の本来の意図の確認を。
2. **DATE_FORMAT 導出列の sortKind が undefined** — `stringFunctionColumnMeta` の返す形の仕様確認。
   テスト期待値(`sortKind: "string"`)をエンジンの意味論に合わせて修正してよい
   (Pro 側は「undefined = 文字列扱い」で対応可能)。
3. **COUNT(*) 列のメタ差分** — 期待 `fieldType: "KSQL_NUMBER"` に対し受領値が異なる。実際の形の確認を。
4. **テスト 4 は当方の設計ミス** — 未定義フィールド `顧客名` を SELECT しており
   validateSelectFieldCodes で正しく拒否されている。テストを修正(定義済みフィールドに変更)。

## 4. 残作業(U3 / U4)

- [ ] §3 の調査・修正 + テスト期待値の確定(エンジンの意味論はそちらの判断を正とする)
- [ ] 既存全テストのパス(特に: `systemColumnMetaWithSource` の source 付与が
      `fieldSemanticsEqual` による一時テーブル append 互換判定へ影響しないか — §5 リスク)
- [ ] `docs/ksql_engine_library.md` の公開 API 節へ列メタの記載追加
- [ ] バージョン 3.22.0 へ bump → `npm run build:engine` → ガード類(`engine:bundle-guard` 等)
- [ ] `npm pack` して Pro 側へ引き渡し:
      `c:\Users\rex02\Projects\ksql-dashboard-pro\vendor\` に tgz を置き、
      Pro の package.json の file: 参照ファイル名を更新 → Pro 側で `npm run ci` が green になること

## 5. リスクノート

- `systemColumnMetaWithSource` は CTE/一時テーブルの実体化メタにも source を付与するため、
  異なるアプリ由来の `$id` 列を同名一時テーブルへ append するケースで
  `fieldSemanticsEqual` が不一致になる可能性がある。既存テストが検出するはず。
  問題になる場合は「inferSelectColumnMeta のトップレベル呼び出し時のみ source 付与」へスコープ縮小可。
- 公開型の変更は追加のみ(既存 consumer 非破壊)を維持すること。

## 6. スコープ外(やらないこと)

- 変数バインド(`:VAR`)— Pro Phase 2 で別途依頼予定
- AbortSignal — エンジン改修不要と判断済み(Pro 側 BYO client で対応)
