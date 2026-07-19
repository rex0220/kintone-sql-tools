# kSQL IMPORT と cli-kintone `record import` の比較評価

- 作成日: 2026-07-19
- ステータス: **比較評価 R2**（R1→codex レビュー反映）。B39 IMPORT の位置づけ（cli-kintone との棲み分け）。
- 分担: Claude=評価・Codex=レビュー（R1 に対し P1×4／P2×5 指摘・全反映）
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B39
- 対象: kSQL [IMPORT v1 R4](ksql_import_statement_spec.md)（フラット CSV・**設計済み・未実装**）＋[IMPORT v2 R1](ksql_import_v2_spec.md)（JSON・サブテーブル・**設計段階**）／[cli-kintone `record import`](https://cli.kintone.dev/)（公式・GA）

## 0. 前提（実装状態）

**kSQL IMPORT は未実装。** 本文書の kSQL 列は「**仕様どおり実装された場合**の能力」であり、現時点の利用可能機能ではない（v1 R4＝実装着手可の設計・v2＝設計 R1）。cli-kintone は GA。→ 「使うべき」は**実装後に適する用途**の意味。

## 1. 目的

cli-kintone は kintone 公式（サイボウズ）の CSV 入出力 CLI で、**取込の実績・成熟度は圧倒的**。kSQL の IMPORT が「cli-kintone の劣化再実装」でないことを明確にし、**どちらをいつ使うか**を確定する。

## 2. 機能比較表

| 軸 | cli-kintone `record import`（GA） | kSQL IMPORT（v1 R4=未実装／v2 R1=設計） |
|---|---|---|
| ソース形式 | **CSV のみ**（JSON 入力なし） | **CSV**（v1）＋**JSON**（v2a・ネストで subtable 自然表現） |
| フィールド対応 | CSV ヘッダ＝**フィールドコード名**で対応 | `INTO` への**位置対応**＋任意の `SELECT` 射影 |
| **ユーザー定義変換** | **なし**（型固有の CSV 解釈はある・下記） | **`SELECT` 射影**（`CAST`・文字列/数値関数・`\|\|`・`@var`） |
| 型固有の CSV 解釈 | あり（複数値 LF 分割・ユーザーコード・添付パス・テーブル組立） | CSV 値は全 string＋書込み先型で既存 DML 検証（複数値は§4末尾の穴） |
| UPSERT キー | `--update-key`＝**単一**（重複禁止の文字列(1行)/数値、**またはレコード番号**） | `ON DUPLICATE`＝**複合キー可**（業務キー）。`$id`/レコード番号は不可（書込みフィールド限定・[execute.ts:4251](../../src/execute.ts#L4251)） |
| レコード番号キーで既存更新 | **取込コマンド内で完結**（`--update-key=レコード番号`・CSV のレコード番号列で照合） | 一般能力はある（`WHERE $id`／`UPDATE … FROM` の `$id` 結合・[execute.ts:4562](../../src/execute.ts#L4562)）が **IMPORT の CSV を更新ソースにできない**（CSV は IMPORT 内部源・temp/JOIN 非公開） |
| レコード番号の値変更 | 不可（kintone API 制約） | 不可（同・キー照合とは別） |
| 不良行の扱い | **エラー時中断**（不良行隔離なし・処理済みチャンクのロールバックは非保証） | **`ON ERROR SKIP INTO #err`＝不良行隔離＋合格行のみ書込み**（`REJECT LIMIT`） |
| サブテーブル | **対応**（`*` 複数行・**複数テーブル/行ID更新追加/欠落行削除**・成熟） | v2b（**設計 R1**・JSON ネスト第一・CSV `*` は任意） |
| 添付ファイル | **対応**（`--attachments-dir`・相対パス/複数 LF・空セルで空更新） | **非対応**（v1/v2 とも・面依存で後続候補） |
| アプリコード付きレコード番号 | 対応 | 論理アプリ（`LAPP_`）は別概念・レコード番号 prefix 照合は非対応 |
| 面 | **CLI 単体**（npm 配布・CI/シェル向き） | **CLI／MCP／プラグイン／engine**（loader capability で面非依存） |
| 認証 | API トークン／ID+PW・Basic 認証・**クライアント証明書**（`--pfx-file-path`）・プロキシ・ゲストスペース | profile ベース（既存 `@profile`・`LAPP_`） |
| エンコーディング | UTF-8（既定）／SJIS | UTF-8／SJIS（CSV・BOM 除去明示）・JSON は UTF-8 |
| 数値 | CSV 文字列をそのまま | 厳密10進（B9）。**JSON number は精度対象で string 供給必須**（字句保持） |
| 前処理との統合 | 別ステップ | **SQL パイプライン内**（temp テーブル・`SELECT FROM app` → DML を1バッチ） |
| 部分更新（欠落 vs 空） | **`--fields`**：CSV に無い列は無視・空セルは明示的な空更新（欠落と空を区別） | INTO/射影で対象列を明示（空セルの意味は DML 検証依存） |
| 成熟度/サポート | **公式・GA・API サポート窓口・安定性区分** | サードパーティ・**未実装** |

## 3. cli-kintone が優れる点（kSQL が張り合わない／届かない領域）

1. **添付ファイル**: `--attachments-dir` のアップロード/削除・複数ファイル LF 区切りは cli-kintone の強み。kSQL は非対応。
2. **サブテーブルの実績**: `*` 形式は GA で、単なる行グルーピングでなく**複数テーブル・テーブル行 ID による更新/追加・CSV に無い既存行の削除（破壊的）・テーブルコードの `--fields` 指定**まで持つ。kSQL は v2b が設計段階。
3. **CSV 取込内でのレコード番号キー更新**: `record import --update-key=レコード番号` は CSV のレコード番号列で既存レコードを一発更新。**kSQL IMPORT は CSV を更新ソースにできない**（CSV は IMPORT 内部源で temp/JOIN 非公開・[v1仕様 §2](ksql_import_statement_spec.md)）→ この用途は cli-kintone のみ。
4. **部分更新の欠落 vs 空の区別**（`--fields`）: CSV に列が無いフィールドは無視・空セルは明示的な空更新。
5. **成熟度・公式サポート・配布**: 運用実績・API サポート窓口・安定性区分（stable/experimental/deprecated）・npm 単体 CLI（CI/シェル向き）・幅広い認証（クライアント証明書/Basic/プロキシ/ゲスト）。
6. **単純一括ロードの手軽さ**: 生 CSV をそのまま入れるだけなら cli-kintone が最短（SQL 構文不要）。

## 4. kSQL IMPORT が優れる点（実装後の固有価値・cli-kintone に無い）

1. **ユーザー定義変換付き取込**: `SELECT CAST(金額 AS NUMBER)`・`CONCAT`・`\|\|`・関数・`@var` で**取込時に整形**。cli-kintone は型固有解釈はするがユーザー定義の計算/CAST/文字列加工は無い。
2. **業務ルール検証（B37 `CHECK`）**: `CHECK WHEN CAST(金額 AS NUMBER) < 0 THEN '負値'` のような**行レベル業務チェック**を取込に付与。
3. **不良行の隔離（`ON ERROR SKIP INTO #err`）**: **合格行は書込み・不良行は `#err` へ隔離**して後段で `SELECT`/集計/レシピ再利用。cli-kintone はエラーで中断（不良行隔離なし）。→「大きな CSV の一部だけ不正」を**止めずに流す**運用が kSQL の看板。※ cli-kintone を「原子的」と評価してはならない（ロールバック非保証）。
4. **dry-run（`VALIDATE ONLY`）**: 書込み0でエラーを事前確認。
5. **SQL パイプライン統合**: `CREATE TEMP TABLE #x AS SELECT … FROM APP1; INSERT INTO APP2 SELECT … FROM #x` のように**アプリ間転記や差分と1バッチ**で組める（cli-kintone は取込単機能）。
6. **多面（CLI/MCP/プラグイン）**: **MCP＝生成 AI から自然言語で取込**・**プラグイン＝ブラウザ内でファイル選択して取込**・CLI＝バッチ。cli-kintone は CLI 単体。
7. **JSON ソース（v2）**: API 形状に近い JSON を直接取込・ネストで subtable を自然表現。
8. **複合キー UPSERT＋源内キー重複の決定的拒否**: `ON DUPLICATE (k1, k2)`。さらに**源内の正規化キー重複を事前エラー**（[execute.ts:4253](../../src/execute.ts#L4253)）。cli-kintone は単一キーかつ CSV 順処理で源内重複を黙って上書きし得る。

## 5. 位置づけ（棲み分け・実装後）

- **cli-kintone を使うべき**: 添付ファイル込みの一括投入／サブテーブル（複数テーブル・行 ID 更新・欠落行削除）を含む取込／**CSV のレコード番号列で既存更新を一発**したい／単純な生 CSV ロードで変換・検証が不要／CI・シェルスクリプト常用／公式サポート必須。
- **kSQL IMPORT を使うべき（実装後）**: **取込時に変換・業務チェック・不良行隔離**が要る／CSV↔アプリの前処理と**同じ SQL バッチ**で回したい／**MCP（AI）やプラグイン（ブラウザ）**から取込みたい／**JSON** を入れたい／**複合キー UPSERT＋源内重複の安全拒否**。
- **重複領域**: フラット CSV の INSERT/UPSERT（業務キー）は両者可能。ここは cli-kintone が成熟で手軽。kSQL の付加価値は「変換＋検証＋隔離＋多面＋パイプライン」。

## 6. 結論・提言

- **kSQL IMPORT は cli-kintone の置換を狙わない**。cli-kintone の強み（添付・サブテーブル成熟・CSV レコード番号キー更新・成熟/配布）に張り合わず、**「検証・変換・不良行隔離を伴う取込を、SQL/AI/ブラウザの文脈で」**という別ニッチを埋める。
- **看板の差別化＝`ON ERROR SKIP INTO #err`（不良行隔離）＋`CHECK`（業務ルール）＋`SELECT` 射影（変換）＋源内キー重複の決定的拒否＋多面**。これは cli-kintone に無い。
- **レコード番号キー更新の整理（R1→R2 訂正）**: 「一般の `$id` 更新能力」（両者可）と「**CSV 取込内でレコード番号をキーに更新する能力**」（cli-kintone のみ・kSQL v1 は CSV を更新ソースにできない）を分離する。R1 は前者だけ見て「パリティ・差でない」と**過剰訂正**していた（codex P1-1）→ 後者は cli-kintone 優位として残す。レコード番号の**値変更**は API 制約で両者不可（キー照合と無関係）。
- **弱点は正直に**: 添付・サブテーブル成熟度・CSV レコード番号キー更新・公式サポート/配布は cli-kintone。v2b でサブテーブルは近づくが、添付・CSV レコード番号キー更新は当面 cli-kintone に委ねる（対象外を明記）。
- **文書化の提言**: レシピ集/言語リファレンスに「**cli-kintone との使い分け**」節を設け、上記の棲み分けを明記（実装リリース時に同梱）。**複数値セル（LF 区切り）**は v1 仕様の穴（下記）として IMPORT 仕様に論点追記。

## 7. 実装前に確定すべき論点（仕様の穴）

- **複数値フィールドの CSV 表現**: cli-kintone はチェックボックス/複数選択/ユーザー・組織・グループ複数値/同一添付の複数ファイルを**セル内 LF 区切り**で表す（[公式 CSV 形式](https://cli.kintone.dev/guide/formats/csv/)）。一方 kSQL の DML 値変換は CHECK_BOX/MULTI_SELECT/USER 系を**カンマ区切りまたは JSON 配列**で解釈し **LF は扱わない**（[execute.ts:3920](../../src/execute.ts#L3920)・[3929](../../src/execute.ts#L3929)）。v1 R4 にも LF→配列の意味規則が無い。→ **cli-kintone の複数値 CSV はそのまま取込めない**。IMPORT v1 で LF 分割契約を足すか、対象外と明記するかを実装前に決める。
