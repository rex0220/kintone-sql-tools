# B85 ライブラリの VALIDATE が制約を検証できず黙って 0 件を返す

- 起票: 2026-07-28
- ステータス: ✅ **案 A・B・C すべて実装済み（未リリース）**（2026-07-28）。
- 出典: Pro（ksql-dashboard-pro）返信 2026-07-28「確認依頼③」
- 関連: [B68 計画](ksql_b68_engine_library_readonly_impl_plan.md) / [B78](ksql_b78_user_field_loginuser_issue.md) / [B79](ksql_b79_outer_join_search_abort_issue.md)

## 1. 事象（Pro 報告）

**同じ `VALIDATE` 文が MCP とライブラリで違う結果を返す。**

| 実行経路 | 結果 |
|---|---|
| MCP `ksql_query` | **10 行 / `errorRecords: 6, errorCount: 12`**（すべて `ERR_LENGTH_MIN`） |
| ライブラリ `runQuery` | **0 行 / `errorRecords: 0, errorCount: 0`** |

選択肢違反（`ERR_CHOICE_INVALID`）だけは両経路とも一致する。
`runBatch` でも同じで、単文 / 複文の違いではない。

**利用者は「エラーなし」と読む。**打ち切りを hard error にし、押し下げ不能を取得前エラーにしてきた
**fail-closed の設計思想と一貫しない**（Pro の指摘）。

## 2. 原因＝**Pro の推測とは違った**（実測で確定）

Pro は「`ReadonlyFieldInfo` に制約を渡す口が無いから」＝**契約上の限界**と推測していた。
**そうではない。パイプラインは制約を素通ししている。**

### 2.1 実測

`getFields` が制約を返すかどうかだけを変えて `runQuery("VALIDATE APP100")` を実行した。

| `getFields` の返り値 | 検出 |
|---|---|
| `{ code, label, fieldType, minLength: 3, required: true }` | **2 件検出**（`errorRecords: 2, errorCount: 2`） |
| `{ code, label, fieldType }` | **0 件** |

**ライブラリは制約を受け取れば検証できる。**

### 2.2 では何が問題か＝**型が宣言していない**

```ts
export interface ReadonlyFieldInfo {
  code: string; label: string; fieldType: string;
  optionOrder?: Record<string, number>;   // ← 選択肢だけ宣言されている
  sortKind?: "number" | "string";
  inSubtable?: boolean; subtableCode?: string;
  // minLength / maxLength / minValue / maxValue / required が無い
}
```

- **自前でクライアントを書く利用者は、制約を渡すべきだと分からない**
- TypeScript は**オブジェクトリテラルの余剰プロパティを拒否**するので、
  型に無いフィールドは**書こうとしても止められる**

### 2.3 `createReadonlyKintoneClient` は実は制約を返している

```ts
async getFields(appId): Promise<readonly ReadonlyFieldInfo[]> {
  const response = await api("/k/v1/app/form/fields.json", "GET", { app: appId });
  return flattenFormFieldProperties(response.properties);   // ← KintoneFieldInfo[]
}
```

`flattenFormFieldProperties` は **`required` / `minLength` などを含む `KintoneFieldInfo`** を返す。
戻り値の型が `ReadonlyFieldInfo` へ狭められているだけで、**実行時のオブジェクトには制約が乗っている**。

**したがって `createReadonlyKintoneClient` を使っている利用者は、既に完全な検証ができる。**
Pro の「`createReadonlyKintoneClient` を使っても同じはず」は**未検証の推測**であり、
Pro は自前クライアントを使っている可能性が高い。**メタデータの取得量も増えない**
（同じ `fields.json` を既に取得している）。

## 3. 影響

**v3.29.0 で出荷済み。**しかも Pro は「データ品質チェック」ペインとして採用検討中で、
**現状では用途を「選択肢の妥当性チェック」に限定せざるを得ない**と述べている。

文字数・必須・上下限は業務アプリでよく使う制約であり、**そこが 0 件で返ると
「品質に問題なし」という誤った結論**を導く。B78（`LOGINUSER()` が黙って 0 件）と同型である。

## 4. 対応案

### 4.1 案 A（必須）— `ReadonlyFieldInfo` へ制約を宣言する

**純加法**。任意フィールドを追加するだけで、`createReadonlyKintoneClient` 利用者は**変更不要**。
自前クライアントの利用者は**渡すべきものが型から分かる**ようになる。

```ts
export interface ReadonlyFieldInfo {
  // ...既存
  required?: boolean;
  minLength?: number; maxLength?: number;
  minValue?: string;  maxValue?: string;
}
```

