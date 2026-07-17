# kSQL v3.0.0 比較・ORDER BY 実装計画

- ステータス: **R3承認済み / Phase 0–7実装・Node検証・全実機smoke完了 / v3.0.0 公開済み（2026-07-17）**。CLI / MCP / Firefox / Chromiumのrelease gateはすべて通過し、**release blockerなし**
- 対象リリース: **v3.0.0**
- 対象課題: **B26 / B27 / B30 / B31 / B32**
- follow-up: **B9（v3.1.0候補）**
- 正となる仕様:
  - [文字列の扱い R8.5](ksql_string_semantics.md)
  - [型付き順序・安全な ORDER BY R8](ksql_local_order_by_draft.md)
  - [B30: ORDER BY と取得打ち切り](ksql_order_by_truncate_completeness_issue.md)
  - [B32: WHERE 型×演算子能力](ksql_where_operator_pushdown_capability_issue.md)

## 1. 目的と完了条件

v3.0.0では、次を一つの移行として完成させる。

1. 通常`ORDER BY`、文字列`MIN`/`MAX`、範囲比較、`GREATEST`/`LEAST`、`REORDER`が共有するcanonical比較規則を実装する（B26）
2. canonical結果と窓全体が同値と証明できる場合だけREST top-Nを使う（B27）
3. 不完全な候補集合をsortしてtop-Nとして返さない（B30）
4. kintone固有順を明示的に選ぶ`KORDER BY`を実装する（B31）
5. WHEREのフィールド型×演算子能力をschema-awareに判定し、実行不能なREST queryを計画しない（B32）

完了は「単体テストが通る」だけではない。CLI / MCP / プラグインで同じplanner・比較器・エラー契約を使い、EXPLAINと実行が同じ最終planを示し、公開リファレンスと移行ガイドが同期した状態を指す。

## 2. 今回含めないもの

- B9の最大30桁厳密10進比較
- kintoneの`numberPrecision.decimalPlaces` / `roundingMode`の再現
- 日本語辞書順、ICU照合、`COLLATE`
- canonical key未定義の複合型ORDER BY
- nested `KORDER BY`（CTE、temp、UNION分岐、サブクエリ、SELECT-based DML）
- DMLに新しい全件取得＋ローカルWHERE実行方式を追加すること
- B20〜B24、B28、B29

B9を先に実装しない。B26で分散した比較経路を共有leafへ集約した後、v3.1.0で数値primitiveだけを厳密10進化する。

## 3. 現行コードで確認した変更点

| 責務 | 現状 | 主な変更先 |
|---|---|---|
| SELECTモード判定 | `resolveSelectMode()`がAST形状だけで`SIMPLE`/`FULL_SCAN`を決める | `src/converter/selectToKintone.ts`、新規schema-aware planner |
| SIMPLE実行 | `LIMIT <= 500`なら生GET、それ以外は`fetchAll`後にlocal sort | `src/execute.ts:1272`付近 |
| EXPLAIN | `buildSelectPlan()`が同期・メタデータ取得なしで`resolveSelectMode()`を再実行 | `src/execute.ts:4431`以降、CLI/MCP/UI呼出し |
| ORDER BY比較 | 値ベース数値判定と`localeCompare("ja")` | `src/engine/process.ts:509-604` |
| WHERE/ASSERT比較 | `compareScalarValues()`が値ベース数値判定 | `src/core/scalarCompare.ts`、`src/engine/evalWhere.ts`、`src/execute.ts` |
| GREATEST/LEAST | 集合モードは実装済み、tieはUTF-16比較 | `src/core/scalarCompare.ts:43-67` |
| MIN/MAX | 文字列の生`<`/`>` | `src/engine/process.ts:344-350` |
| REORDER | 値ベース数値判定＋`localeCompare("ja")` | `src/execute.ts:4110-4119` |
| 型メタ | `sortKind`はnumber/stringだけ。通常テキストは未分類 | `src/core/formFieldInfo.ts`、`src/execute.ts`の実体化メタ |
| STATUS順 | `status.json`の`index`を捨て、name配列だけ保持 | `src/execute.ts`、`src/cli/nodeKintoneClient.ts`、`src/ui/kintoneClient.ts` |
| truncate判定 | surfaceの`requiresCompleteInput`と各fetch呼出しに分散 | `src/core/dmlGuard.ts`、`src/core/batch.ts`、`src/execute.ts`、各surface |

