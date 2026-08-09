# B53＋B160 静的読解調査報告

調査は静的読解のみ。コード変更・ファイル書き込み・`git`・MCP・ビルド・テスト実行は行っていない。

## 結論

仕様 R2 の基本前提には、v3.65.0 と一致する部分と、実装着手前に読み替えが必要な部分がある。

- `SET` は現在も `src/lexer/tokens.ts:47,230` のハードトークンで、仕様の前提どおり。
- `RECURSIVE` / `CYCLE` / `TO` / `DEFAULT` はトークン表に存在せず、通常は `IDENT` になる。文脈限定ソフトキーワードとして追加できる字句状態は維持されている。
- 一方、v3.63.0 の `CROSS` は文脈判定ではなくハード予約語化された。直近の追加キーワード流儀は仕様 §7.3 と異なる。
- 現行 `WITH` parser は、CTE列名リストを受けず、定義本体を読み終えてからCTE名を登録する。このままでは仕様の列名リストと自己参照は成立しない。
- CTE実行基盤は、GENERATE_SERIES、共有 leaf policy、列メタ、UNION位置対応、EXPLAIN静的relation処理が追加され、R2凍結時より再利用資産が増えている。
- ただし列メタは基本的に各 SELECT の実行結果へ関連付けられる。seed/再帰項の型整合を「実行前 planning」で証明する既存経路はない。
- B158/B159 のガードは設定値ではなく共有固定値10,000であり、設定配管の新しい前例にはならない。既存 `maxRecords` の配管は5面に分散している。
- B160の警告生成点では「直接生成列か」「JOINがあるか」は見えるが、JOIN後の生成列由来追跡やpartition内一意性は保持されていない。
- 通常CTE・一時テーブル・CTE内ウィンドウはいずれも同じ警告生成・伝播経路を通る。再帰CTEも通常の実体化relationとして接続すれば同経路になる構造である。
- B158/B159は専用error codeを持たず、`ArgumentError:` 文字列を持つ通常の `Error` を投げる。仕様 §5.1の固定コード流儀とは一致しない。

---

## A. パーサ・lexer 前提

### A-1. `SET`

- enum定義は現在も `SET = "SET"`：`src/lexer/tokens.ts:47`
- keyword mapにも登録：`src/lexer/tokens.ts:230`
- lexerはkeyword mapにあれば専用TokenKind、なければ `IDENT` にする：`src/lexer/lexer.ts:229-241`
- 文頭 `SET @x` は `TokenKind.SET` でdispatch：`src/parser/parser.ts:428-443`
- batch変数の実構文：`src/parser/parser.ts:476-485`
- UPDATE/APPLYの区切りにも同じトークンを使用：`src/parser/parser.ts:3697`, `3846`

したがって仕様の「既存ハードトークンを維持」は現状と一致する。非引用のフィールド名 `SET` は通常識別子ではなく、バッククォートが必要な既存状態である。

### A-2. `RECURSIVE` / `CYCLE` / `TO` / `DEFAULT`

- 4語とも `TokenKind`・`KEYWORDS` に登録されていない：`src/lexer/tokens.ts:35-120`, `220-295`
- keyword mapにない語は `IDENT` になる：`src/lexer/lexer.ts:236-241`
- `parseIdentifier()` は `IDENT` / `BIDENT` を受理する：`src/parser/parser.ts:4367-4387`

したがって4語は現在、フィールド名・CTE名・alias等の識別子位置を通る。

現行文法で `TO` / `DEFAULT` を句の区切りとして使う文脈は0件だった。

- GENERATE_SERIESの引数は数値・文字列・変数のみで、後置 `TO` / `DEFAULT` はない：`src/parser/parser.ts:1271-1306`
- CHECKは `CHECK WHEN ... THEN ...`：`src/parser/parser.ts:3927-3942`
- UPSERTは `UPSERT INTO ... VALUES|SELECT ... ON DUPLICATE (...)`：`src/parser/parser.ts:3527-3589`
- `DEFAULT` はwindow frameの内部属性 `source: "DEFAULT"` としてのみ存在し、SQL lexemeではない：`src/parser/parser.ts:1661`, `src/types/ast.ts:303`
- DECLAREの既定値も `DECLARE @x = ...` であり、`DEFAULT` 語を使わない：`src/parser/parser.ts:486-509`