### 4.2 案 B（必須）— 検証範囲を開示する

> **【訂正 2026-07-28】本節は初版の「警告する」案。§8 で「開示する」設計へ変更した。**
> 以下は経緯の記録として残す。

**案 A だけでは足りない。**自前クライアントが制約を渡さなければ、依然として黙って 0 件になる。

Pro の要望は「`warnings` に載るだけでも Pro 側でペインに注記を出せる」。

**判断が要る点**＝ライブラリは「制約が無い」と「制約が見えない」を**区別できない**。
`fieldType` から**制約を持ち得る型か**は分かるので、
**「制約を持ち得る型なのに制約情報が皆無」なら警告**する、という判定は可能である。

> **hard error にすべきか。**このプロジェクトの前例（B78・B79）は
> 「黙って誤る」を**エラー化**してきた。しかし今回は
> **選択肢検証という正しく動く用途を壊す**ため、**警告が妥当**と考える。
> ただし**警告を見落とす利用者は「0 件＝問題なし」と読む**ので、
> `validateStats` に**検証範囲を示すフィールド**を足す案も検討に値する。

### 4.3 案 C（docs）— `SUM($err_count)` の注意

Pro からの別指摘。**`COUNT(*)` で内訳を集計すると `validateStats.errorCount` と合わない。**
サブテーブル違反が**1 行に複数エラーとしてまとまる**（`$err_count` に本数が入る）ため。

| 集計 | 実測（`APP4221`） |
|---|---:|
| `COUNT(*)`（行数） | 10 |
| `SUM($err_count)` | **12**（`errorCount` と一致） |

**KPI カードに `errorCount`、隣の棒グラフに `COUNT(*)` を置くと合計が食い違って見える。**
言語リファレンスへ `SUM($err_count)` を使う旨を明記する。

## 5. Pro からの質問への回答

> テスト固定は**受理可否**の担保であって**結果の一致**は対象外、という理解で合っていますか。

**合っている。**B68 Step 4 の parity テストは
「MCP が read-only として受理する文は library でも受理する」ことだけを固定しており、
**同じ文が同じ結果を返すことは対象外**である。

**本課題はその隙間を突いた形**であり、**parity の定義を見直す契機**でもある。
ただし「結果の一致」を機械的に固定するのは、
**両面が同じメタデータを持つ前提**が要るため、案 A / B の後に検討する。

## 6. 規模

| 作業 | 見積 |
|---|---:|
| 案 A（型の宣言 ＋ docs） | 0.25 |
| 案 B（警告の判定・4面 parity・テスト） | 0.5〜1.0 |
| 案 C（docs） | 0.1 |

**合計 0.85〜1.35 人日。** SemVer=**minor**（純加法）。

## 7. 優先度の根拠

**v3.29.0 で出荷済みの機能が黙って過少報告している。**
Pro の採否判断に直結し、**「品質チェックで 0 件だった」という誤った安心**を与える。

B78（黙って 0 件）・B79（黙って誤った値）と同じ silent wrong result の系列で、
このプロジェクトが一貫して最優先で潰してきた類である。

---

## 8. 【2026-07-28】案 B の判定規則を修正＝「推測」ではなく「開示」にする

§4.2 で「**制約を持ち得る型なのに制約情報が皆無なら警告**」と書いたが、**この規則は成立しない。**

### 8.1 実測＝制約が1つも無いアプリは実在する

| アプリ | 全項目 | 制約つき（`required` / `minLength` / `maxLength` / `minValue` / `maxValue`） |
|---|---:|---:|
| **APP4147**（活動履歴） | 21 | **0** |
| APP4148（顧客管理） | 24 | 2（`顧客ランク` の `required` ほか） |

**APP4147 では正しく「制約なし」**である。ここで警告を出すと**誤警告**になり、
利用者は警告を無視するようになる。**無視される警告は無いのと同じ**である。

### 8.2 ライブラリは原理的に区別できない

`getFields` の返り値だけからは、

- **アプリに制約が無い**のか
- **クライアントが制約を落としている**のか

を**区別できない**。推測しようとすると必ず誤警告か見逃しが出る。

### 8.3 修正案＝「検証しなかったもの」ではなく「**検証したもの**」を返す

**入力の事実だけを述べる。**推測を含めない。

```
渡されたメタデータに含まれていた制約種別: 選択肢
（文字数・必須・上下限は渡されていないため検証対象外）
```

- **クライアントが渡した制約種別を列挙する**。これは観測可能な事実で、推測が要らない
- APP4147 のように本当に制約が無い場合も、**「渡されていない」は正しい**
- ダッシュボードは「**何が検証されたか**」を利用者へ提示できる

