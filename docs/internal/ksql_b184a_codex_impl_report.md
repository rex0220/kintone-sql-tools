# B184-A 実装報告（codex・2026-09-16）

- 依頼: [ksql_b184a_codex_impl_request.md](ksql_b184a_codex_impl_request.md)（集計と同じ SELECT のウィンドウ）
- 起票: [ksql_b184_window_in_same_select_issue.md](ksql_b184_window_in_same_select_issue.md)
- 作業ブランチ: `b184/dev`（v3.80.0 の HEAD）
- 末尾に Claude のレビュー節（旧契約テスト 7 件の書き換え・実機確認・副作用）を追記

---

# 実装報告

## 変更ファイル一覧

- `src/types/ast.ts:340`
- `src/parser/parser.ts:1872`
- `src/core/aggregateDependencyValidation.ts:288`
- `src/core/groupingValidation.ts:200`
- `src/converter/selectToKintone.ts:731`
- `src/engine/process.ts:434`
- `src/execute.ts:3667`
- `src/parser/__tests__/window.test.ts:61`
- `src/engine/__tests__/b184aWindowWithAggregate.test.ts:1`
- `docs/ksql_language_reference.md:2136`
- `docs/ksql_batch_recipes.md:597`

version・CHANGELOG・README・release・台帳・起票文書・`prod/js/desktop.js` は変更していない。git操作、ビルド、MCP tool callも未実施。

## 修正箇所 ↔ 根拠行の対応表

| 修正箇所 | 根拠 |
|---|---|
| GROUP BY / 集計との同一SELECTを拒否していた門番を撤去 | `src/parser/parser.ts:1348` |
| `PARTITION BY GROUPING(field)` を表せる型と解析を追加 | `src/types/ast.ts:340`、`src/parser/parser.ts:1872` |
| `ORDER BY SUM(売上)` を集計合成名と元の `AggregateRef` に正規化 | `src/parser/parser.ts:3771` |
| `SUM(SUM(売上)) OVER` と `LAG(SUM(売上)) OVER` の内側集計を実体化参照へ正規化 | `src/parser/parser.ts:1907`、`src/parser/parser.ts:2712` |
| ウィンドウ引数・PARTITION BY・ORDER BYを既存の非グループ依存検証へ接続 | `src/core/aggregateDependencyValidation.ts:288` |
| ROLLUP / GROUPING SETSでウィンドウ内の`GROUPING()`をmembership検証へ接続 | `src/core/groupingValidation.ts:200` |
| ウィンドウ内集計の物理引数だけを取得フィールドへ追加し、集計別名・合成名を取得列にしない | `src/converter/selectToKintone.ts:731`、`src/converter/selectToKintone.ts:793` |
| B187の`materializeAggregateDependencies`をウィンドウ依存にも適用 | `src/engine/process.ts:516`、`src/engine/process.ts:619`、`src/engine/process.ts:744` |
| HAVING後のグループ行から、集計別名・集計合成名・`GROUPING()`をウィンドウ評価 | `src/engine/process.ts:1365`、`src/engine/process.ts:1540` |
| 集計式直書きのORDER BYに数値等の比較semanticsを付与 | `src/execute.ts:8526` |
| 同一SELECTの全PLAIN GROUP BYキーがORDER BYに含まれる場合、入力グループ行を一意と判定 | `src/execute.ts:3667` |
| `GROUP_BY` / `AGGREGATE`と`WINDOW_ORDER` / `AGGREGATE_WINDOW`の既存併記を回帰テスト化 | `src/engine/__tests__/b184aWindowWithAggregate.test.ts:159` |

## 追加・変更したテストと結果

追加したテスト:

- 1段版と2段版の行・値・列順・`warnings`一致
- `9 / 10`、`99 / 100`、`9,050,000 / 20,700,000`と同額2社の数値順位
- 集計別名、集計式直書き、グループキー、SELECT外の`COUNT(*)`
- HAVING後の順位・累計
- `LAG(SUM(...))`
- 未グループ化フィールドと曖昧な別名の既存診断
- ROLLUPと`GROUPING()`のPARTITION BY / ORDER BY
- 既定RANGE警告の発生・抑止
- complete-input理由と取得列
- DISTINCT・LIMIT・ウィンドウ別名ORDER BY
- 言語リファレンス掲載例

変更したテスト:

- `src/parser/__tests__/window.test.ts`の同一SELECT拒否を受理へ変更
- 集計式と`GROUPING()`のASTを追加確認
- B129の式内ウィンドウ診断テストは変更なしで通過

結果:

- 対象テスト: **54 passed / 0 failed**
- `npm run docs:check`: **通過**（リンク3969件、台帳13行）
- `npm test`: **6578 passed / 7 failed**
- Test Suites: **302 passed / 4 failed / 306 total**
- Snapshots: **27 passed**

失敗した既存テスト:

- `src/__tests__/b94CountTotalCount.test.ts`: 1件
- `src/core/__tests__/b65GroupingStaticValidation.test.ts`: 2件
- `src/__tests__/b148BareColumnGroupBy.test.ts`: 1件
- `src/parser/__tests__/b65GroupingSets.test.ts`: 3件

いずれも「集計とウィンドウの同一SELECT」または「GROUPING SETSとウィンドウ」を拒否する旧契約を固定しており、B184-Aで意味が変わるテストである。依頼書§1.3の停止条件に従い、これらの期待値は変更せず停止した。

## 文書の差分

### 言語リファレンス追記・改訂全文

> v3.81.0 から、`GROUP BY` / 集計と同じ SELECT にウィンドウ関数を書ける。ウィンドウから参照できるのは、グループキー、同じ SELECT の集計の別名、集計式、`GROUPING()`。評価順は `GROUP BY` → `HAVING` → ウィンドウ

> v3.81.0 から、`GROUP BY` / 集計と同じ SELECT にウィンドウ関数を書けます。ウィンドウが参照できるのはグループキー・集計の別名・集計式・`GROUPING()` です。評価は `GROUP BY` → `HAVING` → ウィンドウの順なので、`HAVING` で除外されたグループは順位や累計に入りません。

```sql
SELECT 会社名, SUM(売上) AS 売上合計,
       RANK() OVER (ORDER BY SUM(売上) DESC) AS 順位
FROM APP100
GROUP BY 会社名
ORDER BY 順位, 会社名
```

> ウィンドウの結果を同じ SELECT の式の中で使う形は未対応です。割り算、`ROUND`、`CASE` などでウィンドウ結果を使う場合は段を分けます。次の3段の書き方は、集計・ウィンドウ・最終計算を段ごとに確かめたいときにも使えます。

### バッチレシピR15追記全文

> v3.81.0 から、集計とウィンドウは同じ SELECT に書けるため、`base` と `ranked` は1段にまとめられます。ウィンドウ結果を使う比率計算は引き続き次の段に置きます。

既存の3段SQLは、段ごとに確認する書き方として残した。

### バッチレシピR16改訂全文

> 月次集約の直前行を `LAG` で参照し、前月比を出します。v3.81.0 から月次集約と前月列は同じ SELECT に書けます。ウィンドウ結果を同じSELECTの式に含める形は未対応なので、比率計算だけを次の段に分けます。

```sql
WITH 前月付き AS (
  SELECT DATE_FORMAT(日付, '%Y-%m') AS 年月,
         SUM(個数) AS 出庫数,
         LAG(SUM(個数)) OVER (ORDER BY DATE_FORMAT(日付, '%Y-%m')) AS 前月
  FROM APP4228
  WHERE 入出庫区分 = '出庫'
  GROUP BY 年月
)
SELECT 年月, 出庫数, 前月,
       CASE WHEN 前月 = '' THEN ''
            ELSE ROUND((出庫数 - 前月) * 100.0 / 前月, 1) END AS 前月比
FROM 前月付き
ORDER BY 年月
```

> `ORDER BY 年月` が重複し得る粒度なら、元の集約キーをすべて追加します。同一 SELECT では全グループキーの組を `ORDER BY` に含めると入力グループ行を一意と判定します。CTE / 一時テーブルへ分ける従来形では一意性を静的に証明できず、実際には一意でも警告が残ることがあります。

## §4の5項目

1. 参照解決

   - グループキー: `validateAggregateDependencies()`がウィンドウのPARTITION BY / ORDER BY / 引数を既存group identityと照合する。
   - 集計別名: 既存`aliasesByName`と`resolveProjectedName`で一意なSELECT別名へ解決し、エンジンでは`materializedSelectValues.byLookupKey`から読む。
   - 集計式: パーサで`aggregateSyntheticName()`へ正規化し、`AggregateRef`を保持する。`materializeAggregateDependencies()`がグループ単位で値を作る。
   - `GROUPING(field)`: 専用`GroupingRef`として解析し、B65 planningでcanonical IDを束縛し、`evalGroupingRef()`でmembership sidecarを評価する。
   - 未グループ化参照は既存`NON_GROUPED_DEPENDENCY_REASON`を使用し、新しいエラー文は追加していない。

