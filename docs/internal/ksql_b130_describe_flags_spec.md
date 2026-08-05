# B130 `DESCRIBE` に「値の由来」を出す 仕様（R3）

- ステータス: 📋 **仕様 R3（依頼元の回答を反映）** → [依頼元の返信](../../../ksql-analytics/docs/internal/kSQLエンジンへの返信-B130-20260806.md) / [確認文](ksql_analytics_inquiry_b130_20260806.md) / [レビュー](ksql_b130_codex_review_1.md)（高 3・中 5・低 1 を**全件反映**）
- 起票: [B130](ksql_b130_describe_flags_issue.md)（実測済み）
- 関連: [B136](ksql_b136_language_reference_examples_issue.md)（列表が実装と食い違っている＝本件で DESCRIBE 分を直す）

> **R1 からの最大の訂正: 「3 つ揃えば `ksql_app_metadata` を引くべきか判断できる」は誤り。**
> 起票で挙げた `仕入先` は **ルックアップのコピー先**（`fieldMappings` の宛先）で、
> **3 フラグはすべて空**になる（R3 でここを埋める）。素の文字列と区別が付かない。
> **つまり「3 つとも空なら metadata 不要」とは判断できない。**
> しかも現行の正規化は**その差を既に `writable` として持っている**（`formFieldInfo.ts:72,86-97`）。
>
> **依頼元も「当方の誤りでした」と認めている**（返信 §1）。
> 「型だけでは分からない何かの 1 ビット」という**完全性を主張する文言は撤回する**。

> **R2 からの変更: 依頼元の提案で「値の由来」という枠に置き直し、4 列にする。**
> R2 は第 4 のフラグを「`書込不可`」として非対象にしていたが、
> **依頼元は「読み取り専用のプロジェクトなので書き込み可否そのものには意味がない。
> 一方でその値がどこから来たかは分析の読み方を変える」**と指摘した（返信 §2）。
>
> **具体例が決定的だった**＝`仕入先` はルックアップのコピー先なので、
> **`GROUP BY 仕入先` は「マスタの現在の仕入先」ではなく「入力時点の仕入先」で割れる。**
> 仕入先を切り替えた製品があれば**同じ製品が 2 つに分かれ、エラーも警告も出ない。**
>
> **「書込不可」より「値の由来」の方が停止規則が立つ**（→ §1.1）。

> **【重要】実需の所在が変わった。** 依頼元は**⑤の優先度を下げるよう自ら申し出ている**
> （返信 §0・§3）。`sql/` と `scripts/` に `DESCRIBE` は **0 件**、
> **カタログ作成以降 `ksql_describe_app` を呼んだ記録も無い**（`/catalog` コマンドが明示的に禁止）。
> **「軽くて手が伸びるから塞ぎたい」という依頼の動機自体が、実測すると成立していなかった。**
>
> **残る根拠は依頼元の面ではなく、一般利用者の面**（返信 §3）:
> 「**当方の鉄則は当方のリポジトリでしか効かない。`CLAUDE.md` を持たない環境のエージェントは、
> MCP のツール説明だけを見て `ksql_describe_app`（軽い・名前が分かりやすい）を選ぶ可能性が高い**」。
> **この重み付けはこちらで判断する**（依頼元が明示的にこちらへ委ねた）。

---

## 0. 確定事項（コード確認・実測・レビューで裏取り済み）

| 事実 | 根拠 |
|---|---|
| **`ksql_describe_app` は別実装ではない。`DESCRIBE APP<n>` を組み立てて `query()` に渡すだけ** | `mcp/tools.ts:946-955` |
| **列の定義は 1 か所だけ** | `execute.ts:9367-9372` |
| **`formFieldInfo` は `unique` も `expression` も保持していない** | `core/formFieldInfo.ts:5-19`。`src` 全体で参照 0 件 |
| **`lookup` は権限不足時に `null` を返す**（空 object ではない・kintone 公式） | レビュー H1 |
| **`KintoneFieldInfo` は公開型**（`core/index.ts:53-55` で export・`KintoneClient.getFields()` の戻り値） | `execute.ts:244-258,291-313` |
| **`ReadonlyFieldInfo` は npm の `./engine` が BYO client に要求する別の公開型**。現在 3 必須のみで構築できる | `engine-library/publicTypes.ts:58-61,91-95` |
| **projector は最後に cast するため、型不一致が compile error にならず runtime で `undefined` が core へ入る** | `engine-library/readonlyClient.ts:42-97` |
| **`SELECT *` は行の全キーをそのまま出す。0 行時は保存済み `sourceColumns` を使う** | `engine/process.ts:1313-1332` |
| **UNION は左列順へ位置対応、`INSERT ... SELECT` は列数一致を要求**＝列数依存経路が `validCodes` 以外にある | `execute.ts:5010-5015,7842-7847` |
| **JOIN 後の行は非修飾キーも持つ**ため、同名フィールドを持つ表と JOIN して `SELECT *` すると衝突する | `engine/process.ts:103-105,164` |
| **`writable` は既にルックアップのコピー先を区別している** | `formFieldInfo.ts:72,86-97` |
| engine-library の契約＝DESCRIBE の全列は `valueType: "string"` で全値が string | `engine-library/resultMapping.ts:41,56` / `acceptance.test.ts:163-178` |
| CLI は `result.columns` 駆動の汎用整形。**DESCRIBE 専用処理は無い** | `cli/index.ts:822-862` |
| プラグイン UI も汎用レンダラ。**サイドパネルの表は DESCRIBE とは別実装** | `ui/renderResult.ts:196` / `ui/desktop.ts:90-107,1712-1735` |
| ツール**説明文**を固定している箇所は **4 つ** | レビュー M3 |
| 実列名に依存するテストは 1 本だけ（`フィールドコード`） | `__tests__/b86MaterializedUnknownColumn.test.ts:121-127` |
| **文書の列表は実装と食い違っている**（`fieldCode`/`label`/`type`）。**§13 と §14 の 2 か所** | `docs/ksql_language_reference.md:2099-2109,2163-2175`・実測 |

