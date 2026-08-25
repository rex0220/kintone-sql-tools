# B175 `KLIKE` 索引反映ラグ — EXPLAIN 注記仕様 R1

- 状態: **R1 仕様確定・実装待ち**。B173 のリリースに同梱し、B175 単独のリリースは切らない。
- 対象: 同一バッチ内の書込後に、同じ kintone アプリを `KLIKE` で読む文がある場合の **EXPLAIN への静的な助言行追加**。
- 前提（レビュー対象外として受け取った決定事項）:
  - 今回は **EXPLAIN の注記だけ**を実装し、実行結果の `warning` は追加しない。`/flow` の `StatementResult` に `warnings` の格納先がなく（`src/flow-library/publicTypes.ts:258-270`）、通常バッチの警告マージ経路（`src/execute.ts:1720-1729,1757-1763`）も managed `/flow` 経路（`src/execute.ts:1944-1950`）には適用されないためである。
  - 言語リファレンスへの明記は実施済みであり、本対応の主目的にしない（`docs/internal/ksql_b175_klike_index_lag_issue.md:115-121`）。
  - 自動待機は実装しない。索引ラグの上限は未測であり、待ち時間を仕様化しない（`docs/internal/ksql_b175_klike_index_lag_issue.md:169,175-179`）。
  - 影響範囲は `KLIKE` に限定する。`=`、`IN`、`$id`、JS 評価の `LIKE` は対象外とする（`docs/internal/ksql_b175_klike_index_lag_issue.md:26-44,64-76`）。
  - 将来の第2段階である実行時 `warning`、`StatementResult.warnings`、B143 案Aは今回実装しない（`docs/internal/ksql_b175_klike_index_lag_issue.md:150-167`）。

## 1. 目的

kintone の全文検索索引はレコード本体と同時に可視化されるとは限らない。同一バッチで書込直後に `KLIKE` を実行すると、エラーを返さず一致レコードを取りこぼすことがある（`docs/internal/ksql_b175_klike_index_lag_issue.md:12-44`）。

実行結果、API呼出回数、エラー契約を変更せず、バッチを実行する前の EXPLAIN に危険な文順を示す。`ExplainScriptResult.statements[].plan` は既に `string[]` であり、行の追加に公開型変更は不要である（`src/flow-library/publicTypes.ts:121-124`）。

## 2. 非目標

R1では次を行わない。

- SQL実行前後の自動待機
- 書込や読取の再試行
- `KLIKE` から `LIKE` への自動書換え
- 実行結果への `warning` 追加
- `StatementResult`、MCPレスポンススキーマその他の公開型変更
- 索引ラグの秒数、上限、解消時間の保証
- `KLIKE` の一致規則変更
- `LIKE`、`=`、`IN`、`$id` に対する注記
- 単文 EXPLAIN への注記
- R18のレシピ変更。R18は書込が最後なので、現行の定石どおりなら該当しない（`docs/internal/ksql_b175_klike_index_lag_issue.md:76`）。

## 3. 判定条件

### 3.1 基本条件

次の条件をすべて満たす後続文の `plan` に、§4の注記を1回だけ追加する。

1. パースされた文が2文以上ある。
2. 後続文より前に、§3.2の書込文が存在する。
3. 後続文のいずれかの SELECT スコープに `KLIKE` が存在する。
4. その `KLIKE` が読むアプリと、先行書込文の書込先アプリが§3.3の意味で同一である。

文順の比較には0-indexedの内部値ではなく、単純な配列上の先行・後続関係を使う。EXPLAIN の公開結果に文番号を含める必要はない。

同じ後続文が複数の先行書込や複数の `KLIKE` に該当しても、注記はその後続文に1回だけ出す。

### 3.2 書込文の範囲

書込文には次を含める。

- `INSERT`（`INSERT ... SELECT` を含む）
- `UPDATE`
- `DELETE`
- `UPSERT`（`UPSERT ... SELECT` を含む）
- `IMPORT`

`APPLY` は独立した文種ではなく `INSERT`、`UPDATE`、`UPSERT` 内の書込句なので、親文が実書込であれば書込文に含める。APPLY付きかどうかによって判定を分岐させない。