## 4. 目標アーキテクチャ

### 4.1 比較層

`src/core/scalarCompare.ts`を値ベース自動判定の置き場として延命せず、意味型を入力に取る共有比較primitiveへ整理する。ファイル分割名は実装時に調整してよいが、最低限次を公開する。

```ts
type CompareMode = "string" | "number" | "option" | "recordNumber";

compareCodePointStrings(a: string, b: string): -1 | 0 | 1;
compareNumbers(a: string, b: string): -1 | 0 | 1; // v3はNumber、B9で差替え
compareTypedValues(a: string, b: string, meta: CompareMeta): -1 | 0 | 1;
```

規則:

- 文字列は正規化せずUnicodeコードポイント列を辞書式比較する
- primitiveは常に`-1 / 0 / 1`を返し、`NaN`を返さない
- 型不明は文字列。値の見た目からnumberへ切り替えない
- typed numberは`空セル < -Infinity < 有限数 < +Infinity < NaN sentinel < その他非数値`の固定バンド。最後のバンド内はコードポイント順
- NUMBER空セル、option vector、RECORD_NUMBER末尾IDはR7の個別契約を使う
- DESCはcallerが比較結果の符号を反転する
- canonical tie-breakはpeer比較器へ混ぜない

`GREATEST`/`LEAST`は例外として既存の集合モードを維持する。callerが集合全体について`number`/`string`を一度決め、共有leafへ渡す。`GREATEST('20','100') = '100'`を固定し、ペア単位の再判定を禁止する。

### 4.2 型メタデータ層

`sortKind?: "number" | "string"`だけで済ませず、比較とplannerが共有できる解決済み意味型を持つ。

```ts
interface ResolvedFieldSemantics {
  fieldType: string;
  compareMode: "string" | "number" | "option" | "recordNumber" | "unsupported";
  inSubtable: boolean;
  optionOrder?: ReadonlyMap<string, number>;
}
```

- 物理フィールド、system field、CALC format、LOOKUP基底型、SUBTABLE所属をここで解決する
- temp/CTEの`MaterializedColumnMeta`へ意味型とoption metadataを伝播する
- alias、`*`、CASE、UNION、文字列関数、算術、集約、WINDOWの戻り型を明示する
- 真に型不明な式はstring。複合値でcanonical keyが無い場合はunsupported

STATUSについては`KintoneProcessStatuses.states`をname配列から`{ name, index }[]`へ変更する。`index`は文字列レスポンスをクライアント境界またはmetadata構築時に有限非負整数へ正規化し、STATUS ORDER BYが実在するときだけ`status.json`を取得してrank mapへ統合する。`enable:false`と`states:null`を混同しない。

### 4.3 planner層

AST形状だけの`resolveSelectMode()`を最終判断に使わない。同期の形状解析と、非同期のschema-aware最終planを分離する。

```ts
type SelectPlanKind =
  | "CANONICAL_REST_TOP_N"
  | "CANONICAL_LOCAL"
  | "KORDER_NATIVE";

interface SelectExecutionPlan {
  kind: SelectPlanKind;
  where: WherePushdownPlan;
  requiresCompleteInput: boolean;
  restQuery: string | null;
  localOrderBy: boolean;
  applyLocalOffsetLimit: boolean;
  reasonCodes: string[];
}
```

plannerは、解決済みschema、変数束縛済みAST、query形状、WHERE能力、ORDER BY能力、LIMIT/OFFSET、`maxRecords`を入力にして一度だけplanを作る。実行とEXPLAINは同じplanオブジェクトを消費し、各々が`resolveSelectMode()`を再実行しない。

重要: 現在のEXPLAINと`buildBatchExplainPlans()`は同期かつkintoneアクセスなしである。B27/B31/B32ではschemaなしに正しい判定ができないため、物理アプリを含むEXPLAINを非同期化し、レコード取得はせずフォーム定義と必要時の`status.json`だけを読む。メタ取得失敗時にSIMPLEを仮定しない。CLI / MCP / プラグインのbatch EXPLAIN呼出しもawaitする。純粋なtemp/静的検査用には内部のstatic shape解析を残してよいが、利用者へ最終planとして表示しない。

### 4.4 WHERE能力層

