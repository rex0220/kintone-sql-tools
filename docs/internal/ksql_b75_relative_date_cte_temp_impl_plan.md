# B75 実装計画 — 相対日付を CTE 本体・一時テーブルでも使えるように（第4許可形）

- 作成: 2026-07-26（Claude 起草）
- ステータス: ✅ **リリース済み（v3.25.0・2026-07-27）**。Step 1〜4 完了。Step 3 で Steps 1-2 が `inheritedForbidden` を無効化していた回帰も修正。
- 評価: [B75 eval](ksql_b75_relative_date_cte_temp_evaluation.md) / 前提: [B72 spec](ksql_b72_relative_date_fullscan_exact_spec.md)

## 0. 前提の実証（着手前に済ませてある）

guard の CTE 分岐だけを一時的に開いた実験で、**runtime 側の配線は既に完成している**ことを確認済み。

```
WITH cur AS (SELECT 担当者, SUM(受注金額) AS 売上 FROM APP100 WHERE 受注日 = THIS_MONTH() GROUP BY 担当者) SELECT * FROM cur

→ getRecords app=100 q=[受注日 = THIS_MONTH() order by $id asc limit 500 offset 0]
→ rows=[{担当者:佐藤, 売上:400}, {担当者:鈴木, 売上:200}]     ← 正しい集計
→ EXPLAIN: relative date evaluation: kintone server whole-WHERE exact
           client residual: (none)
           relative date client evaluations: 0
```

理由は `executeQueryWithCte(cte.query, ...)` が最終的に `executeSelect()` を呼び、
そこで `buildRelativeDateFullScanExactPlan({ ..., context: { allowFullScanExact: true } })` が
**CTE かどうかに関係なく**構築されるため（`src/execute.ts` の `executeSelect` 内）。

> **したがって本課題は原則 guard のみの変更**。runtime・EXPLAIN・残余抑止の新規実装は不要。
> ただし「開けた形が本当に client 残余 0 か」の検証は Step ごとに必須（下記 §3 の受入条件）。

## 0.1 【訂正 2026-07-26】第1許可形も開く

初版の本計画は非スコープに「第1許可形（SIMPLE＋whole exact）」を挙げていたが、**これは根拠のない過剰な制約**だった。
第2許可形を閉じる理由（client 残余評価が残り未検証）は書いていたが、第1許可形については理由を書いていない。

実装着手時に codex が「`forceForbidden=false` にすると第1許可形も同時に開くため計画と矛盾する」と指摘して停止。
指摘は正しく、**guard の構造上フラグだけで第3許可形のみを開くことはできない**（第1許可形は
`allowFullScanExact` 相当の gate を持たない）。新しい gate を足すことも検討したが、実測により不要と判断した。

```
WITH c AS (SELECT 日付 AS d FROM APP100 WHERE 日付 = YESTERDAY()) SELECT * FROM c
→ q=[日付 = YESTERDAY() order by $id asc limit 500 offset 0]
→ EXPLAIN: evaluation: kintone server / client evaluation: forbidden
```

第1許可形は SIMPLE 経路（`executeSimpleSelect`）で **client WHERE filter が存在しない**ため、
第3許可形より厳しい形であり CTE 本体でも安全。

**したがって本課題の不変条件は「CTE 本体は whole WHERE が exact に押し下げられるなら許可」**とし、
第1・第3許可形を開き、第2許可形（client 残余が残る）のみ `allowPhase2 = false` で閉じたままとする。
新しい gate は追加しない。

> B72 では逆に Claude が過剰な制約（`RELATIVE_DATE_FULL_SCAN_EXACT` complete-input reason）を足し、
> 実機 smoke で発覚して撤回した。**根拠を書けない制約は足さない**こと。

## 1. スコープと非スコープ

### 開ける対象（`relativeDatePushdownGuard.ts` の walk）

| 経路 | 現状 | 変更 | Step |
|---|---|---|---|
| `collectWith()` の CTE 本体 | `forceForbidden=true`, `allowFullScanExact=false` | 第1・第3許可形を開く（第2は閉じたまま） | 1 |
| `collectWith()` のインライン経路 `buildInlinedQuery()` | `allowFullScanExact=false` | 第3許可形を開く | 2 |
| `collectWith()` の `.main`（WITH 最終 SELECT） | `forceForbidden=true` | 第1・第3許可形を開く | 2 |
| `CREATE_TEMP_TABLE` の source | `forceForbidden=true` | 第1・第3許可形を開く | 3 |
| CTE 本体が `UNION` の枝（`collectUnion`） | `forceForbidden=true` | **非スコープ** | — |

### 非スコープ（fail-closed 継続）