### A-3. `CROSS` と現行の両方式

`CROSS` はハード予約語である。

- enum：`src/lexer/tokens.ts:54`
- keyword map：`src/lexer/tokens.ts:235`
- parserは `consume(TokenKind.CROSS)`：`src/parser/parser.ts:2568-2597`
- テストも「hard keyword」と明記：`src/parser/__tests__/b158CrossJoin.test.ts:40-43`

現行の実例は次の二系統。

- ハード予約語方式：`SET`、`CROSS`  
  `src/lexer/tokens.ts:47,54,230,235`
- 文脈限定ソフトキーワード方式：
  - `CREATE` / `DROP` / `DECLARE` / `VALIDATE` / `IMPORT`：`src/parser/parser.ts:444-462`
  - CTE本体の `GENERATE_SERIES`：`src/parser/parser.ts:1249-1258`
  - `CHECK`：`src/parser/parser.ts:3927-3942`
  - `VALIDATE ONLY` / `ERROR` / `SKIP` / `REJECT`：`src/parser/parser.ts:3945-3994`

事実として、仕様 §7.3 は後者に近く、直近の `CROSS` は前者である。

### A-4. 現行WITH構造へ4段階手順を重ねた結果

右括弧直後に `CYCLE` を判定する位置自体は存在する。

- CTE本体を解析：`src/parser/parser.ts:1249-1259`
- 右括弧を消費：`src/parser/parser.ts:1260`
- CTE登録・次のカンマ判定：`src/parser/parser.ts:1261-1264`

したがって、`RPAREN` と `ctes.push()` の間へ文脈判定を置ける構造であり、4段階手順そのものに構造的不可能点はない。

ただし周辺に二つの成立しない前提がある。

1. CTE列名リスト非対応  
   現行は `name` の直後に直ちに `AS` を要求する：`src/parser/parser.ts:1245-1248`。  
   ASTにも `columnAliases` がない：`src/types/ast.ts:180-184`

2. 自己参照名を本体解析中に解決できない  
   CTE名は本体と右括弧を読み終えた後に登録される：`src/parser/parser.ts:1260-1263`。  
   CTE参照判定は登録済み `cteNames` のみを見る：`src/parser/parser.ts:2499-2503`。  
   したがって再帰項内の自己名は現状、CTEではなく物理テーブル名として解釈される。

また現行ASTには `recursive` / `recursiveSpec` / `cycle` がなく、`WithStatement` は `ctes` と外側queryだけである：`src/types/ast.ts:180-199`。

---

## B. CTE実行経路

### B-1. 現行フロー

主要経路は次のとおり。

1. `executeParsedStatement()` の `WITH` dispatch  
   `src/execute.ts:1096-1115`

2. `executeWith()`  
   `src/execute.ts:5273-5323`

3. 単純1 CTEならインライン化  
   判定：`src/core/cteInlining.ts:5-20`  
   WHERE合成：`src/core/cteInlining.ts:23-49`  
   接続点：`src/execute.ts:5282-5290`

4. 非インライン時は定義順に実体化  
   `src/execute.ts:5293-5315`
   - SHOW APPS：`5300-5301`
   - DESCRIBE：`5302-5303`
   - GENERATE_SERIES：`5304-5305`
   - SELECT/UNION：`5306-5307`

5. 実体化結果を `MaterializedTable` としてcacheへ登録  
   `src/execute.ts:5310-5315`

6. 外側queryを `executeQueryWithCte()` へ渡す  
   `src/execute.ts:5318-5322`

7. UNIONなら左右を実行して位置対応  
   `src/execute.ts:5365-5390`

8. CTE参照なしなら通常 `executeSelect()`  
   `src/execute.ts:5393-5406`