`VALIDATE ONLY` など、静的に kintone mutation API を呼ばないことが確定している文は書込文から除外する。現行でも `writesKintone` は DML かつ `validateOnly !== true` を実書込としている（`src/core/dmlGuard.ts:25-33,56-63`）。

`REORDER` は起票時に確定した書込文集合に含まれておらず、索引ラグとの関係も未測のためR1では除外する。追加する場合は実測または別途判断を要する。

### 3.3 「同じアプリ」の判定

「同じアプリ」は、SQL表記上の名前や正規化後の仮想IDではなく、次の正規化済み実行先識別子で比較する。

```text
(profile, physical appId)
```

これにより、次のように扱う。

- 同じ profile・同じ物理 appId: 同一
- 同じ数値 appIdでも profileが異なる: 別アプリ
- `LAPP_<NAME>` と、その解決先である同じ profile・同じ物理 `APPn`: 同一
- 異なる論理名が同じ実体を指す場合: 同一として扱う
- `APPn$tbl` と親の `APPn`: 同一

`LAPP_<NAME>` はパース前に仮想 `APP<mappedAppId>` へ正規化されるが、bindingには元の物理 `appId` と `profile` が保持される（`src/core/logicalApps.ts:33-46,235-269,303-327`）。物理参照と論理参照は同じ実体でも別の `mappedAppId` になることが既存テストで固定されている（`src/node/__tests__/appProfiles.test.ts:109-124`）。したがって、仮想ID同士の単純比較だけで確定してはならない。

各EXPLAIN面が既に持つ静的な app binding を共通計画生成へ渡し、そこで `(profile, physical appId)` に正規化する。これはSQL設定の解決結果だけを使い、フォーム定義その他の追加メタデータ取得を行わない。

サブテーブル仮想テーブルは独立したkintoneアプリではない。テーブル参照の `subtableCode` を同一性キーに含めず、親 `appId` で比較する。現行AST収集も正の `appId` を文の参照アプリとして収集している（`src/core/batch.ts:127-150`）。

### 3.4 `KLIKE` が読むアプリの特定

判定はASTだけで行い、フォーム定義を使わない。

SELECTスコープごとに `KLIKE` の左辺が属する物理テーブルを求める。

- テーブル修飾されたフィールドなら、そのaliasに対応する物理テーブルを対象とする。
- 物理ソースが1つだけなら、そのアプリを対象とする。
- 修飾なしで複数物理ソースがあり、フォーム定義なしでは所属を一意に決められない場合は、そのSELECTスコープの全物理ソースを候補とする。
- CTE、一時テーブル、FROMなしSELECTのプレースホルダーは物理アプリとして扱わない。
- サブクエリ内の `KLIKE` は、そのサブクエリ自身のSELECTスコープで判定する。

最後の曖昧ケースは誤検知を許容するが、危険な取りこぼしを見逃さないための安全側判定である。追加のフォーム定義取得によって厳密化してはならない。

`NOT KLIKE` は同じ全文検索索引経路を使う演算子群として静的検出対象に含める。ただし、書込直後の `NOT KLIKE` の結果方向は実機未確認であり、§10に未確認事項として残す。共通の静的検証も `KLIKE` と `NOT KLIKE` を同じ演算子群として扱っている（`src/core/klikeValidation.ts:145-159,228-246,255-260`）。

### 3.5 CTE・一時テーブル

#### CTE

CTE定義内に `KLIKE` がある場合、CTEを含むトップレベル文を注記対象とし、CTE定義内で実際に読む物理アプリと先行書込先を比較する。

```sql
UPDATE APP100 SET 状態 = '更新' WHERE $id = 1;

WITH x AS (
  SELECT * FROM APP100 WHERE 状態 KLIKE '更新'
)
SELECT * FROM x;
```

この例では2文目の `plan` に注記を出す。

#### 一時テーブル

```sql
UPDATE APP100 SET 状態 = '更新' WHERE $id = 1;

CREATE TEMP TABLE #t AS
SELECT * FROM APP100 WHERE 状態 KLIKE '更新';

SELECT * FROM #t;
```