B32文書のnative capability matrixをコード上の明示allowlistへ写す。ただし次を別の判定値にする。

```ts
type PredicateCapability =
  | "EXACT_PUSHDOWN"
  | "SUPERSET_PREFILTER"
  | "LOCAL_ONLY"
  | "UNSUPPORTED";
```

- RESTが演算子を受理すること
- kSQLのローカル意味と同値であること
- 上位集合だけを取得する最適化であること
- ローカル評価契約が存在すること

未知型・型解決失敗・未登録演算子はfail-closed。通常SELECTで`LOCAL_ONLY`ならFULL_SCAN残余WHERE、`UNSUPPORTED`ならplanning error。DMLでは`LOCAL_ONLY`へ暗黙拡張せずAPI呼出し前の`DmlConvertError`等にする。B27/B31の「WHERE完全押し下げ」は全leafが`EXACT_PUSHDOWN`の場合だけ真とする。

## 5. 実装フェーズとコミット分割

各フェーズを独立コミットにする。途中コミットはmainへ公開せず、v3.0.0ブランチ上で統合試験する。

### Phase 0: baseline fixtureを先に追加

- 現行の誤動作を再現するテストを、期待するv3結果または`test.todo`として追加する
- B30: `maxRecords=100, onLimit=truncate, ORDER BY ... LIMIT 1`で真のtop-1が取得外にある例
- B32: `SINGLE_LINE_TEXT > '100'`が現行SIMPLE queryになる例
- B26: `ｱ`/`😀`、`切`(U+FA00)/`😀`、`2`/`10`/`1a`、typed string WHERE例
- GREATEST集合モード、RANK peer、STATUS index、同値群LIMIT/OFFSETをfixture化する
- typed numberの正規`"NaN"`とB14 `#err`の非数値入力をtempへ実体化する。空セル、±Infinity、有限数、`"NaN"`、複数のその他非数値の固定バンド順とpeerを固定する
- `#err` NUMBER宣言列の現行`MIN(...)=NaN`をbefore fixtureにし、v3では数値があれば最小数値、数値がなければ存在する最初の域外バンド値を返すafter fixtureを固定する。MAX、ORDER BY、範囲比較も同じ関係を使う
- 互換漢字は見た目を再入力せずコードポイントescapeで構築する

### Phase 1: B30を先にfail-closed化

- `ORDER BY`をlocal評価するplanでは、エンジン層で`onLimitReached="error"`を強制する
- 単文だけでなくWITH / UNION / CTE / temp / 保存query / batchの内側まで同じ判定を伝播する
- surfaceの`requiresCompleteInput`も更新するが、正しさをCLI/MCP/UIの事前上書きだけに依存させない
- REST top-N planと`KORDER_NATIVE`は完全候補取得を行わないためB30の強制対象外
- EXPLAINへ`requires complete input`と理由を表示する

### Phase 2: 共有metadata基盤

- `KintoneFieldInfo`とmaterialized column metadataへ意味型を追加する
- 通常テキスト、LINK、日付時刻、CALC format、RECORD_NUMBER、選択系を分類する
- temp/CTE/alias/式の型伝播を実装する
- STATUSの`name + index`をCLI/Node runtime/UI/MCP mockまで一貫して保持する
- STATUS ORDER BYがないqueryで`status.json`を呼ばないことを維持する

このフェーズでは結果順をまだ切り替えず、metadataの単体テストを先に通す。

### Phase 3: B32 WHERE capabilityとschema-aware planner骨格

- native capability matrixを共有モジュールに実装する
- WHERE treeを`EXACT_PUSHDOWN` / `SUPERSET_PREFILTER` / `LOCAL_ONLY` / `UNSUPPORTED`へ分類する
- AND / OR / NOT / GROUP、LIKE / KLIKE、IN、NULL、変数束縛、SUBTABLE/REFERENCE_TABLE構造制約を試験する
- 通常SELECTの`SINGLE_LINE_TEXT > '100'`をCANONICAL_LOCALへroutingする
- DMLの同じ述語は実行前エラーにする
- EXPLAINを非同期schema-aware plannerへ移し、実行と同じreason codeを表示する
- DML EXPLAINも同じschema-aware WHERE能力判定を通す。実行時に`DmlConvertError`となる型×演算子を、GET→PUT等の実行可能planとして表示せず、同じreject理由を返す

