# B128 Phase 2a `LAG` / `LEAD` codex 実装依頼（2026-08-06）

実装は codex、レビューは Claude。**仕様は [R2](ksql_b128_lag_lead_spec.md) が正。必ず通読すること。**

> **運用制約**
> - **kSQL MCP を叩かないこと**（headless で無言停止する）。実機確認はレビュー側で行う
> - **git 操作は一切しないこと**（`git status` も含む）。コミットは Claude 側
> - `npm test` は実行すること。`KSQL_USERNAME` / `KSQL_PASSWORD` / `KINTONE_USERNAME` /
>   `KINTONE_PASSWORD` が設定されていると CLI テストが落ちるので、テスト実行プロセスでだけ解除してよい

---

## 依頼

**`LAG(expr [, offset])` / `LEAD(expr [, offset])` を `OVER (PARTITION BY ... ORDER BY ...)` で使えるようにする。**

対象: `C:\Users\rex02\Projects\kintone-sql-tools`（v3.50.0）

**実需は「前月比」**（依頼元が実測で移動フレームより先だと示した）。到達点は R2 §1.1 の 3 段構成。

### 進め方

1. R2 を通読する（**冒頭に R1 の誤り 6 件がある**）
2. **失敗するテストを先に書く**
3. `npm test` を通す
4. 変更点と判断を報告する

### 守ってほしいこと

- **仕様に書かれていない意味論を自分で決めない。** 迷ったら止めて報告に書く
- **既存テストを書き換えない。** 落ちたら報告する（行番号など形式的追従だけは例外・列挙する）
- **公開型に必須プロパティを足さない**

---

## 罠（2 回のレビューで判明した点）

1. **`isRankingWindow` は「`AGGREGATE` でなければ RANKING」の二者択一。**
   `windowKind: "VALUE"` を足すと**順位系と誤判定される**。
   **positive discriminator** にして `applyWindow` を 3 分岐、**未知 kind は fail-closed**。
   **`isRankingWindow` の全利用者を確認すること。**

2. **引数フィールドが required-field 収集から漏れる。**
   現行 walker は**集計系だけ `arg` を走査**する（`selectToKintone.ts:778-784`）。
   `VALUE` でも `walkAggregateArg` を通さないと **`LAG(出庫)` の `出庫` が kintone から取得されず、
   静かに空文字になる**（B125 の集計引数漏れと同じ形）。

3. **型メタが一律 number になる。** 「`AGGREGATE` でなければ number」という二者択一が
   **複数箇所にある**。**R2 §3.3 の 6 箇所すべて**を直す。
   **とくに 4 番（source metadata のロードゲート）は集計窓の `MIN`/`MAX` だけが対象**で、
   直さないと **direct APP の `LAG(選択肢列)`** で resolver が元メタを持たない。

4. **完全入力の理由は `WINDOW_ORDER`。** `AGGREGATE_WINDOW` **ではない**
   （`dmlGuard.ts:183-187` は `windowKind === "AGGREGATE"` だけを前者にする）。
   **`VALUE` を `AGGREGATE_WINDOW` へ無理に入れないこと。** 受入で reason を固定する。

5. **B129 の nested 検出は `LAG`/`LEAD` を自動では拾わない。**
   現行 scanner は **aggregate token map だけ**を見ている。
   **`ROUND(LAG(x) OVER (...), 1)` が診断へ行かない。**
   scanner に `IDENT(LAG|LEAD) + LPAREN ... RPAREN + OVER` を加え、
   **VALUE parser 自身も後続の算術・連結を B129 へ送る**
   （集計窓が `parser.ts:1564-1568` でやっているのと同じ形）。
   **受入は 3 形（関数で包む・算術・`CASE` の中）で、
   `WINDOW_RESULT_IN_EXPRESSION_MESSAGE` の本文を固定する。**

6. **第 3 引数 `default` は取らない。** 型が一貫しなくなるため（R2 §2.3）。**ParseError。**

7. **`offset` がパーティション長を超えたら空文字。** **弾かない**（R2 §2.2）。

8. **引数の評価は `evaluateValueWindowArg` を別に置く。**
   **`aggregateRowValues()` を呼ばない**（空値スキップに入ってしまう）。
   **ソート後の行ごとに 1 回だけ**評価する。

9. **`LAG` / `LEAD` は soft keyword。** 同名フィールドが従来どおり参照できること。
   引数終端は **comma-aware**（`LAG(CASE WHEN ... END, 2)` の内側のカンマを終端と誤認しない）。

10. **B127 の全順序判定は独立 helper ではない**（RANGE 専用 warning 内の inline 判定）。
    `canProveTotalWindowOrder` を**純粋 helper として抽出**してから両方で使う。
    **暗黙の `$id` タイブレークを共有 comparator に足してはならない**（既存の並びが変わる）。

11. **代表 SQL は実在アプリの形で書き、3 段構成にする**（R2 §1.1）。
    **過去に 5 回、パースできないサンプルを書いている。**

---

## 受入・回帰

R2 §4 のとおり。落とさないでほしいもの:

- **§4.1** 先頭/末尾は空文字／`LAG(x,0)` は自分自身／**`LAG(x,999)` は空文字（エラーにしない）**／
  `PARTITION BY` 境界をまたがない／参照先が空セルなら空文字／
  負数・小数・変数・式・第 3 引数は ParseError／**`LAG(CASE WHEN ... END, 2)` は通る**
- **§4.2**（型）**出力を観測して固定する**＝`LAG(数値列)` を次の段で `ORDER BY` すると数値順／
  **direct APP の `LAG(選択肢列)` を次の段で `ORDER BY` すると定義順**（罠 3-4 が直っていないと崩れる）
- **§4.3**（収集漏れ）**引数にしか現れないフィールド**で前月が空文字にならないこと
- **§4.4** B129 の 3 形で **`WINDOW_RESULT_IN_EXPRESSION_MESSAGE` の本文**が出ること
- **§4.5** 順位系・集計窓・`LAG` の混在（別々の `ORDER BY`）／`SELECT DISTINCT` 併用／
  `GROUP BY` 併用は ParseError のまま／**完全入力の理由が `WINDOW_ORDER`**／
  **`LAG` という名前のフィールドが従来どおり参照できる**

## 併せて直すもの

- `docs/ksql_language_reference.md` §10.1 に `LAG` / `LEAD`
  （**`SHOW APPS` / `DESCRIBE` の列表を検査するテストがある**ので、そこは壊さないこと）
- `docs/ksql_batch_recipes.md` に**前月比のレシピを 1 本**
  （**レシピを足したら `docsResourceBuilder.cjs` の `count` と関連テストも追従が要る**。
  B135 で同じ取り残しを踏んでいる）
- `CHANGELOG.md` は **`## v3.50.0` がリリース済み**なので、**新しい節を先頭に作る**
  （`version:check:release` が検査する）

## 報告してほしいこと

`docs/internal/ksql_b128_codex_impl_report.md` に。

- 結果（完了 / 部分完了。`npm test` の結果）
- 変更ファイルと変更内容 / 追加したテスト
- R2 §4 の受入それぞれの確認結果
- **仕様と違えた箇所**（仕様の誤りを見つけた場合もここに）
- **仕様が決まっていなかった箇所**（自分で決めずにここに。R2 §6 に 3 件ある）
- 既存テストへの影響 / 未実施
