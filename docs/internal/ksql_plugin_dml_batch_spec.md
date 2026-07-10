# kSQL プラグイン DML バッチ対応 仕様案

- 作成日: 2026-07-10
- 更新履歴:
  - 2026-07-10 R5(実機検証で発覚した UX 改善): kintone API エラーの詳細表示。`kintone.api()` の reject(`{code, message, errors}` のプレーンオブジェクト)はバッチ実行だと `BatchStatementError` が code / message しか運ばず「[2] 入力内容が正しくありません。」だけになる(単文は renderError の既存分岐で詳細表示できていた)。プラグイン client 層に `toDetailedApiError` を追加し、フィールド単位の `errors` 詳細を改行区切りで message に畳み込む(CLI の nodeKintoneClient が response body 全文を message に入れるのと同方針)+ `renderError` が Error message の改行を行として展開。エラー name に kintone コード(CB_VA01 等)を設定し `BatchStatementError.code` にも通る。テスト4本追加
  - 2026-07-10 R4(レビュー3巡目反映): DML を含む実行では `onLimitReached` を **"error" に固定**(§3.6)。UI 設定が truncate だと SELECT-based DML のソース読み取りが黙って切り捨てられ、切り捨て後の件数で confirm → 部分書き込みになるため(バッチ・単文とも修正)。裏取りで指摘の範囲を精緻化: 危険経路は **SELECT-based DML のソース SELECT のみ**(`options.onLimitReached` を継承)。UPDATE/DELETE の対象取得(`resolveDmlTargetIds`)・UPSERT 照合・サブテーブル親読み取りは `onLimit` を渡さず常に "error" で影響なし。「CLI/MCP は error 固定」は **MCP のみ正**(`DEFAULT_ON_LIMIT` 固定)— **CLI は `--on-limit truncate` が DML にもそのまま渡る同種の潜在問題があり、本仕様の範囲外の別課題**として §6 に記録。コアの truncate 挙動は回帰テストで固定
  - 2026-07-10 R3(実装完了): コア(`DmlConfirmContext` + `executeBatch` の文ごと confirm ラップ)・プラグイン(ガード削除 / 実行前 INSERT VALUES 確認 / 実行時確認 / キャンセル表示 / DML サマリ / 単文 INSERT VALUES 併修)・テスト4本を実装。全 624 テストパス。実装中の判明事項: ①`ksql_batch_temp_table_spec.md` §9 にプラグイン拒否エラーの行は元々存在せず、§8.4 の記述更新のみで足りた(§5 の記載を訂正)。②ソース 0 行の SELECT-based DML はコアが「SELECT の列数(0)と ... が一致しません」で先にエラーになる(0 行では列が導出されないため)。0 件 UPSERT の confirm スキップ経路は実機ではほぼ到達しない — §7 の検証項目から除外し、コンテキスト整合は INSERT VALUES 混在のユニットテストで担保
  - 2026-07-10 R2(レビュー2巡目・実装着手): 残課題「単文 `INSERT INTO ... VALUES` の確認ダイアログ併修」を**本リリースに含める**と決定（バッチだけ塞ぐと単文の穴が残り仕様説明がねじれるため。同じ静的 `insertValuesCount` 確認で閉じられスコープ増は小）。`DmlConfirmContext.targetAppId` の型を `number | null` に修正（`StatementAnalysis.targetAppId` に整合）
  - 2026-07-10 R1(レビュー反映): ①confirm フックの文コンテキスト注入を「プラグイン側クロージャ」から**コア optional 第3引数（正式スコープ）**に変更（confirm 呼び出し回数と文番号の対応がクロージャでは崩れるため — `INSERT VALUES` は confirm 非経由・`UPSERT` 系は 0 件時スキップ）。②`INSERT VALUES` が confirm を通らずに書き込まれる穴を明記し、プラグイン側の**実行前静的確認**で塞ぐ方針を採用（コア側で confirm 対象化する案は MCP の `staticInsertTotal` 二重計上・CLI の挙動変更を伴うため不採用）。③`runBatchSql` の返却契約変更（DML サマリ）を実装対象に明記。④未決事項 1〜3 を決定に変更
