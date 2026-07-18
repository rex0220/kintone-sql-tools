# B39 別案 — IMPORT 文（CSV → アプリ書込みの自己完結ステートメント）

- 作成日: 2026-07-18
- ステータス: **設計 R1・codex レビュー済（要 R2）＋ユーザー決定反映（2026-07-19）**。bind 案の代替。codex 確認＝**IMPORT は bind 固有の難所 3 つ（APP レス実行・temp seed・temp read-only）を確実に除去**するが「源取得差替えだけ」の軽さではない。ユーザー決定＝**①空 CSV（0 行）はエラー（§3.5）②CLI 限定にしない＝loader capability で面非依存（§6）**。R2 で残 3 重大（源 materializer 共通化・ON ERROR SKIP はバッチ限定・CSV 射影の列スコープ検証）を確定すれば実装着手可。
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