9. CTE参照ありなら `executeFullScanWithCte()`  
   `src/execute.ts:5409-5414`

10. CTE行・物理APP行をtable mapへ詰め、`runFullScan()` でJOIN・外側評価  
    `src/execute.ts:5551-5616`, `5622-5640`

GENERATE_SERIES追加後は、生成結果にも型メタと `uniqueGeneratedColumn` が付く：`src/execute.ts:5325-5346`, `5314`。

### B-2. B155共有leaf policyと押し下げ接続点

共有モジュールは `src/core/optimization/supportedLeafPolicy.ts`。

- `classifySupportedLeaf()`：`src/core/optimization/supportedLeafPolicy.ts:28-107`
- metadata候補判定：`src/core/optimization/supportedLeafPolicy.ts:109-127`
- JOIN plannerから利用：`src/core/optimization/joinPredicatePushdown.ts:191-214`
- fallback抽出器から利用：`src/core/optimization/wherePredicatePushdown.ts:144-163`

実体化時の物理取得に関係する箇所は以下。

- 単純CTEのWHEREを外側WHEREと合成するインライン化：`src/core/cteInlining.ts:23-49`
- runtime JOIN pushdown plan生成：`src/execute.ts:3979-4007`
- 通常FULL_SCANでplan選択：`src/execute.ts:4975-5007`
- main/join fetchへの条件伝搬：`src/execute.ts:5022-5073`
- CTE参照付きFULL_SCANでの同じplan生成：`src/execute.ts:5516-5532`
- main/joinの実取得：`src/execute.ts:5554-5612`
- 元WHERE・pushdown条件をkintone queryへ合成：`src/execute.ts:5686-5735`
- JOINキー由来のtargeted `IN` 取得：`src/execute.ts:5916-5990`
- 取得フィールドの列射影：`selectToFetchAllFields()` の呼出し `src/execute.ts:5700`

仕様 §4.2の再帰source収集で接触する既存箇所は、上記に加え、再帰CTEを誤ってインライン化しないための `canInlineSingleCte()`、定義実体化を行う `executeWith()`、物理sourceを取得する二つのfetch helperである。

### B-3. 列メタの現在形と揃う段階

現在の型名は仕様記載どおり `MaterializedColumnMeta`。

- 型：`src/execute.ts:413-421`
- map：`src/execute.ts:423`
- 実体化表：`src/execute.ts:425-435`
- SelectResultとの関連付けはWeakMap：`src/execute.ts:437-442`

保持情報は `displayName`、`sortKind`、`fieldType`、`semantics`、公開用 `publicSourceApp`。

伝播点：

- SELECT結果から推論：`src/execute.ts:4628-4768`
- 物理列・CTE列の解決：`src/execute.ts:4649-4678`
- 集計・式・window・CASEの型推論：`src/execute.ts:4728-4766`
- CTE cache登録：`src/execute.ts:5310-5314`
- UNION左右のメタmerge：`src/execute.ts:4771-4793`
- CTE外側SELECT結果への再推論：`src/execute.ts:5410-5413`

現行では `inferSelectColumnMeta()` が `outputColumns` と実行後の `SelectResult` を前提とする。UNIONメタも左右実行後にmergeされる。EXPLAINのrelation事前処理は列名を推論するが、一般SELECTの型mapは作らない：`src/execute.ts:10197-10227`, `10236-10263`。

したがって、seed/再帰項双方の情報が現在確実に揃うのは両者のSELECT結果が得られた後であり、仕様 §3.4の「実行前planningで型整合を証明する」既存経路はない。

### B-4. UNION ALL射影対応

通常UNION：

- 列数検査：`src/execute.ts:5171-5179`
- 右辺を左辺列名へ位置対応：`src/execute.ts:5226-5236`
- `all` がtrueなら重複排除なし：`src/execute.ts:5238-5242`
- 列メタmerge：`src/execute.ts:5247-5252`

CTE cache付きUNIONにも同じ処理の別実装がある：

