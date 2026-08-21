# 実装タスク指示書: kSQL エンジンへの Flow 拡張構文（dialect 1）実装

**対象リポジトリ**: kintone-sql-tools（本リポジトリ・MIT）
**発注元設計書**: `C:\Users\rex02\Projects\ksql-flow\docs\ksql_flow_design_v2_4.md`（参照できない場合も、本書は自己完結しているのでこのまま作業可能）
**担当**: Claude Code
**最終更新**: 2026-08-21

- ステータス: 📋 **B168 調査完了・実装計画提示済み・オーナーレビュー待ち**（2026-08-21）。調査結果・段階分け・リスク・要判断 10 件（Q1〜Q10）は [実装計画](internal/ksql_b168_flow_dialect1_plan.md) を参照。**Q1〜Q10 の裁定が出るまでコード変更しない**。台帳: [ksql_issue_tracker.md](ksql_issue_tracker.md)

---

## 0. 背景と全体像（まず読むこと）

kSQL は別リポジトリ `ksql-flow`（MIT）で「バッチ実行ランナー（kSQL Flow）」を開発する。役割分担は次の通りで、**本タスクはエンジン側のみ**を対象とする。

```
kintone-sql-tools（本リポジトリ）        ksql-flow（別リポジトリ・触らない）
  パーサー / validate / EXPLAIN / MCP      run / run-all / --resume / 排他ロック /
  + Flow 拡張構文（dialect 1）の           チェックポイント / ログアプリ書込 /
    解析・検証・意味論定義                 リトライ / 通知 / CLI
         ▲                                        │
         └──────── npm 依存（公式 API）───────────┘
```

設計原則: **「構文の理解はエンジン、本番実行の堅牢性はランナー」**。AI が MCP 経由で Flow SQL を生成・検証するアーキテクチャは、MCP（= 本リポジトリ）が dialect 1 を理解できてこそ成立する。そのため実装順序は「エンジン → ランナー」であり、本タスクが先行する。

### 絶対条件（違反したら作業を止めて報告）

1. **既存構文の後方互換を壊さない**。既存のクエリ・MCP ツール・テストはすべて無変更で通ること。dialect 1 は純粋な追加である。
2. **ランナーの機能をエンジンに持ち込まない**。ロック・リトライ・ログアプリ書込・設定ファイル・Exit Code はすべて ksql-flow の責務。エンジンは「解析・検証・実行計画・構造化された結果の返却」まで。
3. **大きな設計判断はコード変更前に提案する**。特にパーサーの構造変更が必要と判明した場合は、実装前に方針をまとめて報告すること。

---

## 1. 実装スコープ

### 1.1 対象（IN）

| # | 項目 | 概要 |
| --- | --- | --- |
| A | マルチステートメント解析 | `.sql` ファイル（複数文 + コメント）→ 順序付き文リストへの解析 |
| B | `-- @ksql` ヘッダメタデータ | name / depends_on / timeout / dialect の解析と API 公開 |
| C | `ASSERT` / `ASSERT WARN` | 業務アサート文（中断 / 警告続行） |
| D | `EXIT SUCCESS IF` | 正常な早期終了文 |
| E | 構文エイリアス | `CREATE TEMP TABLE ... AS` / `UPSERT ... KEY(...)` / `MERGE INTO` を既存構文の内部表現へ正規化 |
| F | 時刻関数の as-of 固定評価 | `@NOW()` 等を外部注入された基準時刻から導出 |
| G | validate 拡張 | updateKey 制約・サブテーブル DML 禁止・素の INSERT 警告 ほか |
| H | EXPLAIN 拡張 | 推定 API 消費回数（HTTP リクエスト単位）の出力 |
| I | 公式 API の切り出し | ランナーが依存する parse / validate / explain / 文実行 API の確定と semver 管理 |
| J | MCP 対応 | `ksql_validate` / `ksql_explain` / `ksql_docs` の dialect 1 対応 |

### 1.2 対象外（OUT — 実装しないこと）

ジョブオーケストレーション（depends_on の実行制御。**解析はする**が依存グラフの実行はしない）、リトライ / バックオフ、分散ロック、ログアプリへの記録、チェックポイント記録、通知、`ksql.config.json`（ランナー側設定）、Exit Code 体系、`--resume` / `--dry-run` の CLI フラグ。
※ dry-run の「差分算出ロジック」も ランナー側。エンジンは EXPLAIN（推定）まで。