この例では、実際に `KLIKE` を実行する2文目の `CREATE TEMP TABLE` の `plan` に注記を出す。3文目は既に実体化された `#t` を読むだけなので注記を出さない。

逆に、書込より前に `KLIKE` で一時テーブルを作成し、書込後にその一時テーブルだけを読む場合は注記を出さない。

一時テーブルの参照・生成元依存は既存の静的解析が文単位で保持している（`src/core/batch.ts:71-89,379-407,441-469`）。ただしB175では、後続の一時テーブル参照へ注記を伝播させず、`KLIKE` を含む実読取文だけを対象にする。

### 3.6 SELECT以外の包含文

トップレベルの文種名だけで対象を `SELECT` に限定しない。次のように、内部のSELECTが `KLIKE` を実行する文も対象とする。

- `ASSERT`
- `WITH`
- `UNION`
- `CREATE TEMP TABLE ... AS SELECT`
- スカラサブクエリを持つ `SET`
- 条件評価にサブクエリを持つ `EXIT`

`ASSERT`、`EXIT`、変数文のnested SELECTも現行のKLIKE静的検証対象である（`src/core/klikeValidation.ts:45-67`）。

### 3.7 単文実行

文数が1文の場合は注記を出さない。

単文には「同一バッチ内の先行書込」が存在しないためである。MCPも現在、複数文だけを共通バッチEXPLAINへ渡し、単文は既存の単文EXPLAIN経路へ送っている（`src/mcp/tools.ts:679-706,721-730`）。

`/flow` など単文でも共通計画生成を呼ぶ面では、共通判定側で `statementCount >= 2` を必須条件にする。

### 3.8 書込結果が0件の場合

注記を出す。

EXPLAINでは書込対象件数を実行せず、実際に0件になるかを一般には確定できない。静的に実書込文である以上、後続の同一アプリ `KLIKE` に注記する。

`WHERE 1 = 0` など一部を特別扱いして注記を消す最適化はR1では行わない。既定結果やAPI呼出しを変えず、見逃しより余分な注記を優先する。

## 4. 注記文言

後続の該当文の `plan` 末尾に、次の1行をそのまま追加する。

```text
    reference: 同一バッチの書込後に同じアプリを KLIKE で読むと、検索索引の反映前は一致レコードを取りこぼし得る。回避は LIKE を使うか、書込文を最後に置く
```

要件は次のとおり。

- 先頭は既存の助言行と同じ `reference:` とする。
- 既存の `bulkRequest` 助言行と同じ、簡潔な常体にする（`src/execute.ts:12844-12856`）。
- 秒数、待機時間、ラグ上限を書かない。
- 原因がkintone検索索引の反映であることを示す。
- 回避策として以下の2つを示す。
  - 全文検索索引を使わない `LIKE` を使う。
  - 書込文をバッチの最後に置く。
- アプリ名や文番号を文言へ埋め込まない。これにより、論理アプリ名の復元処理を経ても5面で文字列を完全一致させる。

`NOT KLIKE` を検出した場合もR1では同じ文言を出す。文言を複数形にしたり、別メッセージを追加したりしない。

## 5. 注記を置く文

注記は **`KLIKE` を含む後続の読取文だけ**に出す。

先行書込文の `plan` には出さない。両方にも出さない。

理由は次のとおり。

- 修正すべき位置は、索引反映前の結果を利用する後続読取文である。
- 1つの書込に複数の危険な読取が続く場合、それぞれの危険箇所を識別できる。
- 書込文へ出すと、後続のどの文が危険なのか判別できない。
- 両方へ出すと同じ助言が重複し、EXPLAINが読みにくくなる。

注記は当該文の既存 `plan` の最後に追加する。先頭行や既存計画行の順序は変えない。

## 6. dialect

dialect 0、dialect 1の両方で同じ注記を出す。

現行のdialect 1 API見積りは `meta.dialect === 1` のときだけ追加される（`src/execute.ts:12757-12771`）が、B175判定をその条件内へ置いてはならない。B175注記はAPI見積りとは独立して末尾へ追加する。

## 7. API・実行契約

