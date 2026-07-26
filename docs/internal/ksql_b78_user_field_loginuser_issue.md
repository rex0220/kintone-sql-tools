# B78 ユーザー系フィールドのログインユーザー絞り込みが機能しない／`=` が黙って0件

- 起票: 2026-07-27（B77 の追加調査中に、実機 console での確認をきっかけに発見）
- ステータス: ✅ **リリース済み（v3.25.0・2026-07-27）＝オーナー決定 (a)(b) とも実施**。**実機 PASS**＝`作成者 in (LOGINUSER())` が押し下げ（`kintone query: 作成者 in (LOGINUSER())`・client 評価 0）／`作成者 = '...'` が `WHERE_OPERATOR_INVALID_FOR_FIELD_TYPE` で拒否。
- 関連: [B77 TODAY/NOW/LOGINUSER の fail-closed 対象外](ksql_b77_today_now_loginuser_fail_closed_issue.md) / [B54 User API](../ksql_issue_tracker.md) / [B67 関数評価](ksql_b67_rest_query_functions_evaluation.md)

## 0. オーナー決定（2026-07-27）

**(a) と (b) の両方を実施する。B77（案 A＝fail-closed 統一）と同一リリースで出す。**

- **(a) `IN` / `NOT IN` リストに kintone 関数（`LOGINUSER()` 等）を書けるようにする。**
  ユーザー系フィールドで唯一妥当な演算子が `in` である以上、これが無いと機能が存在しない。純加法。
- **(b) `CREATOR` / `MODIFIER` / `CHECK_BOX` / `MULTI_SELECT` への `in` / `not in` 以外の演算子を
  取得前に拒否する**（`USER_SELECT` と同じ扱いに揃える）。破壊的変更だが、
  **現状これらは常に0件**なので正しい結果は失われない。
  `DROP_DOWN` / `RADIO_BUTTON` は値が素の文字列で局所評価が正しいため**対象外**。
- (a) で押し下げできない位置に来た `LOGINUSER()` は、**B77 の決定に従い fail-closed** とする。

## 1. 事象

### 1.1 kintone では動く

実機のブラウザ console で以下は正しくレコードを返す。

```js
kintone.api('/k/v1/records', 'GET', { app: 15, query: '作成者 in (LOGINUSER())' })
```

**kintone のクエリでは、`作成者` / `更新者` / ユーザー選択などのフィールドに指定できる演算子は
`in` / `not in` だけ**であり、`LOGINUSER()` はその `in` リストの中に書く。

### 1.2 kSQL では書けない／黙って0件になる

| kSQL の式 | パース | 押し下げ | 結果 |
|---|---|---|---|
| `作成者 in (LOGINUSER())` | **✗ パースエラー**「IN リストには文字列、数値、またはバッチ変数が必要です」 | — | **書けない** |
| `作成者 = LOGINUSER()` | ✓ | されない | **常に0件**（client 評価で `LOGINUSER()` → `""`） |
| `作成者 in ('taro')` | ✓ | される | 正しく動く |
| `件名 in (TODAY())` | **✗ パースエラー** | — | 書けない |

**kintone が要求する形（`in`）に `LOGINUSER()` を書けず、書ける形（`=`）は必ず0件**になる。
結果として **kSQL には「ログインユーザーで絞り込む」手段が存在しない**。
しかもエラーではなく黙って0件なので、利用者は「該当レコードが無い」と誤解する。

## 2. `=` の扱いが型によって不揃い（silent wrong result）

`=` を使ったときの挙動を実測したところ、**同じ「`in` しか許されない型」なのに結果が3通り**だった。