- `src/execute.ts:5365-5389`

---

## C. 設定配管

### C-1. Optionsの現在形

- `ExecuteOptions`：`src/execute.ts:705-745`
- `BatchExecuteOptions extends ExecuteOptions`：`src/execute.ts:1401-1410`

`ExecuteOptions` は `captureColumnMeta`、`confirm`、`maxRecords`、`onLimitReached`、`fetchParallel`、`cacheContext`、`cursorMaxActive`、IMPORT/APPLY関連値を持つ。

`BatchExecuteOptions` はさらに `variables`、`continueOnError`、`timeoutMs`、`tempTableMaxRows` を持つ。

### C-2. 5面の配管実例：`maxRecords`

B158/B159の10,000ガードは設定値ではなく固定定数なので、配管実例にはならない：

- 共有値：`src/core/generateSeries.ts:10-11`
- CROSSも同じ値：`src/core/optimization/crossJoinRowPlan.ts:1-3`

そのため `maxRecords` を追跡した。

**env**

- CLI解決：`KSQL_MAX_RECORDS`  
  `src/cli/index.ts:1922`
- Node/MCP runtime解決：`src/node/runtime.ts:398-401`

**profile**

- Node profile型：`src/node/config.ts:31-41`
- CLI profile型：`src/cli/index.ts:163-182`
- CLI解決：`src/cli/index.ts:1922`
- MCP runtime解決：`src/node/runtime.ts:395-401`

**CLI**

- help：`src/cli/index.ts:97`
- args状態：`src/cli/index.ts:222-224`, `278-280`
- `--max-records` parse/検証：`src/cli/index.ts:450-453`
- 実効値解決：`src/cli/index.ts:1922`
- 単文executeへ渡す：`src/cli/index.ts:2447-2454`
- batch dry-run planへ渡す：`src/cli/index.ts:2297-2303`

**MCP**

- 共通schema：`src/mcp/schemas.ts:20-22`
- `ksql_explain` input：`src/mcp/schemas.ts:63-70`
- `ksql_query` input：`src/mcp/schemas.ts:72-82`
- runtime解決：`src/node/runtime.ts:385-401`
- explain単文・batch：`src/mcp/tools.ts:600-650`
- query batch：`src/mcp/tools.ts:672-703`
- query単文：`src/mcp/tools.ts:730-765`

**plugin**

- UI初期値・保存値復元：`src/ui/desktop.ts:480-499`
- UI変更時の状態更新・保存：`src/ui/desktop.ts:641-658`
- localStorage schema：`src/ui/desktop.ts:923-929`
- load/save：`src/ui/desktop.ts:936-965`
- 入力UI：`src/ui/desktop.ts:989-1008`
- DOM値解決：`src/ui/desktop.ts:2258-2289`
- batchへ渡す：`src/ui/desktop.ts:2058-2069`, `2173-2178`
- 単文executeへ渡す：`src/ui/desktop.ts:2225-2233`

### C-3. plugin UIとlocalStorage

現在の実行オプションUIは `src/ui/desktop.ts` 内で動的生成される。

- 最大取得件数：`src/ui/desktop.ts:998-1008`
- 一時テーブル上限：`src/ui/desktop.ts:1010-1027`
- 同時Cursor上限：`src/ui/desktop.ts:1029-1035`
- 保存値は `{ maxRecords, onLimitReached, tempTableMaxRows, cursorMaxActive }`：`src/ui/desktop.ts:956-965`
- 一覧ページではlocalStorage、レコードページでは保存SQL側の値を優先：`src/ui/desktop.ts:480-489`

`src/ui/config.ts:1-15` のプラグイン設定画面は現在「設定項目なし」であり、実行オプションはdesktop UI側にある。

---

## D. dry-run／VALIDATE ONLY／EXPLAIN

### D-1. WITH RECURSIVEが通る表示経路

現行のWITH/EXPLAIN対応箇所から、新しいWITH ASTが通る経路は次の全経路になる。