B175判定は、SQLの文列、AST、既存のapp bindingだけで完結させる。

次を禁止する。

- `getRecords`
- Cursor API
- POST、PUT、DELETEその他のmutation API
- B175判定のための `getFields`
- B175判定のための数値精度、プロセス管理その他のメタデータ取得
- 待機、ポーリング、再試行

共通バッチEXPLAINは現在「metadata API以外の実行APIは呼ばない」と明記されている（`src/execute.ts:12636-12653`）。B175によって既存のメタデータ取得回数も増やしてはならない。`resolveMetadata=false` の場合でも同じ注記を出せなければならない。

通常実行、preview、batch実行、managed `/flow` 実行のコードパスにはB175判定を追加しない。したがって、既定の結果、API呼出回数、エラー、`warnings` はすべて変更しない。

## 8. 5面への到達

共通のバッチ計画結果へ注記を追加し、各面の既存整形をそのまま利用する。

- CLIは各 `plan` 行をそのまま標準出力へ展開する（`src/cli/index.ts:2348-2365`）。
- MCPは複数文の `statements` を返し、各 `plan` 配列を保持する（`src/mcp/tools.ts:705-727`）。
- プラグインは共通計画を直接返し（`src/ui/batchExplain.ts:4-31`）、画面用SelectResultへ各行をそのままコピーする（`src/ui/desktop.ts:1998-2023`）。
- engine-libraryは各文の `plan` を `lines` へ平坦化する（`src/engine-library/query.ts:120-143`）。
- flow-libraryは共通計画結果を `ExplainScriptResult` としてそのまま返す（`src/flow-library/index.ts:76-100`）。

面ごとの文言変更、独自判定、独自注記は禁止する。

## 9. 変更ファイル

### 9.1 実装で変更するファイル

- `src/execute.ts`
  - 書込先と後続 `KLIKE` 読取先を静的に照合する処理を追加する。
  - 該当する後続文の `plan` 末尾へ§4の固定文言を1回追加する。
  - app bindingから正規化済み実行先識別子を受け取る任意引数または同等の内部入力を追加する。
  - API呼出しを追加しない。

- `src/cli/index.ts`
  - 既存の `appBindingByMappedApp` を、共通バッチEXPLAINのアプリ同一性判定へ渡す。
  - 出力整形は変更しない。CLIは既に正規化結果を保持している（`src/cli/index.ts:1873-1881,2350-2364`）。

- `src/mcp/tools.ts`
  - 既存の正規化結果に含まれるapp bindingを共通判定へ渡す。
  - MCPレスポンス型と整形は変更しない（`src/mcp/tools.ts:674-706,721-727`）。

- `src/flow-library/index.ts`
  - `parseWithBindings` が保持しているapp bindingを共通判定へ渡す。
  - `ExplainScriptResult` は変更しない（`src/flow-library/index.ts:76-100,269-289`）。

- `src/engine-library/logicalApps.ts`
  - 論理アプリだけでなく、B175の同一性比較に必要な正規化済みbindingを内部結果として保持する。
  - 公開結果へbindingを追加しない。現行の内部戻り値は `sql`、`client`、`logicalBindings` である（`src/engine-library/logicalApps.ts:10-24`）。

- `src/engine-library/query.ts`
  - engine-libraryが保持するbindingを共通判定へ渡す。
  - `lines`、`text`、構造化fetch planの公開形は変更しない（`src/engine-library/query.ts:120-145`）。

### 9.2 追加するテストファイル

- `src/__tests__/b175KlikeIndexLagExplain.test.ts`
  - 共通判定の正例・負例・dialect・CTE・一時テーブル・APPLY・0件見込み・サブテーブル・論理アプリ同一性を固定する。

- `src/cli/__tests__/b175_klike_index_lag_explain.e2e.test.ts`
  - CLI出力に固定文言が1回現れることを確認する。

- `src/mcp/__tests__/b175KlikeIndexLagExplain.test.ts`
  - MCPの該当文 `plan` に固定文言が現れることを確認する。

- `src/ui/__tests__/b175KlikeIndexLagExplain.test.ts`
  - プラグイン面の該当文 `plan` に固定文言が現れることを確認する。

