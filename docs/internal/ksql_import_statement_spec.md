# B39 別案 — IMPORT 文（CSV → アプリ書込みの自己完結ステートメント）

- 作成日: 2026-07-18
- ステータス: **設計 R2・codex レビュー済（要 R3・実装着手不可）（2026-07-19）**。核心方針（IMPORT 文・フラット CSV・**サブテーブル IMPORT は v1 非対応＝codex 裏取り済み**・loader capability・SemVer minor）は妥当。ただし §10 に事実誤認/未確定（§11・P1×9）＝源経路は `runSelectLike` でなく3経路（要 `materializeDmlSource → MaterializedTable{columns,rows,columnMeta}`）・CSV 射影の出力列名/CHECK スコープ未確定・ヘッダ検証は実行時 preflight・源構文の `'path'` vs 名前付き `<source>` 矛盾・`update-key` ≠ `ON DUPLICATE`（複合キー/レコード番号）。**R3 必須6点は §11**。工数 概算 11〜18 人日。**テーブル(サブテーブル)可否の回答＝§10.4**: cli-kintone は `*` 複数行形式で可・kSQL は親 INSERT/UPSERT がサブテーブル子を書けず v1 非対応（v2 は cli-kintone 形式基準）。
- 分担: Claude=仕様/観点・Codex=実装/テスト
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B39
- 対比: [bind 案 R2](ksql_csv_bind_import_spec.md)・[評価](ksql_import_export_evaluation.md)
- 関連: [B12 ON ERROR SKIP](ksql_validate_only_implementation_plan.md)・[B37 カスタムチェック](ksql_custom_check_spec.md)・[B38 スカラー値式](ksql_concat_operator_spec.md)

## 1. 動機（bind 案との違い）

bind 案は CSV を `#name` の**汎用 temp テーブル**にするため、`SELECT FROM #csv`（APP なしのローカル実行）・実 store seed・temp の read-only・空 CSV スキーマまで背負い、**「APP レス実行経路」が最大の難所**だった（codex 2 次レビューで要 R3）。

IMPORT 文は **「CSV を読み、必要なら射影して、アプリへ INSERT/UPSERT する」自己完結の書込み文**に限定する。ファイルを temp テーブルに露出しないため:

- **常に `INTO <app>`**＝APP・認証・profile が必ずある → **APP レス実行が不要**。
- ファイルは IMPORT 実行の**内部の源データ**（`FROM #csv` で参照できる名前ではない）→ **analyzeBatch の temp seed 不要・temp read-only 不要**。
- 既存 `executeInsertSelect`/`executeUpsertSelect` の**「源 SELECT を実行して rows を得る」段（[execute.ts:4459](../../src/execute.ts)）を「ファイルを読んで rows を得る」に差し替える**だけで、下流（フィールド型検証・位置対応・`ON DUPLICATE`・B37 `CHECK`・`ON ERROR SKIP`・`VALIDATE ONLY`）を全再利用。

**トレードオフ**：CSV を**アプリと JOIN したり汎用クエリで使う**ことはできない（源として書込むだけ）。「検証・UPSERT・変換・不良行隔離付きで CSV をアプリへ取込む」用途には十分。CSV↔アプリ結合が要る場合のみ bind 案が必要。

## 2. 構文

```text
IMPORT INTO <app> ( <field1>, <field2>, ... )
FROM CSV '<path>' [ ENCODING { UTF8 | SJIS } ] [ NO HEADER ] [ COLUMNS ( <c1>, <c2>, ... ) ]
[ SELECT <式1>, <式2>, ... ]              -- 任意: CSV 列に対する射影（既定は位置対応）
[ ON DUPLICATE ( <key> ) ]                -- 指定で UPSERT、無指定で INSERT
[ CHECK WHEN <条件> THEN <メッセージ> ... ] -- B37
[ VALIDATE ONLY | ON ERROR SKIP INTO #err [ REJECT LIMIT n ] ]
```

例:
```sql
IMPORT INTO APP123 (顧客コード, 金額)
FROM CSV 'sales.csv' ENCODING SJIS
SELECT 顧客コード, CAST(金額 AS NUMBER)
ON DUPLICATE (顧客コード)
CHECK WHEN CAST(金額 AS NUMBER) < 0 THEN CONCAT('金額が負: ', 金額)
ON ERROR SKIP INTO #err;
```