1. SQLとしての `EXPLAIN WITH ...`
   - parser：`src/parser/parser.ts:610-628`
   - execute dispatch：`src/execute.ts:11503-11540`
   - WITH plan dispatch：`src/execute.ts:11569-11594`

2. CLI単文 `--dry-run`
   - SQLへ `EXPLAIN` を前置して `execute()`：`src/cli/index.ts:2447-2451`

3. CLI複文dry-run
   - metadata要否・静的plan判定：`src/cli/index.ts:1824-1879`
   - client選択：`src/cli/index.ts:2042-2044`
   - `buildBatchExplainPlans()`：`src/cli/index.ts:2297-2314`

4. B155静的typed planを使うCLI単文
   - 単文でもbatch explain builder側へ入る条件：`src/cli/index.ts:2297`
   - metadata解決値は `!dryRunUsesStaticTypedPlan`：`src/cli/index.ts:2302`

5. B161のWITH metadata要否判定
   - WITH/UNION/subqueryを再帰走査：`src/core/explainMetadata.ts:111-141`
   - CTE内物理SELECT検出：`src/core/explainMetadata.ts:89-108`, `123-130`

6. MCP `ksql_explain`
   - single：`src/mcp/tools.ts:647-652`
   - batch：`src/mcp/tools.ts:628-637`

7. plugin EXPLAINボタン
   - 単文は `EXPLAIN` 前置、batchはplan mode：`src/ui/desktop.ts:553-563`
   - batch builder：`src/ui/desktop.ts:1925-1940`, `2027-2035`

8. engine library
   - 単文は既存EXPLAIN execute：`src/engine-library/query.ts:96-117`
   - batchは `buildBatchExplainPlans()`：`src/engine-library/query.ts:120-139`

`VALIDATE ONLY` はWITH外側queryの経路ではない。

- 現行 `WithStatement.query` はSELECT/UNION限定：`src/types/ast.ts:195-199`
- parserもCTE定義後に `parseSelect()` だけを呼ぶ：`src/parser/parser.ts:1266`
- `VALIDATE ONLY` はDML suffixとして先に処理される：`src/execute.ts:1087-1092`
- 仕様R2も再帰CTEの外側をSELECT/UNIONに限定しているため、現行構造上は再帰WITHがDML `VALIDATE ONLY` へ直接入る経路はない。
- MCPの `ksql_validate` は構文静的検査面であり、DML `VALIDATE ONLY` 実行経路とは別である：`src/mcp/schemas.ts:56-61`

### D-2. WITH/CTE EXPLAIN生成点

- WITH全体：`buildWithPlan()`  
  `src/execute.ts:12337-12424`
- 通常SELECT CTE：`src/execute.ts:12346-12352`
- GENERATE_SERIES CTE：`src/execute.ts:12353-12399`
- 外側query：`src/execute.ts:12402-12414`
- インライン化された実効plan：`src/execute.ts:12416-12422`
- relationの事前列推論：`src/execute.ts:10197-10263`

仕様 §9.1の再帰専用表示は、この `buildWithPlan()` 系に現在存在しない。

### D-3. plugin bundle範囲

- plugin build入口：`src/ui/desktop.ts`  
  `build.mjs:94-101`
- output：`prod/js/desktop.js`  
  `build.mjs:98-100`
- esbuildは `bundle: true`：`build.mjs:59-69`
- `src/ui/desktop.ts` は `execute` / `buildBatchExplainPlans` をimportしているため、そこから到達するparser・engine・EXPLAIN文言はbundle対象になる。
- buildはdesktop/configを再生成する：`build.mjs:94-116`

したがってengineまたはEXPLAIN文言の変更は、`prod/js/desktop.js` の再生成対象になる事実が確認できる。

---

## E. B160 全順序警告

### E-1. 生成点とB140文言

- 全順序証明：`canProveTotalWindowOrder()`  
  `src/execute.ts:2577-2597`
- 派生relation向け助言：`tieBreakAdvice()`  
  `src/execute.ts:2608-2637`