- `src/engine-library/__tests__/b175KlikeIndexLagExplain.test.ts`
  - engine-libraryの `lines` と `text` に固定文言が現れることを確認する。

- `src/flow-library/__tests__/b175KlikeIndexLagExplain.test.ts`
  - `explainScript` の該当文 `plan` に固定文言が現れることを確認する。

### 9.3 状態同期だけを行う文書

- `docs/internal/ksql_b175_klike_index_lag_issue.md`
  - 実装完了時に冒頭状態を「EXPLAIN注記実装済み」に更新する。
  - 実測内容、秒数、一致規則の再編集はしない。

- `docs/ksql_issue_tracker.md`
  - B175行をB173同梱済みの状態へ更新する。現行行は「起票のみ」となっている（`docs/ksql_issue_tracker.md:42`）。

### 9.4 変更しないファイル

- `src/flow-library/publicTypes.ts`
  - `ExplainScriptResult`、`StatementResult`とも変更しない。

- `src/ui/batchExplain.ts`
  - 共通計画生成の呼出しと返却形は維持する。論理アプリbindingのないプラグイン面では物理appId比較だけで足りる。

- `src/ui/desktop.ts`
  - 行の描画処理は変更しない。

- `src/core/batch.ts`
  - 既存のバッチ解析結果と公開型は変更しない。B175専用判定はEXPLAIN側に閉じる。

- `src/core/dmlGuard.ts`
  - DML・実書込の既存分類を変更しない。

- `src/core/klikeValidation.ts`
  - `KLIKE` の静的使用制約を変更しない。

- `src/mcp` の入力・出力スキーマ定義
  - 新フィールドを追加しない。

- `docs/ksql_language_reference.md`
  - 案Aは実施済みなのでR1では再編集しない。

- `docs/ksql_batch_recipes.md`
  - R18は書込が最後という既存形を維持する。

- `docs/internal/ksql_b143_explain_warnings_issue.md`
  - B143案AやEXPLAINの `warnings` は実装しない。

## 10. 受入条件

### AC-1 基本正例

同一バッチで `APP100` への書込後に、`APP100` を `KLIKE` で読むと、後続読取文の公開 `plan` に§4の固定文言がちょうど1回現れる。

### AC-2 注記位置

§4の固定文言は `KLIKE` を含む後続文の `plan` にだけ現れる。先行書込文の `plan` には現れない。

### AC-3 複数一致

同じ文に複数の `KLIKE`、または同じアプリへの複数の先行書込があっても、その文の注記は1回だけである。

### AC-4 dialect

同じSQL構造について、dialect 0とdialect 1の両方で固定文言が現れる。文言は完全一致する。

### AC-5 5面同値

CLI、MCP、プラグイン、engine-library、flow-libraryで、§4の固定文言が文字列として完全一致する。各面のラベル、JSON envelope、表形式の差は許容するが、注記本文の変更・欠落は許容しない。

### AC-6 論理アプリ

次の各ケースで同一アプリとして注記が出る。

- 同じ `LAPP_<NAME>` への書込と読取
- `LAPP_<NAME>` と、その解決先である同一profileの物理 `APPn`
- 表記は異なるが `(profile, physical appId)` が同じbinding

同じ数値appIdでもprofileが異なる場合は注記が出ない。

### AC-7 サブテーブル

`APP100$tbl` と `APP100` は親アプリが同じなので同一アプリとして扱う。異なる親アプリでは注記が出ない。

### AC-8 CTE

先行書込後のCTE定義内で同じアプリを `KLIKE` すると、CTEを含む文の `plan` に注記が出る。

### AC-9 一時テーブル

先行書込後の `CREATE TEMP TABLE ... AS SELECT ... KLIKE ...` ではCREATE文に注記が出る。その一時テーブルを読むだけの後続文には注記が出ない。

書込前に作成済みの一時テーブルを、書込後に読むだけの文にも注記が出ない。

### AC-10 APPLY

実書込となるINSERT/UPDATE/UPSERTのAPPLY付き文は先行書込として扱う。`VALIDATE ONLY` のAPPLY付き文は先行書込として扱わない。