### Phase 4: B26 canonical比較器

- コードポイント三方比較を実装し、property testを追加する
- `compareSortKeys`の値ベース`isNum`分岐と`localeCompare("ja")`を廃止する
- MIN/MAX、WHERE/HAVING/CASE/ASSERT、REORDERを共有leafへ移す
- GREATEST/LEASTは集合モードを維持し、文字列モードと数値tieだけ共有leafへ移す
- optionはcanonical vector、STATUSはprocess index rankを使う
- typed numberの`"NaN"`とその他非数値を固定末尾バンドへ写像する。ペア単位で数値／文字列へ切り替えず、その他非数値バンド内だけ共有コードポイント比較器を使う
- peer比較とトップレベルcanonical tieを別関数にする
- `RANK`/`DENSE_RANK`がROW_NUMBERへ退化しないことを確認する

### Phase 5: B27 canonical ORDER BY planner

- 初期REST top-N allowlistを`$id`だけに固定する
- 全ORDER BYキー、WHERE完全押し下げ、query形状、窓同値性を満たす場合だけ`CANONICAL_REST_TOP_N`
- それ以外はORDER BY / OFFSET / LIMITをREST queryから外して`CANONICAL_LOCAL`
- REST top-N時は利用者キー末尾へ`$id asc`を補い、重複させない
- local sortのpeer比較へ`$id`を混ぜない
- local結果のcanonical tieとstable input ordinalの責務を明示する
- `LIMIT <= 500`という値だけで実行主体を選ぶ現行`useSingleGet`分岐を廃止し、plan kindで分岐する

### Phase 6: B31 `KORDER BY`

- lexerへ`KORDER`予約語を追加する
- ASTへ通常ORDERとnative ORDERの区別を追加する。推奨は`SelectStatement.orderMode: "CANONICAL" | "KINTONE_NATIVE"`で、同じ文に両方を持たせない
- parserで`KORDER BY`をトップレベルSELECTにだけ受理する
- `$id`＋公式受理15型のnative allowlistを実装し、LOOKUPは解決済み基底型で判定する。初期版のキーは非修飾フィールドコードに限定し、表修飾をkintone queryから安全に除去する契約は将来段階とする
- 単一物理アプリ、直接フィールド、完全押し下げWHERE、LIKE/KLIKEなし、`LIMIT 0..500`かつ`LIMIT <= 実行時maxRecords`、`OFFSET 0..10000`を検査する
- `OFFSET >= 10001`、LIMITなし、LIMIT 501以上、nested利用、未知型をplanning errorにする
- `LIMIT 0`も完全検証後にRESTを呼ばず空結果を返す
- 条件外で通常ORDER BYへ黙ってfallbackしない
- parser/AST変更による予約語・保存query互換性をリリースノートへ記載する

### Phase 7: surface・文書・リリース統合

- CLIヘルプ、MCP tool descriptionとschema `.describe()`、プラグイン設定説明を同期する
- MCP `ksql_explain`の「without calling kintone APIs」を撤回し、フォーム定義と必要時の`status.json`を読むがレコード取得・書込みはしない契約へ変更する。対象アプリの閲覧権限が必要になり、権限がないEXPLAINが新たに失敗することをリリースノートへ記載する
- EXPLAINにplan kind、REST query、残余WHERE、local sort、完全入力要否、reject理由を表示する
- 保存queryのvalidate/runで直接SQLと同じplannerを使う
- `docs/ksql_language_reference.md`へcanonical ORDER BY、`KORDER BY`、typed string WHERE移行、B30エラーを追加する
- README、CHANGELOG、移行ガイド、課題台帳、バージョン表記を同期する
- B14のリリース済み受入証拠`MIN(数値T1)=NaN`がv3の結果契約ではなくなることを移行ガイドへ記載する。`#err`のORDER BY・範囲比較・MIN/MAXはエラーにせず固定域外バンドで評価する
- `package.json` / lockfile / plugin manifest / MCP bundle等、既存のリリース成果物をv3.0.0へ更新する
- EXPLAIN/planner変更を含む`src/ui/desktop.ts`依存グラフをプラグインへ反映するため`npm run build:plugin`を必須とし、生成した`prod/js/desktop.js`に新plan kind・`KORDER BY`・新エラー文言が含まれることをsmokeで確認する

## 6. テスト計画

### 6.1 比較器property test