- `FROM CSV '<path>'`：CLI がローカルパスを読む。`IMPORT`/`CSV` はソフトキーワード（後述の予約語方針）。
- `COLUMNS (...)`：`NO HEADER` 時の CSV 列名（省略時 `c1..cn`）。ヘッダ有りは 1 行目を列名に。
- `SELECT <式>`：**CSV 列を入力にした射影**（B38 の `ScalarValueExpr` を再利用・`CAST`/関数/`||`/`@var` 可）。**CSV 列のみのスコープ**（アプリ参照・JOIN・サブクエリ不可）。省略時は `INTO` 列へ**位置対応**。
- 射影の出力列数 = `INTO` の列数（不一致はエラー）。

## 3. 意味論

- IMPORT は **INSERT（`ON DUPLICATE` 無）/ UPSERT（有）INTO app** として実行。源 rows は**ファイルから内部生成**（SELECT を実行しない）。
- **型**：CSV 値は文字列。射影の各式は B38 `ScalarValueExpr` を **CSV 列スコープの resolver**（全列 string）で評価 → 出力行。数値/日付は `CAST`/関数で明示、または**書込み先フィールド型に委ねて既存 DML 検証**（型/範囲/桁/B29）が効く。
- **`CHECK`（B37）**：源（射影後）行に対して評価（`ON ERROR SKIP` で `#err` 隔離）。数値比較は `CAST`。
- **処分**：`VALIDATE ONLY`（書かず報告）・`ON ERROR SKIP INTO #err [REJECT LIMIT n]`（隔離＋合格書込み）・無指定（fail-fast）。既存 Tier-0 と同一。
- **サブテーブル/複合型**：非対応（CSV で表現困難・v1）。

## 3.5 空 CSV はエラー（ユーザー決定）

**データ行 0 の CSV は IMPORT エラー**（「取込む行がありません」）。ゼロバイト・ヘッダのみ・`NO HEADER` 0 行のいずれも 0 行 → エラーで統一。→ codex レビュー #4（空 CSV の列スキーマ契約）は「0 行=エラー」で解消（0 件成功の分岐・空 columns の DML 源化を持たない）。射影の列参照検証はヘッダ/`COLUMNS`/供給メタから行い、0 行判定はその後。

## 4. なぜ実装が bind より軽いか（要点）

| 論点 | bind 案 | IMPORT 文 |
|---|---|---|
| APP レス実行（no-op client） | 必要（`SELECT FROM #csv`） | **不要**（常に `INTO app`） |
| analyzeBatch の temp seed | 必要（汎用参照） | **不要**（temp 名を作らない） |
| temp の read-only（CREATE/DROP/INTO） | 必要 | **不要** |
| 空 CSV の temp スキーマ契約 | 必要 | INSERT 源としての 0 行契約のみ（既存の空 SELECT 源と同等） |
| 実 store seed（単文/バッチ両方） | 必要 | **不要**（源は文内部） |
| 実装の主変更点 | 実行パイプライン全体 | **INSERT/UPSERT SELECT の源取得を差し替え＋パーサ＋CSV 読取** |

## 5. パーサ・実行の要点

- **パーサ**：`IMPORT INTO app (fields) FROM CSV '…' […] [SELECT …] [ON DUPLICATE …] [CHECK …] [処分]`。AST は `InsertSelect`/`UpsertSelect` に近い新ノード（源が `{ kind: "CSV_FILE", path, encoding, hasHeader, columns } ＋ 任意射影`）。`IMPORT`/`CSV`/`ENCODING`/`NO HEADER`/`COLUMNS` は**ソフトキーワード**（新規予約語を増やさない方針・`CHECK WHEN` 前例）。
- **実行**：`executeInsertSelect`/`executeUpsertSelect`（[execute.ts:4446](../../src/execute.ts)/[5282](../../src/execute.ts)）の**源取得（SELECT 実行）を「CSV 読取→射影評価→rows」に分岐**。以降（フィールド検証・位置対応・`ON DUPLICATE`・`CHECK`・`ON ERROR SKIP`）は不変で再利用。
- **CSV/エンコーディング**：`TextDecoder({fatal:true})`（SJIS/UTF8・不正バイトは error）・RFC4180 パース（引用符・`""`・セル内改行/カンマ・CRLF/LF）・BOM 除去・行幅不一致/空列名は error（行/列/ファイル名付き）。
- **行数上限**：`tempTableMaxRows` 相当を CSV 読取段で適用。

