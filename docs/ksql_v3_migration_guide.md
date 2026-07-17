# kSQL v3.0.0 移行ガイド

v3.0.0は、文字列・数値の比較、`ORDER BY`の実行主体、WHERE押し下げ、取得上限時のtop-Nを一つの契約へ統合するmajor releaseです。対象はB26 / B27 / B30 / B31 / B32です。

## 1. 通常ORDER BYはkSQL canonical順になります

通常の`ORDER BY`、ウィンドウ内ORDER、MIN/MAX、WHERE範囲比較、REORDERの比較leafは、宣言型に基づく共通規則を使います。

- typed stringと型不明列: Unicodeコードポイント順。`localeCompare`、Unicode正規化、値ベース数値判定は使いません
- typed number: `空セル < -Infinity < 有限数 < +Infinity < "NaN" < その他非数値`
- 選択系: 定義順。未知値は既知値の後ろ
- RECORD_NUMBER: アプリコードを含む表示値の末尾IDを任意精度で比較

特に、文字列型の`"2"`と`"10"`は数値順ではなく文字列順です。通常`ORDER BY`はLIMITが500以下でも、canonical窓との同値性を証明できなければ全候補を取得してローカルで並べます。初期REST top-N allowlistは`$id`だけです。

## 2. typed stringの範囲比較で結果行が変わります

v2のFULL_SCANには、数字だけに見える文字列をペアごとに数値比較する経路がありました。v3では宣言型を優先します。

```sql
WHERE 郵便番号 > '100'
```

文字列型ではコードポイント順なので、`'20'`、`'30'`、`'9'`等も`'100'`より大きい値です。返る行、COUNT/SUM等の集計結果、UPDATE/DELETE候補が変わり得ます。

なお、文字列型の`>`をkintone RESTは受理しません。v2のSIMPLE経路は`GAIA_IQ03`で失敗していました。v3のSELECTは型×演算子能力を確認してFULL_SCANへ切り替えます。DMLは対象集合を暗黙に広げず、実行前に`DmlConvertError`で拒否します。

## 3. #err数値列の非数値は固定バンドで扱います

B14の`#err`では、NUMBER宣言列に検証失敗入力`"x"`等が入ることが正常です。v3はこれを型破損エラーにせず、固定末尾バンドへ置きます。

- 数値が存在する`MIN`は最小数値を返します
- 数値がなく`"NaN"`があればsentinelを返します
- `MAX`は最も後ろの非数値を返し得ます

したがって、v2.15.0の受入証拠`MIN(数値T1) = NaN`は型メタ伝播の履歴上の証拠であり、v3の結果契約ではありません。ORDER BY、WHERE、MIN/MAXは同じ大小関係になります。

## 4. GREATEST / LEASTの集合モードは維持します

`GREATEST` / `LEAST`は物理列型ではなく引数集合について一度だけモードを決めるB19契約を維持します。

```sql
GREATEST('20', '100') -- v2.17.0と同じく '100'
```

v3が変更するのは文字列モードと数値tieの二次比較をコードポイント順へ揃える部分です。typed string一般則で集合モード自体を上書きしません。

## 5. 不完全なlocal top-Nはエラーになります

ローカル`ORDER BY`は完全な候補集合がなければ正しい最小・最大・top-Nを保証できません。`maxRecords`到達時に`onLimit=truncate`を指定していても、部分候補を並べ替えて成功せず`FetchAllLimitError`になります。

対処:

- WHEREを狭める、または`maxRecords`を安全な範囲で増やす
- canonical順が必要なら通常`ORDER BY`を維持する
- kintone固有順でよく、下記の条件を満たすなら`KORDER BY`を明示する

`CANONICAL_REST_TOP_N`と`KORDER_NATIVE`は単発REST窓であり、部分候補のローカルsortを行わないため、このエラーの対象外です。

入口ごとの`maxRecords`既定値（エンジン10,000件／CLI・MCP 500件／プラグイン3,000件）と、通常`ORDER BY`・REST top-N・`KORDER BY`のLIMIT/OFFSET境界は、[言語リファレンス「v3.0.0 制限値一覧」](ksql_language_reference.md#v300-制限値一覧)を参照してください。

## 6. KORDER BYを追加しました

`KORDER BY`はkintone RESTの型別順序を明示的に選ぶ別構文です。通常`ORDER BY`の高速化ヒントではありません。

```sql
SELECT 会社名
FROM APP100
WHERE 顧客ランク = 'A'
KORDER BY 会社名 ASC, $id ASC
LIMIT 20
```

初期版はトップレベル単一物理アプリ、非修飾の直接フィールド、完全押し下げWHERE、明示allowlist型、`LIMIT 0..500`かつ`maxRecords`以下、`OFFSET 0..10000`に限定します。JOIN、temp/CTE、subquery、UNION、SELECT-based DML、LIKE/KLIKE、alias、表修飾、式キーは拒否します。

`KORDER`は新しい予約語です。同名フィールドはバッククォートで囲んでください。

```sql
SELECT `KORDER` FROM APP100
```

## 7. JOINの曖昧ORDER BYを拒否します

JOIN両側に同じ列名がある非修飾`ORDER BY name`は、v2では黙って動く場合がありました。v3はplanning時に`ambiguous column`として拒否します。

```sql
-- NG
ORDER BY name

-- OK
ORDER BY a.name
```

## 8. EXPLAINはmetadata APIを読みます

schema-aware plannerと実行で同じ型・WHERE能力判定を行うため、`EXPLAIN`はフォーム定義を読み、canonical STATUS順が必要な場合だけプロセス状態定義も読みます。レコード取得・書き込みは行いません。

このため、対象アプリのフォーム定義を読めない認証では、v2で表示できたEXPLAINがv3で失敗する場合があります。CLI / MCP / プラグインの全サーフェスで同じ扱いです。

## 9. B9はv3.1.0候補です

v3.0.0は比較経路を共有leafへ統合しましたが、kintoneの最大30桁・小数桁・HALF_EVEN等を完全再現する厳密10進演算はB9として分離しています。binary64を超えるNUMBERの算術・丸めは、v3.0.0でもkintoneと差が残る可能性があります。