- **第2許可形（B67 Phase2 A の prefilter＋client 残余）を CTE 本体で開くこと。**
  client 残余評価が残る形で、CTE 実体化と組み合わせたときの挙動を実験で判別できていない。
  CTE 本体と `.main` には `allowPhase2 = false` を渡して閉じたままにする。
  （§0.1 の訂正により**第1許可形は開く**。インライン展開経路はインライン後が通常の物理 SELECT と
  同一のため `allowPhase2 = true` のままでよい。）
- **CTE 本体・`.main` の入れ子 SELECT**（スカラーサブクエリ等）。`forceNestedForbidden` で fail-closed を維持する。
- `UNION` 枝、再帰 CTE（B53 領域）、相互参照 CTE
- KORDER（そもそも CTE 内では構文エラー「KORDER BY は利用者へ結果を返すトップレベル SELECT でのみ使用できます」＝二重防御が既にある）
- JOIN を含む CTE 本体（B72 の plan builder が `joins.length > 0` で null を返すため自動的に閉じたまま。B76 の領域）
- DML の source（`INSERT/UPSERT ... SELECT`・`UPDATE ... FROM`）＝B67 の方針どおり拒否継続

## 2. 実装ステップ

### Step 1 — CTE 本体に第1・第3許可形を開く

`collectWith()` の CTE ループを、`forceForbidden` を落として `allowFullScanExact` を立てる形へ。
**`allowPhase2Prefilter` は `false` を渡し、第2許可形が同時に開かないようにする**（非スコープの明示）。

```ts
statement.ctes.forEach((cte, index) => {
  if (cte.query.type === "SELECT") {
    // B75: CTE 本体でも「whole WHERE exact ＋ client 残余 0」だけは許可する。
    // Phase2 A（prefilter＋残余）は CTE 実体化との組み合わせ未検証のため閉じたまま。
    collectSelect(cte.query, `${path}.cte[${index}]`, candidates, false, false, true);
  } else if (cte.query.type === "UNION") {
    collectUnion(cte.query, `${path}.cte[${index}]`, candidates, true, false);  // 変更なし
  }
});
```

> `collectSelect(select, path, candidates, forceForbidden, allowPhase2, allowFullScanExact)`
> の第5引数が `allowPhase2` である点に注意（現行コードは `true` を渡している）。

**注意**: `collectSelect` は `nestedSelects()` で入れ子 SELECT にも同じフラグを伝播する。
CTE 本体の中のスカラーサブクエリ等が意図せず開かないか、Step 1 のテストで必ず確認すること。
意図せず開く場合は入れ子側だけ `forceForbidden=true` に落とす分岐を足す。

### Step 2 — インライン経路と WITH 最終 SELECT

- インライン経路: `collectSelect(buildInlinedQuery(statement), `${path}.inlined`, candidates, false, true, false)`
  の最終引数を `true` へ。現状これが `false` のため
  `WITH cur AS (SELECT ... WHERE 日付 >= FROM_TODAY(-30,DAYS) ORDER BY 受注金額) SELECT * FROM cur`
  が `path=statement.inlined` で落ちる（実測）。
- `.main`: `collectSelect(statement.query, `${path}.main`, candidates, false, false, true)`。
  最終 SELECT が物理アプリを読む形（`WITH x AS (...) SELECT ... FROM APP100 WHERE 日付 = THIS_MONTH()`）が対象。
  CTE を読む形は `from.cteName !== null` で plan builder が null を返すため自動的に閉じる。

### Step 3 — 一時テーブル

`collectStatement()` の `CREATE_TEMP_TABLE` 分岐を同様に緩める。
`WITH` 版（`statement.query.type === "WITH"`）は Step 1/2 の変更が効くので追加変更は不要かを確認。
一時テーブルはバッチスコープのため、**バッチ内の後続文が結果を再利用しても相対日付は再評価されない**
（実体化済み）ことをテストで固定する。

### Step 4 — 4面 parity・docs

- プラグイン / CLI / MCP / engine ライブラリの4面で同一挙動を確認（既存の parity テスト方式を踏襲）
- `docs/ksql_language_reference.md` §5 の「CTE 本体では相対日付を使えない」旨の記述を更新
- `CHANGELOG.md` / `release/README.txt` / 台帳 §2 / spec ステータス（4点同期）
- `ksql_docs`（MCP）に反映されることを確認

## 2.5 既存テストの更新（Step 1 に含む）

本変更で **旧挙動（materialized CTE は fail-closed）を固定している既存テスト 4 suites / 5 tests が失敗する**。
これらは B75 が意図して変える挙動なので、**削除せず「新しい正しい挙動」を固定する形へ書き換える**こと。

| suite | テスト |
|---|---|
| `src/core/optimization/__tests__/b67RelativeDatePlanGuard.test.ts` | materialized CTE は plan walk で fail-closed にする／WITH は inline plan を1物理 SELECT として判定し、非 inline materialization を拒否する |
| `src/__tests__/b72RelativeDateFullScanExactStep2.test.ts` | materialized CTE は records/cursor/mutation/confirm 0 |
| `src/__tests__/b67RelativeDateExecutionPaths.test.ts` | materialized CTE は metadata 以外の API と confirm の前に拒否する |
| `src/__tests__/b67RelativeDateSurfaces.test.ts` | materialized CTE は reject/reason/records API 0 が3面で一致する |