- 値軸: 空、ASCII大小、BMP、補助平面、共通接頭辞、NFC/NFD、IVS、結合文字列、孤立サロゲート
- 数値軸: 空セル、負数、0/-0、整数、小数、±Infinity、数値同値異表記、正規`"NaN"` sentinel、複数のその他非数値
- 正規`"NaN"` sentinelは全数値より後、その他非数値はさらに後。バンド内はコードポイント順で同一値はpeer
- 数値＋garbage、garbageのみ、`"NaN"`＋garbageの各集合でMIN/MAXとORDER BY先頭／末尾が一致する
- option軸: 空、単一、同rank、未知値、複数値、保存配列順違い
- 性質: `cmp(a,a)=0`、反対称性、推移律、同値関係の推移律、返値が`-1/0/1`
- 複数キー、ASC/DESC、入力全順列

### 6.2 planner unit test

plan kindとreason codeを表形式で固定する。

| query | 期待plan |
|---|---|
| `ORDER BY $id LIMIT 5` + exact WHERE | `CANONICAL_REST_TOP_N` |
| `ORDER BY RECORD_NUMBER LIMIT 5` | 初期版`CANONICAL_LOCAL` |
| `ORDER BY $id LIMIT 5` + residual WHERE | `CANONICAL_LOCAL` |
| `ORDER BY 文字列 LIMIT 5` | `CANONICAL_LOCAL` |
| `WHERE SINGLE_LINE_TEXT > '100'` | SELECT=`CANONICAL_LOCAL`、DML=事前エラー |
| `KORDER BY NUMBER LIMIT 5` + exact WHERE | `KORDER_NATIVE` |
| `KORDER BY RICH_TEXT LIMIT 5` | planning error |
| `KORDER BY NUMBER LIMIT 0` | schema検証後0行、records GETなし |
| `KORDER BY NUMBER LIMIT 500`, `maxRecords=100` | planning error |
| `KORDER BY NUMBER LIMIT 501` | planning error |
| `KORDER BY NUMBER LIMIT 5 OFFSET 10001` | planning error |

### 6.3 経路直積

- 物理アプリ / temp / CTE / WITH / UNION
- LIMIT 0 / 1 / 500 / 501 / なし、OFFSET境界
- 単一キー / 複数キー、ASC / DESC、同値群あり / なし
- SIMPLE相当 / FULL_SCAN相当、LIKE / KLIKE / safe AND leaf / 残余WHERE
- CLI / MCP / プラグイン
- 通常実行 / EXPLAIN / 保存query
- WINDOWの`RANK` / `DENSE_RANK` / `ROW_NUMBER`
- `onLimit=error` / `truncate`、maxRecords未満 / 到達 / 超過

### 6.4 実機smoke

- raw RESTと`KORDER BY`が同じ窓を返す
- 通常`ORDER BY`の500件以下／501件以上がcanonical順で一致する
- `$id asc`を明示したREST top-Nとlocal planの同値群LIMIT/OFFSETが一致する
- `SINGLE_LINE_TEXT > '100'`がGAIA_IQ03ではなくlocal契約で動く
- kintoneが拒否する型を`KORDER BY`がAPI呼出し前に拒否する
- CLI / MCP / Chromium / Firefoxの最低1本ずつ。ブラウザ実行環境が用意できない場合は未実施をrelease blockerとして明示し、Nodeテスト成功で代用したと書かない

実施記録（2026-07-17）:

- CLI / MCP: 全9項目PASS。常駐ksql MCPがPhase 7専用のJOIN曖昧列エラーを返すことも確認
- Firefox plugin: APP4148で `EXPLAIN SELECT $id FROM APP4148 KORDER BY 会社名 ASC, $id ASC LIMIT 5` を実行し、`KORDER_NATIVE`、kintone native、single GET、`order by 会社名 asc, $id asc limit 5` を確認。実行結果の `$id` は `211, 109, 110, 111, 112`
- Chromium（Google Chrome）plugin: APP4148でFirefoxと同じEXPLAIN・実行queryを確認。`KORDER_NATIVE`、kintone native、single GET、`order by 会社名 asc, $id asc limit 5`、実行結果 `$id = 211, 109, 110, 111, 112` がFirefoxと一致

## 7. EXPLAIN移行の注意

