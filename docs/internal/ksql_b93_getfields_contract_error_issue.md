# B93 未知フィールド型のエラーがエンジンの不具合に見え、クライアント契約も書かれていない

- 起票: 2026-07-29
- ステータス: ✅ **実装済み（未リリース）**（2026-07-29）
- 出典: [Pro からの報告 2026-07-29](../../../ksql-dashboard-pro/docs/internal/kSQLエンジンへの報告-v3311-統合版.md) §1
- 関連: [B88 0 行 `SELECT *` の列復元](ksql_b88_empty_wildcard_schema_restore_issue.md) / [B85 VALIDATE の制約検証](ksql_b85_library_validate_constraints_issue.md) / [B73 エラーの構造化](ksql_b73_error_structured_i18n_evaluation.md)

## 1. 何が起きたか

Pro が **v3.31.1 の回帰**として報告してきた事象が、調査の結果**Pro 側の自前クライアントの誤り**だった。

```js
// Pro の自前 ReadonlyKintoneClient（誤り）
out.push({ code: "$id",       label: "$id",       fieldType: "__ID__" });
out.push({ code: "$revision", label: "$revision", fieldType: "__REVISION__" });
```

B88 で追加した**未知フィールド型の fail-closed** に当たっていた。

```
EXECUTION_ERROR / InternalError: empty SELECT * schema policy is not defined for field type __ID__.
```

**Pro は自力で切り分けて取り下げた。**しかし**エンジン側の伝え方に 2 つ問題がある。**

## 2. 問題 1＝エラーが「エンジンの不具合」に見える

| | 現状 |
|---|---|
| 接頭辞 | **`InternalError:`** |
| 文言 | **`policy is not defined`**（エンジン側に定義が足りない、と読める） |
| 含まれる情報 | **型のみ**。どのフィールドかが分からない |

**実際はクライアント契約の違反**（`getFields` が未知の型を返した）である。

このコードベースで `InternalError:` は
**「到達しないはずの不変条件が破れた＝エンジンのバグ」**に使われている
（例: `unresolved arithmetic variable @x reached SELECT field collection`）。
**クライアント由来の入力エラーに使うのは誤用。**

**結果として Pro は回帰として報告し、双方が調査に時間を使った。**
**エラー文面だけで自己解決できるべきだった。**

## 3. 問題 2＝`getFields` の契約が片側しか書かれていない

[`docs/ksql_engine_library.md`](../ksql_engine_library.md) には
**「何を渡すべきか」**（`required` / `minLength` などの制約メタデータ・B85 で追記）はあるが、
**「何を渡してはいけないか」が無い。**

**Pro は同じ種類の誤りを 2 回している。**

| | 誤り |
|---|---|
| B85（確認依頼③） | `getFields` が制約を**落としていた** |
| **本件** | `getFields` が擬似フィールドを**足していた** |

Pro 自身が「**足りない項目だけを直して、余計に足している項目を見ていなかった**」と書いている。
**契約が片側しか書かれていないことが効いている。**

## 4. 対応

### 4.1 エラーをクライアント契約違反として報告する

- **接頭辞を `InternalError:` から `ArgumentError:` へ**。
  エンジンの不変条件違反ではなく、**渡された値が不正**である
- **フィールドコードを含める。**どのフィールドかが分からないと直せない
- **期待を 1 文で示す**（`getFields` は `fields.json` のフィールドだけを返す）

```
ArgumentError: getFields returned unknown fieldType "__ID__" for field "$id".
  getFields must return only the fields from /k/v1/app/form/fields.json;
  $id and $revision are synthesized by the engine.
```

### 4.2 `code` は変えない（B73 の制約）

**ライブラリの `code` は `EXECUTION_ERROR` のまま。**
[B73](ksql_b73_error_structured_i18n_evaluation.md) で Pro は
**エラー種別を `code` で判定しており、既存の `code` の値と意味を変えないこと**が受入条件になっている。

MCP / CLI は [`codeFromMessagePrefix`](../../src/execute.ts#L1937) が
`^([A-Za-z]+Error):` を code にするため、接頭辞の変更は MCP の code に影響する。
ただし**この経路は MCP / CLI では発生しない**（クライアントが `nodeKintoneClient` で
実際の kintone 型しか返さない）。**BYO クライアントでのみ到達する。**

### 4.3 `getFields` の契約を明記する

`docs/ksql_engine_library.md` の BYO client の節へ次を追記する。

- **`getFields` は `fields.json` のフィールドだけを返す**
- **`$id` / `$revision` はエンジンが合成するので渡さない**
- 制約メタデータ（`required` / `minLength` / `maxLength` / `minValue` / `maxValue` /
  `optionOrder`）は**渡す**（B85 で追記済みの内容と対にする）

**「渡すもの」と「渡さないもの」を並べて書く。**片側だけだともう片側を見落とす。

## 5. 受入条件

1. **エラーがフィールドコードと型の両方を含む** — `__ID__` だけでなく `$id` も出ること
2. **接頭辞が `ArgumentError:`** — `InternalError:` でないこと
3. **契約の期待が文面に含まれる** — `fields.json` のフィールドだけを返す旨
4. **ライブラリの `code` が `EXECUTION_ERROR` のまま** — B73 の制約
5. **`docs/ksql_engine_library.md` に「渡さないもの」が書かれている** — `$id` / `$revision`
6. **既存テスト全 green・snapshot 22 不変・公開型不変**

## 6. 規模

- 実装（メッセージ・呼び出し側でフィールドコードを渡す）: 0.25 人日
- 文書（`ksql_engine_library.md` の BYO client 節）: 0.25 人日

**合計 0.5 人日。SemVer=patch**（エラー文面と文書のみ・挙動は不変）。

## 7. 優先度の根拠

**誤った結果を返す類ではない**ため緊急ではない。
一方で**同じ利用者が同じ種類の誤りを 2 回**しており、**次も起きる**。

**エラー文面だけで自己解決できるようにする**のは、
利用者の時間だけでなく**こちらの調査時間も減らす**。