- ステータス: **実装・実機検証完了（v1.9.0）**
- 対象バージョン: v1.9.0
- 関連資料:
  - [ksql_batch_temp_table_spec.md](../ksql_batch_temp_table_spec.md) §8.4（現行のプラグイン read-only 制限）・§8.3（CLI の DML バッチ確認）・§10（制限事項）
  - [ksql_batch_temp_table_implementation_plan.md](ksql_batch_temp_table_implementation_plan.md)（フェーズ1・2 の実装経緯）

---

## 1. 背景と目的

プラグイン UI のバッチ実行は v1.4.0（仕様 §8.4）で **read-only バッチのみ**に限定された。DML を含むバッチは次のエラーで拒否される。

```
ArgumentError: プラグインのバッチ実行は read-only 文のみ対応しています
（DML を含むバッチは CLI / MCP を使用してください）。
```

このため、以下のような「一時テーブルで対象を絞り込み → UPSERT → 結果確認」という典型フローがプラグインでは実行できない（CLI / MCP では v1.7.0 時点で全文実行可能）。

```sql
CREATE TEMP TABLE #targets AS SELECT 会社名, $id AS 顧客No FROM APP4148 WHERE 顧客ランク IN ('A') LIMIT 2;
UPSERT INTO APP4149 (案件名, 顧客No_) SELECT 会社名, 顧客No FROM #targets ON DUPLICATE (案件名);
SELECT 案件名, 顧客No_ FROM APP4149 WHERE 顧客No_ <> '' ORDER BY 顧客No_
```

本仕様は、プラグインのバッチ実行で DML を受理できるようにする。

### §8.4 の割り切りが成立しなくなった理由

v1.4.0 時点の §8.4 は「DML バッチの確認 UI はプラグインには持たせない」を根拠に read-only 限定とした。しかし現状は:

1. **プラグインは単文 DML を既にサポート**しており、確認 UI（`confirmDialog` — 確定件数付きダイアログ）も既に存在する（`src/ui/desktop.ts`）
2. コアの `executeBatch`（`src/execute.ts`）は CLI / MCP 向けに **DML バッチをサポート済み**で、`options.confirm` フックが DML 文の書き込み直前に確定件数付きで呼ばれる（UPSERT_SELECT は照合後の insert + update 合計、INSERT_SELECT はソース読み取り後の件数）
3. したがって「確認 UI を新規に持たせる」必要はなく、単文 DML と同じ確認機構をバッチに流すことで対応できる

### コア confirm フックの実態（前提となる制約）

設計判断の前提として、`options.confirm` の呼び出し実態は文タイプにより異なる（レビュー R1 で確定）。

| 文タイプ | confirm 呼び出し |
|---|---|
| UPDATE / DELETE / INSERT_SELECT / UPSERT / UPSERT_SELECT / REORDER 等 | 書き込み直前に確定件数付きで呼ぶ |
| UPSERT / UPSERT_SELECT で対象 0 件 | **呼ばない**（`(toInsert + toUpdate) > 0` ガード） |
| `INSERT INTO ... VALUES` | **呼ばない**（`executeInsert` は confirm を通さず POST。CLI / MCP は `insertValuesCount` の**静的ガード**で件数制限しており、確認プロンプトも confirm フック非経由） |

この2点から:

- **confirm 呼び出し回数と DML 文番号の対応付けはフック外の状態追跡（クロージャ）では成立しない** → 文コンテキストはコアが confirm に直接渡す（§3.2）
- **`INSERT VALUES` はコアの confirm に頼れない** → プラグインが実行前に静的件数で確認する（§3.3）。コア側で `executeInsert` に confirm を追加する案は、MCP `ksql_mutate` が INSERT VALUES を `staticInsertTotal` として**静的に計上済み**のため実行時加算と二重計上になること、CLI の既存挙動（静的ガードのみ・プロンプトなし）が変わることから**不採用**