- B140免除文言：`src/execute.ts:2629-2631`
- RANGE/VALUE警告の生成：`collectDefaultRangeWindowWarnings()`  
  `src/execute.ts:2639-2670`
- 通常SELECTから呼出し：`src/execute.ts:2853-2857`
- CTE/一時テーブルFULL_SCANから呼出し：`src/execute.ts:5478-5485`

### E-2. 文言固定テストの全数

完全な警告文字列を比較しているassertion siteは6か所。

1. RANGE direct：`src/__tests__/window.execute.test.ts:272-282`
2. VALUE direct：`src/__tests__/window.execute.test.ts:442-445`
3. GENERATE_SERIES JOIN後 LAG：`src/__tests__/b149GenerateSeries.test.ts:74,173-174`
4. 同 RANGE：`src/__tests__/b149GenerateSeries.test.ts:75,175-176`
5. month/year通常JOIN：`src/__tests__/b159GenerateSeriesMonthYear.test.ts:67,203-206`
6. month/year一時テーブル：`src/__tests__/b159GenerateSeriesMonthYear.test.ts:67,209-220`

5と6はそれぞれ2ケースの `test.each` なので、展開後は8ケース。

これとは別に、B140の派生relation用末尾文言を逐語固定するassertionが2か所ある。

- CTE VALUE：`src/__tests__/window.execute.test.ts:480-493`
- CTE RANGE：`src/__tests__/window.execute.test.ts:480-502`

したがって、文言変更が直接触れるのは合計8 assertion site、パラメータ展開後10ケースである。

### E-3. v3.59.0生成列免除の条件と見える情報

「生成列を直接読む」のコード上の条件は次の全条件。

- `generatedColumn !== undefined`
- `stmt.joins.length === 0`
- `stmt.from.cteName !== null`
- ORDER BY項が `FIELD_NAME`
- field名が生成列名と一致
- 無修飾、またはFROM relationのeffective aliasと一致

実装：`src/execute.ts:2582-2591`

生成列マーカーは直接のGENERATE_SERIES CTEだけに付く。

- 定義：`src/execute.ts:433-434`
- 登録：`src/execute.ts:5314`
- 警告点へ渡す条件：`src/execute.ts:5481-5484`

警告判定点で見える情報：

- SELECT AST全体
- FROM relationとそのalias
- JOINの有無・種類・ON条件
- windowのpartition/order/frame AST
- ORDER BY field名
- field semantics resolverの結果
- 直接relationの `uniqueGeneratedColumn` 文字列

見えない／保持されない情報：

- 通常CTEを越えた生成列由来
- JOIN出力列がGENERATE_SERIES由来であるというprovenance
- JOIN cardinality
- JOIN後に同じ生成値が複数行になるか
- partitionごとのunique key
- GROUP BY候補キー
- relation-levelの一意性証明

`MaterializedColumnMeta` にも一意性・generated provenanceはない：`src/execute.ts:414-421`。

### E-4. CTE・一時テーブル越しの警告経路

- CTE本体で発生したwarningsは `executeWith()` が収集：`src/execute.ts:5297-5310`
- 外側結果へmerge：`src/execute.ts:5318-5322`
- 外側ウィンドウがCTEを読む場合は `executeFullScanWithCte()` の警告生成へ入る：`src/execute.ts:5393-5414`, `5478-5485`
- 一時テーブル参照も同じ `executeQueryWithCte()` へ入る：`src/execute.ts:1881-1893`, `1916-1927`
- テストで通常CTE・一時テーブル双方が警告を維持：`src/__tests__/window.execute.test.ts:473-503`, `src/__tests__/b159GenerateSeriesMonthYear.test.ts:203-220`

再帰結果を `MaterializedTable` としてcacheへ登録する場合、消費側はこの同じ警告経路を通る。

---

## F. ガード前例・文書同期

### F-1. B158/B159ガード

共通上限：