### 0.1 実測で分かった判定の落とし穴（→ [起票](ksql_b130_describe_flags_issue.md) §2）

1. **ルックアップのフィールドには `unique` プロパティが存在しない。**
   判定は **`unique === true`** であって `!== false` ではない
2. **`expression` は素の SINGLE_LINE_TEXT にも空文字で存在する。**
   「プロパティの有無」で判定すると素の文字列まで計算列になる
3. **`lookup` は `null` になり得る**（権限不足時・レビュー H1）。
   **値の truthiness で見てはいけない。キーの存在で見る**

---

## 1. スコープ

| 区分 | 内容 |
|---|---|
| **対象** | `DESCRIBE` の出力に **`ルックアップ` / `コピー元` / `重複禁止` / `計算式` の 4 列**を足す |
| **対象** | `formFieldInfo` に `unique` / `expression` を運ばせ、4 つを導出する（`writable` の材料は既にある） |
| **対象** | **`docs/ksql_language_reference.md` の DESCRIBE 列表と例の訂正（§13・§14 の 2 か所）** |
| **非対象** | 値の中身（参照先アプリ・キー・式そのもの）。**必要なら `ksql_app_metadata`** |
| **非対象** | `required` / `enabled` / `maxLength` / `digit` / `defaultValue`＝**値を「書く」ための制約**（→ §1.1） |
| **非対象** | `SHOW APPS` の列・文書（→ B136） |
| **非対象** | プラグインのサイドパネル表（別実装・DESCRIBE を使っていない） |

### 1.1 枠は「値の由来」。停止規則もここで決まる（R2 から変更・依頼元の提案）

**`DESCRIBE` が出すのは「値をどう読むか」を変える情報だけ。**

| | 入る | 理由 |
|---|---|---|
| `ルックアップ` | ✅ | 値は**他アプリのキー**。JOIN の相手が決まる |
| `コピー元` | ✅ | 値は**入力時点のスナップショット**。`GROUP BY` の意味が変わる |
| `重複禁止` | ✅ | **名寄せキーに使えるか**が決まる |
| `計算式` | ✅ | 値は**入力ではなく導出**。式が変われば過去の値も変わり得る |
| `required` / `maxLength` / `digit` / `defaultValue` | ❌ | 値を**書く**ための制約。読み取りの解釈を変えない |

**この線なら `ksql_app_metadata` との境界が保てる**（依頼元の言葉）。
R2 の「3 つで打ち止め」は数による停止規則で、**4 つ目が要るかを議論できなかった**。
**「読み方を変えるか / 書くための制約か」なら判断できる。**

### 1.2 これは完全な判定材料ではない（R1 から訂正・維持）

4 つとも空でも `ksql_app_metadata` が要る場合はある。
**「フラグが空なら安全」という一般命題は立たない。**

**それでも価値がある理由**＝この 4 つは
**JOIN の正しさ・名寄せキーの可否・集計軸の意味・数値の由来**に直結し、
**外したときの誤りが静かに通る**（起票 §1 の実例＝ルックアップを素の文字列と誤認して
「結合キーが無い」と書いた／`GROUP BY 仕入先` が入力時点で割れる）。

---

## 2. 出力仕様

### 2.1 列

```
フィールドコード | ラベル | タイプ | ルックアップ | コピー元 | 重複禁止 | 計算式
```

**既存 3 列の名前・順序・値は変えない。追加は末尾。**

### 2.2 値は文字列（engine-library 契約）

**boolean を入れてはいけない。**

