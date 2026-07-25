# B69 評価 — engine ライブラリ `QueryColumn` 列メタ公開（fieldType / sortKind / sourceApp）

- 作成日: 2026-07-25
- ステータス: **📝 評価・引き継ぎ受領（2026-07-25）**。ksql-dashboard-pro 側の Claude セッションが実装ドラフト（後方互換）を起草し、B67 と同一 working tree に未コミットで残していたものを本リポジトリへ引き継いだ。**ドラフトは WIP ブランチ [`feat/b69-query-column-metadata`](https://github.com/rex0220/kintone-sql-tools/tree/feat/b69-query-column-metadata) へ退避（gate 未通過・columnMeta.test.ts 4件 failing）**。採用/修正/破棄は本 B69 のレビューで判断する。**次＝方向確認→（採用なら）本リポジトリの review-driven フロー〔eval→仕様 R1→Claude レビュー→R2→実装計画→Step 実装〕で進める**。
- 起草ブリーフ（Pro 側引き継ぎ原文）: [HANDOFF-column-meta-v3.22.md](HANDOFF-column-meta-v3.22.md)
- 依頼元: ksql-dashboard-pro Phase 1（`c:\Users\rex02\Projects\ksql-dashboard-pro\docs\plans\M1-1エンジン改修見積.md`）
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B69
- 関連: B66 engine ライブラリ（v3.19.0・[spec](ksql_b66_engine_library_phase1_spec.md)／[利用ガイド](../ksql_engine_library.md)）／B68（read-only 拡張）

## 1. 目的

B66 engine ライブラリ `runQuery()` の `QueryResult.columns`（`QueryColumn`）に、列メタを**後方互換の追加**として公開する。Pro 側の用途＝型別ソート比較器・表示フォーマット自動初期化・`$id` からのレコード遷移。

```ts
interface QueryColumn {
  name: string;
  valueType: "string";      // 既存・維持
  fieldType?: string;       // 元 kintone フィールド型 or 導出型（NUMBER / DROP_DOWN / KSQL_NUMBER 等）
  sortKind?: "number" | "string";
  sourceApp?: number;       // 単純フィールド参照列（$id 等システム列含む）のみ
}
```

追加フィールドはすべて optional かつ primitive（string / enum / number）で、公開面へ内部型を漏らさない（B66 の型隔離契約と両立）。

## 2. ドラフトの実装方針（WIP ブランチ）

既存の `inferSelectColumnMeta` / `MaterializedColumnMeta`（CTE/一時テーブル用の列メタ推論）をトップレベル SELECT へ開放する方式。

| ファイル | 変更 |
|---|---|
| `src/execute.ts` | `ExecuteOptions.captureColumnMeta?`（既定 false）追加・SELECT/UNION/WITH へ伝搬／`getSelectColumnMeta()` 公開・`MaterializedColumnMetaMap` export／`systemColumnMetaWithSource()` 新設（`$id` に sourceApp 付与） |
| `src/engine-library/publicTypes.ts` | `QueryColumn` に 3 フィールド追加 |
| `src/engine-library/query.ts` | `captureColumnMeta: true` を execute へ付与・`toPublicColumn()` でマップ |
| `src/engine-library/__tests__/columnMeta.test.ts` | 新規4件（**現状すべて failing**） |

## 3. 未解決点（レビュー・調査対象）

引き継ぎ原文 §3 の所見を要調査項目として引く（エンジンの意味論は本リポジトリ側の判断を正とする）。

1. **単純 SELECT で列メタが空** — `selectNeedsSourceColumnMeta` ゲートで physicalInfos が未取得。無条件取得の可否・ゲート本来の意図を確認。
2. **DATE_FORMAT 導出列の sortKind 未定義** — `stringFunctionColumnMeta` の返す形の仕様確認。テスト期待値はエンジン意味論へ合わせる。
3. **COUNT(*) 列のメタ形** — 期待 `KSQL_NUMBER` との差分。実際の形を確認。
4. **テスト4は設計ミス** — 未定義フィールド SELECT が `validateSelectFieldCodes` で正しく拒否。テスト修正。

## 4. 本リポジトリの「作法」との差分（引き継ぎ時レビュー・要是正）

引き継ぎドラフトを review-driven 化するにあたり、次を是正・確認する。

1. **doc 命名/登録**: 原文は `HANDOFF-column-meta-v3.22.md`（`ksql_bNN_*` 命名でなく台帳未登録・ステータス行なし）→ 本 eval を SSOT とし台帳へ B69 登録。原文はブリーフとして保持。
2. **版数の先出し**: 原文は `v3.22.0` を doc 名・チェックリスト・作業前提に固定。**版数はリリース時に確定**する作法のため、eval 段階では「次 minor（TBD）」とし固定しない。
3. **review-driven の順序**: 原文は eval/仕様/レビューを経ず実装（かつテスト赤）へ直行。採用時は eval→仕様 R1→Claude レビュー→R2→実装計画→Step 実装の順で進める（実装は codex・git は Claude）。
4. **B66 の公開面 drift guard**: engine 公開型の変更は `engine:bundle-guard` / `engine:declaration-smoke` 等の drift guard 同期が必要か要確認（原文チェックリストは guard 実行に触れるが公開型カウント/宣言の期待更新まで明示せず）。**公開面変更は guard を必ず同期**する（B55/B60 のカタログ drift guard と同じ作法）。
5. **engine core 改変**: B66 は「engine 本体無改変（packaging のみ）」が作法だったが、本改修は `execute.ts`（`inferSelectColumnMeta`/`executeUnion`/`ExecuteOptions`）を改変する。よって packaging-only レビューでなく **engine core 変更としてフル gate**（全 npm test・snapshot・build・engine guard 群）が必要。既存 CTE/一時テーブルのメタ推論・`fieldSemanticsEqual` 判定への非回帰を重点確認（§5 リスク）。
6. **cross-repo 結合をスコープに入れない**: 原文の DoD 末尾「npm pack → Pro の `vendor/` へ tgz 引き渡し・Pro package.json 更新」は Pro 側タスク。kSQL 側 B69 の完了定義は **engine 改修＋通常リリース（npm publish）まで**とし、Pro の vendoring/consumption は結合しない。
7. **working tree/commit 衛生**: gate 未通過コードは main に入れない・dirty working tree を残さない作法に従い、ドラフトは WIP ブランチへ退避済み。`.claude/settings.local.json` はコミット対象外（原文ドラフトは同ファイルも変更していたため除外した）。

## 5. リスクノート（原文 §5 由来）

- `systemColumnMetaWithSource` は CTE/一時テーブルの実体化メタにも source を付与するため、異なるアプリ由来の `$id` 列を同名一時テーブルへ append するケースで `fieldSemanticsEqual` 不一致になり得る。既存テストで検出できるはず。問題化するなら「トップレベル呼び出し時のみ source 付与」へスコープ縮小。
- 公開型の変更は追加のみ（既存 consumer 非破壊）を維持。

## 6. スコープ外

- 変数バインド（`:VAR`）＝ Pro Phase 2 で別途。
- AbortSignal ＝ engine 改修不要（Pro 側 BYO client 対応）。

## 7. 次アクション

1. **方向確認**（本改修を採用するか・優先度）。
2. 採用なら Phase1 仕様 R1 起草（公開型契約・列メタ導出規則〔§3 の意味論確定〕・drift guard 同期・engine core 非回帰の受入）。
3. 実装は WIP ブランチを起点に review-driven で仕上げ（4 failing test の解消・全 gate・docs〔`ksql_engine_library.md`〕・次 minor で release）。