## 6. 面（ユーザー決定: CLI 限定にしない）

**IMPORT は CLI 限定にしない**。ファイルパスを SQL に埋めず、**面ごとに CSV バイトを供給する loader capability**（codex レビュー #5）で面非依存にする。

- **SQL からパスを外す**：`FROM CSV <source>`（`<source>` は面が供給する名前付きソース）。パスは面が解決する。
  - CLI：`--import-csv <source>=<path>`（fs 読取）。
  - プラグイン：ファイル選択ダイアログで `<source>` にバイトを供給。
  - MCP：ツール入力の inline data を `<source>` に供給。
- この「**IMPORT 専用の名前付きソース**」は bind 案の `#temp` とは違い、**`IMPORT INTO app FROM <source>` でのみ使える**（`FROM #source` の汎用クエリ・JOIN 不可）。→ APP レス実行・temp read-only・analyzeBatch seed の難所は依然として発生しない。
- **実装**：`ExecuteOptions` に `importSources?: Map<name, {bytes|rows, encoding, hasHeader, columns?}>` 相当の loader を追加。loader 未供給の `<source>` 参照はパース直後・kintone API 前に `UnsupportedSourceError`。Node `fs` は CLI/node モジュールに閉じ込め、共有コアは bytes/rows のみ扱う（ブラウザビルド境界を壊さない）。

## 7. 受入条件（テスト化）

- INSERT（`ON DUPLICATE` 無）/ UPSERT（有）で CSV → アプリ書込み。位置対応と `SELECT` 射影（`CAST`/`CONCAT`/`||`/`@var`）。
- 型：文字列供給＋`CAST` で数値比較（`CHECK WHEN CAST(金額 AS NUMBER) < 0`）・`"10"/"2"/"-1"` 固定で暗黙数値推論なし。
- 処分：`VALIDATE ONLY`（書かず #err 報告）・`ON ERROR SKIP INTO #err [REJECT LIMIT]`・fail-fast。
- B37 `CHECK` 発火（源射影後行）。
- エンコーディング：SJIS/UTF8・BOM・不正バイト error。CSV パース：引用符/`""`/セル内改行/CRLF/空 CSV(0 行)/ヘッダのみ/行幅不一致 error/`NO HEADER`+`COLUMNS`。
- 射影出力列数 ≠ INTO 列数は error。CSV 列スコープ外参照（アプリ列・JOIN・サブクエリ）は ParseError。
- 面：CLI 以外は非対応エラー。サブテーブル/複合型 INTO は非対応。
- 非回帰：`IMPORT` 無しの既存挙動不変・`IMPORT`/`CSV` 同名フィールド（バッククォート）。

## 8. bind 案との関係・提言

- **IMPORT 文＝「取込に特化・実装が軽い・面適合が良い」**。bind 案＝「CSV を汎用クエリソースにする・柔軟だが APP レス実行が重い」。
- 実需（検証/UPSERT/変換/不良行隔離）は **IMPORT 文で満たせる**。CSV↔アプリ JOIN の実需が出たら bind 案（または IMPORT の SELECT を拡張）を v2 で。
- **提言**：B39 v1 は **IMPORT 文**を第一候補にする（bind 案の R3 難所を回避）。本 R1 を codex レビューで裏取り後に実装判断。

## 9. SemVer・文書
- **minor**（新ソフトキーワード・既存挙動不変）。CLI help・言語リファレンス・レシピ・CHANGELOG・台帳 B39 同期。

---

## 10. R2 確定事項（2026-07-19・Claude・コード裏取り）

R1 review の残 3 重大を確定し、ユーザーの問い「テーブル（サブテーブル）のインポート可否」に回答する。