---

## 2. 採用案と代替案

### 採用: 案A — 文ごと確認ダイアログ方式

`runBatchSql` の `containsDml` ガードを削除し、`executeBatch` に単文 DML と同じ `confirm` フック（`confirmDialog` ベース）を渡す。バッチ内の各 DML 文の書き込み直前に、確定件数付きの確認ダイアログが1文ごとに表示される。文番号・書き込み先の表示のため、コアの confirm フックに **optional の文コンテキスト第3引数**を追加する（§3.2。CLI / MCP は後方互換で無影響）。

| 観点 | 評価 |
|---|---|
| 変更規模 | 小（desktop.ts + execute.ts の confirm コンテキスト追加 + ドキュメント） |
| UX 一貫性 | 単文 DML と同一の確認体験 |
| 安全性 | **確定件数を見てから承認 / キャンセル**できる（CLI の事前一覧確認より実データに近い）。件数上限設定（dmlMaxRows 相当）はプラグインの単文 DML 同様、導入しない — 人間が件数を見て止める設計 |
| 短所 | DML が複数あるとダイアログが複数回出る（バッチ上限 20 文・実用上 DML は 1〜3 文のため許容） |

### 不採用の代替案

| 案 | 内容 | 不採用理由 |
|---|---|---|
| 案B: バッチ全体で1回の事前確認（CLI §8.3 方式） | 実行前に全 DML 文の一覧（タイプ / 対象アプリ / WHERE 有無）を1ダイアログで確認し、実行中は件数ガードのみ | 事前確認では**件数が分からない**ため `dmlMaxRows` 相当の上限設定が必須になり、プラグイン設定画面への項目追加とセットで変更範囲が広い。単文 DML が件数確認だけで運用できている以上、バッチだけ別方式にする一貫性上の理由が薄い |
| 案C: B + A のハイブリッド（事前一覧 → 文ごと件数確認） | 二段確認 | 最も安全だが確認が二重になり煩雑。監査的な要件が出た場合の発展形として温存 |
| コアで `INSERT VALUES` を confirm 対象化 | `executeInsert` に confirm 呼び出しを追加 | MCP の `dmlTotalMaxRows` 集計（静的計上 + 実行時加算）が二重計上になる。CLI の INSERT VALUES 挙動（静的ガードのみ）も変わる。プラグイン側の静的確認（§3.3）で同等の安全性を達成できる |

---

## 3. 仕様

### 3.1 受理範囲

- プラグインのバッチ実行（複文入力）は **DML を含むバッチを受理**する。§8.4 の read-only 限定を撤廃
- 受理できる文の種類・一時テーブルの制約はコア（`executeBatch`）に準拠し、プラグイン独自の追加制限は設けない
  - DML 内の一時テーブル参照は SELECT-based DML（`INSERT_SELECT` / `UPSERT_SELECT`）のみ可、`UPDATE` のサブクエリ等は不可 — コアの事前チェックがそのまま効く（v1.7.0 仕様）
  - `INSERT INTO ... VALUES` を含むバッチも受理する（確認は §3.3 の実行前静的確認）
  - `continueOnError` はプラグインから渡さない（従来どおり fail-fast 固定。コアも DML バッチでは拒否）

### 3.2 確認ダイアログと confirm フックの文コンテキスト（コア小変更）

`ExecuteOptions.confirm` に optional の第3引数を追加する。