### AC-11 0件見込み

先行 `UPDATE` または `DELETE` が実行時に0件となる条件でも、静的には注記が出る。

### AC-12 単文

単文の `SELECT ... KLIKE ...`、単文EXPLAINには注記が出ない。

### AC-13 文順

次の場合は注記が出ない。

- `KLIKE` 読取が書込より前
- 書込がバッチの最後
- 書込と `KLIKE` 読取のアプリが異なる
- 書込文がない
- `VALIDATE ONLY` しかない

### AC-14 非対象述語

`LIKE`、`=`、`IN`、`$id` だけを使う後続読取には注記が出ない。

### AC-15 API契約

B175該当・非該当のどちらでも、EXPLAINはレコードAPI、Cursor API、mutation APIを呼ばない。

B175判定の有無によってメタデータAPI呼出回数も変わらない。`resolveMetadata=false` でも注記が出る。

### AC-16 実行非回帰

同じバッチを通常実行した結果、API呼出回数、エラー、`warnings` はB175対応前後で変わらない。変更が観測できるのはEXPLAINの追加行だけである。

### AC-17 既存計画行

§4の行を除き、各文の既存 `plan` の内容と順序は変わらない。

## 11. 既存テストへの影響

`src/__tests__/b168Stage5ExecutionExplain.test.ts:77-82` はdialect 1のAPI見積りと既存 `bulkRequest` 助言行を部分一致で固定している。B175の試験SQLには危険な `KLIKE` がないため、この期待値は変更しない。既存の `reference: bulkRequest ...` 文言も変更しない。

`src/__tests__/b168Stage5ExecutionExplain.test.ts:86-100` のdialect 0試験は「estimated API consumptionがない」ことを確認しているだけであり、SQLに危険な `KLIKE` がないため非回帰のままとする。

`src/__tests__/explain.test.ts:857-874` など、`plan` 配列を完全一致で固定する既存テストについても、該当SQLに「先行書込後の同一アプリ `KLIKE`」がなければ期待値を更新してはならない。

実装時には、次を全件検索して確認する。

- `plan` 配列の `toEqual` / `toStrictEqual`
- EXPLAINのsnapshot、inline snapshot
- CLI dry-runの標準出力固定値
- MCP、flow、engine-libraryの `lines` / `text` / `statements[].plan` 固定値

既存テストがB175条件に該当して初めて、§4の1行だけを期待値へ追加する。無関係なsnapshotの一括更新は禁止する。

## 12. Claudeが実機で確認すべき未確認事項

次はR1の静的注記実装を妨げないが、実機事実として未確認である。

1. `UPDATE` 直後の全文検索索引ラグ
2. `DELETE` 直後の全文検索結果への影響
3. `UPSERT` 直後の索引ラグ
4. `IMPORT` 直後の索引ラグ
5. APPLYで親フィールド、複数選択、サブテーブルを変更した直後の索引ラグ
6. 書込対象フィールドと `KLIKE` 対象フィールドが異なる場合の再索引挙動
7. サブテーブル変更後に、親またはサブテーブル仮想テーブルを `KLIKE` した場合の挙動
8. `NOT KLIKE` で索引反映ラグが結果へ与える方向と再現率
9. 日本語トークンでの索引ラグ。現行実測は英数字だけである（`docs/internal/ksql_b175_klike_index_lag_issue.md:175-179`）。
10. 大量書込、大規模アプリ、高負荷環境でのラグ上限。仕様へ秒数は反映しない。
11. CLI、MCP、プラグイン、engine-library、flow-libraryの各実機・実ランタイムで、固定文言が欠落せず同一になること。
12. 各面のEXPLAIN実行時に、B175追加によるレコードAPI呼出しや追加メタデータ取得がないこと。
13. `LAPP_<NAME>` と同じ実体の物理 `APPn` を混在させたバッチで、ルーティング先とB175の同一性判定が一致すること。

1〜10の結果によって、R1の静的判定を狭めてはならない。判定を広げる必要が判明した場合は、実測根拠を付けてR2または別課題で扱う。
---

