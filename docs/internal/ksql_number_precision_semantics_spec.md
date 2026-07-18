# B29 kintone 数値精度・丸め設定と DML/Tier-0 の整合仕様

- 作成日: 2026-07-18
- ステータス: **仕様 R1・Claude レビュー承認（2026-07-18）・実装待ち（B9 先行）**。HALF_EVEN 丸めは検算 9/9 一致・既存コードアンカー実在・B34 CALC 衝突/ROUND 意味/B9 primitive 再利用の各契約を確認。実装は B9 完了後（S0→S5）。
- 分担: Claude=仕様/観点・Codex=実装/テスト
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B29
- 課題文書: [ksql_number_precision_semantics_issue.md](ksql_number_precision_semantics_issue.md) R2（本仕様の正）
- B9 仕様: [ksql_exact_decimal_compare_issue.md](ksql_exact_decimal_compare_issue.md) R5（現時点の B9 契約。B29 は B9 の厳密10進 primitive を再利用する）
- 参考: [B12-A `VALIDATE ONLY` 実装計画](ksql_validate_only_implementation_plan.md)、[kintone「アプリの一般設定を取得する」](https://cybozu.dev/ja/kintone/docs/rest-api/apps/settings/get-general-settings/)、[kintone「数値の有効桁数と丸めかたを設定する」](https://jp.kintone.help/k/ja/app/form/othersettings/significant_figures)
- リリース想定: **minor**。安全側の検証強化だが、従来 `valid` だった行が `invalid` へ変わることを移行時に明示する

---

## 1. 目的

kintone のアプリ単位設定 `numberPrecision` を DML の Tier-0 検証へ取り込み、kSQL がローカルで `valid` と判定した数値を実書込みが桁超過の `CB_VA01` で拒否する偽合格を解消する。

対象設定は次の3項目である。

```text
numberPrecision.digits         全体の最大桁数（1〜30）
numberPrecision.decimalPlaces  小数部の最大桁数（0〜10）
numberPrecision.roundingMode   HALF_EVEN / UP / DOWN
```

kintone では整数部の許容桁数は `digits - decimalPlaces` である。設定は NUMBER と数値表示の CALC、およびそれらを使う計算へアプリ単位で適用される。

本仕様は B29 v1 として、次を確定する。

- 書込み先アプリの設定を取得し、NUMBER 候補値の整数部・小数部の桁超過を Tier-0 で検出する
- `VALIDATE ONLY`、`ON ERROR SKIP`、通常書込みで同じ値検証 primitive と同じ設定を使う
- 通常の DML 値を暗黙に丸めて受理しない。超過はエラーにし、入力値を保持する
- 3 種の量子化アルゴリズムは厳密10進文字列上で定義するが、暗黙の DML 補正には接続しない
- 算術全体の任意精度10進化は B29 v2 へ分離する

## 2. 現状と変更境界

### 2.1 現行コードの事実

2026-07-18 時点の `src` には `numberPrecision`、`app/settings.json`、`general-settings` の参照がない。

`src/core/dmlValidation.ts` の NUMBER 検証は次だけを行う。

1. `isFiniteDecimal()` による有限10進形式の確認
2. `compareDecimal()` による `minValue` / `maxValue` の範囲確認

`digits`、`decimalPlaces`、`roundingMode` は一切参照しない。このため、実測では `VALIDATE ONLY` が桁超過を `valid` とした後、実 INSERT が `CB_VA01` で拒否した。

### 2.2 B29 v1 の対象

| 項目 | v1 |
|---|---|
| app settings 取得・アプリ別キャッシュ | 対象 |
| NUMBER 書込み値の整数部・小数部の桁検証 | 対象 |
| INSERT / UPDATE / UPSERT の全対応経路 | 対象 |
| `VALIDATE ONLY` / `ON ERROR SKIP` / 通常書込みの判定共有 | 対象 |
| 厳密10進の解析・正規化・比較 primitive | B9 を再利用 |
| HALF_EVEN / UP / DOWN の文字列ベース量子化 primitive | 対象。ただし暗黙の DML 自動丸めには使用しない |
| `+ - * / %`、集計、CALC 由来値の任意精度評価 | 対象外。binary64 のまま |
| kintone の計算エンジン全体の再現 | 対象外 |

### 2.3 意図的な Tier-0 範囲拡大

従来の Tier-0 は「kintone API 拒否の完全な予測」ではなかった。B29 v1 は、`numberPrecision` で静的に判定できる拒否を Tier-0 へ追加する意図的な契約拡大である。

この結果、次の利用者可視の変更が起きる。

- 従来 `VALIDATE ONLY` で `validRows` に数えられた行が `invalidRows` へ移る
- 従来 `ON ERROR SKIP` のローカル検証を通過してバッチ API エラーに至った行が、書込み前に `#err` へ隔離される
- 通常 DML も同じ検証で書込み前に停止し、kintone の汎用的な `CB_VA01` より具体的なローカル診断を返す

ただし、権限、一意制約、競合、参照先実在性など Tier-0 外の API エラーまで成功保証するものではない。

## 3. B9 との所有境界と着手順

| 領域 | 所有 |
|---|---|
| 既に存在する有限10進値の解析・正規化・厳密比較 | B9 |
| SQL 数値リテラルの raw lexeme 保持 | B9 |
| 指数表記の有限10進正規化 | B9 |
| 書込み値がアプリ精度に表現可能かの判定 | B29 |
| `digits` / `decimalPlaces` の超過診断 | B29 |
| `HALF_EVEN` / `UP` / `DOWN` による量子化 | B29 |
| JS 算術を任意精度10進評価へ置換 | B29 v2 |

着手順は **B9 → B29** とする。B29 は B9 が確立する単一の厳密10進 primitive を、桁検証と量子化へ拡張して再利用する。現行 `dmlValidation.ts:compareDecimal` と別の decimal parser/comparator を新設してはならない。

B9 完了前に B29 の surface 配線だけを先行させない。raw lexeme が `Number()` で失われた後では、16〜30桁値の正しい桁判定も量子化もできないためである。

## 4. app settings の取得契約

### 4.1 クライアント契約

`KintoneClient` に、運用環境の `GET /k/v1/app/settings.json` を表す取得口を追加する。レスポンスから少なくとも次を文字列のまま受け取り、検証済みの内部型へ変換する。

```ts
interface NumberPrecision {
  digits: number;                 // 1..30
  decimalPlaces: number;          // 0..10
  roundingMode: "HALF_EVEN" | "UP" | "DOWN";
}
```

未知の `roundingMode`、欠落、非整数、範囲外値は設定取得失敗として扱う。既定値 `16/4/HALF_EVEN` を補わない。

CLI、MCP、plugin UI は各自で設定を解釈せず、`KintoneClient` と engine の同じ取得・検証経路を使う。ゲストスペース URL や API token profile の扱いは既存 `getFields` / `getProcessStatuses` と同じ client route に従う。

### 4.2 取得条件

取得対象は DML の書込み先アプリだけである。B34 と同様に書込み先フィールドをフォーム定義で解決した後、DML 候補の対象に数値意味型の NUMBER または CALC が含まれる場合だけ取得する。

- 実際に書込み可能な対象列は NUMBER である
- CALC は現行 B34 契約では書込不可であり、CALC を直接指定した文は行検証前の静的エラーになる
- INSERT SELECT 等のソースに CALC が存在するだけでは、ソースアプリの settings を取得しない。書込み先 NUMBER の精度で候補値を検証する
- 数値対象列がない INSERT / UPDATE / UPSERT、SELECT、DELETE、DESCRIBE 等では取得しない
- 空の source SELECT でも NUMBER 書込み列が確定しているなら、設定を取得できることを文の成立条件とする。0行を理由に設定失敗を隠さない

### 4.3 キャッシュ

`getFieldsCached(appId, client, cacheContext)` と同じ scope・同じライフサイクルで、`cacheContext × appId` ごとに `Promise<NumberPrecision>` をキャッシュする。

- 同じ実行コンテキストでは、同じアプリへの実 API 呼出しは最大1回
- 並行して要求された場合も同じ in-flight Promise を共有する
- CLI / MCP / plugin のバッチ中に同一アプリを複数文が参照しても最大1回
- 別 `cacheContext` へ値を漏らさない
- rejected Promise を既定値へ置換しない。文またはバッチは fail-closed する
- フォーム定義と一般設定は別 endpoint なので別 cache entry とするが、scope と invalidation 規則は揃える

### 4.4 権限と失敗時動作

運用環境の一般設定取得には、公式仕様上、次のいずれかがあればよい。

- アプリのレコード閲覧権限
- アプリのレコード追加権限

したがって、通常の参照または追加ができる DML 利用者へアプリ管理権限を追加要求しない。preview endpoint は使用しない。

HTTP エラー、認証・権限エラー、timeout、不正レスポンス、未対応モードはすべて文全体の静的/準備エラーである。`VALIDATE ONLY` でも成功結果を返さず、`ON ERROR SKIP` でも行エラーへ変換しない。推測した精度で一部行を通すことを禁止する。

## 5. 桁検証の意味論

### 5.1 入力表現

B29 が受け取る値は、B9 primitive が有限10進として正規化できる文字列表現でなければならない。符号、先頭ゼロ、末尾ゼロ、`-0`、指数表記は B9 の正規化契約に従う。検証前に JS `number` へ変換しない。

概念上の正規形は次である。

```ts
interface ExactDecimal {
  sign: -1 | 0 | 1;
  coefficient: string; // 符号・小数点なし。0以外は先頭ゼロなし
  scale: number;        // 小数点以下の桁数
}
```

末尾ゼロは値を変えずに除けるため、`1.2300` は `1.23`、`0.000` と `-0` は `0` として表現可能性を判定する。これは値の自動丸めではなく同じ10進値の正規化である。エラー行へ表示する元入力は書き換えない。

### 5.2 許容範囲

設定を `D = digits`、`P = decimalPlaces`、整数部予算を `I = D - P` とする。**この予算式（整数部 = digits − decimalPlaces）は kintone の実挙動を前提としており、実装前に §11-4 の実機で確定する**（`D=16, P=4` で整数 13 桁が `ERR_NUMBER_INTEGER_DIGITS` 相当で拒否されるか、合計 digits 制限として別挙動になるかを境界で確認）。実機と食い違えば予算式を実挙動へ合わせる。

有限10進値は次を両方満たす場合だけ表現可能である。

1. 正規化後の小数部桁数 `scale <= P`
2. 整数部の桁数が `I` 以下

整数部の桁数は先頭ゼロを除いて数える。絶対値が1未満の値とゼロの整数部桁数は 0 とする。符号と小数点は桁数に含めない。桁上がり後の再検証が必要な量子化結果では、量子化後の正規形に同じ規則を適用する。

例: `D=16, P=4` では整数部12桁、小数部4桁までである。

| 値 | 判定 | 理由 |
|---|---|---|
| `999999999999.9999` | valid | 整数12桁・小数4桁 |
| `1000000000000` | invalid | 整数13桁 |
| `1.2345` | valid | 小数4桁 |
| `1.23450` | valid | 末尾ゼロ除去後は小数4桁 |
| `1.23451` | invalid | 小数5桁、非ゼロ情報を失わず表現できない |
| `-0.0000` | valid | 正規化後はゼロ |

### 5.3 エラー契約

NUMBER の既存検証順を次で固定する。

1. required / empty
2. 有限10進形式
3. `minValue`
4. `maxValue`
5. 整数部桁数 (`digits - decimalPlaces`)
6. 小数部桁数 (`decimalPlaces`)

安定した行エラーコードを追加する。

```text
ERR_NUMBER_INTEGER_DIGITS  整数部の許容桁数を超える
ERR_NUMBER_DECIMAL_PLACES  小数部の許容桁数を超える
```

1値が両方を超える場合は、規則順に最初の `ERR_NUMBER_INTEGER_DIGITS` だけを返す。既存 `validateAndNormalizeDmlValue()` が1フィールド1エラーを返す契約を維持するためである。診断にはフィールドコード、実際の桁数、許容桁数、`digits` / `decimalPlaces` を含める。

通常書込みでこのエラーが出た場合は API を呼ばない。`VALIDATE ONLY` / `ON ERROR SKIP` では既存の `$err_field`、`$err_code`、`$err_message` へ同じ内容を出す。

## 6. 検証位置と全 DML 経路

### 6.1 共通入口

桁検証は `src/core/dmlValidation.ts` の NUMBER 分岐へ追加し、`validateAndNormalizeDmlValue()` が `NumberPrecision` を受け取れる形へ拡張する。候補行検証器と通常 converter の双方がこの primitive を呼ぶ。

`prepareDmlValidation()` は既に `VALIDATE ONLY` と `ON ERROR SKIP` の共通準備入口である。B29 はここで書込み先 field metadata と settings を揃え、全 candidate へ同じ precision を渡す。通常 DML の `executeInsert*` / `executeUpdate*` / `executeUpsert*` も API payload 作成前に同じ primitive を通す。

通常書込みだけ API に任せる、または validation 系だけ厳しくする非対称を残してはならない。

### 6.2 対応マトリクス

次の全セルで同じ precision 検証を行う。これは B34 の書込み先検査と同じ横断適用方針である。

| DML | 値の経路 | 通常書込み | VALIDATE ONLY | ON ERROR SKIP |
|---|---|---:|---:|---:|
| INSERT | VALUES | 対象 | 対象 | 対象 |
| INSERT | SELECT | 対象 | 対象 | 対象 |
| UPSERT | VALUES create/update | 対象 | 対象 | 対象 |
| UPSERT | SELECT create/update | 対象 | 対象 | 対象 |
| UPDATE | 通常 SET | 対象 | 対象 | 対象 |
| UPDATE | 算術 SET | 対象（§8 の制限あり） | 対象（同左） | 対象（同左） |
| UPDATE | CASE / スカラー関数 | 対象（§8 の制限あり） | 対象（同左） | 対象（同左） |
| UPDATE | UPDATE ... FROM | 対象（§8 の制限あり） | 対象（同左） | 対象（同左） |

UPSERT は照合後の create/update どちらでも同じ NUMBER 桁規則を使う。UPDATE は SET 対象列だけを検証する。未送信の NUMBER/CALC 値をアプリ全体から再検証する機能ではない。

### 6.3 surface 一致

CLI、MCP、plugin は engine の結果を表示するだけで、precision 判定を再実装しない。同じ SQL、設定、入力に対し、全 surface で error code と valid/invalid 件数が一致しなければならない。

## 7. v1 の量子化方針

### 7.1 通常 DML は検証のみ

v1 の既定かつ唯一の通常 DML 動作は **検証のみ** である。`decimalPlaces` または整数部予算を超えた値を、app settings の `roundingMode` で自動丸めして受理しない。

自動丸めを選ばない理由:

- 入力の非ゼロ桁を無告知で捨てると、利用者が書いた値と送信値が変わる
- `VALIDATE ONLY` はプレビューであり、値を書き換える操作ではない
- `ON ERROR SKIP` で「隔離」か「丸めて書込み」かが入力から判別できなくなる
- 丸め後の桁上がりで別の境界超過が起き、診断と実行の理解が難しくなる
- B1/B16/B19 で採用した fail-closed・暗黙補正を避ける方針と整合する
- 実 INSERT と一致させる目的は、安全に拒否を予測することで達成できる

`roundingMode` は取得・検証済み settings の一部として保持するが、通常の超過判定結果を変えない。3モードで同じ超過入力はすべて invalid である。

### 7.2 明示的丸め経路との境界

量子化を許すのは、利用者が SQL 上で明示的に丸めを要求した経路だけである。暗黙の DML 後処理、converter の副作用、API payload 作成時の補正から量子化 primitive を呼んではならない。

ただし B29 v1 は、既存 `ROUND` / `FLOOR` / `CEIL` / `TRUNCATE` の公開意味を `numberPrecision.roundingMode` で変更しない。特に既存 `ROUND` の「四捨五入」を、書込み先アプリが `HALF_EVEN` だからという理由で銀行丸めへ差し替えない。app-aware な明示量子化を公開する場合は、構文・関数名・対象 scale を別仕様で明示してから接続する。

したがって v1 の実装境界は次である。

- 文字列ベースの `quantizeDecimal(value, scale, mode)` primitive とテストを持てる
- 通常 DML の桁超過を自動修正する call site は持たない
- 既存の明示的丸め関数が生成した値は、生成後に通常どおり §5 の表現可能性検証を受ける
- 明示的丸め後も app precision を超えるなら invalid であり、追加の暗黙丸めを重ねない

### 7.3 量子化アルゴリズム

`quantizeDecimal()` は B9 の `ExactDecimal` 相当表現を使い、`Number()`、`parseFloat()`、`toFixed()`、`Math.round()` を使わない。

目標小数桁を `P` とし、正規化した絶対値の小数部を `kept`（先頭 P 桁）と `discarded`（残り）へ分ける。`discarded` がない、または全桁 `0` なら値を変えない。増分が必要な場合は、整数部と `kept` を連結した10進数字列へ右端から carry を伝播し、最後に小数点と符号を戻す。

| mode | 増分条件 | 正負の方向 |
|---|---|---|
| `DOWN` | 増分しない | 絶対値を縮める、すなわち 0 方向 |
| `UP` | `discarded` に非ゼロが1つでもある | 絶対値を増やす、すなわち 0 から離れる方向 |
| `HALF_EVEN` | 下記 | 最近接。ちょうど中間は保持末尾が偶数になる側 |

HALF_EVEN は次の桁ベース判定である。

1. 最初の捨てる桁が `0..4` なら増分しない
2. 最初の捨てる桁が `6..9` なら増分する
3. 最初の捨てる桁が `5` で、後続に非ゼロがあれば 0.5 より大きいため増分する
4. 最初の捨てる桁が `5` で、後続がすべてゼロならちょうど中間である
5. 中間では、保持する最後の数字が奇数なら増分し、偶数なら増分しない。`P=0` では整数部末尾を使う

符号は magnitude の丸め決定後に戻す。例:

| 入力、P | HALF_EVEN | UP | DOWN |
|---|---:|---:|---:|
| `1.25`, 1 | `1.2` | `1.3` | `1.2` |
| `1.35`, 1 | `1.4` | `1.4` | `1.3` |
| `-1.25`, 1 | `-1.2` | `-1.3` | `-1.2` |
| `-1.35`, 1 | `-1.4` | `-1.4` | `-1.3` |
| `9.999`, 2 | `10.00` | `10.00` | `9.99` |

量子化結果は再正規化後、整数部予算を再検証する。`9.999 → 10.00` のような carry で `digits` を超えた場合は受理しない。

## 8. binary64 算術の制限と B29 v2

B29 v1 は次を任意精度10進へ置換しない。

- `+ - * / %`
- `SUM` / `AVG` 等の集計
- 数値関数一般
- CASE の分岐内で行われる算術
- CALC 由来値を kSQL 内で再計算すること

これらは現行どおり binary64 で評価される。B9 と同じく、一度 JS 算術で失われた元の10進桁は復元できない。B29 v1 の検証は「検証器へ到達した書込み文字列が app precision に表現可能か」を判定するものであり、JS 算術前の数学的な真値との一致を保証しない。

この制限は UPDATE 算術、CASE、UPDATE FROM、INSERT/UPSERT SELECT の式結果にも同じように適用する。経路ごとに精度保証を誇張しない。

B29 v2 は別仕様として、少なくとも次を扱う。

- 任意精度10進による `+ - * / %`
- 集計 accumulator の10進化
- 数値関数と明示量子化 surface
- CALC / kintone 計算との一致範囲
- 中間演算ごとに app precision を適用するか、最終書込み時だけ適用するか

## 9. 実装段階

本書は仕様であり、この作業では実装しない。実装時は次の順を守る。

### S0: B9 完了と契約テスト

- raw lexeme、指数表記、最大30桁を保持する B9 primitive を完成させる
- 現行 main で桁超過が偽合格する回帰テストを先に赤で固定する

### S1: settings 型・client・キャッシュ

- `KintoneClient` の一般設定取得口
- node / UI client と request gate
- `cacheContext × appId` の Promise cache
- 範囲外・欠落・unknown mode の fail-closed

### S2: precision validator / quantizer

- B9 primitive 上の整数部桁数・scale 判定
- 安定 error code
- 文字列ベース HALF_EVEN / UP / DOWN
- carry 後の再検証

### S3: validation 系配線

- `prepareDmlValidation()` で field metadata と settings を取得
- `validateDmlCandidates()` → `validateAndNormalizeDmlValue()` へ precision を渡す
- `VALIDATE ONLY` / `ON ERROR SKIP` の全 candidate 経路

### S4: 通常 DML 配線

- INSERT VALUES/SELECT
- UPSERT VALUES/SELECT の create/update
- UPDATE 通常/算術/CASE/FROM
- API 呼出し前に同じ primitive を適用

### S5: surface・文書・release

- CLI / MCP / plugin の client 実装と metrics
- Tier-0 拡大、binary64 制限、minor migration note
- 台帳、CHANGELOG、言語リファレンス、MCP descriptions、smoke assertions の同期

## 10. 自動テスト受入条件

### 10.1 settings / cache

- NUMBER/CALC に関係しない DML と read-only 文では settings API を0回
- 同一 `cacheContext × appId` の複数文・並行要求で実 API は最大1回
- 別 app、別 cacheContext は共有しない
- 取得失敗、欠落、`digits=0/31`、`decimalPlaces=-1/11`、unknown mode で fail-closed
- 失敗時に `16/4/HALF_EVEN` を仮定しない
- CLI / MCP / plugin の guest/non-guest route が既存 fields API と同じ app 解決を使う

### 10.2 桁境界

`digits ∈ {1,16,30}`、`decimalPlaces ∈ {0,10}`、`roundingMode ∈ {HALF_EVEN,UP,DOWN}` の直積18設定を table-driven test にする。各設定について少なくとも次を検査する。

- 設定が許す最大整数部の直前・境界・1桁超過
- 小数部 0、P、P+1 桁
- P+1 桁目が 0 のみの等価表現と、非ゼロを含む超過
- 正負、`0`、`-0`、先頭ゼロ、末尾ゼロ、指数表記
- 量子化 carry 前後で整数部境界を跨ぐ値

実在し得ない設定組合せが kintone API から返らないことが確認された場合でも、純粋 primitive の直積テストは残し、設定レスポンス validator の扱いを別途固定する。

### 10.3 丸めモード

3モードそれぞれで、正負の次を検査する。

- ちょうど中間
- 中間の直前（最初の捨てる桁4、または5の後続が中間未満）
- 中間の直後（5の後続に非ゼロ）
- 保持末尾が偶数 / 奇数
- `P=0` と `P=10`
- carry なし / 小数部 carry / 整数部 carry

HALF_EVEN の必須例は `0.5→0`、`1.5→2`、`2.5→2`、`3.5→4` とその負数である。`Math.round` への委譲、binary64 への一時変換、`toFixed()` での代用を検出する大桁・中間値テストを置く。

通常 DML の validation-only 契約として、同じ小数桁超過値は3モードすべてで invalid になり、自動量子化されないことも固定する。

### 10.4 DML 横断

§6.2 の全セルについて、境界内1件・整数部超過1件・小数部超過1件を少なくとも検査する。

- `VALIDATE ONLY` の `validRows` / `invalidRows` / `$err_code`
- `ON ERROR SKIP` の書込み件数、隔離件数、`#err` 元値保持
- 通常書込みが invalid 行で POST/PUT を0回にすること
- valid 行の payload が従来値から変わらないこと
- UPSERT create/update の両分岐
- UPDATE 通常/算術/CASE/FROM
- INSERT/UPSERT SELECT の空 source と複数行
- CLI / MCP / plugin で同じ結果

### 10.5 ローカル判定と実 API の一致

実機 fixture と同じ settings・値を mock へ固定し、次を比較する。

- `VALIDATE ONLY` が invalid とした行を実 INSERT/UPSERT/UPDATE しても受理されない
- `VALIDATE ONLY` が valid とした代表境界行は実 API でも受理される
- 既知の偽合格（桁超過を valid、実 INSERT は `CB_VA01`）が解消する

Tier-0 外エラーの存在により一般的な「valid なら必ず API 成功」までは主張しない。比較対象は numberPrecision による桁判定に限定する。

## 11. Claude が実機で確認する項目（実装後）

実機操作と証跡作成は Claude 担当とし、本仕様作成時には実行しない。

1. settings API が返す `digits` / `decimalPlaces` / `roundingMode` と画面設定の一致
2. 運用環境でレコード閲覧権限のみ、追加権限のみの各 credential で取得可能
3. `digits=1/16/30`、`decimalPlaces=0/10`、3モードの設定可能な直積。UI/API が拒否する組合せも記録
4. 最大整数部境界と1桁超過の INSERT / UPSERT / UPDATE
5. 小数部境界、末尾ゼロだけの超過、非ゼロ超過
6. 正負の中間・直前・直後、および HALF_EVEN の偶数/奇数保持桁
7. carry で整数部桁数が増える値
8. 同じ入力に対する `VALIDATE ONLY`、`ON ERROR SKIP`、実 INSERT/UPSERT/UPDATE の numberPrecision 判定一致
9. 設定取得権限を欠く credential、timeout/HTTP error で既定精度を仮定せず fail-closed
10. CLI / MCP / Chromium plugin / Firefox plugin の同一判定と、settings API 呼出し回数
11. 試験レコードの cleanup と、app settings の原状復帰

証跡には app ID、設定値、SQL、surface、API response/error code、ローカル error code、cleanup 結果を残す。

## 12. SemVer・移行・公開文書

B29 v1 は **minor** とする。

理由:

- API が拒否する値をより早く検出する安全側の正しさ改善である
- 新しい settings API read と、より具体的な診断が加わる
- 一方で、従来 `VALIDATE ONLY` が `valid` とした行が `invalid` に変わり、`ON ERROR SKIP` の書込み件数も変わり得る

release note / migration note には少なくとも次を明記する。

- Tier-0 の意図的な範囲拡大
- `numberPrecision` 取得の追加と必要権限
- 設定取得失敗は fail-closed
- 超過値を自動丸めしない
- JS 算術由来値は binary64 制限が残る
- B9 先行・共通厳密10進 primitive

実装完了時は課題台帳、CHANGELOG、言語リファレンス、MCP tool descriptions/schema descriptions、CLI/plugin help、release manifest と smoke assertions を横断監査する。

## 13. 完了条件

- [ ] B9 の単一厳密10進 primitive を再利用し、decimal parser/comparator を二重実装していない
- [ ] settings API は必要な DML だけで呼ばれ、アプリごと最大1回キャッシュされる
- [ ] 取得失敗時に既定精度を仮定せず fail-closed
- [ ] §6.2 の全 DML × mode 経路が同じ NUMBER 検証を使う
- [ ] 整数部・小数部の桁超過が安定 error code で診断される
- [ ] 通常 DML は超過値を自動丸めしない
- [ ] HALF_EVEN / UP / DOWN が文字列・桁ベースで実装され、`Math.round` を使わない
- [ ] 算術・集計・CALC 由来値の binary64 制限がテストと公開文書に残る
- [ ] `VALIDATE ONLY` と実 API の numberPrecision 判定が実機代表値で一致する
- [ ] minor の互換性注意が migration/release note に明記される
- [ ] Claude 実機証跡と cleanup が完了する

---

実装着手順は **B9 → S0 → S1 → S2 → S3 → S4 → S5** とする。B29 v1 の中心契約は、アプリ設定を推測せず取得し、全 DML 経路で同じ厳密10進検証を行い、超過値を暗黙に捨てないことである。