```ts
export interface DmlConfirmContext {
  /** バッチ内の文 index（0 始まり）。単文実行では 0 */
  statementIndex: number;
  /** バッチの総文数。単文実行では 1 */
  statementCount: number;
  /** DML 文タイプ（"UPDATE" / "UPSERT_SELECT" 等。operation より細粒度） */
  statementType: string;
  /** 書き込み先アプリ ID（`StatementAnalysis.targetAppId` を転記。DML では実質非 null） */
  targetAppId: number | null;
}

confirm?: (
  count: number,
  operation: "UPDATE" | "DELETE" | "INSERT",
  context?: DmlConfirmContext
) => Promise<boolean>;
```

- **実装方式**: `executeBatch` が文ごとに `options.confirm` をラップし、その文のコンテキストを束縛して下位の実行関数へ渡す（`{...options, confirm: (c, op) => userConfirm(c, op, context)}`）。各 `execute*` 関数の confirm 呼び出し箇所は変更しない
- **後方互換**: 第3引数は optional。CLI / MCP の既存 confirm 実装（2引数）は無変更で動作する
- 単文実行経路でもコンテキストを渡せる場合は渡す（`statementIndex: 0` / `statementCount: 1`）が、必須ではない（プラグインの単文表示は現行のまま）

プラグインのダイアログ表示（バッチ中）:

```
[2/3] UPSERT INTO APP4149
2 件のレコードを登録/更新します。よろしいですか？
この操作は元に戻せません。
```

- 操作ラベルは単文と同じ（UPDATE=更新 / DELETE=削除 / INSERT=登録。UPSERT は confirm 上 UPDATE として通知される現行仕様のまま。表示の細粒度化が必要なら `context.statementType` を使う）
- UPSERT / UPSERT_SELECT で対象 0 件の文は confirm が呼ばれない（書き込みも発生しない）。ダイアログなしで次の文へ進むのは仕様どおり

### 3.3 INSERT VALUES の実行前静的確認（プラグイン側）

`INSERT INTO ... VALUES` はコアの confirm を通らない（§1 前提）。プラグインは `analyzeBatch` が文ごとに返す `insertValuesCount`（静的に確定する正確な行数）を使い、**バッチ実行開始前**に該当文ごとの確認ダイアログを表示する。

```
[2/3] INSERT INTO APP4149
2 件のレコードを登録します。よろしいですか？
この操作は元に戻せません。
```

- キャンセルした場合はバッチを実行しない（1文も実行しない。実行前確認のため「前半反映済み」は発生しない）
- 実行時確認（§3.2）と異なり書き込み「直前」ではないが、INSERT VALUES の件数は静的に正確であり確認情報としての差はない
- **単文 `INSERT INTO ... VALUES` の併修（R2 で決定・スコープ内）**: プラグインの**単文** INSERT VALUES は現状ダイアログなしで書き込まれる（confirm 非経由のため。desktop.ts の確認ダイアログのコメントにも UPDATE / DELETE / INSERT_SELECT のみ記載）。同じ静的確認機構（`insertValuesCount`）で単文にも実行前ダイアログを表示する。バッチだけ塞ぐと単文の穴が残り仕様説明がねじれるため、本リリースに含める。単文の表示は文番号なし（`INSERT INTO APP4149` + 件数行）

### 3.4 キャンセル時の挙動と表示

- 実行時確認（§3.2）でキャンセルすると、その文は `OperationCancelledError` となり、コアの仕様どおり **status = error + 後続文は skipped（fail-fast）** になる
- プラグインは `BatchStatementError.code === "OperationCancelledError"` を判別し、生エラー表示（`[2] OperationCancelled...`）ではなく単文と同様のキャンセル表示にする:

```
キャンセルしました（文 [2/3] で中断。[1] までの実行結果は反映済みです）
```

- **トランザクションは無い**（仕様 §10）。キャンセル・途中失敗時に前半の文（一時テーブル作成は無害だが、先行 DML があればその書き込み）が反映済みであることを表示で明示する

### 3.5 結果表示

- 従来どおり**最後に結果セットを返した文（通常は最終 SELECT）のみをテーブル表示**する（§8.4 の表示契約は維持）
- DML を含むバッチでは、結果テーブルの上（または結果セットなしの場合の note）に **DML サマリ行**を追加する:

```
バッチ 3 文を実行しました。[2] UPSERT: inserted=1 updated=1
```

- サマリは **success した DML 文のみ**を `[index] タイプ: 影響件数` で列挙する（`ExecuteResult` の mutation 系結果から取得）。キャンセル・エラー・skipped は専用表示（§3.4・`[N]` エラー形式）があるためサマリに含めない
- **実装契約の変更**: 現行の `runBatchSql` は `{ result: SelectResult | null; note: string | null }` を返すだけで、結果テーブルにメタ情報を挿す経路がない。返却型を `{ result; note; dmlSummary: string[] }` に拡張し、`runSql` 側で `renderResult` の出力の前に summary HTML を合成する
- 最終文が結果セットを返さない場合の「バッチ N 文を実行しました（結果セットなし）」は維持し、DML サマリを併記する

### 3.6 EXPLAIN・履歴・その他

- **EXPLAIN ボタン / 先頭文 EXPLAIN のバッチ**: 現行どおり全文プラン表示のみ（実行しない）。`buildBatchExplainPlans` は DML 込みバッチのプラン生成に既に対応しており変更不要
- **履歴**: 現行どおり（成功・エラーとも保存。確認キャンセル時は保存しない）
- **maxRecords**: 現行の実行時設定をそのまま `executeBatch` に渡す。一時テーブル実体化上限（10,000 行・常に error）はコア既定のまま
- **onLimitReached（R4）**: **DML を含む実行（バッチ・単文とも）では UI 設定に関わらず "error" に固定**する。truncate だと SELECT-based DML のソース SELECT（`options.onLimitReached` を継承する唯一の DML 読み取り経路）が黙って切り捨てられ、切り捨て後の件数で confirm → 部分書き込みになるため。MCP `ksql_mutate` の `DEFAULT_ON_LIMIT = "error"` 固定と同じ扱い。read-only 実行（バッチ・単文とも）は従来どおり UI 設定に従う
  - 参考: UPDATE / DELETE の対象取得（`resolveDmlTargetIds`）・UPSERT の照合読み取り・サブテーブル DML の親読み取りは `onLimit` を渡さず常に "error"（`fetchAll` 既定）のため、この固定の実質的な保護対象は SELECT-based DML のみ

---

## 4. エラー仕様

| 状況 | 変更 |
|---|---|
| DML を含むバッチをプラグインで実行 | `ArgumentError: プラグインのバッチ実行は read-only 文のみ...` を**廃止**（正常実行に変わる） |
| バッチ内 DML の確認キャンセル（実行時） | §3.4 のキャンセル表示（エラー扱いにしない） |
| INSERT VALUES の実行前確認キャンセル | バッチ全体を実行せず「キャンセルしました」表示 |
| 実行時エラー（fail-fast） | 現行どおり `[N] メッセージ` 形式。変更なし |
| UPDATE 等での一時テーブル参照 | コアの `ArgumentError: temp table references in UPDATE are not supported yet.` がそのまま表示される。変更なし |

---

## 5. 変更対象