### 10.1 源 materializer の共通化（重大①・R3 で再設計・codex P1-1/2 訂正）
- **訂正**: `runSelectLike`（[execute.ts:1259](../../src/execute.ts#L1259)）は `CREATE TEMP TABLE AS` 専用（呼出しは 1206 のみ）で、IMPORT の源ではない。実際の源取得は**3経路に分かれる**＝①通常 `executeInsertSelect`（`executeQueryWithCte`/`executeSelect`・[execute.ts:4726/4740](../../src/execute.ts#L4726)）②通常 `executeUpsertSelect`（[execute.ts:5578](../../src/execute.ts#L5578)）③`VALIDATE ONLY`/`ON ERROR SKIP`/CHECK の候補生成 `materializeValidationCandidates`（[execute.ts:4189](../../src/execute.ts#L4189)）。「源だけ差し替えれば下流不変」は誤り。
- **R3 の設計**: 3経路が共有する **`materializeDmlSource(...) -> MaterializedTable {columns, rows, columnMeta}`** を新設（`{columns,rows}` だけでは不足＝CHECK の型判定に `columnMeta` が要る・[execute.ts:244](../../src/execute.ts#L244)）。source を `{kind:"SELECT", query} | {kind:"CSV", loader, encoding, hasHeader, columns, projection}` の判別 union にし、CSV 側は loader → RFC4180 → 射影評価で `MaterializedTable` を返す。以降（B34 検証・位置対応・`ON DUPLICATE`・B37 CHECK・B12）は**この共通入口に接続**して再利用（源差し替え1点ではない）。

### 10.2 `ON ERROR SKIP` / `VALIDATE ONLY INTO` はバッチ限定（重大②）
- `IMPORT … ON ERROR SKIP INTO #err` は `#err` が batch-scoped temp のため、B12/B41 と同じく**単文では拒否**（[batch.ts:208](../../src/core/batch.ts#L208) の「requires a batch」判定に IMPORT の errorTable を含める）。
- 単文 `IMPORT`（INTO なし）は既存 INSERT/UPSERT の結果（INSERT=`insertedCount`／UPSERT=`insertedCount`＋`updatedCount`・`affectedRows` は主に `ON ERROR SKIP` 経路）を返す。`VALIDATE ONLY`（`#err` 無し）は単文可（報告のみ・書込み 0）。複文 `IMPORT … ON ERROR SKIP INTO #err; SELECT … FROM #err` は動作。
- 単文 INTO 拒否は batch.ts:208 だけでは不足＝`validationTable` 抽出・`#err` の生成/依存/payload schema 登録（[batch.ts:321](../../src/core/batch.ts#L321)）・`isDmlType`/`writesKintone`/`requiresCompleteInput`（[dmlGuard.ts:24](../../src/core/dmlGuard.ts#L24)）・単文/バッチの IMPORT dispatch も配線が要る（R3）。

### 10.3 CSV 射影の列スコープ検証（重大③）
- `SELECT <式>` の参照は **CSV 列（ヘッダ／`COLUMNS`／`c1..cn`）のみ**。アプリ列・JOIN・サブクエリ・修飾参照は静的拒否（B41 の修飾参照拒否と同型）。検証は供給メタ（ヘッダ or `COLUMNS`）から列名集合を作り、射影式の FIELD 参照が集合に含まれるかを parse/analyze で確認。0 行判定（§3.5）はその後。
- 射影の出力列数 = `INTO` の列数（不一致はエラー）。

### 10.4 テーブル（サブテーブル）のインポート — v1 非対応・v2 は cli-kintone `*` 形式を基準

**問い（ユーザー・参考 cli-kintone）**: テーブルのインポートは可能か。

- **cli-kintone は対応**: 先頭列 `*` の複数行 = 1 レコード（各レコード先頭行に `*`・サブテーブル追加行は `*` 空欄で継続）。サブテーブル列は CSV の通常列で、追加行は親フィールドを繰り返す。kintone REST API はサブテーブル配列（`{value:[{value:{…}} , …]}`）を書ける。
  ```csv
  "*","EmployeeId","Name",...,"AssignInformation","AssignDate","AssignDivision"
  "*","0008","栗田 健一",...,"3703","2020-04-01","企画部"     ← レコード開始
  "" ,"0008","栗田 健一",...,"3702","2021-04-01","人事部"     ← 同レコードのサブテーブル追加行
  ```
- **kSQL の制約（可否の核心）**: kSQL の**親 `INSERT`/`UPSERT` はサブテーブル子フィールドを書けない**（[言語リファレンス](../ksql_language_reference.md)＝書込みはトップレベルのみ・サブテーブル子は文単位 `ArgumentError`）。サブテーブル DML（`APP$明細`）は**既存親の `_pid` 前提**でレコード新規作成はできない（`expandRowsForSubtableDml`／`buildSubtablePutParams` は既存親の行更新）。→ **「親レコード＋サブテーブル行を 1 文で作成/更新」する経路が現状ない**。
- **結論**: **サブテーブル IMPORT は v1 では非対応**（§3.4 を維持・codex も「現状 親＋子を1文で作成/更新する経路がない・v1 非対応は正しい」と裏取り: 親DMLがサブテーブル子を拒否 [execute.ts:3944](../../src/execute.ts#L3944)・サブテーブル INSERT は `_pid` 必須 [execute.ts:5114](../../src/execute.ts#L5114)）。
  - **前提の限定（codex P2-1）**: 「親 DML のサブテーブル書込み対応が**技術的必須**」ではない＝IMPORT 自身が親 payload＋サブテーブル配列を直接組み立てる実装も理論上可能。ただし本仕様の**「共通 DML 経路を再利用する方針」なら前提**になる。どちらを採るかは v2 で確定。
  - **`*` 形式は単純グルーピングだけではない（codex P2-1）**: cli-kintone の CSV サブテーブルはテーブル識別列・複数テーブル・親フィールドは開始行のみ有効・空テーブル行の無視等を持つ（[cli-kintone CSV format](https://cli.kintone.dev/guide/formats/csv/)）。「配列ペイロードへ組み立てを足すだけ」は工数を過小評価。**v2 は cli-kintone の `*` 形式を設計基準**とし、上記の仕様差も取り込む。

### 10.5 cli-kintone 対照で確定した細目
- `--update-key`（cli-kintone の一括更新キー）= kSQL の `ON DUPLICATE (key)`（UPSERT）。キーは「重複禁止の 文字列(1行)/数値」or レコード番号（kintone 制約と一致）。
- `--encoding` = kSQL の `ENCODING { UTF8 | SJIS }`（既定 UTF8・cli-kintone と同じ）。
- **添付ファイル**（cli-kintone `--attachments-dir`）は **IMPORT v1 非対応**（ファイル参照の面依存・v2 候補）。
- 書込み不可フィールド（計算・ルックアップコピー・ステータス等）は既存 DML 検証（B34）が `INTO` 指定で捕捉。

### 10.6 実装可否・工数
- 3 重大は既存機構の再利用で確定（源差し替え・単文 INTO 拒否・列スコープ検証）。**フラット CSV IMPORT は実装着手可**（源 materializer 抽出＋CSV パーサ＋loader capability＋パーサ）。サブテーブルは v2（前提機能待ち）。SemVer minor。codex R2 レビューで裏取り後に着手。

---

## 11. codex レビュー結果（R2・2026-07-19・要 R3）

Claude が P1-1 を実ファイルで裏取り（`runSelectLike`=CREATE_TEMP_TABLE 専用 execute.ts:1206/1259・`executeInsertSelect`=executeQueryWithCte 4740・`materializeValidationCandidates`=4189）。**判定＝R3 必須・現状では実装着手不可**。核心方針（IMPORT 文・フラット CSV・サブテーブル v1 非対応・loader capability・SemVer minor）は妥当と確認。

### P1（誤り・要修正）
1. **§10.1 の実行経路誤認**（訂正済み）。源は3経路（INSERT_SELECT / UPSERT_SELECT / VALIDATE候補生成 materializeValidationCandidates）で、共通 `materializeDmlSource → MaterializedTable{columns,rows,columnMeta}` の新設が要る。`{columns,rows}` では CHECK 型判定の `columnMeta` が不足。
2. **CSV 射影の出力列名契約が未確定**で B37 CHECK を再利用できない。CHECK は SELECT 出力列名を評価スコープに使い一意性必須・列に無い参照は拒否（[execute.ts:4216/4281/4233](../../src/execute.ts#L4216)）。→ R3 で「射影は `AS alias` 必須か／単純列参照は元名継承か／出力名重複の扱い／CHECK は射影前 CSV 行か射影後行か」を確定（自然なのは「CHECK は射影後の一意な出力列名を参照」）。
3. **§10.3「parse/analyze でヘッダ由来の列集合を検証」は不可**。`analyzeBatch` は AST しか受けず loader データに触れない（[batch.ts:179](../../src/core/batch.ts#L179)）。→ 検証を分割: `COLUMNS`/`NO HEADER` の `c1..cn` と JOIN/サブクエリ/修飾参照は parse/analyze 時・**CSV ヘッダ由来と未知 CSV 列は loader でヘッダ読取後・kintone 書込み前の実行時 preflight**。
4. **`ScalarValueExpr` は resolver 注入型でない**（訂正）。`evalScalarValueExpr(expr, row)`（[evalFunc.ts:38](../../src/engine/evalFunc.ts#L38)）は `ProcessRow` のキーで解決。→ 実装は「射影 AST の全 `FieldRef`（CASE 内条件まで再帰）を収集して CSV 列集合に事前検証 → CSV 行を ProcessRow 化 → 評価 → number は `String()` 正規化」。トップレベル FIELD 走査だけでは CASE 条件参照を取りこぼす。
5. **単文 INTO 拒否は batch.ts:208 だけでは不足**（訂正済み・§10.2）。validationTable 抽出・#err schema/依存・dmlGuard 分類・IMPORT dispatch も要る。
6. **源構文の矛盾**（§2/§5 の `FROM CSV '<path>'` vs §6 の `FROM CSV <source>`）。面非依存 loader を採るなら**名前付き `<source>` に統一**しパス文字列形式は削除。`encoding`/`hasHeader`/`columns` を SQL と loader の双方に持つ場合の優先順位も R3 で確定。
7. **loader 未供給の preflight 位置**。B34 は源取得より先に書込み先 `getFields` を呼ぶ（[execute.ts:4735](../../src/execute.ts#L4735)）。§6「kintone API 前」を守るには文実行直前に **source 存在の同期 preflight** を置く。順序＝①source 存在(ローカル)→②B34 書込み先検証(metadata)→③CSV ロード/射影→④DML 検証/書込み。
8. **`update-key` = `ON DUPLICATE` は完全同値でない**。kSQL は複合キー（`keyFields[]`・[ast.ts:655](../../src/types/ast.ts#L655)）・キーは `fields` に含め RECORD_NUMBER は非書込みで拒否（[execute.ts:3940](../../src/execute.ts#L3940)）。cli-kintone の「レコード番号 update-key UPSERT」は現行 `ON DUPLICATE` と不一致。→「概念的対応」に弱め、差分（複合キー可・レコード番号キー非対応・重複禁止の事前検証 or 既存 UPSERT 意味論委譲）を明記。
9. **通常結果 `affectedRows` は結果型と不一致**（訂正済み・§10.2）。INSERT=insertedCount／UPSERT=insertedCount+updatedCount。

### P2（改善）
1. §10.4 サブテーブル: 事実は正しい（v1 非対応は妥当）が「別の親DML機能が**必須**」は言い過ぎ→「共通DML経路再利用なら前提」に限定（反映済み）。cli-kintone `*` 形式は識別列/複数テーブル/開始行のみ親/空行無視を持ち「組み立てを足すだけ」は過小（反映済み）。
2. loader は `Map` 直接公開より**遅延 loader 関数** `importSource?: (name) => Promise<{bytes, encoding?}>` を推奨（plugin picker/CLI fs/MCP inline を同契約に）。source 型は公開 export・文単位 cache・最大 byte 上限も仕様化。ブラウザ境界（build.mjs=browser / build-cli.mjs=node）方針は妥当。
3. cli-kintone 追加差分: ヘッダ名対応 vs INTO 位置対応・`--fields` はテーブル本体コード可(子単独不可)・添付は LF 区切り複数・レコード番号キーのアプリコード規則・cli-kintone UPSERT は CSV 順序処理だが kSQL は源内キー重複を B12 候補生成でエラー（[execute.ts:4270](../../src/execute.ts#L4270)）。

### 工数・総合
概算 **11〜18 人日**（CLI のみ下側・全面 picker UI まで上側）。SemVer minor 妥当。**R3 の必須6点**＝①共通 `materializeDmlSource → MaterializedTable` 入口②通常 INSERT/UPSERT＋B12/B37 候補生成の全経路接続③CSV 射影の出力列名/alias/CHECK スコープ④ヘッダ依存検証は実行時 preflight⑤名前付き source 構文と loader 契約の一本化⑥cli-kintone 差分（レコード番号キー・複合キー）。サブテーブル v1 非対応・loader・単文/バッチ方針・minor は確定済み。
