# B169 `CURRENT_DATE()` / `CURRENT_TIMESTAMP()` が式評価のたびに時計を読み直す

- ステータス: ✅ **v3.67.0 リリース済み・publish 済み・実機確認済み**（2026-08-21・PR #363 マージ・タグ/GitHub Release/npm publish 完了。**実機確認**＝常駐 MCP 3.67.0（`ksql_docs` 索引先頭で版を確認）で `GENERATE_SERIES` 10,000 行の射影を `SELECT DISTINCT CURRENT_TIMESTAMP()` で潰すと **1 行**（全行同値・文開始時刻）、同一バッチの第 2 文は **51ms 後の別 instant**＝文単位確定も仕様どおり。[B168 実装計画](ksql_b168_flow_dialect1_plan.md) Q10 から分離しオーナー裁定で先行対応。codex 実装・Claude レビュー＋フルゲート通過＝jest 264 suites/6,103 件・e2e 26/26・docs:check・version:check:release。実装＝Symbol キーで `ExecuteOptions` に評価コンテキストを内部束縛し文実行入口で instant を 1 回確定、評価器間は明示引数で貫通・未注入時は従来フォールバック。新規テスト [b169CurrentDatetimeDrift.test.ts](../../src/__tests__/b169CurrentDatetimeDrift.test.ts) 5 件＝受入 1〜5 を fake timers の中間時計進行で固定）
- 種別: 課題（正しさ） ／ 優先: 中
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md)

## 1. 現象（B168 調査で発見・実測）

`CURRENT_DATE()` / `CURRENT_TIMESTAMP()`（`src/engine/evalFunc.ts:466-474`）は関数本体が呼び出しごとに `new Date()` を読む。呼び出しは式評価のたびに起きるため:

- `SELECT 顧客名, CURRENT_TIMESTAMP() AS 取得日時 FROM APP100` は**行ごとに異なるミリ秒**を返す。
- `WHERE 作成日 = CURRENT_DATE()` は**行ごとに時計を読み直す**ため、深夜 0 時を跨ぐスキャンでは前半と後半で「今日」が変わり、結果が非決定になる。
- DML の値評価（`dmlToKintone.ts` 経由・レコードごと）でも同様。

評価位置（射影・WHERE・GROUP BY キー・ORDER BY キー・DML 値）により回数は異なるが、いずれも同一文内で複数回時計を読む。メモ化は無い。

## 2. なぜ問題か

- 同一文の中で「現在」が動くのは利用者の期待（1 つのクエリは 1 つの時点を見る）に反する。SQL 標準・主要 RDB も `CURRENT_TIMESTAMP` は**文単位で固定**が通例。
- 文書契約とは矛盾しない: 言語リファレンスは「今日の日付を JS で取得」「実行環境のローカルタイムゾーンで評価」（`docs/ksql_language_reference.md:652-653, 1104`）とだけ約束しており、評価ごとの再読取を保証した記述・テストは無い（B168 調査で確認済み）。
- **B168（Flow dialect 1）の as-of 固定評価の土台になる**: 本件を先に直すと dialect 0/1 でクロック意味論が分岐せず、B168 Stage 4 は「固定済みクロックを外部注入可能にする」だけになる。

## 3. 修正方針

- **文の実行開始時に 1 回だけ時計を読み、同一文内の `CURRENT_DATE()` / `CURRENT_TIMESTAMP()` はすべてその値から導出する**（文単位固定）。
- TZ の扱いは現状維持（`CURRENT_DATE()` はホストローカル・`CURRENT_TIMESTAMP()` は UTC ISO）。値の形式も不変。
- `SET @x = NOW()` / `DECLARE`（既に文単位で 1 回評価）は挙動不変。WHERE 素通しの server-only 関数（`TODAY()` 等）は対象外（kintone サーバー評価のまま）。
- 実装は「文実行の入口（単文 `executeParsedStatement` / バッチ `executeBatchStatement`）で取得した instant を評価器へ引き回す」形を基本とし、`evalStringFunc` の call site が広いため**最小波及の受け渡し方法（明示引数 vs 評価コンテキスト）は実装時に提案・報告する**。グローバル可変状態は避ける。

## 4. 受入条件

1. 同一文内の `CURRENT_TIMESTAMP()` が全行・全評価位置（射影・WHERE・GROUP BY・ORDER BY・DML 値）で同値。
2. 複数文バッチでは**文ごとに**時刻が確定する（文 1 と文 2 で異なってよい）。
3. fake timers で文実行中に時計を進めても結果が変わらない（深夜跨ぎの再現テスト）。
4. `SET @x = NOW()` / `DECLARE` / server-only 関数（`TODAY()` 等）の既存挙動・既存テストは全件不変。
5. 値の形式（`YYYY-MM-DD` / ISO 8601 ミリ秒付き）不変。
6. CHANGELOG に挙動変更（評価ごと → 文単位固定）を明記。

## 5. B168 との関係

- B168 Stage 4（as-of 注入）は本件のクロック配線を前提に載る。**本件 → B168 の順で実施**。
- B168 側の Q10 は本件の分離により解消（dialect ゲートでクロック意味論を分岐させる必要がなくなった）。