---

## 2. 各構文の仕様

### 2.1 マルチステートメントスクリプト（A）

* 1 ファイル = 複数の文。文はセミコロン区切り。`--` 行コメントは文の間・文中いずれも許可。
* 解析結果は「順序付きの文リスト + ヘッダメタデータ」。文の種類: 既存の SELECT / INTO / UPSERT / INSERT / UPDATE / DELETE に加え、本書の ASSERT / EXIT / CREATE TEMP TABLE / MERGE。
* 文字列リテラル内のセミコロン・`--` を文区切りと誤認しないこと（テスト必須）。

### 2.2 `-- @ksql` ヘッダメタデータ（B）

ファイル先頭の連続するコメント行のうち、`-- @ksql key: value` 形式を解析する。

```sql
-- @ksql name: monthly_sales_sync      # 論理名。省略時は null（ランナーがファイル名で補完）
-- @ksql depends_on: job_a, job_b      # カンマ区切りの論理名リスト。解析のみ
-- @ksql timeout: 600                  # 正の整数（秒）。解析のみ
-- @ksql dialect: 1                    # 省略時は 0（= 既存 kSQL 互換モード）
```

* 未知のキーは**エラーにせず警告**として diagnostics に載せる（前方互換のため）。
* `dialect: 0`（または省略）のスクリプトで dialect 1 専用構文が出現したら validate エラーとする。エラーメッセージには「`-- @ksql dialect: 1` の宣言が必要」と含めること。

### 2.3 `ASSERT` / `ASSERT WARN`（C）

```
ASSERT <スカラー条件式>, '<メッセージ文字列>';
ASSERT WARN <スカラー条件式>, '<メッセージ文字列>';
```

* 条件式にはスカラーサブクエリ比較を許可する（例: `(SELECT COUNT(*) FROM LAPP_x WHERE ...) = 0`）。
* 実行時セマンティクス（エンジンが返す構造化結果として定義。プロセス終了はランナーの仕事）:
  * `ASSERT` 不成立 → 結果種別 `ASSERT_VIOLATION`（メッセージ付き）。**後続文は実行しない**。
  * `ASSERT WARN` 不成立 → 結果種別 `ASSERT_WARNING` を記録し、**続行**。
  * 成立 → `ASSERT_PASSED`。

### 2.4 `EXIT SUCCESS IF`（D）

```
EXIT SUCCESS IF <スカラー条件式>, '<メッセージ文字列>';
```

* 条件成立 → 結果種別 `EXIT_NO_DATA`（メッセージ付き）。後続文は実行せず、**正常終了扱い**。
* ASSERT との違い（異常 vs 正常な早期終了）は docs / ksql_docs に明記すること。設計上の理由: 両者を混同すると「対象 0 件」のたびに誤アラートが出て運用が形骸化するため。

### 2.5 構文エイリアス（E）— 既存構文への正規化

既存 kSQL の一時テーブル構文 `SELECT ... INTO #t` と `UPSERT ... ON DUPLICATE(key)` を正とし、以下を**同一の内部表現に正規化**する。AST 上で区別が残らないこと（= 実行系・EXPLAIN は一切変更不要になるのが理想）。

| 新エイリアス（dialect 1） | 正規化先（既存） |
| --- | --- |
| `CREATE TEMP TABLE x AS SELECT ...` | `SELECT ... INTO #x` |
| `UPSERT INTO app (cols) SELECT ... KEY (k)` | `UPSERT ... ON DUPLICATE (k)` |
| `MERGE INTO app AS t USING src AS s ON t.k = s.k WHEN MATCHED THEN UPDATE SET ... WHEN NOT MATCHED THEN INSERT (...) VALUES (...)` | 同上（UPSERT へ変換） |

MERGE の変換規則と制約:

* `ON` 句は**単一キーの等値結合のみ**許可（kintone updateKey が単一キーのため）。複数条件・非等値は validate エラー。
* `WHEN MATCHED ... UPDATE SET` の代入列と `WHEN NOT MATCHED ... INSERT` の列は、UPSERT の列リストに統合する。両句で同一列に異なる式を与えるケースは、初期実装では「両句の式が一致する場合のみ許可」とし、不一致は validate エラー（メッセージで理由を示す）。
* `WHEN NOT MATCHED` 句の省略は「更新のみ」、`WHEN MATCHED` 句の省略は「挿入のみ」として扱う（UPSERT 側にその表現がなければ、この 2 形は初期実装では未対応エラーで良い。対応可否を調査して報告すること）。

### 2.6 時刻関数の as-of 固定評価（F）

* 対象: `@NOW()` / `@TODAY()` / `@MONTH_START()` / `@NEXT_MONTH_START()` ほか、既存の現在時刻依存関数すべて（コードベースを調査して全列挙し、実装ノートに記載すること）。
* 公式 API に **基準時刻（asOf）とタイムゾーンの注入**を追加する: `execute(script, { asOf?: Date, timezone?: string })` 相当。省略時は呼び出し時点の現在時刻（既存挙動と同一 = 後方互換）。
* **同一スクリプト実行内では、すべての時刻関数が同一の asOf から導出される**こと（文ごと・評価ごとに現在時刻を取り直さない）。これが Flow の再現性（バックフィル・リラン）の土台になる。
* 日付境界の計算は注入されたタイムゾーンで行う。kintone の日時フィールドは UTC 保存であるため、比較値の生成時に変換すること（既存実装の挙動を調査し、変更が必要な場合は後方互換に注意して報告）。

### 2.7 validate 拡張（G）

既存の検証（構文・フィールド存在）に加えて:

1. **updateKey 制約**: UPSERT / MERGE のキーが「重複禁止設定済みの文字列(1行) or 数値フィールド」でない場合はエラー。スキーマ情報から重複禁止設定を取得できるか調査し、取得不能な環境では警告に格下げする。
2. **複合キー禁止**: KEY / ON 句に複数フィールド → エラー（回避策「連結キーフィールド」をメッセージで提示）。
3. **サブテーブル DML 禁止**: サブテーブル仮想テーブル（`$` 付きテーブル参照）を INSERT / UPDATE / UPSERT / DELETE / MERGE のターゲットにしたらエラー。SELECT は従来どおり許可。
4. **素の INSERT 警告**: 書き込み先アプリへの `INSERT` 文に警告を出す（「冪等性のため UPSERT / MERGE を推奨」）。`--strict` 相当のオプションでエラー化できること。
5. **dialect ゲート**: 2.2 の通り。

diagnostics は「severity（error / warning）・コード・メッセージ・位置（行・列）」を持つ構造化形式とし、公式 API・MCP の双方から同一形式で返すこと。

### 2.8 EXPLAIN 拡張（H）

* 出力に**推定 API 消費回数**を追加する。カウント単位は kintone の流量制限と同じ **HTTP リクエスト数**（`bulkRequest` は内包サブリクエスト数によらず 1 回）。参考値としてサブリクエスト数も併記。
* 読取: レコード数上限 / カーソル・オフセット戦略から推定（既存の取得戦略を調査して算式を決める）。書込: 100 件/リクエスト・2,000 件/bulkRequest の自動チャンク前提で推定。
* 件数が実行前に不明な場合は「不明（上限 N と仮定）」を明示する形式とし、数字を捏造しない。

### 2.9 公式 API の切り出し（I）

ksql-flow が依存する API を明示的な公開面として確定する（現状の export 状況を調査し、不足を追加）:

```ts
parseScript(source: string): { meta: KsqlHeaderMeta; statements: Statement[]; diagnostics: Diagnostic[] }
validateScript(source: string, schema: SchemaProvider, opts?): Diagnostic[]
explainScript(source: string, schema: SchemaProvider, opts?): ExplainResult
executeStatement(stmt: Statement, ctx: ExecutionContext): StatementResult
  // ctx: 接続・asOf・timezone・一時テーブル空間。StatementResult に 2.3/2.4 の結果種別を含む
```

* 型名・分割粒度は既存コードベースの流儀に合わせて良いが、**「ランナーが文単位で実行を制御できる」**こと（文リストを受け取り、1 文ずつ実行して結果を見て継続判断できること）が要件。スクリプト一括実行しかできない API は不可。
* この公開面は semver の対象であることを README に明記し、**エンジンバージョン × dialect 対応表**を README に追加する。