2. SELECTにない集計

   - B187と同じ`materializeAggregateDependencies()`を流用した。
   - 値は`WeakMap`の`byLookupKey`だけへ保存され、SELECT列の`byColumn`、公開行キー、`columns`へ追加されない。
   - `COUNT(*)`をウィンドウORDER BYだけで使うテストで、出力列に`COUNT(*)`がないことを確認した。

3. 既定RANGE警告

   - `sameSelectGroupOrderIsUnique()`でPLAIN GROUP BYの全キーがウィンドウORDER BYに含まれる場合だけ抑止する。
   - キーのSELECT別名も照合対象。
   - CTE / 一時テーブル経路の既存「証明できない」規則は変更しておらず、緩和は同一SELECTだけ。
   - `ORDER BY total`は警告あり、`ORDER BY total, 会社名`は警告なしを確認した。

4. B184-Bとの衝突

   - `SelectStatement.hiddenWindows`、隠しウィンドウ列、`project`、`computeOutputKeys`、column meta、CSV、DISTINCTへの非公開処理には触れていない。
   - 今回追加したのは既存の表示ウィンドウ列内にある集計依存の実体化であり、B184-Bの`hiddenWindows`別配列と並存できる。
   - B184-Bでは、今回の`materializeAggregateDependencies`接続を隠しウィンドウにも適用しつつ、`byColumn`や公開列へ渡さない必要がある。

5. プラグイン・MCP・CLI・`/flow`

   - 解析は共通Parser、評価は共通`execute` / `runFullScan` / `process.ts`、取得列は共通`selectToKintone`を通るため、ソース上は同じ結果になる。
   - CLI・MCP・flow固有の結果変換や公開型は変更していない。
   - 全体テストではCLI、MCP、flowの各スイートは今回停止原因の4スイートを除き通過した。
   - MCP tool call、プラグインビルド、配布物実行は禁止事項により未確認。
   - EXPLAINの新規行は追加していない。既存`complete input reason:`に`WINDOW_ORDER` / `AGGREGATE_WINDOW`が併記される。
   - 追加行案は「`window evaluation: after GROUP BY / HAVING`」。既存snapshotへ影響するため、このPRでは実装していない。

## Claudeが実機で確かめるべき残項目

- SFAパックで、会社別集計＋順位＋総計＋累計の1段版を実行する。
- 第3回確認用の1段版を、同額グループ、HAVING、ROLLUPを含む実データで確認する。
- MCP v3.80.0が旧門番で拒否し、新版が同じSQLを通す差分を確認する。
- プラグイン、MCP、CLI、`/flow`で行・列順・warningsが一致することを実配布物で確認する。
- 既定RANGEについて、全グループキーありでは警告なし、欠ける場合は警告ありを確認する。
- EXPLAINのcomplete-input理由に`GROUP_BY` / `AGGREGATE`と`WINDOW_ORDER` / `AGGREGATE_WINDOW`が併記されることを確認する。

## 上限内に終わらなかった項目

- 意味が変わる既存テスト4ファイル・7件の改訂。
- 改訂後の`npm test`再実行と0失敗確認。
- ビルドおよび生成物確認は禁止事項のため未実施。
- 実機・配布物・MCP比較は禁止事項およびClaude担当のため未実施。


---

## Claude レビュー（2026-09-16）

### 1. 判定

codex 版のエンジン変更はそのまま採用（修正なし）。codex は依頼書 §1.3 の停止条件どおり、旧契約を固定していたテスト 7 件で止めて報告した。7 件はいずれも「集計とウィンドウの同一 SELECT を拒否する」「GROUPING SETS とウィンドウを拒否する」旧契約の固定で、B184-A はその契約自体を変えるものなので Claude が新契約へ書き換えた:

| ファイル | 旧 | 新 |
| :--- | :--- | :--- |
| `src/__tests__/b94CountTotalCount.test.ts` | `COUNT(*)` + `ROW_NUMBER() OVER (ORDER BY 金額)` は ParseError | 未グループ化の `金額` を非グループ依存（`B65_NON_GROUPED_DEPENDENCY`）で records API 前に拒否（「API 前に拒否」の意図は不変） |
| `src/__tests__/b148BareColumnGroupBy.test.ts` | 集計 + ウィンドウは ParseError | グループキーを ORDER BY するウィンドウは評価され、2 行・順位 1/2 |
| `src/core/__tests__/b65GroupingStaticValidation.test.ts` | B65-SV03「window functions are not supported with extended grouping」 | 静的検証は拒否しない（意味の検証は依存検証側）。SV03 の 2 件を外し、受理テスト 1 本 |
| `src/parser/__tests__/b65GroupingSets.test.ts` | B65-P04 の 3 形（window ORDER / PARTITION に `GROUPING()`・window with B65）を ParseError | パーサで受理（3 本を受理側へ） |

