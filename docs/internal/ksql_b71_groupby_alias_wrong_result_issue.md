# B71 — `GROUP BY` のエイリアス指定が黙って誤集計する（silent wrong results）

- 作成日: 2026-07-26
- ステータス: **✅ 修正済み・リリース済み（v3.23.0・2026-07-26）**。仕様 R3 に基づく4 Step 実装で解消。実機 PASS。詳細は [spec R3](ksql_b71_groupby_alias_phase1_spec.md)。
- 報告元: kSQL Dashboard Pro（`kSQLエンジン報告-20260726.md` 報告1・Pro 側課題 K-14）
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B71
- 関連: B59（ORDER BY alias 黙殺修正・v3.13.0）／B51（CTE JOIN silent wrong results・v3.11.0）

## 1. 現象

SELECT 句のエイリアスを `GROUP BY` に書くと、**構文エラーにならずに実質グループ化されない**結果を返す。

```sql
SELECT DATE_FORMAT(作成日時, '%Y-%m') AS 年月, COUNT(*) AS 件数
FROM APP100
GROUP BY 年月          -- エイリアス指定
```

## 2. 再現（実エンジン・プローブ 2026-07-26）

レコード3件（2026-01 が2件・2026-02 が1件）:

| GROUP BY の書き方 | 結果 |
|---|---|
| `GROUP BY DATE_FORMAT(作成日時, '%Y-%m')`（式） | ✅ `[{年月:"2026-01",件数:"2"},{年月:"2026-02",件数:"1"}]` |
| `GROUP BY 年月`（エイリアス） | ❌ `[{年月:"2026-01",件数:"3"}]` — **全行が1グループへ潰れる** |
| `GROUP BY 存在しない列` | ✅ `ArgumentError: unknown field code(s): 存在しない列` で拒否 |
| `SELECT 金額 AS a … GROUP BY a`（単純列 alias） | ❌ `[{a:"100",c:"3"}]` — 同様に誤集計 |

先頭行の値がそのまま出力されるため（`outRow = {...groupRows[0]}`）、**一見それらしい値**になり利用者が誤りに気づけない。

## 3. 根因（2層の食い違い）

| 層 | 実装 | 挙動 |
|---|---|---|
| フェッチ / 検証層 | `src/converter/selectToKintone.ts:440` — `if ((phase === "orderBy" \|\| phase === "having" \|\| phase === "groupBy") && selectAliases.has(rawName))` | GROUP BY の名前が SELECT alias なら**取得対象から除外**＝ alias と認識している。このため `validateSelectFieldCodes` の unknown field 検証も通過し、**エラーにならない** |
| 実行層 | `src/engine/process.ts` `evalGroupByKey()` — `if (key.type === "FIELD_NAME") return row[key.name] ?? "";` | GROUP BY は **project 前の入力行**に対して評価されるため alias 列は存在せず `undefined` → `?? ""` で**全行が同一キー（空文字）** |

つまり「alias と分かっていて取得を省く」のに「実行時に alias を解決する仕組みがない」。**B59 で ORDER BY には `aliasEvaluator`（project 前の入力行から alias を評価する事前コンパイル resolver・`process.ts:buildOrderByAliasEvaluator`）を入れたが、GROUP BY は取り残された**。

## 4. 期待する挙動（要オーナー判断）

Pro の要望は「1（解決）推奨、不可なら 2（明示拒否）」。

1. **エイリアスを解決して正しく集計する**（MySQL 互換・ORDER BY と同じ解決を GROUP BY にも適用）
   - B59 の `buildOrderByAliasEvaluator` が project 前の入力行から alias を評価する資産なので**そのまま流用できる見込み**。
   - ただし**集計関数の alias**（例 `SELECT COUNT(*) AS 件数 … GROUP BY 件数`）は SQL 的に不正（グループ化前に集計値は確定しない）。MySQL も拒否するため、**明示エラーで拒否**する必要がある。
   - window 列 alias・scalar subquery alias 等、入力行から評価できない alias の扱いも同様に切り分ける。
2. 解決しないなら **ParseError / ArgumentError で明確に拒否**（「GROUP BY にエイリアスは使用できません」）。

いずれにせよ**「黙って誤結果」を残さない**ことが必須。

## 5. 影響範囲・想定作業

- 対象: `evalGroupByKey`（+ `applyGroupBy` への evaluator 供給）、`applyGroupingSets`（B65 の ROLLUP/GROUPING SETS 経路も同じキー評価を使うか要確認）、静的検証（拒否案の場合は `analyzeBatch`/validate 側にも）。
- ORDER BY（B59）・HAVING の既存挙動は変えない。HAVING は集計後の行に対する評価のため alias が materialize 済みで動作している可能性が高く、要確認。
- 見積り: 解決案で 1.5〜3 人日（alias 種別の切り分け・拒否すべき alias の判定・受入テスト）。拒否案なら 0.5〜1 人日。

## 6. 受入（案）

- `GROUP BY <SELECT の式 alias>` が式指定と**同一結果**（解決案の場合）。
- `GROUP BY <集計関数の alias>` は明示エラー。
- `GROUP BY 存在しない列` は従来どおり `unknown field code(s)`。
- ORDER BY alias（B59）・HAVING・通常の `GROUP BY 式/フィールド`・B65 ROLLUP/GROUPING SETS が非回帰。
- 全 npm test green・snapshot 不変。
