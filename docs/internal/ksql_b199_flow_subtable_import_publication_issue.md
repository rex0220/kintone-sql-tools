# B199 `/flow` のサブテーブル IMPORT の公開 — `supportsImportConfirmDetail` + `importDetail`

- 状態: 📝 **保留（2026-10-28）＝依頼元が要求を取り下げ、他の依頼元に実需が無いため出さない。仕様は下に残す**（2026-10-27 に 📋 仕様確定で起票 → 翌日に保留）
- 種別: 機能（公開 API の純加法追加）
- 優先: — （保留）
- 上流の依頼（正）: kintone-plugin の work-link `ksql-action-engine-ask-subtable.md`（依頼 KJ-5 の 5a-B）。回答は同じ場所の `kSQLエンジンからの回答-20261027-KJ5-サブテーブルの書き込み.md` §4
- 取り下げ: 同じ場所の `kSQLエンジンへの依頼-20261027-KJ6-APPEND_SELECT.md` §7（依頼元が受入基準を取り下げ）→ 保留の判断は `kSQLエンジンからの回答-20261028-KJ6-APPEND_SELECT.md` §7
- 関連: [B198](ksql_b198_flow_apply_mutation_publication_issue.md)（公開の骨組みを共有）、[B200](ksql_b200_apply_append_values_issue.md)（2 が B199 の代わりに選ばれた道）

## 1. 保留の理由（2026-10-28）

1. **唯一の依頼元（kSQL アクション）が取り下げた。** 依頼元は「設定は SQL・プラグインは値を運ばない・許可する文は固定表で fail-closed」を設計の柱にしており、IMPORT の道は**許可文の表をトップレベル SELECT と IMPORT の 2 種類ぶんゆるめる**ことになる。代わりに B200-2（`APPEND … SELECT`）を選んだ。
2. **他の依頼元の実需が無い。** `ksql-flow` / `ksql` / `ksql-flownet` の文書を機械検索して `importDetail`・`supportsImportConfirmDetail`・サブテーブル IMPORT の要求は **0 件**（ksql-flow からの依頼は 2026-08 の F-7 が最後）。
3. **公開オプションは引っ込められない。** 使う人がいない型（`FlowImportConfirmDetail` の JSON / CSV の union）を固定したくない。
4. B198 の `routeConfirm` は**詳細の振り分けを 1 か所にまとめて書いた**ので（v3.88.0 の `routeConfirmDetail`）、後から足す費用は小さい（KJ-6 の回答 §7）。

**再開条件**: どの面でも「サブテーブルを含む IMPORT を `confirm` 付きで使いたい」依頼元が出たとき。

## 2. 仕様（保留中。出すときはこの形）

1. `CreateExecutionContextOptions` に **`supportsImportConfirmDetail?: boolean`**（省略・`false` は今と同じ）。
2. **`confirm` と `IMPORT` の併用禁止（`src/flow-library/index.ts:161`）を、`supportsImportConfirmDetail: true` のときだけ解く。** 渡さなければ今までどおり `ArgumentError`。
3. `FlowDmlConfirmContext` に **`importDetail?: FlowImportConfirmDetail`**（内部 `ImportConfirmDetail` の公開版。JSON 形と CSV 形の union をそのまま写す）。
4. 「サブテーブルを含む IMPORT の mutation は `confirm` 必須」（`src/execute.ts:10379`）は**そのまま**（`supportsImportConfirmDetail` だけでは書けない）。

### 受入基準（出すとき）

1. JSON ネストの `IMPORT … ON DUPLICATE` が `/flow` で書ける（parse・validate は診断 0 を実測済み）。
2. `confirm` の `count` が書く親レコード数・`importDetail` が計画と一致（`operation` は `ON DUPLICATE` ありで UPDATE・なしで INSERT）。
3. 偽なら書込 0 回・`OperationCancelledError`。
4. `supportsImportConfirmDetail` を渡さなければ今までどおり。
5. `IMPORT` を含まないスクリプトは不変。

- **規模 M**（公開する型が union で 2 種類・CSV のサブテーブル置換も同じフラグで開く・併用禁止の解除が条件つき分岐）。実行経路の変更は無い。
- 文の位置と `signal` は管理層の包み（`src/execute.ts:2161-2173`）が本当の値で上書きするので心配ない（`executeImport` の中の `statementIndex: 0, statementCount: 1` は上書きされる）。