schema-aware化でEXPLAINはフォーム定義APIを読むようになる。これはレコード取得・書込みではないが、従来の完全なoffline構文表示から契約が変わる。

- metadata API呼出しをmetricsまたはplanへ明示する
- schema取得失敗を「推定SIMPLE」として成功させない
- batch EXPLAINは各物理アプリのmetadataをcacheContext単位で共有する
- tempだけの後続文は先行CREATE TEMP TABLEの推論メタを使う
- SELECTだけでなくINSERT/UPSERT/UPDATE/DELETE/REORDERのEXPLAINも、実行時と同じWHERE能力・型検査を使う。DMLだけ同期の旧plan builderへ残さない
- `ksql_validate`をEXPLAINの代用にしない。構文妥当性と実行plan妥当性を別表示にする

## 8. エラー契約

新規エラーはsurfaceごとに文字列を作らずcoreで生成する。

- `KORDER BY`条件違反: `ArgumentError`系のplanning error
- WHERE型×演算子がDML REST非対応: `DmlConvertError`
- canonical key未定義: `ArgumentError`
- local ORDER BYの不完全入力: 既存`FetchAllLimitError`系
- schema取得失敗: 元の認証・通信エラーを保持し、FULL_SCAN/SIMPLEへ黙ってfallbackしない

エラーには、対象フィールド、解決済み型、演算子またはORDER BY mode、拒否理由を含める。CLI / MCP / プラグインでcodeと主要文言を揃える。

## 9. 実装レビューgate

各phase完了時に次を確認する。

- [ ] planner判定を実行側とEXPLAIN側で重複実装していない
- [ ] REST受理能力とcanonical同値性を同じbooleanへ潰していない
- [ ] B31の広いnative allowlistをB27のcanonical allowlistへ流用していない
- [ ] `LIMIT <= 500`だけでREST top-Nを選ぶ旧分岐が残っていない
- [ ] peer比較器へ`$id`または非公開ordinalを混ぜていない
- [ ] GREATEST/LEASTの集合モードをtyped string一般則で上書きしていない
- [ ] 型不明値を値ベースでnumberへ分類していない
- [ ] ORDER BYを含むlocal planでtruncate成功経路が残っていない
- [ ] `LIMIT 0`がschema・型・WHERE検査を短絡していない
- [ ] `KORDER BY`のLIMITが実行時`maxRecords`を超える場合にplanning errorとなり、truncateで縮めていない
- [ ] STATUS indexを文字列辞書順で比較していない
- [ ] typed numberの`"NaN"`とB14 `#err`のその他非数値を固定バンドで順序づけ、ペア単位の値ベースモード切替を再導入していない
- [ ] `#err` NUMBER宣言列のORDER BY・WHERE・MIN/MAXが非数値の存在だけでエラーにならず、同じ大小関係を使う
- [ ] DML EXPLAINが実行時に拒否するWHEREを実行可能planとして表示していない
- [ ] MCP `ksql_explain`のAPI・権限契約とプラグイン`desktop.js`を更新している
- [ ] `.claude/settings.local.json`等の個人設定をcommitへ含めていない

## 10. 検証コマンド

phaseごとの対象testを先に実行し、統合時に次を通す。

```powershell
npm test
npm run build
npm run mcp:verify
npm run mcpb:verify
git diff --check
```

生成物をcommit対象にするかは既存リリース手順に従い、`package.json`、lockfile、plugin manifest、CLI/MCP/MCPB成果物のバージョン不一致を確認する。

## 11. 推奨コミット列

1. `test: add v3 ordering and pushdown regression fixtures`
2. `fix: reject truncated local ORDER BY inputs`（B30）
3. `refactor: add resolved comparison metadata and status ranks`
4. `fix: make WHERE pushdown capability schema-aware`（B32）
5. `feat!: unify canonical typed comparison semantics`（B26）
6. `fix!: plan canonical ORDER BY windows safely`（B27）
7. `feat!: add KORDER BY native ordering`（B31）
8. `docs!: add v3 ordering migration guide and release metadata`

公開は途中で分けず、全gate通過後のv3.0.0一回とする。**B30をv2.18.0として先行公開しないのは意図的な判断**である。独立コミットは修正前fail/修正後passの証明と切り分けのために維持するが、現在判明している比較・routing・完全性の問題を一つのmajor移行として説明し、リリース作業を二重化しない。