- `GENERATED_ROW_MAX_ROWS = 10_000`：`src/core/generateSeries.ts:10`
- GENERATE_SERIES上限：`src/core/generateSeries.ts:11`
- CROSS JOINも同じ値を参照：`src/core/optimization/crossJoinRowPlan.ts:1-3`

B158：

- 件数計画は積を計算し `outputRows <= limit`：`src/core/optimization/crossJoinRowPlan.ts:13-25`
- 行生成前に検査：`src/engine/process.ts:250-265`
- 文言：  
  `ArgumentError: CROSS JOIN の生成件数 ... 行（左 ... 行 × 右 ... 行）が上限 ... 行を超えています。`  
  `src/engine/process.ts:261-264`

B159/B149：

- 静的単一系列検査：`src/core/generateSeries.ts:300-304`
- WITH内合計検査：`src/core/generateSeries.ts:307-330`
- 実行時再検査：`src/core/generateSeries.ts:333-336`
- 文言：
  - `ArgumentError: GENERATE_SERIES の生成件数 ...`
  - `ArgumentError: この WITH 文の GENERATE_SERIES 生成件数合計 ...`

いずれも専用error class/codeではなく、`ArgumentError:` を埋め込んだ通常 `Error` である。仕様 §5.1の `RECURSIVE_CTE_MAX_*_EXCEEDED` のような固定識別コードの前例ではない。

### F-2. 「再帰CTE非対応」相当の記述

現行サポート契約を直接否定する記述：

- `docs/ksql_language_reference.md:2485`
- `docs/ksql_language_reference.md:3559`
- `docs/internal/kintone_sql_plugin_spec.md:188-193`
- `docs/internal/ksql_b53_recursive_cte_cycle_evaluation.md:27`
- `docs/internal/ksql_property_graph_evaluation.md:30`
- `docs/internal/ksql_sql_feature_comparison_evaluation.md:48`

B149仕様の「別件B53」記述：

- `docs/internal/ksql_b149_generate_series_spec_r1.md:1617`
- `docs/internal/ksql_b149_generate_series_spec_r2.md:1981`

`src/` 内には「再帰CTEは非対応」という専用文字列や専用エラーはない。現行の閉じた構文列挙が非対応状態を表している。

- MCP server instructionsの対応family記述：`src/mcp/index.ts:89-99`
- `ksql_query` のWITH説明：`src/mcp/index.ts:151-154`
- 文型は「全supported family」と宣言：`src/mcp/statementSyntaxCatalog.ts:36-42`
- WITHテンプレート：`src/mcp/statementSyntaxCatalog.ts:50-57`
- validate input説明：`src/mcp/schemas.ts:56-61`
- explain input説明：`src/mcp/schemas.ts:63-70`
- query input説明：`src/mcp/schemas.ts:72-92`
- saved query説明：`src/mcp/schemas.ts:193-195`
- parserの現行WITH構文：`src/parser/parser.ts:1241-1268`

専用エラーがないため、現在 `WITH RECURSIVE name ...` は `RECURSIVE` をCTE名として読み、次の実CTE名位置で `AS` 要求に失敗する構造である。

### F-3. docs parityテストの構造

`b136DocsColumnParity`：

- 言語リファレンスを読む：`src/__tests__/b136DocsColumnParity.test.ts:18-20`
- 指定heading直後の最初の `| カラム |` 表を読む：`22-42`
- export済み実装定数と配列一致：`45-50`
- stale文字列の不存在も検査：`53-59`

`b141EmptyAggregateDocsParity`：

- 表を特定する列見出しregex：`src/__tests__/b141EmptyAggregateDocsParity.test.ts:21-25`
- 文書内の該当表を全自動走査：`49-73`
- 各集計を空入力で実評価：`76-84`
- 文書値と実値を比較：`92-103`
- 対応集計がすべて文書表に載ることも検査：`106-108`

境界既定値表は、B141が認識する「値が無いとき／0件時の値」列も集計関数セルも持たないため、B141形式では自動対象にならない。構造上は、heading・表を特定してexport済み定数と比較するB136形式に近い。

