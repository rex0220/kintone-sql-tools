# B96 `getRecords()` の応答契約が文書に無く、ラッパーが `searchAborted` を落とすと fail-closed が無効になる

- 起票: 2026-07-29
- ステータス: 📋 **仕様確定・実装待ち**（案 A 採用）。→ [実装仕様](ksql_b96_getrecords_response_contract_spec.md)
- 出典: [Pro からの報告 v3.32.0](../../../ksql-dashboard-pro/docs/internal/kSQLエンジンへの報告-v3320.md) §3
- 関連: [B93 `getFields` の契約](ksql_b93_getfields_contract_error_issue.md) / [B85](ksql_b85_validate_constraint_disclosure_spec.md) / [B94 `totalCount`](ksql_b94_count_star_totalcount_issue.md)

## 1. Pro が自分で見つけて共有してくれた

Pro は 9 ペインが同じアプリを参照するため、`ReadonlyKintoneClient` を**自前のキャッシュで
包んで**エンジンへ渡している。そのラッパーがこう書かれていた。

```ts
// 修正前
return { records: [...records] };   // ← totalCount と searchAborted が落ちる
```

**リクエスト側の `params.totalCount` は素通ししていたのに、応答を組み立て直すときに落としていた。**

**Pro 側は修正済み**で、`totalCount` に対応するモックと対応しないモックの両方で回帰テストを
固定している。**エンジンの不具合ではない。**

## 2. **`searchAborted` の欠落のほうが危険**（Pro の指摘・コードで確認）

| 落ちたもの | 影響 | エンジンが気づけるか |
|---|---|---|
| `totalCount` | **遅くなる／上限でエラー**（B94 の最適化が効かない） | ✅ **気づける**。無い／不正なら全件取得へフォールバックする |
| `searchAborted` | **10 万件で打ち切られた検索を完全な結果として扱う** | ❌ **気づけない** |

**この非対称が本件の核心である。**

`totalCount` は**エンジンが自分で穴を塞げる**。[execute.ts](../../src/execute.ts#L4293) が
`isValidTotalCount` で検査し、満たさなければ従来の全件取得へ落とす（B94 §1.3）。

**`searchAborted` は塞げない。**検出経路は**client の応答だけ**である。

```ts
// execute.ts:935 — client が返さなければ何も起きない
if (response.searchAborted) { collector.aborted = true; if (failClosed) throw new SearchAbortedError(); }
// fetchAll.ts:215
if (response.searchAborted) options.onSearchAborted?.();
```

**`false` と「そもそも入っていない」を区別する手段が無い。**
したがって**ラッパーが落とした時点で、`SEARCH_ABORTED` の fail-closed は静かに無効になる。**

**打ち切られた 10 万件を「全件」として集計する**——B78 / B79 / B86 / B90 と同じ
silent wrong result であり、**しかもエンジン側の防御が全部素通りする。**

## 3. 文書に契約が書かれていない

[`docs/ksql_engine_library.md`](../ksql_engine_library.md#L369) には**挙動**は書いてある。

> client が `searchAborted: true` を返した場合、simple query、JOIN、GROUP BY を問わず
> 常に `SEARCH_ABORTED` の **hard error** です。

**しかし「落としてはいけない」という義務は書かれていない。**
`ReadonlyGetRecordsResult` の 3 つのプロパティが**何のためにあるか**も書かれていない。

```ts
export interface ReadonlyGetRecordsResult {
  records: ReadonlyKintoneRecord[];
  totalCount?: string;
  searchAborted?: boolean;
}
```

**両方とも `?` なので、型からは「省略してよい」と読める。**
実際 `searchAborted` は打ち切りが無ければ省略されるのが正常であり、**型では区別できない。**

## 4. BYO で躓いたのは 3 回目だが、**種類が違う**

| | 内容 | 種類 |
|---|---|---|
| B85 | `getFields` が制約メタデータを**落としていた** | 自作クライアントの実装漏れ |
| B93 | `getFields` へ `$id` / `$revision` を**足していた** | 自作クライアントの実装漏れ |
| **B96** | **`createReadonlyKintoneClient` をそのまま使っているのに、間に挟んだラッパーが応答を痩せさせた** | **ラッパー** |

**Pro の指摘が重要**＝**ラッパーを挟む実装は珍しくない**（キャッシュ・計測・リトライ）。
**公式 factory を使っていても踏む**ため、「自作クライアントを書く人だけの問題」ではない。

## 5. 対応案

### 5.1 案 A（推奨）— `getRecords()` の応答契約を文書化する

**B93 で `getFields()` に対してやったのと同じ形**＝「渡すもの」「落としてはいけないもの」を対で書く。

- **`records` 以外の項目を落とさないこと**を明記する
- **`searchAborted` を落とすと `SEARCH_ABORTED` の fail-closed が効かなくなる**ことを明記する
- **ラッパー（キャッシュ・計測・リトライ）を挟む場合の注意**として独立させる
  （`createReadonlyKintoneClient` の利用者にも該当するため）
- **`totalCount` は落としても正しさは保たれる**（性能だけ）ことも書き、危険度の差を示す

`ReadonlyCursorPage` など**他の応答型にも同じ問題があるか**を確認して、あれば併記する。

**0.25 人日・SemVer=patch（文書のみ）。**

### 5.2 案 B — 型で強制する（不採用寄り）

`searchAborted: boolean`（必須）にすれば落とせなくなる。

**しかし破壊的変更**であり、**B95 でまさに同じ理由で任意プロパティへ倒したばかり**である
（公開型は利用者が構築できる）。**`records` だけを返す既存のラッパーが全部コンパイルエラーになる。**

**得られるものが「うっかり落とす人が減る」だけなので、割に合わない。**

### 5.3 案 C — 実行時に検出する（不可）

**`false` と欠落を区別できない**ため、**エンジン側では検出できない**（§2）。

`getRecords` の応答に `Object.prototype.hasOwnProperty` を使えば区別できるが、
**打ち切りが無いときに `searchAborted` を省略するのは正常な実装**なので、
**警告を出すと正しいクライアントが騒がしくなる。**

## 6. 決めること

1. **案 A でよいか**（文書のみ）
2. **`ReadonlyCursorPage` など他の応答型も同時に書くか**
3. **B95 案 B（[B97](ksql_b97_incomplete_aggregate_failclosed_issue.md)）と同じリリースに含めるか**
   （どちらも「打ち切られた入力を黙って使う」系なので、まとめて伝えるほうが伝わりやすい）
