# B185 実装報告（codex・2026-09-16）

- 依頼: [ksql_b185_codex_impl_request.md](ksql_b185_codex_impl_request.md)（案 A・EXPLAIN の preflight で実行側と同じ列検査）
- 起票: [ksql_b185_explain_select_column_existence_issue.md](ksql_b185_explain_select_column_existence_issue.md)
- 作業ブランチ: `b188/dev`（B188・B186 コミットの上）
- 末尾に Claude のレビュー節（取りこぼしの修正 1 点・実機確認）を追記

---

## 変更ファイル一覧

- `src/execute.ts:5105`
- `src/__tests__/b185ExplainSelectColumnExistence.test.ts:1`
- `docs/ksql_language_reference.md:3831`

## 修正箇所 ↔ 根拠行の対応表

| 修正箇所 | 根拠 |
|---|---|
| `validateB86SelectFieldCodes` にキャッシュ済み物理定義だけを使うモードを追加 | `src/execute.ts:5105`。実行経路の既定値は従来どおり取得あり、EXPLAIN のみ `cachedPhysicalFieldsOnly=true` |
| キャッシュ未取得 APP を非 authoritative として保持し、API を追加しない | `src/execute.ts:5173`。`getFieldsIfCached` のみ使用 |
| EXPLAIN の名前束縛直後に実行側と同じ列存在検査を追加 | `src/execute.ts:12572`。既存 plan 行の生成前に例外化 |
| deferred relation を schema-unavailable として検査保留 | `src/execute.ts:5114`。実行側の「materialized source unavailable」は変更なし |
| 再帰 CTE の宣言列と CYCLE マーク列を自己参照 preflight 前に登録 | `src/execute.ts:12532` |
| B185 の受入テストを追加 | `src/__tests__/b185ExplainSelectColumnExistence.test.ts:56` |
| EXPLAIN の検査範囲を §24 に追記 | `docs/ksql_language_reference.md:3831` |

## 追加・変更したテストと結果

追加した B185 テスト:

- 実践例で EXPLAIN と execute のエラー全文が一致
- SELECT 列、別名付き列、集計引数、CASE 条件／結果、文字列関数引数、GROUP BY、ORDER BY、window PARTITION BY／ORDER BY
- JOIN 左右の alias 修飾列
- フォーム定義を読まない `COUNT(*)`／単純 SELECT が API 呼び出しを増やさない
- `defs=[]` の非 authoritative escape hatch
- CTE の B86 文言維持
- UNION、サブクエリ、`GENERATE_SERIES`、`SHOW APPS`、`DESCRIBE`
- 0 行一時表、再帰／deferred relation、B186 の物理 APP＋CTE 混在
- 正常な EXPLAIN の出力外形維持

結果:

- B185 専用: `19 passed / 0 failed`
- API 回数固定 6 スイート: `193 passed / 0 failed`
- `npm run docs:check`: `[docs-check] ok（リンク 3958 件 / 台帳 18 行）`
- 最終 `npm test`:
  - `Test Suites: 303 passed, 303 total`
  - `Tests: 6540 passed, 6540 total`
  - `Snapshots: 23 passed, 23 total`
  - 逐次 E2E: `Test Suites: 2 passed, 2 total`
  - 逐次 E2E: `Tests: 26 passed, 26 total`
  - 失敗数: `0`

## 文書の差分

追記全文:

> `EXPLAIN` は SELECT・GROUP BY・集計引数・CASE・関数引数・ORDER BY・ウィンドウの列名も、フォーム定義と突き合わせます。存在しない列は実行時と同じ `ArgumentError: unknown field code(s): <列> (<source label>)` で失敗します（v3.79.0〜）。対象は、WHERE の型付き述語・ORDER BY・GROUP BY など、`EXPLAIN` が計画作成のためにフォーム定義を読む文です。`SELECT COUNT(*) FROM APP100` や、フォーム定義を必要としない単純な SELECT 列だけの文ではフォーム定義の取得を増やさず、存在しない列は従来どおり実行時に検出します。

## §4 の確認結果

1. **(a) を選択**

   追加 API がなく、既存 EXPLAIN 行と snapshot を変更しないためです。

   フォーム定義を読む主な文型:

   - 型情報が必要な WHERE: `src/execute.ts:3513`、EXPLAIN 側判定は `src/execute.ts:12634`
   - GROUP BY／GROUPING SETS: `src/execute.ts:4126`、`src/execute.ts:4408`
   - ORDER BY／window ORDER BY: `src/execute.ts:8400`、EXPLAIN 呼び出しは `src/execute.ts:12731`
   - CTE の出力 schema 推定: `src/execute.ts:12454`
   - 物理 JOIN key の prefilter 計画: `src/execute.ts:12661`

   読まない文型は、GROUP BY・ORDER BY・型付き WHERE・物理 JOIN metadata を必要としない単純 SELECT、GROUP BY なしの `COUNT(*)`、schema 不要の `$id` 条件です。

2. **EXPLAIN relation の誤検出**

   - UNION は左右を個別に preflight
   - SELECT／WHERE／HAVING のサブクエリも再帰検査
   - `GENERATE_SERIES`、`SHOW APPS`、`DESCRIBE` は推定済み列を検査
   - 0 行でも `columns` があれば authoritative
   - `rows=[] && columns=[]` の deferred relation は検査保留
   - 再帰 CTE は宣言列と CYCLE 列を自己参照検査前に登録

   専用テストと既存 B53／B162／B163 テストで通過を確認しました。