| 値 | 意味 |
|---|---|
| `"YES"` | 付いている |
| `""`（空文字） | 付いていない／該当しない／**BYO client が値を返さない** |

`"true"` / `"false"` を避けるのは、**`"false"` が非空文字列なので CTE 下流で真に見える**ため。

### 2.3 判定

| 列 | 条件 |
|---|---|
| `ルックアップ` | property に **`lookup` キーが存在する**（値が `null` でも `"YES"`） |
| `コピー元` | **同じアプリ内のどれかの `lookup.fieldMappings[].field` に自分のコードが挙がっている**（`formFieldInfo.ts:86-97` が `writable` の算出で既に集計している集合） |
| `重複禁止` | **`unique === true`**（プロパティ非在は `""`） |
| `計算式` | 型が `CALC` **または** `expression` が**非空文字列** |

**`lookup` を値の truthiness で判定してはいけない**（権限不足時に `null` が来る・H1）。

> **【H1 と `コピー元` が組み合わさる穴・実装時に必ず確認】**
> `collectLookupCopyFields`（`formFieldInfo.ts:86-97`）は `field.lookup?.fieldMappings` を辿るため、
> **`lookup: null` のフィールドからはコピー先を集められない。**
> つまり**参照先アプリの権限が無いと、そのルックアップがコピーしてくる項目には `コピー元` が立たない**
> （`ルックアップ` は `null` でも立つのに、`コピー元` だけ落ちる）。
>
> **これは新しい欠陥ではなく、既存 `writable` が同じ穴を持っている**（権限が無いと
> コピー先が `writable: true` と誤判定される）。**本件で作り込むわけではないが、
> `コピー元` を出すと利用者から見えるようになる**ため、
> **仕様として明記し、必要なら別課題として起票する。**

**システムフィールド**（`RECORD_NUMBER` / `STATUS` / `CREATOR` 等）はいずれの条件も満たさず
自然に `""` になる。**特別扱いを書かない。**

### 2.4 `SELECT *` の列が 3 → 7 になる（R1 から訂正・R3 で 1 列増）

R2 で「破壊的」と訂正済み（R1 は「破壊的ではない」と書いていた）。

```
WITH d AS (DESCRIBE APP1) SELECT * FROM d   → 3 列だったものが 7 列になる
```

**列を厳密に固定している利用者（列スナップショット・CSV ヘッダ・配列変換・列数検査）には破壊的。**
UNION の位置対応（`execute.ts:5010-5015`）や `INSERT ... SELECT` の列数一致
（`execute.ts:7842-7847`）も列数に依存する。

**したがって意図した schema 拡張として CHANGELOG / リリースノートに明記し、移行例を示す。**

```
移行  SELECT フィールドコード, ラベル, タイプ FROM d      -- 3 列だけ要るなら名指しする
```

**JOIN 時の同名衝突**にも触れる。`ルックアップ` 等のフィールドコードを持つ表と JOIN して
`SELECT *` すると非修飾キーが衝突する（`engine/process.ts:103-105,164`）。
**修飾参照 `d.ルックアップ` は区別できる。**

### 2.5 サブテーブル子フィールド

現在もフラット化されて行に含まれる（`formFieldInfo.ts:76`）。**子にも同じ判定を適用する。**
親テーブル行の扱いは現状のまま変えない。

---

## 3. 実装方針

### 3.1 型は **optional** で足す（R1 から訂正）

R1 は必須 boolean 3 つを足す案だったが、**`KintoneFieldInfo` も `ReadonlyFieldInfo` も公開型**で、
必須追加は **repo 内の型付き fixture と npm の BYO client を壊す**（H2）。

```ts
// FormFieldProperty（kintone 生 JSON 側）
lookup?: { fieldMappings?: Array<{ field?: string }> } | null;   // null になり得る（H1）
unique?: boolean;
expression?: string;

// KintoneFieldInfo / ReadonlyFieldInfo（公開型・いずれも optional）
hasLookup?: boolean;
isLookupCopyTarget?: boolean;   // R3 で追加（値の由来）
isUnique?: boolean;
isCalculated?: boolean;   // R1 の hasExpression から改名（L1）
```

- **公式の browser / CLI / plugin client の正規化では常に埋める**
- **`executeDescribe` は `=== true` のときだけ `"YES"`、欠落は `""`**（BYO client 互換の fallback）
- **BYO client が正確なフラグを返すには新 optional metadata が要る**ことを公開型のコメントに書く

> **projector は最後に cast するため型不一致が compile error にならない**（`readonlyClient.ts:83`）。
> optional にしておかないと、**BYO 経由で `undefined` が入っても誰も気づかない**。

### 3.2 `executeDescribe` に列を足す

`execute.ts:9367-9372` の 1 か所だけ。

### 3.3 ツール説明文は **4 か所すべて**を受入に含める（R1 から変更）