### 2. 実機（dev profile・SFA パック・`npm run build:cli` 後の CLI）

| 形 | 結果 |
| :--- | :--- |
| 1 段版（`RANK() OVER (ORDER BY SUM(売上) DESC)`・`SUM(SUM(売上)) OVER ()`・累計 `ROWS`）と 2 段版（`WITH base AS …`） | stdout が **`diff` で完全一致**（10 行・同額 0 円 2 社が 9 位・総計 81,800,000）。`warnings` も同じ |
| `HAVING SUM(売上) >= 9000000` の後にウィンドウ | 4 行（HAVING で落ちた会社は順位に入らない） |
| SELECT に無い `COUNT(*)` をウィンドウの ORDER BY だけで使う | 通る。出力列は `会社名, 売上合計, 件数順` のみ |
| `ROLLUP` + `PARTITION BY GROUPING(商談フェーズ)` | 明細 4 行（順位 1〜4）+ 総計行（順位 1） |
| 第 2 回の `LAG(COUNT(*)) OVER (ORDER BY 年月)` 1 段版と 2 段版 | 同一 |
| 既定 `RANGE` 警告 | `ORDER BY 売上合計` だけ → 警告あり／`ORDER BY 売上合計, 会社名`（全グループキー）→ 警告なし／CTE 経由は従来どおり警告あり（緩めたのは同一 SELECT だけ） |
| EXPLAIN | `complete input reason: GROUP_BY, WINDOW_ORDER, AGGREGATE, LOCAL_ORDER`・`reason: GROUP BY あり, 集計関数あり, ウィンドウ関数あり`・`fields: 会社名, 売上`（取得列は集計段と同じ） |
| 未グループ化フィールドをウィンドウで参照 | 既存の非グループ依存エラー（文言不変） |
| 式内ウィンドウ（`ROUND(SUM(SUM(売上)) OVER () / 2, 1)`） | 従来どおり B129 の診断（B184-B の範囲） |

### 3. 副作用として確認した点（記録）

- 文レベルの `ORDER BY SUM(売上)`（ウィンドウではない）は v3.80.0 ではパーサが拒否していた（`フィールド名またはテーブル名が必要です`）。`parseOrderByKey()` が集計式を key に持てるようになった結果、修正後はパースを通り、実行時に `ORDER BY key has no canonical comparison contract (reason=ORDER_KEY_UNRESOLVED)` で止まる。**どちらも拒否**で結果は変わらないが、止まる層が実行時へ移った。文レベル `ORDER BY SUM(x)` を通すか、パーサで従来どおり止めるかは別課題候補（`ORDER BY s`（別名）は従来どおり通る）

### 4. 結果

- `npm test`（Claude 実行・テスト書き換え後の最終）: 306 suites / 6,584 tests passed、サブプロセス 2 suites / 26 passed、snapshots 27、`docs:check` 通過

### 5. 追記（2026-09-16・リリース前の再レビューで見つけた退行 1 件を修正）

言語リファレンス §10「`OVER (ORDER BY ...)` から同一 SELECT の alias は参照できません」の記述を見直す過程で、codex 版の `collectRequiredFieldsByTable` がウィンドウの ORDER BY を phase `"orderBy"`（SELECT 別名なら物理列として集めない）で歩くように変えた結果、**集計を含まない別名**（`売上 * 2 AS 倍`・`売上 AS s`・グループキーの別名 `会社名 AS c`）をウィンドウの ORDER BY で参照する形が、v3.80.0 の `unknown field code(s): 倍 (APP4149)`（fail-closed）から**空文字で静かに評価される**（全行が `RANK` 1 位）状態になっていた。実機で確認（v3.80.0 の MCP は拒否、修正前のビルドは全行 1 位・警告なし）。

修正: ウィンドウの ORDER BY で「同一 SELECT の別名」として扱うのは、ウィンドウ評価より前に実体化される**集計を含む列の別名と集計合成名**（`collectAggregateMaterializedNames`）だけにし、それ以外は従来どおり物理フィールドとして集めて B86 の存在検査で止める。テスト 4 本（算術別名・物理列別名・グループキー別名の拒否と、集計算術・CASE 別名の参照）を追加。言語リファレンス §10 の該当行を「集計を含む列の別名だけ参照できる」に書き換え。

同時に、MCP の Writing rules 5 行目（B183・「集計とウィンドウは同じ SELECT に書けない」）を B184 後の仕様「書ける。OVER の参照はグループキー・集計別名・集計式・`GROUPING()` に限る」へ更新（語数 exact `{952, 347, 605}`・上限内）。
