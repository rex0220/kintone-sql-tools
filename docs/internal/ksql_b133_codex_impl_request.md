# B133 codex 実装依頼（2026-08-05）

実装は codex、レビューは Claude。**仕様は [R2](ksql_b133_saved_query_batch_spec.md) が正。必ず通読すること。**

> **運用制約**
> - **kSQL MCP を叩かないこと**（headless で無言停止する）。実機確認はレビュー側で行う
> - **git 操作は一切しないこと。** コミットは Claude 側
> - `npm test` は実行すること。`KSQL_USERNAME` / `KSQL_PASSWORD` / `KINTONE_USERNAME` /
>   `KINTONE_PASSWORD` が設定されていると CLI テストが落ちるので、テスト実行プロセスでだけ解除してよい

---

## 依頼

保存クエリを **①実行時に変数を注入できるように**し、**②読み取り専用に限り複文を許可**する。

対象: `C:\Users\rex02\Projects\kintone-sql-tools`（v3.47.0）

```sql
-- これが保存でき、実行時に @d90 を差し替えられるようにする
DECLARE @d90 = '2026-05-08';
DECLARE @d30 = '2026-07-06';
SELECT 製品名, SUM(CASE WHEN 日付 >= @d90 THEN 個数 ELSE 0 END) AS 出庫90
FROM APP4228 WHERE 入出庫区分 = '出庫' GROUP BY 製品名
```

```
ksql_run_saved_query { name: "...", variables: { d90: "2026-06-01" } }
```

### 進め方

1. R2 を通読する（**冒頭に R1 から訂正した点がある**）
2. **失敗するテストを先に書く**
3. `npm test` を通す
4. 変更点と判断を報告する

### 守ってほしいこと

- **仕様に書かれていない意味論を自分で決めない。** 迷ったら止めて報告に書く
- **既存テストを書き換えない。** 落ちたら報告する（スキーマ変更への形式的追従だけは例外・列挙する）
- **公開型に必須プロパティを足さない**

---

## 罠（R1 で間違えて、レビューで直った点）

1. **①が本体。** 「複文を保存できる」だけでは実需に届かない。
   **`variables` は `ksql_query` / `ksql_mutate` にはあるが `ksql_run_saved_query` には無い。**
   注入対象は **`DECLARE` 専用**で `SET` は注入されない。**①と②は一体で出す。**

2. **許可条件は `containsDml` ではなく `canRunWithQueryTool`（=`isReadOnlyBatch`）。**
   `containsDml` は「DML 構文か」ではなく `writesKintone()` で、
   **`VALIDATE ONLY` 付き DML は `false`** になる。
   **`INSERT ... VALIDATE ONLY; SELECT ...` は read-only 保存クエリとして通すのが正しい**
   （既存 `ksql_query` と同じ対応能力）。

3. **返却はバッチエンベロープ**（`ksql_query` と同じ）。「最後の結果セット」ではない。

4. **`ksql_list_queries` は SQL を返さない。** 変更不要。
   **既存テスト（`tools.test.ts:1573-1578`）が緑のままであることを確認する。**

5. **カタログは手編集できる**（parser は `sql: string` としか検証しない）。
   **防御は `saveQuery` と `runSavedQuery` の両方**に置く。
   `runSavedQuery` が毎回 validate と safety check をやり直している既存の形を維持する。

6. `requireSingleStatement` は**利用者が save / run の 2 箇所だけ**なので、
   両方から外したら**関数ごと削除**してよい。

---

## 受入・回帰

R2 §3 のとおり。落とさないでほしいもの:

- **§3.1**（★最優先）`DECLARE` を含む複文の保存 → `variables` で上書きが効くこと。
  `SET` で書いた保存クエリに `variables` を渡しても**注入されない**こと（既存契約）
- **§3.2** `INSERT ... VALIDATE ONLY; SELECT ...`（`readOnly: true`）は**通す**／
  実書き込み DML を含むバッチは拒否／**カタログを手編集して複文 DML を仕込んだら run 側で拒否**／
  同じ保存クエリの**同時実行で一時テーブルが衝突しない**
- **§3.3** **複文・改行・コメントを含む SQL** のカタログ往復で完全一致
- **§3.4** 既存の単文保存クエリが不変／`ksql_list_queries` が SQL を返さない／
  **既存 smoke（`mcp:smoke` ほか）が破綻しないこと**（保存クエリの入力スキーマを照合している
  smoke を洗う）／**実書き込み DML が `query()` 経路へ漏れない**ことを単文・複文の両方で固定

## 報告してほしいこと

`docs/internal/ksql_b133_codex_impl_report.md` に。

- 結果（完了 / 部分完了。`npm test` の結果）
- 変更ファイルと変更内容 / 追加したテスト
- R2 §3 の受入それぞれの確認結果
- **仕様と違えた箇所**（仕様の誤りを見つけた場合もここに。
  前回 B126/B127 では R4 の内部矛盾を実装時に見つけてもらった）
- **仕様が決まっていなかった箇所**（自分で決めずにここに。R2 §5 に 3 件ある）
- 既存テストへの影響 / 未実施
