# B39 別案 — IMPORT 文（CSV → アプリ書込みの自己完結ステートメント）

- 作成日: 2026-07-18
- ステータス: **設計 R4・Claude レビュー済（承認）・フラット CSV 実装着手可**（2026-07-19）。分担=codex 設計／Claude レビュー。R3 review の P1×4 を §13 で確定（Claude がコード裏取り・§13.9）＝共通源入口の内部契約を `MaterializedTable` に統一・射影後の意味型メタ推論・IMPORT UPSERT 全経路の源内キー重複 preflight・同期 source capability＋10 MiB 上限。**サブテーブル・添付・レコード番号キー・CSV↔アプリ JOIN は v2**。工数 17〜27 人日・SemVer minor。
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
FROM CSV <source> [ ENCODING { UTF8 | SJIS } ] [ NO HEADER ] [ COLUMNS ( <c1>, <c2>, ... ) ]
[ SELECT <式1>, <式2>, ... ]              -- 任意: CSV 列に対する射影（既定は位置対応）
[ ON DUPLICATE ( <key> ) ]                -- 指定で UPSERT、無指定で INSERT
[ CHECK WHEN <条件> THEN <メッセージ> ... ] -- B37
[ VALIDATE ONLY | ON ERROR SKIP INTO #err [ REJECT LIMIT n ] ]
```

例:
```sql
IMPORT INTO APP123 (顧客コード, 金額)
FROM CSV sales ENCODING SJIS
SELECT 顧客コード, CAST(金額 AS NUMBER)
ON DUPLICATE (顧客コード)
CHECK WHEN CAST(金額 AS NUMBER) < 0 THEN CONCAT('金額が負: ', 金額)
ON ERROR SKIP INTO #err;
```

- `FROM CSV <source>`：面が供給する名前付き source。SQL にローカルパスは埋め込まない。`IMPORT`/`CSV` はソフトキーワード（後述の予約語方針）。
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

- **パーサ**：`IMPORT INTO app (fields) FROM CSV <source> […] [SELECT …] [ON DUPLICATE …] [CHECK …] [処分]`。AST は `InsertSelect`/`UpsertSelect` に近い新ノード（源が `{ kind: "CSV", sourceName, encoding, hasHeader, columns } ＋ 任意射影`）。`IMPORT`/`CSV`/`ENCODING`/`NO HEADER`/`COLUMNS` は**ソフトキーワード**（新規予約語を増やさない方針・`CHECK WHEN` 前例）。
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

---

## 12. R3 確定事項（2026-07-19・Claude・コード裏取り・実装着手可）

§11 の必須6点を確定する。フラット CSV IMPORT のみ（サブテーブル・添付・レコード番号キーは v2）。

### 12.1 共通源入口 `materializeDmlSource → MaterializedTable`（R3-1・R3-2）
- 新設 `materializeDmlSource(source, client, options, cacheContext, tempTables): Promise<MaterializedTable>`。戻り型は**既存 `MaterializedTable {rows: ProcessRow[]; columns: string[]; columnMeta?}`**（[execute.ts:253](../../src/execute.ts#L253)）。
- `source` = `{kind:"SELECT", query} | {kind:"CSV", sourceName, encoding, hasHeader, columns?, projection?}`。
  - SELECT: 現行の `executeQueryWithCte`/`executeSelect` を呼び SelectResult → `{rows, columns, columnMeta(WeakMap)}`（挙動不変）。
  - CSV: loader → decode → RFC4180 パース →（射影評価）→ `ProcessRow[]`＋columns＋columnMeta（全 string・§12.3）。
- **3経路を共通入口へ接続**（源だけ差し替えではなく）: `executeInsertSelect`（[execute.ts:4740](../../src/execute.ts#L4740)）・`executeUpsertSelect`（[5578](../../src/execute.ts#L5578)）・`materializeValidationCandidates`（[4189](../../src/execute.ts#L4189)）の源取得を `materializeDmlSource` 呼出しへ置換。以降（列数チェック [4746]・位置対応 `columns[i]→fields[i]` [4768 付近]・CHECK uniqueness/`assertInsertCheckRefs` [4281]・B34・B12 候補生成）は**現行のまま**（`{columns,rows,columnMeta}` 契約が既存と一致）。IMPORT は CSV source を渡すだけ。

### 12.2 CSV 射影の出力列名・CHECK スコープ（R3-3）
- **`SELECT <式>` は式に `AS alias` 必須**。**単純列参照は元 CSV 列名を継承**（`SELECT 顧客コード, 金額` は AS 省略可）。式（`CAST`/`CONCAT`/`||`）は合成名を作らず `AS alias` 必須。
- 出力列名は**常に一意**（重複エラー）。射影省略（位置対応）時は CSV 列名がそのまま出力列名。
- **CHECK は射影後の一意な出力列名を参照**（B37 と同一・`assertInsertCheckRefs` [execute.ts:4281](../../src/execute.ts#L4281) が既存どおり検証）。`SELECT 顧客コード, CAST(金額 AS NUMBER) AS 金額` なら CHECK は射影後 `金額` を参照（射影前 CSV 行は参照しない）。
- 射影出力列数 = `INTO` 列数（現行チェック [4746] を流用）。

### 12.3 CSV 列型・射影評価（R3-1 補足）
- CSV 値は全て string。`materializeDmlSource(CSV)` の `columnMeta` は全列 `syntheticColumnMeta("string")`。数値/日付は射影の `CAST`/関数で明示、または書込み先型に委ねて既存 DML 検証（B34/B29）が捕捉。
- 射影は `evalScalarValueExpr(expr, row)`（[evalFunc.ts:38](../../src/engine/evalFunc.ts#L38)）＝ProcessRow キー解決。CSV 行を ProcessRow 化して評価。**列参照は射影 AST（CASE 内条件まで再帰）で全 FieldRef を収集**して CSV 列集合へ事前検証（トップレベル走査だけでは CASE 条件を取りこぼす）。number 出力は `String()` 正規化。

### 12.4 検証の時点分割・順序（R3-4）
- **parse/analyze 時**（AST のみ・[batch.ts:179](../../src/core/batch.ts#L179)）: JOIN/サブクエリ/修飾参照の静的拒否・`COLUMNS`/`NO HEADER` の `c1..cn` への射影参照検証・射影出力列数チェック。
- **実行時 preflight**（loader ヘッダ読取後・kintone 書込み前）: CSV ヘッダ由来列集合への射影/CHECK 参照検証・未知 CSV 列拒否・0 行判定（§3.5）。
- **順序（P1-7）**: ①source 存在の同期 preflight（loader 未供給は `UnsupportedSourceError`・kintone API 前）→②B34 書込み先検証（`getFields`）→③CSV ロード/decode/パース/射影→④DML 検証/CHECK/書込み。

### 12.5 名前付き source 構文と loader 契約の一本化（R3-5・§2/§5/§6 の矛盾解消）
- **構文は名前付き `<source>` に統一**: `IMPORT INTO app (fields) FROM CSV <source> [ENCODING …] [NO HEADER] [COLUMNS(…)] [SELECT …] [ON DUPLICATE …] [CHECK …] [処分]`。**§2/§5 の `'<path>'` リテラルは削除**（面依存を SQL に埋めない）。
- **loader = 遅延関数**（Map 直接公開でなく・codex P2-2）: `ExecuteOptions.importSource?: (name: string) => Promise<{ bytes: Uint8Array; encoding?: "utf8" | "sjis" }>`。source 型は公開 export・**文単位 cache**（同 source の多重ロード回避）・**最大 byte 上限**を仕様化。CLI=`--import-csv <name>=<path>`（fs）・プラグイン=picker・MCP=inline。Node `fs` は CLI/node に閉じ込め共有コアは bytes のみ（build.mjs=browser / build-cli.mjs=node 境界維持）。
- **優先順位**: `ENCODING`/`NO HEADER`/`COLUMNS` は **SQL 明示が優先**、無ければ loader 供給値（loader は encoding を返せる）。

### 12.6 cli-kintone との差分（R3-6）
- `ON DUPLICATE (keys)` は **kSQL の複合キー**（`keyFields[]`・[ast.ts:655](../../src/types/ast.ts#L655)）。cli-kintone `--update-key` は単一キー。
- **レコード番号キーは v1 非対応**（kSQL は RECORD_NUMBER を非書込みで拒否 [execute.ts:3940](../../src/execute.ts#L3940)・キーは `fields` に含める必要）。cli-kintone の「レコード番号 update-key UPSERT」は再現しない（v2 候補）。
- UPSERT の重複: cli-kintone は CSV 順序処理だが kSQL は**源内キー重複を B12 候補生成でエラー**（[execute.ts:4270](../../src/execute.ts#L4270)）。IMPORT も同挙動。
- ヘッダ名対応: cli-kintone は CSV ヘッダ名でフィールド対応、IMPORT は **INTO への位置対応**（射影で明示可）。添付は LF 区切り複数（v1 非対応）。

### 12.7 実装着手可・工数・SemVer
- R3 の6点を確定＝**フラット CSV IMPORT は実装着手可**。主コスト＝共通 `materializeDmlSource` 抽出＋3経路接続・CSV decoder/parser・loader capability＋面配線・パーサ・EXPLAIN。工数 **11〜18 人日**（CLI のみ下側・全面 picker UI まで上側）。**SemVer minor**。サブテーブル・添付・レコード番号キー・CSV↔アプリ JOIN は v2。

---

## 13. R4 確定事項（保守 v1・実装着手可）

R3 review の P1×4 と P2 を、現行コードの契約に合わせて確定する。R4 の対象はフラット CSV の INSERT/UPSERT のみで、サブテーブル・添付・レコード番号キー・CSV↔アプリ JOIN は v2 のままとする。

### 13.1 共通源入口の内部契約は `MaterializedTable`（P1-1）

- `materializeDmlSource(source, client, options, cacheContext, tempTables): Promise<MaterializedTable>` を新設する。`MaterializedTable` は現行どおり `rows`・`columns`・任意の `columnMeta` を一体で保持する（[execute.ts:244-257](../../src/execute.ts#L244)）。`source` は公開 AST の `DmlSource = {kind:"SELECT"; query: SelectStatement} | {kind:"CSV"; sourceName:string; encoding?:ImportEncoding; hasHeader:boolean; columns?:string[]; projection?:ImportProjection[]}` とする。
- `executeInsertSelect` の SELECT 実行（[execute.ts:4726-4743](../../src/execute.ts#L4726)）、`executeUpsertSelect` の SELECT 実行（[execute.ts:5578-5595](../../src/execute.ts#L5578)）、`materializeValidationCandidates` の SELECT 実行（[execute.ts:4189-4215](../../src/execute.ts#L4189)）をすべてこの関数へ接続し、3経路のローカル変数を `SelectResult` ではなく `MaterializedTable` にする。これは「源だけ差替え、下流不変」ではなく、**共通内部契約を `MaterializedTable` へ変更する再編**である。
- CHECK/VALIDATE 経路は `materializedMetaBySelectResult.get(selectResult)` を廃止し、`table.columnMeta` を直接参照して `evaluationTypes` を構築する。現状は WeakMap からメタを取得し、数値メタがなければ `SINGLE_LINE_TEXT` に落としている（[execute.ts:4220-4233](../../src/execute.ts#L4220)）。通常 INSERT/UPSERT も同じ `table.rows`・`table.columns` を受け、既存の列数検査（[execute.ts:4745-4752](../../src/execute.ts#L4745), [execute.ts:5597-5603](../../src/execute.ts#L5597)）と位置対応 `columns[i] -> fields[i]`（[execute.ts:4764-4770](../../src/execute.ts#L4764), [execute.ts:5616-5623](../../src/execute.ts#L5616)）を再利用する。
- **アダプタは SELECT 境界に一方向だけ置く**。既存 `executeSelect`/`executeQueryWithCte` の公開戻りは `SelectResult` のまま保ち、`materializeDmlSource` の SELECT 分岐内で `SelectResult -> MaterializedTable` に変換し、WeakMap のメタをそこで回収する。既存 CTE 実体化も同じ変換を行っている（[execute.ts:3043-3060](../../src/execute.ts#L3043)）。逆方向 `MaterializedTable -> SelectResult` はDML源処理には不要なので新設しない。公開 `SelectResult` とその WeakMap 契約は非DML利用者の互換性のため残す（[execute.ts:259-261](../../src/execute.ts#L259)）。

### 13.2 CSV射影後の列メタは式から推論する（P1-2）

- 射影**前**の生CSV列はすべて string とし、`fieldType:"KSQL_STRING"`・`sortKind:"string"`・string semantics を持つ。射影**後**は出力式ごとに `MaterializedColumnMeta` を作り、`MaterializedTable.columnMeta` に出力列名で格納する。CHECK が `fieldType`/`semantics.compareMode`/`sortKind` から比較型を決める現行動作（[execute.ts:4225-4232](../../src/execute.ts#L4225)）のため、射影後を一律 string にはしない。
- 推論規則は次で固定する。(1) 単純列参照は入力列メタを継承、(2) 文字列リテラル・文字列関数・`CONCAT`・`||` は string、(3) 数値リテラル・`CAST(... AS NUMBER)`・算術式は number、(4) `CASE` は全 `THEN` と `ELSE` を再帰推論し、全枝 number なら number、全枝 string なら string、混在または `ELSE` なしは string、(5) `CAST(... AS 文字列型)` は string、(6) 変数、未対応CAST型、その他導出不能な式は安全側の string とする。number は `fieldType:"NUMBER"`・`sortKind:"number"`・number semantics、string は上記 string メタに正規化する。既存 SELECT も算術を number、文字列関数を関数メタ、それ以外の未確定スカラー/CASEを string と分類している（[execute.ts:1761-1785](../../src/execute.ts#L1761)）。
- 射影参照検査はトップレベルだけでなく `ScalarValueExpr` 全体を再帰走査する。対象は `FieldRef`、`SCALAR_ARITH.left/right`、`CONCAT_OP.left/right`、全 `StringFuncExpr.args`、`CASE` の各 `condition` 内の FieldRef・各 `result`・`elseResult` である。AST上も `ScalarValueExpr` は関数・算術・連結・CASEを内包し（[ast.ts:774-786](../../src/types/ast.ts#L774)）、CASEは条件と枝値を別に持ち（[ast.ts:342-353](../../src/types/ast.ts#L342)）、関数引数も `ScalarValueExpr` を再帰的に含む（[ast.ts:302-309](../../src/types/ast.ts#L302)）。修飾参照・変数以外の未知列・サブクエリ・集約・JOINは v1 で拒否する。

### 13.3 IMPORT UPSERTは全経路で源内キー重複を拒否する（P1-3）

- **処分句の有無に関係なく**、IMPORT UPSERT は materialize/射影後かつkintone照合read前の共通preflightで源内キー重複を検査し、1件でもあれば書込み0件で `ERR_KEY_DUP_SOURCE` として文全体を拒否する。`VALIDATE ONLY`/`ON ERROR SKIP` の隔離対象にはしない。強い安全契約を全経路で同一にし、同一キーの行順で最終値が変わる意味論を導入しない。
- 現状の `ERR_KEY_DUP_SOURCE` は候補生成内にしかなく（[execute.ts:4253-4273](../../src/execute.ts#L4253)）、通常 UPSERT SELECT は候補生成を通らず、照合結果を行ごとに insert/update へ振り分ける（[execute.ts:5626-5640](../../src/execute.ts#L5626)）。また CHECK 付きだけが検証側へ分岐する（[execute.ts:5586-5589](../../src/execute.ts#L5586)）。したがって既存関数に任せず、IMPORT専用の共通preflightとして明示的に追加する。
- キーは `keyFields[]` の全要素からなる複合キーで比較する（ASTも配列契約、[ast.ts:655-666](../../src/types/ast.ts#L655)）。正規化は既存 `upsertNormalizedKey(parts,numeric)` と転送先 `fieldTypes` を再利用し、空キーは既存 `ERR_KEY_EMPTY` とする。キーは全て `INTO fields` に含む必要がある（[execute.ts:4250-4256](../../src/execute.ts#L4250)）。`RECORD_NUMBER` は非書込み型（[execute.ts:3939-3942](../../src/execute.ts#L3939)）なので v1 のキーに指定不可とする。

### 13.4 loader順序・単一契約・byte上限（P1-4）

- 方式 (b) を採る。公開型を次で固定する: `ImportSourceHandle = { load(): Promise<{bytes:Uint8Array; encoding?:"utf8"|"sjis"}> }`、`ExecuteOptions.importSource?: (name:string) => ImportSourceHandle | undefined`。resolver は**同期**で存在/capabilityだけを返し、bytes取得は `load()` まで遅延する。`hasImportSource` と非同期loaderの二本立てにはしない。
- 実行順は (1) `importSource(sourceName)` を同期呼出しして handle の存在を確認、なければ `UnsupportedSourceError`、(2) B34相当の転送先フィールド検証、(3) `handle.load()`、(4) byte上限検査、(5) decode/CSV parse/射影、(6) IMPORT UPSERT重複preflight、DML検証/CHECK/confirm、書込み、とする。現行 INSERT/UPSERT SELECT が源取得より先に転送先を検査する順序（[execute.ts:4735-4742](../../src/execute.ts#L4735), [execute.ts:5587-5594](../../src/execute.ts#L5587)）を維持できる。handle と `load()` の Promise/結果は**文単位でキャッシュ**し、同じ文内で3経路から再解決・再読込しない。バッチの別文は別キャッシュとする。
- `hasHeader` と `columns` はSQL ASTだけが所有し、loaderは供給しない。loaderが返せるメタは任意 `encoding` だけとし、SQLの `ENCODING` があればSQL優先、双方なければ UTF-8 とする。これでR3の「戻りはencodingのみ」と「loaderがhasHeader/columnsも供給」の矛盾を解消する。
- 最大サイズは **10 MiB = 10,485,760 bytes/文/source**。共有エンジンの `IMPORT_SOURCE_MAX_BYTES` 既定値と `ExecuteOptions.importMaxBytes?: number`（正整数、既定10 MiB）で管理し、CLI/MCP/pluginはいずれも解決値を options に渡す。`load()` 後、decode前に `bytes.byteLength` を検査し、超過は `ArgumentError: import source <name> exceeds max bytes (<limit>).`、書込み0件とする。行数上限はbyte上限とは別に既存 `tempTableMaxRows` 相当を適用する。現行の実行上限が `ExecuteOptions` に集約され（[execute.ts:350-370](../../src/execute.ts#L350)）、バッチ実体化上限も各面から渡される（[cli/index.ts:2088-2106](../../src/cli/index.ts#L2088), [tools.ts:711-721](../../src/mcp/tools.ts#L711), [desktop.ts:2008-2021](../../src/ui/desktop.ts#L2008)）構造に合わせる。

### 13.5 CSV列名・構文・公開型（P2）

- 構文は§2・§5を含め全て `FROM CSV <source>` に統一する。`<source>` は識別子またはバッククォート識別子で、文字列pathは受け付けない。
- HEADER時はBOM除去後の第1レコードを列名とし、trimや大小文字変換をせず完全一致で扱う。空ヘッダ名と重複ヘッダ名は、データ行の有無にかかわらず列番号付きParseError。HEADER時の `COLUMNS` は禁止する。`NO HEADER COLUMNS(c1,...)` は列数と各データ行幅の一致、空名なし、一意を必須とする。`NO HEADER` で `COLUMNS` 省略時は最初のデータ行幅から `c1..cn` を生成し、後続行も同幅を必須とする。CSV 0データ行は§3.5どおりエラー。
- `ImportStatement`、`DmlSource`、`ImportEncoding`、`ImportSourceHandle` は export し、トップレベル `Statement` union（現状の列挙箇所 [ast.ts:15-34](../../src/types/ast.ts#L15)）と `ExplainStatement.query` に IMPORT を追加する。`ExecuteOptions` には §13.4 の `importSource` と `importMaxBytes` を追加する。共有コアは `Uint8Array` だけを扱い、Node `fs`・DOM `File`・MCP入力形式を持ち込まない。

### 13.6 各実行面の配線範囲（P2）

- **CLI**: `--import-csv <name>=<path>`（複数可）をparseし、同期resolverでnameを引き、handleの `load()` 内だけでfs読込する。単文 `execute` と `executeBatch` の両optionsへ `importSource`/`importMaxBytes` を渡す。現行の両呼出し位置は [cli/index.ts:2088-2121](../../src/cli/index.ts#L2088)。同名指定は引数エラー、未参照sourceは読まない。
- **MCP**: `ksql_mutate` とDMLを許可するsaved-query入力に名前付きinline source（base64またはUTF-8 textの排他的union）と `importMaxBytes` を追加し、decodeしたbytesを返すhandle mapをruntimeから単文/バッチへ渡す。現行のmutate単文/バッチoptions配線は [tools.ts:700-730](../../src/mcp/tools.ts#L700), [tools.ts:782-804](../../src/mcp/tools.ts#L782)。read-only toolはIMPORTを拒否する。
- **plugin**: 実行前pickerで選択した `File` をsource名へ束縛し、handleの `load()` で `arrayBuffer()` を読む。単文とバッチ双方へoptionsを渡す（現行呼出し [desktop.ts:2008-2021](../../src/ui/desktop.ts#L2008), [desktop.ts:2166-2174](../../src/ui/desktop.ts#L2166)）。未束縛sourceは実行前エラー。ビルド生成物 `plugin/js/desktop.js` は直接編集しない。
- parser/analyze、単文dispatch、batchのDML分類・`VALIDATE ONLY`/`ON ERROR SKIP INTO` temp依存、EXPLAIN、CLI/MCP/pluginの入力schema/help、共有コアと各面の単体/統合testまでをv1実装範囲とする。

### 13.7 工数・SemVer・着手判定

- R3の11〜18人日は、共通入口を `MaterializedTable` に揃える3経路再編、CHECKのWeakMap依存除去、式型メタ推論、全UPSERT経路の重複preflight、3実行面の入力/UI・単文/バッチ全面配線を過小評価していた。現実的な段階見積りは、(1) AST/parser/analyze/EXPLAIN **3〜4人日**、(2) 共通materializer・3経路再編・CHECK改修 **4〜6人日**、(3) CSV decode/parser/列契約/byte・row上限 **3〜4人日**、(4) 射影評価・参照収集・型メタ推論 **3〜4人日**、(5) UPSERT重複preflight/B34/B12統合 **1.5〜2.5人日**、(6) CLI/MCP/plugin配線 **3〜4人日**、(7) 非回帰・文書・release確認 **2〜3人日**。一部並行化を見込み合計 **17〜27人日**（レビュー修正を除く）。
- 新文・新公開option・各面入力の追加であり既存SQLの意味を変えないため **SemVer minor**。R4のP1×4は確定したので、Claude reviewで新たなP1が出ない限り**フラットCSV実装着手可**。サブテーブル等v2項目は着手条件に含めない。

### 13.8 Claude レビュー用の要確認ポイント

1. `MaterializedTable` への統一で、CHECK経路に `SelectResult`/WeakMap依存が残らず、通常INSERT/UPSERTの位置対応も維持されているか。
2. CASE・関数引数・算術・`||`までの再帰参照収集と、混在/導出不能をstringへ倒す型メタ規則がB37比較契約と矛盾しないか。
3. IMPORT UPSERTの重複preflightが処分句に左右されず、kintone照合read・confirm・書込みより前に全件拒否するか。
4. 同期resolver→B34→`load()`→byte検査の順序と文単位cacheが、単文/バッチ/CHECKの全dispatchで一貫するか。
5. `hasHeader`/`columns` はSQL、bytes/任意encodingはloaderという責務分離、10 MiB上限、HEADER/NO HEADER列名契約が各面とtestに同じ形で露出するか。
6. CLI/MCP/pluginの単文・バッチ双方、DML分類、temp error table、EXPLAIN、help/schemaまで配線漏れがないか。

---

## 13.9 Claude レビュー結果（R4・2026-07-19・承認・実装着手可）

codex 執筆の §13 を Claude がコードで裏取り。**判定＝承認・フラット CSV IMPORT は実装着手可**。P1×4 はいずれも現行契約に沿って正しく解決されている。

### 裏取りで正確だった点
- §13.1: `MaterializedTable`（[execute.ts:244-257](../../src/execute.ts#L244)）・候補生成の WeakMap columnMeta（[execute.ts:4225](../../src/execute.ts#L4225)）・位置対応 `columns[i]→fields[i]`・CTE の `SelectResult→MaterializedTable` 変換（3043-3060）。「共通内部契約を MaterializedTable へ変更・CHECK は columnMeta 直参照」は正しい修正。
- §13.2: 既存 SELECT の列型分類（[execute.ts:1761-1785](../../src/execute.ts#L1761)＝ARITH→number・STRFUNC→関数メタ・LITERAL/CASE/SCALAR_VALUE→string）と、射影後型推論規則（算術/CAST NUMBER=number・文字列関数/CONCAT/||=string・CASE 共通型・導出不能=string）が整合。`ScalarValueExpr`/CASE/関数引数の再帰走査も AST（ast.ts:774/342/302）と一致。
- §13.3: `ERR_KEY_DUP_SOURCE` は候補生成のみ（[execute.ts:4271](../../src/execute.ts#L4271)）・通常 UPSERT は insert/update 振り分け（5626）→ IMPORT 専用の共通 preflight 追加は妥当。複合キー・RECORD_NUMBER 非対応も正。
- §13.4: `ExecuteOptions`（350-370）・CLI/MCP/plugin の options 配線（cli:2088・tools:700/782・desktop:2008/2166）確認。同期 resolver＋遅延 `load()`＋文単位 cache・hasHeader/columns は SQL・10 MiB 上限は R3 の契約矛盾を解消。

### codex 6 確認ポイントへの回答
1. MaterializedTable 統一で CHECK の WeakMap 依存除去・位置対応維持＝OK（§13.1 のとおり）。
2. 再帰参照収集と混在/導出不能→string の型規則は B37 比較契約（columnMeta 由来）と矛盾しない＝OK。
3. IMPORT UPSERT の重複 preflight が処分句非依存・照合read/confirm/書込み前に全件拒否＝OK。
4. 同期 resolver→B34→`load()`→byte 検査の順序・文単位 cache が3経路で一貫＝OK（§13.4）。
5. hasHeader/columns=SQL・bytes/任意 encoding=loader の責務分離・10 MiB・列名契約＝OK。
6. CLI/MCP/plugin の単文/バッチ・DML 分類・temp error table・EXPLAIN・help/schema の配線範囲＝§13.5/13.6 で網羅。

### 観察（実装時に留意・ブロッカーではない）
- **IMPORT UPSERT は通常 `UPSERT … SELECT` より厳格**＝源内キー重複を無条件拒否する（通常 UPSERT SELECT は振り分けて処理）。CSV 取込の安全契約として妥当だが、両者の挙動差を言語リファレンス/レシピに明記すること（利用者が「UPSERT SELECT と同じ」と誤解しないため）。

**着手条件**: §13 の確定（共通 materializeDmlSource・型メタ推論・重複 preflight・同期 loader・10 MiB）を守り、共通基盤→CSV パーサ/loader→3経路接続→各面配線→回帰の順。サブテーブル/添付/レコード番号キー/CSV↔アプリ JOIN は v2。