---

## 仕様 R2 と現行実装の食い違い

1. **CTE列名リスト**
   - R2：`name [(列名,...)] AS`
   - 現行：`name AS` 固定。ASTにもaliasesなし。  
     `src/parser/parser.ts:1245-1248`, `src/types/ast.ts:180-184`

2. **自己参照の名前解決**
   - R2：定義中の自分自身を再帰項で解決
   - 現行：CTE名は本体解析後に登録。  
     `src/parser/parser.ts:1260-1263`, `2499-2503`

3. **ASTの現状**
   - R2：`WithStatement.recursive`、`CteDefinition.recursiveSpec`
   - 現行：両方なし。GENERATE_SERIESがquery unionへ追加された。  
     `src/types/ast.ts:180-199`

4. **キーワード前例**
   - R2：4語を文脈限定soft keyword
   - 現行直近例 `CROSS`：hard keyword。  
     `src/lexer/tokens.ts:54,235`

5. **型整合の検査時点**
   - R2：seed/再帰項の型をplanning時に証明
   - 現行：一般の列メタは実行結果取得後に推論・UNION merge。  
     `src/execute.ts:4628-4768`, `4771-4793`, `5247-5252`

6. **UNION資産の実装重複**
   - R2：既存UNION ALL射影対応を再利用
   - 現行：通常UNIONとCTE-cache付きUNIONに位置対応処理が二系統ある。  
     `src/execute.ts:5182-5254`, `5353-5390`

7. **CTE実行入口**
   - R2凍結後、GENERATE_SERIESという文CTE分岐と `uniqueGeneratedColumn` が追加済み。  
     `src/execute.ts:5297-5315`

8. **設定配管の前例**
   - R2は3値×5面。
   - B158/B159は固定値で配管なし。現行5面の可変値前例は `maxRecords`。

9. **EXPLAIN/dry-run**
   - R2記載より現行経路が増えており、CLI単文・CLI batch/static、MCP、plugin、engine-libraryが共有plan builderへ接続する。
   - WITH内物理sourceのmetadata要否判定もB161で追加済み。  
     `src/core/explainMetadata.ts:89-141`

10. **ガードのerror命名**
    - R2：固定コード `RECURSIVE_CTE_MAX_*_EXCEEDED`
    - B158/B159：専用コードなしの `ArgumentError:` 文言。

11. **文書同期対象**
    - 言語リファレンス2か所だけでなく、plugin spec、内部比較資料、MCP instructions、tool schema、statement syntax catalogにも現行WITH範囲が固定されている。

---

## §11見積りを増減させる事実

見積りの再計算は行っていない。増減要因となる事実のみを示す。

**減少方向の事実**

- GENERATE_SERIESにより、文CTEの別query種別、実体化、型メタ、EXPLAIN、static relation処理の前例が増えた：B-1、D-2。
- B155共有leaf policyにより、JOIN/fallbackのleaf可否判定は共通化済み：B-2。
- `MaterializedColumnMeta`、UNION位置対応・メタmerge、CTE/一時テーブルの警告伝播は実装済み：B-3、B-4、E-4。
- CLI/MCP/plugin/engine-libraryのbatch EXPLAIN builderが共有されている：D-1。

**増加方向の事実**

- CTE列名リストと定義中自己参照は既存parser構造に存在せず、単なるsoft keyword追加では完了しない：A-4。
- planning時型整合にそのまま使える事前型推論経路がない：B-3。
- 物理sourceの取得にはインライン化、WHERE/JOIN pushdown、JOINキー `IN` 取得、列射影という複数最適化経路がある：B-2。
- EXPLAIN/dry-runの対象面はR2記載より具体的に多い：D-1。
- 3設定値は、`maxRecords` の実例ではenv/profile/CLI/MCP/pluginに加えてtool schema、runtime、desktop保存・UI・単文/batch各接続点へ分散している：C-2、C-3。
- B160案Aの文言変更は、8 assertion site・展開後10ケースを直接更新対象にする：E-2。