### 2.10 MCP 対応（J）

* `ksql_validate` / `ksql_explain` が dialect 1 スクリプト（複数文 + ヘッダ）を受け付けること。
* `ksql_docs` に dialect 1 の説明（ASSERT / EXIT / エイリアス / as-of / ヘッダ）を追加。**AI が Flow SQL を生成する際の一次資料になる**ため、構文例は豊富に。
* `ksql_query` / `ksql_mutate` の既存挙動は変更しない。

---

## 3. 受け入れ基準（すべて満たすこと）

1. 既存テストが全件パス（後方互換）。
2. 下記のサンプルジョブが `parseScript` で解析でき、`validateScript` が診断ゼロ（スキーマが揃っている前提のモックで）を返す:

```sql
-- @ksql name: monthly_sales_sync
-- @ksql depends_on: sync_master_customers
-- @ksql timeout: 600
-- @ksql dialect: 1
ASSERT (
  SELECT COUNT(*) FROM LAPP_受注
  WHERE 受注日 >= @MONTH_START() AND 受注日 < @NEXT_MONTH_START() AND 金額 < 0
) = 0, '【異常中断】マイナスの売上データが存在するため処理を停止しました';

CREATE TEMP TABLE temp_monthly_summary AS
SELECT 顧客コード, COUNT(レコード番号) AS 受注件数, SUM(金額) AS 当月売上合計
FROM LAPP_受注
WHERE 受注日 >= @MONTH_START() AND 受注日 < @NEXT_MONTH_START() AND ステータス = '受注完了'
GROUP BY 顧客コード;

EXIT SUCCESS IF (SELECT COUNT(*) FROM temp_monthly_summary) = 0,
  '集計対象となる受注データが 0 件のためスキップ';

UPSERT INTO LAPP_顧客マスタ (顧客コード, 当月受注件数, 当月売上実績, 最終集計日時)
SELECT 顧客コード, 受注件数, 当月売上合計, @NOW()
FROM temp_monthly_summary
KEY (顧客コード);
```

3. 同スクリプトの MERGE 版が UPSERT 版と**同一の内部表現**に正規化されることをテストで証明。
4. as-of テスト: `asOf` を注入した実行で、スクリプト内の全時刻関数が注入値から導出される（複数文にまたがっても値が一致する）。
5. validate テスト: (a) 重複禁止でないキー → エラー、(b) 複合キー → エラー、(c) `$` テーブルへの DML → エラー、(d) dialect 0 での ASSERT 使用 → エラー、(e) 素の INSERT → 警告。各エラーメッセージが原因と対処を含む。
6. 文字列リテラル内の `;` / `--` / `@ksql` を誤解釈しないパーサーテスト。
7. `ksql_validate`（MCP）に上記サンプルを渡すと構造化 diagnostics が返る。
8. README に公開 API・dialect 対応表・変更履歴が追記されている。

---

## 4. 進め方

1. **調査フェーズ**: パーサー・実行系・MCP の現行構造、時刻関数の一覧、一時テーブルと UPSERT の内部表現、スキーマ情報で updateKey 設定が取れるかを調査し、**実装計画（変更ファイル・段階分け・リスク）を先に提示**する。
2. 実装は小さい単位で: A/B（解析基盤）→ C/D（新文）→ E(エイリアス)→ F（as-of）→ G/H（validate / EXPLAIN）→ I/J（API / MCP）。各段階でテストを追加してから次へ。
3. 无関係なリファクタリング・フォーマット変更はしない。
4. 判断に迷う仕様（特に 2.5 の MERGE 片側省略、2.6 の既存タイムゾーン挙動、2.7-1 の重複禁止設定の取得可否）は、**推奨案を添えて質問として報告**し、勝手に確定しない。

## 5. 完了報告に含めること

変更ファイル一覧と各段の要約、公開 API の最終シグネチャ、追加した診断コードの一覧、時刻関数の全列挙と as-of 対応状況、未解決の質問（あれば）、`ksql_docs` に追加した dialect 1 ドキュメントの抜粋。
