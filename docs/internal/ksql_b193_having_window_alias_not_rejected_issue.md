# B193 `HAVING` から同じ SELECT のウィンドウ別名を参照しても止まらず、空文字として比較される（静かに全件／0 件）

- 状態: ✅ **v3.85.0 でリリース（2026-09-17）**。Claude が直接修正・テスト追加（codex 未介在・小規模のため）。`src/core/aggregateDependencyValidation.ts` の依存走査で、`HAVING` 句の未修飾名が同じ SELECT の `WINDOW_COL` 別名に解決されたら `ArgumentError … (reason=HAVING_WINDOW_ALIAS)` で止める。テスト 2 本を `b184aWindowWithAggregate.test.ts` に追加。起票時の実測 v3.84.0（MCP・dev profile・SFA パック APP4149）。バグ（**結果が変わる**＝止まるべき形が静かに誤答していた・規模 S）。報告元: kSQL Dashboard Pro（[連絡 2026-09-17](../../../ksql-dashboard-pro/docs/internal/kSQLエンジンへの連絡-20260917-送付版.md)・Ver.2 の v3.84.0 取り込み確認で発見）

## 1. 現象

v3.81.0（B184-A）でウィンドウを集計と同じ SELECT に書けるようになった。CHANGELOG は「`WHERE` / `HAVING` / `JOIN ON` / `GROUP BY` / 文レベルの `ORDER BY` でのウィンドウ参照は従来どおり拒否」としていたが、**`HAVING` でウィンドウ列の別名を参照する形は拒否されず**、別名が空文字として比較される。

```sql
SELECT 会社名, SUM(売上) AS 売上合計, RANK() OVER (ORDER BY SUM(売上) DESC) AS 順位
FROM APP4149
GROUP BY 会社名
HAVING 順位 <= 5
```

| HAVING | v3.84.0 の結果（dev・10 社） |
| :--- | :--- |
| `順位 <= 5` | **10 行すべて**（順位 1〜9）・エラーも警告もなし |
| `順位 = 1` | **0 行** |
| `WHERE 順位 <= 5`（同じ形を WHERE に） | `WHERE predicate is unsupported (field=順位, … reason=WHERE_FIELD_UNRESOLVED)` で止まる |
| `HAVING 存在しない <= 5` | `B65_NON_GROUPED_DEPENDENCY` で止まる |
| `HAVING 売上合計 >= 199`（集計別名） | 正しく絞られる（従来どおり） |

利用者は「上位 5 件に絞れた」と思ったまま全件を見る。Pro 側の再現は APP4239（売上明細）・CLI v3.84.0。

## 2. 原因

`validateAggregateDependencies`（B65 / 通常の集計依存検査）は `HAVING` の未修飾名を SELECT の別名に解決し、その別名の**定義式**の依存を歩く。`WINDOW_COL` の定義式（`PARTITION BY` / `ORDER BY` / 引数）は集計式かグループキーなので依存検査を通り、別名参照そのものは合格扱いになっていた。実行時の `HAVING` は `GROUP BY` → `HAVING` → ウィンドウの順で評価されるため、その時点でウィンドウ列は無く空文字になる（`'' <= 5` は真、`'' = 1` は偽）。

ウィンドウ**式**を `HAVING` に直接書く形（`HAVING SUM(x) OVER () > 0`）はパーサで拒否済み（B184-B のテスト）。別名経由だけが抜けていた。

## 3. 対応

`walkDependency` の `HAVING` 分岐で、未修飾名が同じ SELECT の `WINDOW_COL` 別名に解決されたら実行前に止める（静的検証・EXPLAIN・実行の全経路で同じ検査を共有）:

```text
ArgumentError: HAVING からは同じ SELECT のウィンドウ関数の結果（別名 順位）を参照できません。HAVING はウィンドウより先に評価されます。WITH で段を分け、次の段の WHERE で絞ってください (reason=HAVING_WINDOW_ALIAS)
```

- 結果が変わる形: `HAVING` にウィンドウ別名を書いた文（v3.81.0〜v3.84.0 は静かに全件／0 件、修正後はエラー）
- 変わらない形: 集計別名・集計式・グループキーの `HAVING`、`WITH` で段を分けて次の段の `WHERE` で絞る形、文レベルの `ORDER BY` でのウィンドウ別名参照（ウィンドウの後に評価されるので従来どおり可）

テスト（`b184aWindowWithAggregate.test.ts`）: `HAVING 順位 <= 5` / `= 1` / `順位 + 0 = 1` / `IS NULL` / `SUM(売上) > 0 AND 順位 <= 5` の 5 形が止まる。段を分けた `WHERE` と集計別名の `HAVING` は従来どおり。

## 4. 受入条件

- §1 の 1〜2 行目が実行前に止まり、エラー文に別名と回避策（WITH で段を分ける）が入る
- 静的検証（MCP `ksql_validate` / Pro の設定画面の構文チェック）でも同じ文で止まる
- 集計別名の `HAVING`、`ORDER BY 順位`、段を分けた形は不変
- 既存の B65 / B147 / B181 / B184 テストが不変

## 5. 経緯

- 2026-09-17: Pro が Ver.2（エンジン 3.66.1 → 3.84.0）の取り込み確認で発見し連絡。dev で再現（10 行／0 行）し即日修正。B184-A の「HAVING は従来どおり拒否」は、パーサが拒否するウィンドウ式だけを見ていて、別名経由の参照を確かめていなかった（**助言や契約文には、その文どおりの形を実行するテストを 1 本**の型）
- 関連: B184-A、B65（依存検査）、B181（HAVING の別名束縛）