3. **B186 との相互作用**

   `src/execute.ts:12574` で `bindProjectedNamesForSelectWithSchemas` を先に実行してから存在検査します。キャッシュ未取得の物理 APP は非 authoritative のまま残るため、未修飾名が CTE 列へ解決できる場合に物理側の不存在として落ちません。B186 スイートおよび専用混在テストが通過しています。

4. **各 surface が同じ結果になる根拠**

   - MCP `ksql_explain`: 単文は共通 `execute(EXPLAIN ...)`、複文は `buildBatchExplainPlans`。`src/mcp/tools.ts:709`
   - CLI `--dry-run`: 同じ2経路。`src/cli/index.ts:2582`、`src/cli/index.ts:2781`
   - プラグイン EXPLAIN: `buildBatchExplainPlans`。`src/ui/batchExplain.ts:5`
   - `/flow` `explainScript`: `buildBatchExplainPlans`。`src/flow-library/index.ts:83`

   いずれも最終的に `src/execute.ts:12357` の共通 EXPLAIN 解析へ到達します。

## Claude が実機で確かめるべき残項目

- SFA パック実アプリで、存在しない `売上金額` が EXPLAIN と実行で同じ全文になること
- MCP v3.78.0 では通過し、更新版では同じ SQL が EXPLAIN 時点で失敗する差分
- Qiita「kSQL 実践」第9回 §4 の SQL そのもの
- ビルド済みプラグイン、CLI、MCP、`/flow` の配布物上での surface 横断確認

## 上限内に終わらなかった項目

なし。禁止事項に従い、git 操作、ビルド、MCP tool call、台帳・起票文書・release/version 関連の変更は実施していません。


---

## Claude レビュー（2026-09-16）

### 1. 修正 1 点: 検査の時点が早すぎて、型付き WHERE・ORDER BY・GROUP BY の文で取りこぼしていた

codex 版は (a)「キャッシュ済みのフォーム定義だけで検査」を選び、検査を**名前束縛の直後**に置いた。ところが EXPLAIN がフォーム定義を読むのは、その後の型付き WHERE の解析・ORDER BY の意味型・GROUP BY 計画の段階なので、束縛直後にはキャッシュが空のまま。相対日付（`THIS_YEAR()`）だけは計画の前段（`resolveRelativeDateExecutionPlan`）で読むため通り、codex のテストは全形が `WHERE 受注予定日 = THIS_YEAR()` を含んでいたので気づけなかった。

実機（CLI 再ビルド版・dev）で確認した取りこぼし: `SELECT 売上金額 FROM APP4149 ORDER BY 売上`・`… WHERE 商談フェーズ = '受注' GROUP BY …`・`… WHERE 商談フェーズ = '受注'` はいずれも `metadata API: form definition APP4149@dev` を出しながら EXPLAIN が通っていた。

修正: 束縛直後の早期検査は残し（CTE・一時表の列と、既にキャッシュにある物理 APP を見る）、**計画作成の最後**（`buildExplainWhereAnalysis` の return 直前）に、記録しておいた全 SELECT をキャッシュ済み定義だけでもう一度検査する。追加 API は無し。テストに「型付き WHERE だけ／型付き WHERE + GROUP BY／ORDER BY だけ／GROUP BY だけ」の 4 形を足し、`getFields` が 1 回（EXPLAIN が計画のために読んだ分）のままであることを固定。API 回数を固定する 6 スイートは変更なしで通過。

### 2. 実機（dev profile・SFA パック・修正後）

| 文型 | EXPLAIN |
| :--- | :--- |
| 第 9 回 §4 の SQL（`THIS_YEAR()` + GROUP BY + `SUM(売上金額)`） | `ArgumentError: unknown field code(s): 売上金額 (APP4149)`＝実行と同じ文言 |
| `SELECT 売上金額 … ORDER BY 売上` | 同上（修正前は通っていた） |
| `… WHERE 商談フェーズ = '受注' GROUP BY …` | 同上（修正前は通っていた） |
| `… WHERE 商談フェーズ = '受注'` | 同上（修正前は通っていた） |
| `SELECT 売上金額 FROM APP4149 LIMIT 1`（定義を読まない） | 通る（従来どおり実行で検出・文書 §24 のとおり） |
| 存在する列だけの文・B186 の混在 CTE | 通る（出力行不変） |

### 2.1 既存テストの修正 1 件（意味は変わらない）

計画作成の最後の再検査で `src/__tests__/explain.test.ts` の「EXPLAIN INSERT SELECT — SELECT 部分のプランも表示」が `unknown field code(s): 案件名 (APP88)` で落ちた。テストの SQL が mock のフォーム定義に無い `案件名` を source SELECT に使っており、実行なら従来から同じエラーになる形（EXPLAIN だけが通していた）。検査意図はプラン形状なので、列を定義に実在する `件名` に差し替えた（意図不変・コメントで経緯を残した）。

### 3. 据え置き

- EXPLAIN の `fields:` 行に未修飾の CTE 列が物理 FROM の取得列として並ぶ表示（B186 で据え置き）は今回も変えていない。直すと既存の計画行が変わるため、B184 の EXPLAIN 面の改修と合わせて判断する

### 4. 結果

- `npm test`（Claude 実行・修正後の最終）: 303 suites / 6,544 tests passed、サブプロセス 2 suites / 26 passed、snapshots 23、`docs:check` 通過