| 型 | `=` の結果 | `in` の結果 | 評価 |
|---|---|---|---|
| `USER_SELECT` | **ArgumentError**「values of type USER_SELECT cannot be compared.」 | 押し下げ・正常 | ✅ 正しい |
| `CREATOR` / `MODIFIER` | **rows=0（エラーなし）** | 押し下げ・正常 | ❌ silent |
| `CHECK_BOX` / `MULTI_SELECT` | **rows=0（エラーなし）** | 押し下げ・正常 | ❌ silent |
| `DROP_DOWN` / `RADIO_BUTTON`（対照） | rows=1（正しい） | 押し下げ・正常 | ✅ 値が素の文字列なので局所評価で正しい |

### 2.1 原因

`src/core/optimization/whereCapability.ts` の `NATIVE_OPERATORS` は
**「kintone へ押し下げ可能な演算子」の表**であり、「妥当な演算子」の表ではない。

```ts
["CREATOR", new Set(["in", "not in"])],
["MODIFIER", new Set(["in", "not in"])],
["USER_SELECT", new Set(["in", "not in"])],
["ORGANIZATION_SELECT", new Set(["in", "not in"])],
["GROUP_SELECT", new Set(["in", "not in"])],
```

この集合を外れた演算子は**拒否されず、ローカル評価へフォールバックする**。
ローカル評価では値が JSON へ平坦化されており（`作成者` → `{"code":"taro","name":"太郎"}`）、
`= 'taro'` は素の文字列比較になって必ず false になる。

`USER_SELECT` だけがエラーになるのは、`LOCAL_COLLECTION_TYPES` 側の比較ガードが
オブジェクト配列を弾いているため。**`CREATOR` / `MODIFIER` は `LOCAL_SCALAR_TYPES` に
入っている**ので、スカラーとして扱われガードに掛からない。

`in` 評価だけは `evalWhere.ts` の `typedInContains()` が
「値/code 単位で IN 評価する」専用処理を持つため正しく動く。

## 3. 方針案

### (a) `IN` / `NOT IN` リストに kintone 関数を書けるようにする（パーサー拡張）

`作成者 in (LOGINUSER())` を受理する。**ユーザー系フィールドで唯一妥当な演算子が `in` である以上、
これができないと機能そのものが使えない。**

- 押し下げ時は `whereToKintone` が `LOGINUSER()` をそのまま出力すればよい（既存の仕組みで足りる）
- 押し下げできない位置では **B77 の判断に従う**（案 A なら fail-closed、案 B なら環境から解決）
- `TODAY()` 等も同じ経路なので併せて検討する（`件名 in (TODAY())` も現状パースエラー）

### (b) ユーザー系・複数選択系への `=` を取得前に拒否する

`CREATOR` / `MODIFIER` / `CHECK_BOX` / `MULTI_SELECT` を `USER_SELECT` と同じ扱いに揃え、
**`in` / `not in` 以外の演算子は取得前にエラー**にする。現状の「黙って0件」を止める。

- `DROP_DOWN` / `RADIO_BUTTON` は値が素の文字列で局所評価が正しいため、**対象外**（現状維持）
- 破壊的変更にあたるが、**現在成功しているように見えるクエリは実際には誤り（常に0件）**なので、
  エラー化しても正しい結果を失わない

### (c) B54 / B77 との関係

- **B54（User API）**: 組織・グループの解決が必要になる場面と重なる。`PRIMARY_ORGANIZATION()` も同じ文脈
- **B77**: `LOGINUSER()` の client 評価が無条件で空文字を返す問題。(a) を入れても、
  押し下げできない位置での扱いは B77 の決着が必要

## 4. 優先度の根拠

- **機能欠落**: ログインユーザーによる絞り込みは kintone アプリで最も一般的な要件のひとつで、
  現状 kSQL では実現手段が無い
- **silent wrong result**: `=` を書いた利用者はエラーも警告も得られず、0件を「データが無い」と誤解する
- 対策 (b) は既存の `USER_SELECT` の扱いに合わせるだけで、設計判断はほぼ済んでいる

## 5. 補足

本件は B75 の変更とは無関係の既存挙動である（B75 適用前も同じ）。