| 区分 | 内容 |
|---|---|
| `src/execute.ts` | `DmlConfirmContext` 型と `confirm` の optional 第3引数を追加。`executeBatch` で文ごとに confirm をラップしてコンテキストを注入（各 `execute*` の confirm 呼び出し箇所は無変更）。**後方互換**: CLI / MCP の2引数 confirm は無変更で動作 |
| `src/ui/desktop.ts` | `runBatchSql`: ①`containsDml` ガード削除、②実行前の INSERT VALUES 静的確認（`analyzeBatch` の `insertValuesCount`）、③文コンテキスト付き confirm ラッパーを `executeBatch` に渡す、④`OperationCancelledError` の判別とキャンセル表示、⑤返却型を `dmlSummary: string[]` 付きに拡張し `runSql` で summary HTML を合成、⑥単文 INSERT VALUES の実行前静的確認（R2） |
| `src/core/__tests__` / `src/__tests__` | confirm コンテキスト注入のユニットテスト（バッチ内で confirm に正しい statementIndex / targetAppId が渡ること。0 件 UPSERT・INSERT VALUES 混在で番号がずれないこと） |
| `docs/ksql_batch_temp_table_spec.md` | §8.4 改訂（read-only 限定の撤廃・確認 / キャンセル / サマリ表示の追記・旧制限の注記）。§9 にプラグイン拒否エラーの行は元々なく変更不要（R3 訂正） |
| `docs/internal/ksql_v1.4.0_plugin_verification_sql.md` | 該当ケース（DML バッチ拒否の期待値）を新仕様に更新、実機検証 SQL を追加（§1 の例がそのまま検証ケース） |
| 公開ドキュメント | プラグイン利用ガイドの「DML バッチは CLI / MCP を使用」記述の更新 |

CLI・MCP は**変更なし**（confirm 第3引数は optional のため既存実装に影響しない）。

---

## 6. 決定事項と残課題

レビュー1巡目（R1）での決定:

1. **confirm フックへの文情報**: コアの optional 第3引数（`DmlConfirmContext`）を**採用**。プラグイン側クロージャでの追跡は、confirm 非経由の文（INSERT VALUES）・0 件スキップ（UPSERT 系）で対応付けが崩れるため不採用
2. **DML サマリの粒度**: **success した DML のみ**。キャンセル・エラーは専用表示があるため重複させない
3. **オプトイン設定**: 今回は**設けない**。入れるなら単文 DML も含む別仕様（DML 全体の有効 / 無効設定）として切り出す

レビュー2巡目（R2）での決定:

4. **単文 `INSERT INTO ... VALUES` の確認ダイアログ併修**: **本リリースに含める**（§3.3）。バッチだけ塞ぐと単文の穴が残り仕様説明がねじれる。同じ静的 `insertValuesCount` 確認で閉じられるためスコープ増は小さい

レビュー3巡目（R4）での決定:

5. **DML 実行時の `onLimitReached` は "error" 固定**（§3.6。バッチ・単文とも）

別課題（本仕様の範囲外・起案済み）:

- **CLI の DML × `--on-limit truncate`**: CLI は単文・バッチとも `onLimitReached` にユーザー設定（`--on-limit` / `KSQL_ON_LIMIT` / profile）をそのまま渡しており、truncate 指定時は SELECT-based DML のソースが黙って切り捨てられる同種の問題がある（MCP は `DEFAULT_ON_LIMIT = "error"` 固定で安全）。**`ksql_cli_dml_on_limit_truncate_issue.md` に別課題として起案済み**（対策案 A〜C・推奨は「DML では error 強制 + stderr 注記」）

---

## 7. リリース

- コア（`src/execute.ts`）に後方互換の型拡張が入るが、外部挙動の変更はプラグインのみ。プラグイン zip の再ビルド・リリースが主。npm publish は CLI / MCP の挙動不変のため必須ではない（コード同梱の都合で行う場合はパッチバージョン）
- 実機検証: §1 の例（CREATE TEMP → UPSERT_SELECT → SELECT）、UPDATE / DELETE / INSERT VALUES 混在バッチ（確認番号の整合）、キャンセル（実行前 / 実行時の両方。先行 DML 反映済みの表示確認）、単文 INSERT VALUES の確認ダイアログ、EXPLAIN ボタン、結果セットなし終端（DROP TEMP TABLE 終わり）。検証 SQL は `ksql_v1.4.0_plugin_verification_sql.md` E-4a〜d に追加済み
  - 注: 0 件 UPSERT の confirm スキップはソース 0 行時にコアが列数エラーで先に止まるため実機ではほぼ到達しない（R3。番号整合はユニットテストで担保）