> **「0 件でした」より「選択肢だけ検証して 0 件でした」のほうが、
> 誤った安心を与えない。**品質チェック用途では**検証範囲の開示が本体**である。

置き場所は `warnings` か `validateStats` の拡張。`validateStats` に載せるほうが
**KPI を出す時点で必ず目に入る**ので望ましい。

### 8.4 これにより案 A の位置づけも変わる

案 A（型へ制約を宣言）は**単なる利便性ではなく、開示を正確にするための前提**になる。
型が宣言していれば、クライアント実装者は**何を渡せば何が検証されるか**を型から読める。

---

## 9. 【2026-07-28】案 A・C を実装

### 宣言した制約＝`hasAuditableConstraint` が見る集合と完全一致

| 宣言 | 型 |
|---|---|
| `required` | `boolean` |
| `minValue` / `maxValue` | `string` |
| `minLength` / `maxLength` | **`string`** |
| `optionOrder` | 既存宣言 |

> **§4.1 の例で `minLength?: number` と書いたのは誤り。**実コードの `KintoneFieldInfo` と
> フォーム API 正規化後の型は **`string`** で、codex が実装時に訂正した。

### 独立検証

| クライアントが渡すもの | 結果 |
|---|---|
| 制約あり（型どおりの `ReadonlyFieldInfo` リテラル） | **2 行**・`ERR_LENGTH_MIN` ＋ `ERR_REQUIRED` |
| 制約なし | **0 行** |

**型どおりに書けること**（余剰プロパティ検査を通ること）も型レベルで確認した。
これが通らないと、案 A の目的（自前クライアント実装者が型から気づける）が達成できない。

### 公開 snapshot を拡張

`engine:declaration-smoke` が **`ReadonlyFieldInfo` の全 12 プロパティ**を照合するようになった。
**型が痩せたら落ちる**ので、将来の drift を防げる。

### 案 C

言語リファレンスと engine ライブラリ利用ガイドの両方へ、
`$err_code` 別の内訳は **`COUNT(*)` ではなく `SUM($err_count)`** を使う旨と、
KPI の `errorCount` と棒グラフの `COUNT(*)` が食い違う具体例を記載した。

### 手順上のミス（記録）

**案 A・C の docs 変更が、B86 起票のコミット `6da9b05` へ紛れ込んだ。**
codex が背景で作業している最中に `git add docs/` を実行したため。

内容は正しく、コミット先だけが誤っている。**履歴は書き換えず記録に留める。**
**背景実行中は `git add` の対象を明示列挙する**こと。

### 残り＝案 B

**§8 の設計（「検証したもの」を開示する）は確定済み・未着手。**
案 A だけでは、自前クライアントが制約を渡さなければ**依然として黙って 0 件**になる。

---

## 10. 【2026-07-28】案 B を実装＝検証範囲の開示

### 形

```ts
validateStats?: {
  errorRecords: number;
  errorCount: number;
  constraintMetadata?: {
    present: ("required" | "length" | "range" | "choice")[];
    absent:  ("required" | "length" | "range" | "choice")[];
  };
}
```

- **実際の `VALIDATE` 対象フィールドだけから算出**する。アプリ全体ではなく検証対象に限ることで開示が正確になる
- **`hasAuditableConstraint` と判定ロジックを共有**する。「どの制約を見るか」が2箇所に分かれると B68 で解消した二重管理を再生する
- **警告は生成しない。**出すのは事実の開示であって警告ではない

### 独立検証（4 形すべて期待どおり・警告 0）

| 渡したメタデータ | `present` | `absent` | 警告 |
|---|---|---|---:|
| 全種別 | 4 種すべて | — | **0** |
| 選択肢だけ | `choice` | `required` / `length` / `range` | **0** |
| 文字数だけ | `length` | 他 3 種 | **0** |
| **制約なし（本当に無いアプリ）** | — | 4 種すべて | **0** |

**開示は入力の写しであり、推測が入っていない。**
§8.1 で懸念した誤警告（APP4147 のように本当に制約が無いアプリ）が起きないことを実測した。

### 手順上の記録

`execute.ts` の行追加で **B65 の行番号 allowlist が再び落ちた**（今日2回目）。
機械的な追随を許可したが、**行番号だけ合わせて別の場所を指していないか**の確認も条件に付けた。
行番号ピンは「合わせれば通る」ため、**内容を見ずに数字だけ直すと静かに無意味なテストになる**。
次に踏むようなら**内容で固定する形**への変更を課題化する。
