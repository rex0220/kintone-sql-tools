codex
# 1. 結論

**推奨は案A「実体化 relation に複合候補キーを持たせる」**です。

候補キーは列ごとのフラグではなく、たとえば `candidateKeys: [["年月"]]`、複合なら `candidateKeys: [["年", "月"]]` のような**列 identity の組**として扱います。ただし Phase 1 では伝播を一般化せず、次の最小形に限定します。

> **plain `GROUP BY` の解決 plan と SELECT 列位置から、実際の group key 値が、重複も上書きもなく CTE 出力へ残ったことを証明できる直接 CTEだけ。**

さらに安く始めるなら、Phase 1-min は `ALIAS_SAFE` で解決されたキーだけに限定できます。依頼元の `DATE_FORMAT(日付, ...) AS 年月 GROUP BY 年月` はこの対象です。一方、`PHYSICAL` キーの rename 対応は Phase 1+ に回せます。

この方式なら、§2 の二反例を名前一致ではなく**解決 plan・列位置・最終出力 identity**で落とせます。一時テーブルも同じ `MaterializedTable` 経路に載っているため、Phase 2 の道を塞ぎません。

# 2. 案の比較表

| 案名 | 何を持つか | Phase 1 の大きさ | 主な壊れ方 | §2 の反例を弾けるか |
|---|---|---|---|---|
| **案A: relation metadata（推奨）** | 実体化 relation に `candidateKeys: ColumnIdentity[][]`。結果側では内部 relation meta、CTE キャッシュでは `MaterializedTable` に保持 | **中**。直接 plain GROUP BY CTEだけなら小〜中 | 変換・UNION・JOINを越えて古いキーを残すと偽陰性。Phase 1 は「伝播しない」で閉じる | **両方可**。①は PHYSICAL と式出力が一致しない。②は重複出力 identity で候補キーを失効 |
| **案B: CTE名別 sidecar registry** | `cteCache` と並ぶ `Map<CTE名, CandidateKeys>` | **小〜中**。公開型に触れずに済む | キャッシュと sidecar の更新・引数伝播がずれる。一時テーブル対応で二重ライフサイクルが増える | **両方可**。案Aと同じ生成規則が前提 |
| **案C: 定義AST・解決planを consumer まで運び、その場で再証明** | CTE名 → 定義 `SelectStatement` と `PlainGroupByResolutionPlan`。候補キーは永続化しない | **最小にしやすい**。直接1段CTE専用 | 多段CTE・一時テーブルで再設計になりやすい。planを使わず名前で再解決するとR1へ逆戻り | **条件付きで可**。必ず実行時と同じ plan と投影規則を使う必要あり |
| **案D: 現状維持／文言のみ** | 候補キーを持たない | **最小** | 偽陰性は増えないが、主用途の偽陽性と警告疲れは残る | **両方とも警告を残す**ので安全。ただしB140は解決しない |

# 3. 各案の詳細

## 案A: 実体化 relation metadata

### 保持場所

現状の列メタは列単位で、表示名・型・semanticsしか持ちません。

- `MaterializedColumnMeta`: `src/execute.ts:397-404`
- `MaterializedTable`: `src/execute.ts:408-415`

複合キーは列単位フラグでは表せないので、`MaterializedColumnMeta` ではなく**relation レベル**に置くのが自然です。

概念上は次のような形です。

```ts
interface MaterializedRelationMeta {
  candidateKeys?: readonly (readonly ColumnIdentity[])[];
}
```

`ColumnIdentity` は、producer の解析中は SELECT 列位置、実体化後は「重複していない、実際に参照可能な出力列 identity」に変換するのが安全です。最初から文字列名だけにするとR1と同じ穴が開きます。

`MaterializedTable` は export されているため、必須プロパティ追加は避けるべきです。公開型への追加自体も避けたいなら、内部 wrapper または内部 WeakMap で保持し、実体化キャッシュへコピーする構成が保守的です。

### 現行経路との適合

CTEは先に実行され、結果をキャッシュしてから consumer を実行します。

- CTEを順次実行: `src/execute.ts:5186-5195`
- `rows / columns / columnMeta` をキャッシュ: `src/execute.ts:5197-5201`
- その後 consumer を実行: `src/execute.ts:5204-5207`