書き換え後は「押し下げられること・client 評価が 0 であること・結果が正しいこと」を固定する。
**JOIN を含む CTE 本体・UNION 枝・DML source など、依然拒否される形の fail-closed テストは残すこと。**

## 2.6 【Step 2 レビューで判明】残る非対称（本課題では閉じない）

第2許可形（B67 Phase2 A の prefilter＋client 残余）を CTE 本体で閉じた結果、
**同じ WHERE がトップレベルでは通り CTE 本体では拒否される**非対称が残る。

```
SELECT COUNT(*) AS n FROM APP100 WHERE 日付 = YESTERDAY() AND LENGTH(件名) > 1
→ OK（Phase2 A で 日付 = YESTERDAY() を押し下げ・LENGTH は client 残余）

WITH c AS (SELECT 日付 FROM APP100 WHERE 日付 = YESTERDAY() AND LENGTH(件名) > 1) SELECT COUNT(*) AS n FROM c
→ NG（path=statement.cte[0]）
```

これは **Step 1 で意図的に `allowPhase2 = false` にした結果**であり、欠陥ではない。
ただし B72 が解消したのと同じ class の非対称なので、**放置すると同じ指摘を受ける**。

- 本課題（B75）では閉じない。CTE 実体化と client 残余の組み合わせが未検証のため。
- **Step 4 の docs でこの制約を明記すること。**
- 解消するなら別 Step ないし別課題とし、「CTE 本体で client 残余評価が起きても
  相対日付リーフだけは採用済み（client 評価 0）」であることを実測で確認してから開くこと。

なお、**単一 CTE がインライン展開される形は `.main` 経路を通らない**（`canInlineSingleCte` が
先に効いて CTE が消える）。`.main` が CTE を読む形の fail-closed は、
インライン不可の場合（複数 CTE・最終に集計など）にのみ観測できる。

## 3. 受入条件（各 Step 共通）

1. **相対日付の client 評価が 0**。EXPLAIN が `client residual: (none)` と
   `relative date client evaluations: 0` を出すこと。
2. **押し下げクエリが実際に発行される**。`getRecords` の `query` に相対日付関数が
   そのまま乗ること（`受注日 = THIS_MONTH()`）。
3. **fields を尊重するモック**で検証すること（B71 の教訓。全フィールドを返すモックは
   取得列の欠落を隠す）。
4. **非スコープの形が依然として拒否される**こと。特に:
   - CTE 本体に JOIN があるとき
   - CTE 本体が UNION の枝のとき
   - DML の source のとき
   - 押し下げ不能述語が混ざり whole WHERE が exact にならないとき
5. **既存テストが全て green**（`npm test` を必ず全件実行。スコープ限定実行では
   B71 のときのように他所の drift guard・allowlist の破壊を見落とす）。
6. snapshot 差分は意図したものだけ。

## 4. リスクと備え

| リスク | 備え |
|---|---|
| `collectSelect` のフラグ伝播で入れ子 SELECT が意図せず開く | Step 1 のテストで入れ子ケースを明示的に固定 |
| 第2許可形が同時に開いてしまう | `allowPhase2=false` を明示的に渡す。EXPLAIN が `prefilter` を出さないことを確認 |
| CTE 実体化の結果が後続で再フィルタされ、相対日付が再評価される | Step 3 で一時テーブル再利用のテストを追加 |
| 台帳・docs の更新漏れ | Step 4 で4点同期 |

## 5. 見積もり

**1〜1.5 人日**（Step 1: 0.25、Step 2: 0.25、Step 3: 0.25、Step 4: 0.5）。
guard のみの変更で runtime 実装が無いため、B72（4 Step・実装あり）より軽い。

SemVer=**minor**（純加法。現在通っているクエリの結果は不変）。

## 6. 実装時の注意（B72 の教訓の適用）

- **過剰な制約を足さないこと。** B72 では「新たに許可された形は fail-closed に」という
  指示から `RELATIVE_DATE_FULL_SCAN_EXACT` complete-input reason を足してしまい、
  「リテラル日付なら truncate できるのに相対日付だとできない」非対称を生んだ（実機 smoke で発覚・撤回）。
  **B75 でも、開けた形の取得上限挙動はリテラル日付と同一でなければならない。**
- **out-of-scope な修正をしないこと。** B71 で `src/ui/desktop.ts` の既存型エラー修正が
  混入し revert した。本課題の変更は guard とテストと docs に限る。
- リリース準備コミットの後にコード変更が入った場合、**`release/` 成果物を再ビルドしてから tag を打つ**。