## 13. レビュー結果 R1（2026-08-25・Claude）

分担は [[spec-and-impl-by-codex]]（codex が仕様と実装、Claude がレビュー・実測・リリース）。静的な主張は file:line を開いて突き合わせ、**動的な主張は実機で測った**（§13.2）。

**総評: 構成と契約は正しい。ただし実測で「書込文の範囲」が広すぎることが分かった。** R2 で 3 件（うち 1 件はオーナー判断）。

**評価できる点**（R2 でも変えない）:

- **§7 の API 契約**が明示的（レコード API・Cursor・mutation・B175 のための `getFields` を禁止し、`resolveMetadata=false` でも注記が出ることを要求）。EXPLAIN の既存契約を壊さない
- **§5「注記は `KLIKE` を含む読取文だけに置く」**の判断と理由づけ（直すべき位置は後続読取文であり、書込文へ出すとどの文が危険か判別できない）
- **§11 の既存テストの扱い**＝「無関係な snapshot の一括更新は禁止」「該当して初めて 1 行だけ追加」。[B141](ksql_b141_doc_sql_unverified_issue.md) の再発を防ぐ形になっている
- **§3.3 の論理アプリ同一性の指摘は正しい**（§13.3 で実測確認）

### 13.1 R2 で直すこと

#### [Major] 書込文の範囲が実測より広い（§3.2）— **誤検知を減らせる**

§3.2 は `INSERT` / `UPDATE` / `DELETE` / `UPSERT` / `IMPORT` を一律に書込文とするが、**実測すると危険なのはその一部だけ**だった（§13.2）。

| 書込の種類 | 実測 | R2 での扱い |
|---|---|---|
| `INSERT`（新規レコード） | **新値が引けない 6/8** | **含める** |
| `UPDATE` で **`KLIKE` 対象フィールドを書く** | **新値が引けない 6/8・旧値が残る 4/8** | **含める** |
| `UPDATE` で **`KLIKE` 対象フィールドを書かない** | **0/8**（既に索引済みの値は消えない） | **除外できる** |
| `DELETE` | **0/8**（削除は即時に索引から消える） | **除外できる** |
| `UPSERT` / `IMPORT` | 挿入し得るので `INSERT` と同じ | 含める |

→ **判定を「書込文の書込フィールド集合 ∩ `KLIKE` 対象フィールド ≠ ∅、または挿入し得る文（INSERT / UPSERT / IMPORT）」に絞れる。** 書込フィールド集合も `KLIKE` の対象フィールドコードも**AST から静的に取れる**ので、追加 API はゼロのまま。

**絞る価値**＝「別フィールドを更新してから `KLIKE` で読む」は普通に書かれる形であり、そこに注記が出ると [B140](ksql_b140_cte_groupby_total_order_issue.md) の警告疲れになる。**実測で無害と分かっている形に注記を出さない。**

**フォールバック**: `KLIKE` の対象フィールドが静的に決まらない場合（§3.4 の曖昧ケース）は**含める側**に倒す。

#### [Major] 注記の回避策の順序が危険（§4）— **助言どおりに直すと別のエラーになる**

現行案の文言は `回避は LIKE を使うか、書込文を最後に置く` で、**`LIKE` を先に挙げている**。

しかし言語リファレンスは `LIKE` について「**FULL_SCAN になり…大規模アプリでは取得上限（`maxRecords`）に達してエラーになりがち**」と明記しており、**`KLIKE` を使っている利用者は定義上その大規模アプリにいる**（`KLIKE` を選ぶ理由がそれ）。**助言どおり `LIKE` に置き換えると `FetchAllLimitError` に落ちる。**

→ **順序を入れ替え、「書込文をバッチの最後に置く」を第一の回避策にする。** `LIKE` は副次として、**取得上限に触れる限定を付ける**か落とす。

[[check-sibling-path-when-fixing]]（助言を出す機能には、助言をそのまま実行するテストを 1 本）に該当する。**同じ誤りが案 A で入れた言語リファレンスの文にもあるので、そちらも直す。**

#### [新事実] 「件数が減るだけ」ではない — **旧値に当たる偽陽性も出る**（§1・§4）