consumer の警告判定地点にはすでに `cteCache` があります。

- `executeFullScanWithCte` が `cteCache` を受ける: `src/execute.ts:5284-5289`
- 警告判定: `src/execute.ts:5333-5344`

したがって、定義ASTを後から探すより、producer 実行時に得た証明結果を `MaterializedTable` へ載せる方が経路に沿っています。

一時テーブルも同じ実体化形を使っています。

- `CREATE TEMP TABLE` の保存: `src/execute.ts:1830-1835`

Phase 2 では同じ relation metadata をコピーすればよく、Phase 1 の設計が一時テーブル対応を妨げません。

### 候補キーの生成

plain GROUP BY plan は、物理列解決と alias fallback を明確に区別しています。

- 物理列を先に検索: `src/core/optimization/plainGroupByPlan.ts:177-202`
- 物理列がなければ SELECT alias へ fallback: `src/core/optimization/plainGroupByPlan.ts:204-220`
- `ALIAS_SAFE` は SELECT の `columnIndex` を保持: `src/core/optimization/plainGroupByPlan.ts:211-216`
- 式キーは別種 `EXPRESSION`: `src/core/optimization/plainGroupByPlan.ts:236-247`

実行時もこの plan を使っています。

- plan作成: `src/execute.ts:2978-3040`
- `PHYSICAL` は `runtimeKey` を評価: `src/engine/process.ts:502-505`
- `ALIAS_SAFE` は指定された SELECT 列位置を評価: `src/engine/process.ts:505-521`

また、GROUP BY は内部キーごとに Map の1 bucketを作り、各 bucketから1行だけ出します。

- グループ生成: `src/engine/process.ts:267-281`
- 1 group → 1 output row: `src/engine/process.ts:293-310`

したがって、**その group tuple が値を変えず最終出力へ残ること**まで証明できれば、候補キーになります。

ただし `ALIAS_SAFE` だから無条件に安全、とはまだ言えません。集計値は group row へ alias 名で書き込まれます。

- 集計 alias の書き込み: `src/engine/process.ts:416-431`
- 最終 projection はさらに後: `src/engine/process.ts:2021-2028`

別の集計 alias がキー式の入力フィールド名を上書きすると、grouping時とprojection時の再評価値が異なる可能性があります。Phase 1 では、キー式の参照先と post-group 書き込み先の衝突を除外するか、対象式を狭く制限する必要があります。

### §2の反例

反例①では `GROUP BY 日付` は物理列を先に見つけるため `PHYSICAL` です。出力 `日付` は `DATE_FORMAT` 列であり、`PHYSICAL.runtimeKey` の直接投影ではありません。

- 物理優先: `src/core/optimization/plainGroupByPlan.ts:183-202`
- alias fallbackはその後: `src/core/optimization/plainGroupByPlan.ts:204-220`

したがって、列位置・値 identity の対応を証明できず、候補キーを生成しません。**警告は残ります。**

反例②では、最終投影が同じ object keyへ列順に書き込みます。

- FIELD書き込み: `src/engine/process.ts:1412-1416`
- 後続AGGREGATE書き込み: `src/engine/process.ts:1424-1429`

出力キー配列自体も SELECT 列位置から作られます。

- 出力キー計算: `src/engine/process.ts:1363-1369`
- 列種別ごとの名前決定: `src/engine/process.ts:1517-1547`

候補キー生成時に「出力 identity が一意である」を必須にすれば、同名出力がある時点で relation の候補キーを破棄できます。**警告は残ります。**

### 費用と壊れ方

費用は、候補キー生成、結果への内部付与、CTEキャッシュへのコピー、warning predicateへの入力追加、受入テストです。

WeakMapで結果へ付ける場合は、結果をcloneする箇所にも注意が必要です。現行 `mergeSelectWarnings` は列メタだけを新しい結果へ引き継いでいます。

- cloneと列メタ引継ぎ: `src/execute.ts:2626-2631`
- 実行結果は最後に警告mergeされる: `src/execute.ts:2923-2929`

relation metaを同様に引き継がないと、producerで生成したキーがCTEキャッシュ到達前に消えます。

最も危険なのは過剰伝播です。Phase 1では次をすべて「候補キーなし」にすれば fail-closed です。

