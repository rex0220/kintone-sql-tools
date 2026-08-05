# B130 codex 実装依頼（2026-08-06）

実装は codex、レビューは Claude。**仕様は [R3](ksql_b130_describe_flags_spec.md) が正。必ず通読すること。**

> **運用制約**
> - **kSQL MCP を叩かないこと**（headless で無言停止する）。実機確認はレビュー側で行う
> - **git 操作は一切しないこと。** コミットは Claude 側
> - `npm test` は実行すること。`KSQL_USERNAME` / `KSQL_PASSWORD` / `KINTONE_USERNAME` /
>   `KINTONE_PASSWORD` が設定されていると CLI テストが落ちるので、テスト実行プロセスでだけ解除してよい

---

## 依頼

`DESCRIBE` の出力に**「値の由来」4 列**を足す。

対象: `C:\Users\rex02\Projects\kintone-sql-tools`（v3.48.0）

```
フィールドコード | ラベル | タイプ | ルックアップ | コピー元 | 重複禁止 | 計算式
```

### 進め方

1. R3 を通読する（**冒頭に R1→R2→R3 の訂正が 3 段ある**）
2. **失敗するテストを先に書く**
3. `npm test` を通す
4. 変更点と判断を報告する

### 守ってほしいこと

- **仕様に書かれていない意味論を自分で決めない。** 迷ったら止めて報告に書く
- **既存テストを書き換えない。** 落ちたら報告する（列数・行番号など**形式的追従だけは例外・列挙する**）
- **公開型に必須プロパティを足さない**

---

## 罠（レビューと依頼元の回答で直った点）

1. **3 列ではなく 4 列。** 枠は**「値の由来」**＝値の**読み方**を変える情報だけを出す。
   `required` / `maxLength` / `digit` / `defaultValue` は**値を書くための制約なので入らない**。
   **`コピー元` の材料は既にある**＝`collectLookupCopyFields`（`formFieldInfo.ts:86-97`）が
   `writable` の算出で同じ集合を作っている。

2. **`lookup` は権限不足時に `null` を返す**（kintone 公式）。
   **値の truthiness で判定すると実在するルックアップを取りこぼす。**
   **キーの存在**で判定すること（`lookup: null` でも `ルックアップ = "YES"`）。
   型も `lookup?: {...} | null` にする。

3. **公開型に必須プロパティを足さない。**
   `KintoneFieldInfo`（`execute.ts:291-313`・`core/index.ts:53-55` で export）も
   `ReadonlyFieldInfo`（`engine-library/publicTypes.ts:58-61`・**npm の BYO client が実装する型**）も
   **4 つとも optional**。`executeDescribe` は **`=== true` のときだけ `"YES"`**、欠落は `""`。
   **`readonlyClient.ts:83` の projector は最後に cast するため、必須にすると
   BYO 経由で `undefined` が入っても compile error にならない。**

4. **値は文字列。boolean を入れてはいけない。**
   engine-library の契約で DESCRIBE の全列は `valueType: "string"` かつ全値 string
   （`resultMapping.ts:41,56` / `acceptance.test.ts:163-178`）。**`"YES"` / `""`**。
   `"true"` / `"false"` は不可（`"false"` が非空で真に見える）。

5. **`expression` は素の SINGLE_LINE_TEXT にも空文字で存在する**（実測）。
   **プロパティの有無で判定すると素の文字列まで計算列になる。** 非空で判定すること。
   型が `CALC` **または** `expression` 非空。

6. **ルックアップのフィールドには `unique` プロパティが存在しない**（実測）。
   **`unique === true`** で判定する。`!== false` ではない。

7. **説明文の固定箇所は 4 つ。** 実装時判断にせず**全部そろえる**
   （`mcp/index.ts:167-171` / `scripts/mcp-smoke.mjs:216-219,262-268` /
   `scripts/mcp-pack-smoke.mjs:175` / `mcp/__tests__/metadataTools.test.ts:79-82`）。
   `"field code" / "label" / "type"` の 3 語は**残す**。

8. **`docs/ksql_language_reference.md` は §13（`:2099-2109`）と §14（`:2163-2175`）の
   両方が誤っている。** 現状 `fieldCode` / `label` / `type`・`name` と書かれているが
   **実装は日本語列名で、例を実行するとエラーになる**（実測済み・B136）。
   **DESCRIBE 分を直す**（`SHOW APPS` 分は B136 で別途）。**例は実行できる形にすること。**

9. **`SELECT *` は 3 → 7 列になる。** これは**破壊的**（列スナップショット・CSV ヘッダ・
   列数検査・UNION の位置対応）。**CHANGELOG に移行例を書く**
   （`SELECT フィールドコード, ラベル, タイプ FROM d`）。

10. **`コピー元` には既知の穴がある**（R3 §2.3 の注記）。
    `collectLookupCopyFields` は `lookup?.fieldMappings` を辿るため、
    **参照先アプリの権限が無いとコピー先を集められず `コピー元` だけ落ちる**。
    **既存 `writable` が同じ穴を持っているので本件では作り込まない。**
    **ただし報告に書くこと**（別課題として起票するかを Claude 側で判断する）。

---

## 受入・回帰

R3 §4 のとおり。落とさないでほしいもの:

- **§4.1**（実データの形）`製品名` は `ルックアップ = YES`／
  **`仕入先` は `コピー元 = YES` かつ `計算式 = ""`**（`expression: ""` を誤判定しない）／
  `個数_在庫計算用` は `計算式 = YES`／`製品名`(APP4229) は `重複禁止 = YES`・`製品番号` は `""`／
  **`lookup: null` でも `ルックアップ = YES`**（単体テストで固定）／
  **サブテーブル子フィールドにも同じ判定が効く**／**全行・全列が string**
- **§4.2**（回帰）既存 3 列の名前・順序・値が不変／
  `WITH d AS (DESCRIBE APP100) SELECT フィールドコード FROM d` が従来どおり／
  `ksql_describe_app` が同じ SQL を組み立てている（`tools.test.ts:517-524`）／
  **`SELECT *` が 7 列になることを直接・CTE 経由の両方で固定**／
  **0 行の BYO DESCRIBE でも 7 列**（`process.ts:1313-1332` の `sourceColumns` 経路）／
  **BYO client がフラグを返さないとき 4 列とも `""` で落ちない**／
  既存 smoke が破綻しない／`acceptance.test.ts:163-178` が緑

## 報告してほしいこと

`docs/internal/ksql_b130_codex_impl_report.md` に。

- 結果（完了 / 部分完了。`npm test` の結果）
- 変更ファイルと変更内容 / 追加したテスト
- R3 §4 の受入それぞれの確認結果
- **仕様と違えた箇所**（仕様の誤りを見つけた場合もここに。
  前回 B126/B127 では R4 の内部矛盾を実装時に見つけてもらった）
- **仕様が決まっていなかった箇所**（自分で決めずにここに。R3 §6 に 3 件ある）
- **罠 10 の権限穴**について、実装中に分かったこと
- 既存テストへの影響 / 未実施