R1 は「実装時に判断」としていたが、**それが drift を許した経路そのもの**（B132・B135 と同型）。

| 箇所 | |
|---|---|
| `mcp/index.ts:167-171` | ツール定義 |
| `scripts/mcp-smoke.mjs:216-219,262-268` | smoke |
| `scripts/mcp-pack-smoke.mjs:175` | pack smoke |
| `mcp/__tests__/metadataTools.test.ts:79-82` | テスト |

`"field code" / "label" / "type"` の 3 語は**残す**。**新しい 3 フラグの語も 4 か所すべてに足す。**

### 3.4 文書

- `docs/ksql_language_reference.md` の **§13（`:2099-2109`）と §14（`:2163-2175`）の両方**を直す
  （現状の `fieldCode`/`label`/`type`・`name` は**誤り**）。新 3 列も表に足す
- **例は実行して確認する。** 過去に未実行のサンプルを 3 回書いた

---

## 4. 受入条件

### 4.1 出力（実機・APP4228 / APP4229）

| 入力 | 期待 |
|---|---|
| `DESCRIBE APP4228` | 7 列。`製品名` は `ルックアップ = "YES"` / `重複禁止 = ""` / `計算式 = ""` |
| 同上 | `個数_在庫計算用` は `計算式 = "YES"`、他 2 つは `""` |
| 同上 | **`仕入先` は `コピー元 = "YES"`**（`製品名` のルックアップが `fieldMappings` でコピーしてくる先）。`計算式` は `""`（`expression: ""` を誤判定しないこと） |
| `DESCRIBE APP4229` | `製品名` は `重複禁止 = "YES"`、`製品番号` は `重複禁止 = ""` |
| システムフィールド | 4 つとも `""` |
| **`lookup: null`（権限不足）** | **`ルックアップ = "YES"`**（H1・単体テストで固定） |
| **サブテーブル子フィールド** | 親と同じ判定が効く（M4） |
| **全行・全列の値が string** | **engine-library だけでなく core / MCP の層でも固定**（M1） |

### 4.2 回帰（必須）

1. **既存 3 列の名前・順序・値が不変**
2. `WITH d AS (DESCRIBE APP100) SELECT フィールドコード FROM d` が従来どおり動く
3. `ksql_describe_app` が同じ SQL を組み立てている（`tools.test.ts:517-524` が緑）
4. 既存 smoke（`mcp:smoke` / `mcp:pack-smoke`）が破綻しない
5. engine-library の受入（`acceptance.test.ts:163-178`）が緑
6. **CTE 下流で新列を参照できる**（`SELECT ルックアップ FROM d WHERE ルックアップ = 'YES'`）
7. **`SELECT *` が 7 列になることを固定する**（直接・CTE 経由の両方）
8. **0 行の BYO DESCRIBE でも 7 列**（`sourceColumns` 経路・`process.ts:1313-1332`）
9. **UNION の列数不一致**が意図どおり検出される
10. **JOIN の同名列**で修飾参照 `d.ルックアップ` が正しく引ける
11. **BYO client がフラグを返さないとき、3 列とも `""` で落ちない**（H2 の fallback）

### 4.3 実機

型だけでは区別できなかった `製品名`（ルックアップ）と `仕入先`（素の文字列）が
**describe だけで見分けられる**ことを確認する。
**ただし `仕入先` がルックアップのコピー先であることは依然 describe から見えない**（§1.1）。

---

## 5. 影響範囲

| ファイル | 内容 |
|---|---|
| `core/formFieldInfo.ts:5-19,42-79` | `lookup?: ... \| null` / `unique?` / `expression?` を運ぶ・3 つの導出 |
| `execute.ts:291-313` | `KintoneFieldInfo` に **optional** 4 つ |
| `engine-library/publicTypes.ts:58-61` | `ReadonlyFieldInfo` に **optional** 4 つ＋コメント |
| `execute.ts:9367-9372` | 列と行の生成 |
| `mcp/index.ts` / smoke 2 本 / `metadataTools.test.ts` | 説明文（§3.3・**4 か所すべて**） |
| `docs/ksql_language_reference.md` | §13・§14 の列表と例（**現状が誤り**） |
| `CHANGELOG.md` | **`SELECT *` の列が増えることと移行例**（§2.4） |

**`prod/js/desktop.js` はエンジンをバンドルするため、リリース時はフルビルドが必須。**

---

## 6. 未確定（実装時に決めて報告する）

1. `lookup` が**空 object** で来る形があるか（公式契約で確認できず・**未確認**）。
   キー存在で判定するので実害は無いが、報告に残す
2. `CALC` 以外の型で `expression` が非空になる実例（この環境には無い・**未確認**）
3. 説明文へ足すフラグ語の具体的な文言（4 か所で同一にすること）