- UNION
- JOIN
- wildcard
- 重複出力名
- 式キー
- grouping sets
- 多段CTEでのrename・変換
- producer側のpost-group alias衝突

UNIONは現在、左右の結果を新しい結果へ再構成しています（`src/execute.ts:5227-5252`）。Phase 1ではここで候補キーを必ず落とすべきです。

## 案B: CTE名別 sidecar registry

`cteCache` と並行して、次のような内部Mapを `executeWith` が持つ案です。

```ts
Map<string, readonly (readonly ColumnIdentity[])[]>
```

現行 `cteCache` は `executeWith` で生成され（`src/execute.ts:5182-5184`）、`executeQueryWithCte`、`executeFullScanWithCte`へ渡っています（`src/execute.ts:5204-5207`, `5215-5222`, `5284-5289`）。同じ経路で sidecar を渡せます。

利点は、export済みの `MaterializedTable` を変更せずに済むことです。直接CTEだけを対象にするなら案Aよりやや安くなり得ます。

欠点は、実体化表と証明メタが別Mapになることです。CTE上書き、バッチseed、DROP/CREATE TEMP TABLE、エラー時の更新などで同期漏れが起きると、別relationのキーを誤利用する危険があります。

一時テーブルは現在 `tempTables` だけで完結しています（`src/execute.ts:1539`, `1830-1835`）。Phase 2では candidate-key registryもバッチ全体で管理する必要があり、ライフサイクルが二重になります。道は塞ぎませんが、案Aより自然ではありません。

反例の遮断規則は案Aと同じです。sidecarであっても、生成を名前一致に戻せば安全性は失われます。

## 案C: 定義ASTと解決planをconsumerまで運ぶ

`executeWith` は `WithStatement` の定義ASTを保持しています。

- `WithStatement.ctes`: `src/types/ast.ts:180-190`
- `executeWith` が各 `cte.query` を直接扱う: `src/execute.ts:5186-5195`

この地点から、CTE名 → 定義AST、さらに実行時の `PlainGroupByResolutionPlan` を consumer の警告判定まで渡す案です。直接1段CTEに限定すれば、候補キーメタを新設せずに済みます。

ただし警告地点では現在、定義ASTはなく `cteCache` しかありません（`src/execute.ts:5284-5344`）。複数関数の引数追加は必要です。また、planは `executeSelect` / `executeFullScanWithCte` のローカル変数です。

- 通常SELECTのplan: `src/execute.ts:2810-2815`
- CTE source実行のplan: `src/execute.ts:5291-5298`

ASTだけを渡してconsumer側で名前を再解決するのは不可です。必ず実行時と同じ plan を捕捉するか再利用する必要があります。

§2の二反例は、案Aと同じprojection identity検査まで行えば遮断できます。逆に「定義に `GROUP BY 日付` があり、出力にも `日付` がある」だけを見ると反例①②を再発させます。

一時テーブルは別文で定義されるため、この方式では定義ASTを保持する新しい仕組みが必要になります。Phase 1は安いものの、Phase 2で案A相当へ移行する可能性が高い案です。

## 案D: 現状維持／文言のみ

現行判定は、`DIRECT` かつ単一物理APPであることを要求し、`$id` または `RECORD_NUMBER` がORDER BYに1本あれば証明します。

- 現行predicate: `src/execute.ts:2552-2565`
- B127呼び出し: `src/execute.ts:2600-2613`
- B128呼び出し: `src/execute.ts:2615-2622`

`DERIVED` はCTE専用ではありません。UNION armでも使われます（`src/execute.ts:5093-5112`）、WITH inlineでも使われます（`src/execute.ts:5175-5179`）、CTE参照のないWITH配下SELECTでも使われます（`src/execute.ts:5263-5268`）。したがって、`DERIVED`を一般解禁する安価な変更は採れません。

現状維持が勝つ条件は次のいずれかです。

- B140の偽陽性頻度が低く、警告疲れの被害が候補キー誤伝播のリスクより小さい
- 主用途をSQL側で安全に書き換えられる
- 候補キーのprojection identityを静的に証明する工数を確保できない
- 警告を「構造的危険」ではなく「証明不能の通知」と再定義しても利用者が受容できる

