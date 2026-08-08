結論: **出荷不可。Critical はありませんが、Major 1件を検出しました。**  
コード変更・git 操作・MCP 実行・テスト実行はしていません。以下は静的検査結果です。

## 指摘

### Major — CTE 内にある CROSS JOIN が CLI dry-run の API 0 経路へ入らない

- 箇所: `src/cli/index.ts:1047`
- 関連: `src/cli/index.ts:2034`、`src/core/explainMetadata.ts:127`、`src/execute.ts:10161`
- テストの穴: `src/cli/__tests__/b158_dry_run.e2e.test.ts:43`

根拠:

`hasStaticTypedPushdownCandidate()` の WITH 分岐は、CROSS JOIN を `WITH` の最終 `query` にだけ探しています。

```ts
return (containsCross(query) && hasPhysicalCte)
  || hasStaticTypedPushdownCandidate(query);
```

CTE 定義群 `node["ctes"]` の中は再帰探索していません。

したがって §12 R17 のように、

```text
格子 CTE内: d CROSS JOIN 製品マスタ
最終query: FROM 0埋め
```

となる SQLでは `dryRunUsesStaticTypedPlan=false` です。一方、APP4228/APP4229 を読む物理 CTE があるため `explainNeedsAppMetadata=true` となり、CLI は API 拒否クライアントではなく実クライアントを選択します。その後、EXPLAIN の CTE 列推論が `getFieldsCached()` を呼びます。

つまり §12 の必須条件である「CLI `--dry-run` は全 API 0 回」を満たしません。単文・複文とも同じ問題になります。現在の B158 CLI テストは CROSS JOIN が最終 query にある簡略形しか検査していないため、この経路を捕捉できません。

修正案:

- CROSS JOIN 検出を WITH の全 CTE、最終 query、UNION、ネストされた SELECT へ再帰させる。
- B157 の metadata 解決をバッチ全体で誤って無効化しないよう、可能なら文単位で静的/API 必要性を決める。
- §12 の R17 SQLそのものを使い、単文・複文の CLI dry-run について fields/status/process/settings/records API がすべて 0 回であるテストを追加する。
- 診断ブロックと計画本体の表示一致も同じテストで固定する。

### Low — B158 の状態文書が現在の実装状態と矛盾

- `docs/ksql_issue_tracker.md:45` は「実装 Go 待ち」
- `docs/internal/ksql_b158_cross_join_grid_issue.md:4` は「仕様 R1 待ち」

実装・テスト・言語リファレンス・MCP syntax catalog は既に存在するため、現状と一致しません。

修正案: Claude 側の実測完了後、tracker・issue status・CHANGELOG・release historyを同じ状態へ同期する。

## 観点別結論

| 観点 | 結論 | 根拠 |
|---|---|---|
| ガード位置 | **PASS** | `process.ts:226` で計画・拒否後に、結果配列を `process.ts:233` で作成。nested loop はその後 |
| 多段 CROSS | **PASS** | `process.ts:2115` で JOIN ごとに `applyJoin()`。各段の中間行数で再判定 |
| サブテーブル展開後行数 | **PASS** | `execute.ts:5749` で展開後、FULL_SCAN JOINへ渡す |
| DML mutation 前停止 | **PASS（構造上）** | SELECT source の `runFullScan()` 内で超過。mutation 0 のテストも `b158CrossJoinAcceptance.test.ts:182` に存在 |
| narrowing | **PASS** | 報告された6経路すべてに `CROSS`/`INNER` gateあり。`join.on` に対する production code の `as any`、optional chaining、`on!` はなし |
| JOIN key prefilter 分離 | **PASS** | runtime は `execute.ts:5917`、EXPLAIN は `execute.ts:10324` で INNER のみ |
| 完全入力 | **PASS** | `dmlGuard.ts:181` で CROSS のみ `CROSS_JOIN`。truncate は `execute.ts:3395` で無効化 |
| 通常 JOIN truncate | **PASS（構造上）** | INNER/LEFT/RIGHT に B158 固有 reason は追加されない |
| EXPLAIN exact/runtime | **PASS** | 物理 APP は `execute.ts:10088` で exact 不明。`maxRecords` を実件数として使用していない |
| CLI dry-run API 0 | **FAIL** | CTE 内 CROSS の再帰検出漏れ。Major 指摘参照 |
| INNER/LEFT/RIGHT 非回帰 | **静的には指摘なし** | discriminated union と各 narrowing は妥当。fresh test結果は未確認 |
| §11.1〜11.6 | **概ね実装済み** | 基本、空、境界、多段、prefilter、APP×APP、subtable、DML のテストあり。ただし subtable 5,001×2 の逐語テストはない |
| §12 R17 | **engine 経路は実装済み、CLI契約は未達** | 730行・0埋め・累計・DATE/number metadata のテストあり。CLI R17 dry-run が未検査かつ上記不具合あり |

## Claude の実測が必要なもの

- 修正後の §12 R17 CLI dry-run単文・複文における全 API 0 回
- B157/B161 の既存 dry-run表示と、B158を含む混在バッチの診断・計画一致
- §11.4 の実 records API serializer、revision、取得件数、prefilter有効/無効比較
- APP×APP、subtable 5,001×2、maxRecords の実 kintone 経路
- R17 の8製品・2,920行、無取引日の0、製品別最終残高一致、全metadata
- MCP EXPLAIN、Firefox/Chrome実機smoke
- `npm test`、build、CLI build、既存 JOIN/B149〜B157回帰
- tracker・issue・CHANGELOG・release history・version/manifest同期

なお、制約面では開始直後に `MEMORY.md` への読み取り専用検索を誤って1回実行しました。該当情報はなく、判断には使用していません。ファイル書き込み、コード変更、git、MCP は行っていません。