起票文書と仕様は「取りこぼす／件数が減る」とだけ書いているが、実測では **`UPDATE` 後に更新前の値で引くと 4/8 でヒットした**。つまり:

- 新しい条件では**引けない**（取りこぼし）
- **古い条件では引けてしまう**（本来外れるはずのレコードが返る）

→ 注記文言と起票文書を「**索引の反映前は、更新後の値で引けず、更新前の値で引けてしまうことがある**」の意味に直す。`ASSERT` ゲートが素通りするだけでなく、**古い条件のゲートが誤って成立する**形もある。

### 13.2 実機測定（2026-08-25・APP4253）

| 測定 | 結果 |
|---|---|
| 別フィールドだけ `UPDATE` した直後に、**索引済みの** `KLIKE` 対象フィールドを引く | **8/8 で ○（取りこぼしゼロ）**＝レコード全体の再索引は起きない |
| `KLIKE` 対象フィールドを `UPDATE` した直後に**新値**で引く | **6/8 で ×**（`INSERT` 直後と同率） |
| 同上、直後に**旧値**で引く | **4/8 で ○**（消えたはずの値に当たる） |
| `DELETE` 直後に削除済みレコードを引く | **8/8 で ×**（即時に索引から消える） |

各回は「投入 → 4 秒待って索引を落ち着かせる → 書込 → 直後に検索」の形。測定スクリプトは scratchpad に保存。

### 13.3 確認して問題がなかった点

- **§3.3 の `(profile, physical appId)` 正規化は正しい。** `APP1234@prod` と `LAPP_ORDERS@prod`（同じ物理 1234）は**別の `mappedAppId` になる**ことを既存テストで確認した（`src/node/__tests__/appProfiles.test.ts:109-124`）。仮想 ID の単純比較では見逃す、という指摘は正確
- **§8 の 5 面到達**。`buildBatchExplainPlans` は CLI（`src/cli/index.ts:2350`）・MCP（`src/mcp/tools.ts:706`）・プラグイン（`src/ui/batchExplain.ts:17`）・engine-library（`src/engine-library/query.ts:122`）・flow（`src/flow-library/index.ts:87`）が共有しており、**共通計画に 1 行足せば 5 面に届く**
- **§3.7 の単文除外**。MCP は複数文のときだけ共通バッチ EXPLAIN を呼ぶ（`src/mcp/tools.ts:705`）ので整合

### 13.4 オーナー判断が要る点

**[費用] 論理アプリ binding の配線を R1 に含めるか。**

§3.3 の正規化は**正しい**が、`buildBatchExplainPlans` の現行シグネチャは**15 個の位置引数で binding を受け取っていない**（`src/execute.ts:12637-12652`）。渡すには `execute.ts` に加えて CLI / MCP / flow / engine-library の `logicalApps.ts`（内部戻り値型）と `query.ts` の**計 6 ファイル**が動く。**B173 と同梱するリリースとしては重い。**

- **含めない場合の実害**＝見逃すのは「**1 バッチ内で同じ実体を `LAPP_` と物理 `APPn` の両方で参照する**」形だけ。注記は助言であり、見逃しても現状（注記ゼロ）より悪くならない
- **後から足せる**（純加法）

**見立て＝R1 は mapped(仮想) appId の比較で出し、この見逃しを仕様に明記する。** binding 配線は B175 の第 2 段階（`warning` 化）とまとめる。**ただし「見逃しを許容するか」はオーナーの判断。**

### 13.5 軽微

- **§3.4 の曖昧ケース（修飾なし・複数物理ソース → 全ソースを候補）は実際には起きない可能性がある。** 言語リファレンスは JOIN 併用時に「すべての JOIN が `INNER JOIN` で、`KLIKE` のフィールドを**テーブルエイリアスで明示した場合だけ許可**」としており、修飾なしの `KLIKE` は複数ソース時点で静的検証に弾かれるはず。**残しても害はないが、受入条件で「この分岐に入らない」ことを確認する**とよい
- §12 の未確認 13 件のうち **1・2・6 は §13.2 で解消**した。R2 では残りに絞る