ただし今回提示された主用途では毎回出るため、少なくとも依頼元の利用形態については現状維持の条件を満たしていません。文言変更だけでは警告数が減らず、B127まで読み飛ばされる問題は残ります。

# 4. 推奨案の Phase 1 受入条件の骨子

推奨する最小線は次です。

## Phase 1-min の対象

- producer は直接の `SelectStatement`
- `normalizeGroupingSpec(stmt).type === "PLAIN"`
- producerにJOIN・サブテーブル・UNION・wildcardなし
- 全GROUP BY itemが `FIELD_NAME`
- 全plan itemが `ALIAS_SAFE`
- 各 `ALIAS_SAFE.columnIndex` が重複のない出力 identityへ残る
- キー式の入力を集計・window等のaliasが上書きしない
- consumerは単一CTE source、JOIN・サブテーブルなし
- consumerのwindow `ORDER BY` が、同じmaterialized sourceの候補キー全メンバーを `FIELD_NAME` として含む
- キー順は不問、追加ORDER BY項目は許可
- 候補キーを多段CTEへ伝播しない
- 一時テーブルはPhase 2

これなら主用途の `DATE_FORMAT(...) AS 年月 GROUP BY 年月` を扱えます。`PHYSICAL` の直接FIELD projectionは警告を残しますが、これは安全側のPhase 1制限です。

## 公開結果での受入

以下は B127・B128の両方について `SelectResult.warnings` で観測します。現行テストもwarning配列を直接確認しています。

- B127: `src/__tests__/window.execute.test.ts:276-309`
- B128: `src/__tests__/window.execute.test.ts:448-470`

警告が消える条件:

- 依頼元の月次CTEで `SUM(...) OVER (ORDER BY 年月)`
- 同じCTEで `LAG(...) OVER (ORDER BY 年月)`
- 複合ALIAS_SAFEキーを全て含む
- 複合キーのORDER BY順を入れ替える
- 全キーに追加ORDER BY項目を加える

警告が残る条件:

- §2反例①
- §2反例②
- 複合キーの一部だけ
- GROUP BYなし
- `PHYSICAL` キー（Phase 1-minでは対象外）
- 式GROUP BY
- wildcardまたは重複出力名
- キー式の入力名と集計aliasの衝突
- grouping sets
- UNION
- consumer JOIN
- 多段CTE
- 一時テーブル

既存回帰:

- direct APPの `$id` / `RECORD_NUMBER` は引き続き警告なし
- direct APPで非一意ORDER BYは警告あり
- 値、行順、rowCount、columnsが変更前後で同一
- 暗黙タイブレークを追加していない

`GroupByKey` は実際に算術・関数式を持てます（`src/types/ast.ts:732-735`）。Phase 1-minで式キーを除外することは、AST上の不存在ではなく、意図的なスコープ制限として扱う必要があります。

# 5. 決めるために測るべきこと

推奨案Aと、より安い案Cのどちらまで絞るかは、次を測ると決めやすくなります。

1. **実クエリのGROUP BY解決内訳**

   `ALIAS_SAFE`、`PHYSICAL`、式キーの割合を数える。主用途がほぼ `ALIAS_SAFE` なら Phase 1-min で十分です。物理列の直接GROUP BYが多いなら、Phase 1から `PHYSICAL → 同一FIELD projection` まで広げる価値があります。

2. **多段CTE・一時テーブルの利用率**

   直接1段CTEが大半なら案Cも候補です。多段CTEまたは `CREATE TEMP TABLE ... AS SELECT ... GROUP BY` が現実に多いなら、最初から案Aのrelation metadataが安くなります。

3. **出力衝突の実態**

   重複alias、wildcard混在、group式の参照フィールドと集計aliasの衝突がどの程度あるか。コード上、同じobject keyへの上書きは確認できますが、各クライアント表面で `columns` が最終的にどう正規化されるかは今回実行していないため**未確認**です。候補キー生成は外部表示に依存せず、projection前の列位置と出力identityで判定すべきです。

4. **警告削減率**

   Phase 1-minの条件だけで、B140対象警告の何割を消せるか。依頼元の月次例は対象になりますが、リポジトリ全利用での比率は**未確認**です。

以上はコード読解に基づく提案です。指定どおり、実行・テスト・kSQL MCP・git操作・ファイル変更は行っていません。
tokens used
123,825
# 1. 結論

