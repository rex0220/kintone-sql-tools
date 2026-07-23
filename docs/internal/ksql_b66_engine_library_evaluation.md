# B66 — kSQL エンジンのライブラリ公開（他プラグインからの利用）評価

- 起票日: 2026-07-23
- ステータス: **📝【A: 評価】起票**（仕様前・優先度未確定）
- 種別: 改善（新機能・配布/アーキテクチャ）
- 効果種別: 機能
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B66
- 関連: B49（read-only メタデータ API の allowlist 思想）／B44・APPLY（DML guard・確認コールバック）／B7（プラグイン raw fetch）

## 1. 提案

kSQL の実行エンジンを、**他の kintone プラグイン／カスタマイズから import して使えるライブラリ**として公開する。想定ユースケース:

- **ダッシュボード系プラグインのデータ取得**＝ SELECT（JOIN・集計・CTE・window・KLIKE 等）を1文で書いて結果を得る（read-only）。
- **ジョブフロー系プラグインの実行エンジン**＝ INSERT/UPDATE/UPSERT/DELETE/APPLY を、CHECK・`ON ERROR SKIP` 隔離・guard 付きで実行（DML）。

## 2. 現状アーキテクチャ（再利用性は設計段階で担保済み）

エンジンは transport から分離されており、実体は純粋な1関数である。

```ts
execute(sql: string, client: KintoneClient, options: ExecuteOptions): Promise<ExecuteResult>
```

- **`KintoneClient`**（`src/execute.ts:194`）＝ getRecords / openCursor / postRecords / putRecords / deleteRecords / getApps / getFields / getNumberPrecision / getProcessStatuses を抽象化したインターフェース。エンジンは REST の実体を知らない。
- 既存の実装アダプタが2種:
  - **ブラウザ用 `src/ui/kintoneClient.ts`** ＝ `kintone.api()` を `KintoneClient` に変換するアダプタ。`kintone.api` は全プラグイン/カスタマイズ共通なので、**他プラグインの JS からそのまま流用できる部品**。
  - **Node 用 `src/cli/nodeKintoneClient.ts`**。
- 両ユースケースは同じ `execute()` を通る。DML 用途に必要な確認コールバック・`dmlMaxRows`/`dmlMaxSubtableRows`・`ON ERROR SKIP` 隔離・request gate は既に `ExecuteOptions` に存在する。

**＝エンジン側の作り替えはほぼ不要**。他プラグインは自分の `kintone.api` を渡すだけでフル機能を呼べる。不足しているのは「配布・公開 API」の梱包側である。

## 3. 足りないもの（機能ではなく梱包）

| 論点 | 現状 | 必要な整備 |
|---|---|---|
| ライブラリ配布 | `package.json` は `dist-cli`/`dist-mcp`/`dist-mcpb` と bin のみ・`exports`/`main`/型定義なし | `import` 用の**エントリ＋ESM/UMD エンジンバンドル（ui アダプタ同梱）＋ `.d.ts`** |
| 公開 API 契約 | `execute()`/型は内部実装（版間で変わり得る） | **安定した小さな public 面**（例 `createKintoneClient()` / `runQuery()` / `runMutation()`）＋ semver 契約・非公開内部との境界 |
| 安全既定 | guard は面ごとに設定 | 消費側（特に DML するジョブフロー）向けの**安全既定＋設定注入**（read-only 強制オプション・guard 既定の明示） |
| バンドルサイズ/依存 | エンジンは docs/カタログ等も含み得る | ライブラリ target で不要部分（MCP instructions・言語リファレンス埋め込み等）を除外し軽量化 |

## 4. 配布形態の現実（重要）

kintone プラグインは ZIP バンドルで**相互にランタイム共有できない**（プラグイン A がプラグイン B のエンジンを実行時に呼ぶことはできない）。したがって現実的な「ライブラリ利用」は次のいずれか:

- **ビルド時 npm 依存（本命）**＝ 相手プラグイン/カスタマイズの開発者が `@rex0220/kintone-sql-tools` の engine を import して**各自バンドル**する。プラグインごとにエンジンのコピーを持つ。
- **UMD グローバル**＝ `window.ksql` を customize JS で `<script>` 読み込みし使う（プラグイン開発でなくカスタマイズ用途）。

＝「実行時共有サービス」ではなく「**各プラグインが取り込む共通ライブラリ**」。この前提を公開 API・ドキュメントで明示する。

## 5. 安全性（DML 用途の勘所）

- **read-only（ダッシュボード）と DML（ジョブフロー）で API を明確に分離**する。read-only entry は書込み API を物理的に呼べないようにする（B49 の read-only 強制思想）。
- DML entry は確認コールバック・guard 上限・`ON ERROR SKIP` 隔離を**必須の設定**として受け取り、既定を安全側（明示 opt-in で書込み）にする。
- 消費側プラグインのバグで大量 mutation が走らないよう、`dmlMaxRows` 等の既定と、検索打ち切り（B7）検出の fail-closed をライブラリでも維持する。

## 6. 段階スコープ（案）

- **Phase1（read-only）**＝ `runQuery(sql, {client, maxRecords, ...})` を公開 API として切り出し、SELECT/WITH/UNION/SHOW/DESCRIBE と EXPLAIN を対象。ダッシュボード用途を満たす。書込み API は含めない。ESM/UMD ビルド＋`.d.ts`＋最小サンプル。
- **Phase2（DML）**＝ `runMutation(sql, {client, confirm, guards, onError, ...})` を追加。ジョブフロー用途。確認/guard/隔離を必須引数化。
- **Phase3（任意）**＝ メタデータ API（B49 相当の read-only reader）や保存クエリ連携など。

## 7. 論点・要判断

1. **公開 API の粒度**＝ 薄い `execute()` 直出しか、`runQuery`/`runMutation` の目的別ラッパーか（後者を推奨＝安全既定と型を用途別に固定できる）。
2. **配布物**＝ npm の `exports` サブパス（例 `@rex0220/kintone-sql-tools/engine`）＋ UMD の二本立てか、npm のみか。
3. **semver 契約の範囲**＝ どの型/関数を公開面として凍結するか（内部の execute.ts 型を全公開すると版間変更が破壊的になる）。
4. **カタログ/docs の同梱可否**＝ ライブラリ target からは MCP instructions・言語リファレンス埋め込みを外し軽量化するか。
5. **サポート境界**＝ 消費側が独自 `KintoneClient` を渡すケース（ゲストスペース・特殊 route）をどこまで契約に含めるか。
6. **実需の所在**＝ 自社のダッシュボード/ジョブフロー実装が具体的にあるか、汎用公開が目的か。

## 8. 工数見積り（概算・R1 前の粗見積り）

- Phase1（read-only ライブラリ）＝ 公開 API 切り出し＋ESM/UMD ビルド target＋`.d.ts`＋サンプル＋smoke。**3〜6 人日**（エンジン改変は最小・梱包中心）。
- Phase2（DML）＝ `runMutation` 公開＋安全既定＋確認/guard/隔離の必須化＋DML smoke。**3〜5 人日**。
- 合計目安 **6〜11 人日**（新エンジン新設ではなく、既存 `execute()` の公開・梱包が主体）。

## 9. 次アクション

1. **実需確認**＝ ダッシュボード/ジョブフローの具体的な利用計画があるか（Phase1 read-only 先行で足りるか）。
2. 方向確定なら **Phase1 仕様 R1**（公開 API 面・`exports`/UMD ビルド・型凍結範囲・read-only 強制・サンプル・非回帰＝既存 plugin/CLI/MCP ビルド不変）を起草。
3. 配布形態（npm サブパス／UMD）とバージョニング方針を確定。
