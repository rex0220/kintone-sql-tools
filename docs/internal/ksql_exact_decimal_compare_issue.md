# 課題: B9 厳密10進比較

- 作成日: 2026-07-15
- 改訂日: 2026-07-17（R4: B26の`#err`非数値末尾バンド契約と境界を同期）
- ステータス: **高優先度の独立 follow-up。B26 と同時実装しないが、旧「16桁級アプリは対象外なので実害は低」という保留理由は撤回する**
- 関連: [文字列・比較の横断仕様](ksql_string_semantics.md) §4.5.5 / §7 制限6、[B29](ksql_number_precision_semantics_issue.md)
- 分担: Claude=仕様/観点、Codex=実装/テスト

## 1. 問題

`scalarCompare`（[src/core/scalarCompare.ts](../../src/core/scalarCompare.ts)）などの数値比較は `Number()` を通す。IEEE-754 binary64 では、kintone が保持できる10進値を常に区別できない。

```text
Number("9007199254740992") === Number("9007199254740993")
```

kintone の [`numberPrecision.digits`](https://cybozu.dev/ja/kintone/docs/rest-api/apps/settings/get-general-settings/) はアプリ単位で1〜30桁を設定できる。したがって、16桁の上記2値を含む安全整数範囲外の値は仕様上の対象になり得る。17桁の値を12桁設定の検証アプリへ入れて拒否された観測から、16桁級を対象外とは結論できない。

この差は次に現れる。

- FULL_SCAN の `ORDER BY` が異なる値を同値として扱う
- WHERE / HAVING / CASE WHEN / ASSERT / BETWEEN の範囲比較が丸めで変わる
- 一般 NUMBER の `<=` / `>=` プレフィルタを押し下げると、超集合性を壊して行を欠落させ得る
- MIN / MAX など、同じ比較 primitive を使う経路がkintoneの10進順とずれ得る

## 2. B9 が所有する範囲

**B9 は、既に値として存在する有限10進数の解析・正規化・比較を厳密化する。**

- 1〜30桁の整数・小数を文字列のまま正確に比較する
- SQL数値リテラルの元字句をASTまで保持する。現状の`NumberLiteral.value: number`と`Number(tok.value)`では、比較器へ届く前に16桁値が丸められるため、比較器だけを差し替えて完了としない
- `< > <= >=` と、typed number の等価判定・ORDER BY・MIN/MAXで同じ10進 primitiveを共有する
- 符号、`-0`、末尾ゼロ、指数表記を正規化する
- 空セルは既存の「数値型では最小値クラス」契約を維持する
- B9の厳密10進primitiveは有限10進値だけを解析する。B26の外側のtyped-number domainは、空セル、算術由来の±Infinity、正規`"NaN"` sentinel、B14 `#err`由来のその他非数値バンドを有限10進値と分離して順序づける。物理kintone NUMBERへの入力・書込みでは引き続き拒否する
- typed textや型不明値を値の見た目だけで数値へ昇格しない

比較器は `numberPrecision` を読まなくても、任意精度の有限10進文字列を比較できるようにする。アプリ設定は受入値域の境界テストと診断には使えるが、比較結果そのものを設定ごとに変えない。

## 3. B9 に含めない範囲

`numberPrecision.decimalPlaces` と `numberPrecision.roundingMode` は、既存値同士の大小比較ではなく、**入力・算術結果を保存精度へ量子化する規則**である。B9へ含めると、比較修正が算術エンジン、DML変換、Tier-0検証まで膨張するため、[B29](ksql_number_precision_semantics_issue.md)へ分離する。

B9 に含めないもの:

- INSERT / UPSERT / UPDATE値の有効桁数・小数桁数の事前検証
- `HALF_EVEN` / `UP` / `DOWN` による丸め
- 算術式・ROUND・集計結果をkintoneのアプリ精度へ量子化する処理
- `+ - * / %`や数値関数そのものを任意精度10進演算へ置き換えること
- `VALIDATE ONLY` / `ON ERROR SKIP` がAPI拒否を事前再現する機能

算術評価が既にbinary64へ丸めた値を、比較器だけで元の10進値へ戻すことはできない。B9完了時に厳密一致を保証するのは、**kintoneから得た数値文字列、字句を保持した数値リテラル、および厳密primitiveが生成した値**である。JS算術由来値はB29の任意精度評価が完了するまで制限として残すか、精度保証が必要な経路ではfail-closedにする。実装前にどちらかを決定する。

## 4. 設計上の決定事項

| 軸 | 契約 |
|---|---|
| 符号 | 負 < 0 < 正 |
| `-0` / `0` | 数値として同値 |
| 末尾ゼロ | `1.10` と `1.1` は同値 |
| 指数表記 | 受理するなら正規化後の同じ10進値として比較。SQL字句としての受理範囲は別途固定する |
| 空セル | typed numberでは全有限値より小さい既存契約を維持 |
| 非有限値・域外値 | B26の外側domainで`空セル < -Infinity < 有限10進 < +Infinity < NaN sentinel < その他非数値`。その他非数値バンド内はコードポイント順。厳密10進parserへ混ぜず、比較器の戻り値へ`NaN`を出さない |
| 非数値文字列 | B14 `#err`等のtyped numberでは上記末尾バンド。typed stringでは通常のコードポイント比較。型不明を値ベースで数値化しない |
| 戻り値 | 常に `-1 / 0 / 1` |

## 5. 影響範囲

- lexer/parser/AST: `NumberLiteral.value: number`だけでは元字句を失う。decimal表現またはraw lexemeを追加し、INSERT等の既存消費先との互換を設計する
- `scalarCompare` の消費先: WHERE / HAVING / CASE WHEN / サブテーブル UPDATE・DELETE・REORDER / ASSERT / BETWEEN
- B26のtyped number ORDER BY、MIN/MAX、比較器共通化
- 数値プレフィルタ: 厳密比較完成後に `<=` / `>=` の超集合性を再証明する。押し下げ解禁は別変更とする
- CLI / MCP / プラグインの4面。同じ文字列ベースprimitiveを共有し、ホストの浮動小数点差へ依存しない

## 6. 受入条件

- `9007199254740992 < 9007199254740993` を区別する
- 同じ2値をSQLリテラルに書いた場合も、parse直後から比較完了まで区別を失わない
- 30桁境界、最大10小数桁、正負、0/-0、末尾ゼロを直積で検査する
- 比較器の反対称性・推移性・同値関係の推移性をproperty testする
- SIMPLE raw RESTとFULL_SCANを、`$id asc`を明示して同じ行列で比較する
- WHERE / HAVING / CASE / ASSERT / BETWEEN / ORDER BY / MIN/MAXの代表経路を回帰テストする
- JS算術由来値について、B9時点で保証する範囲と制限/エラーをテストで固定する
- 正規`"NaN"` sentinel、±Infinity、その他非数値がB26の外側domain順を維持し、有限10進値だけが厳密primitiveへ入る
- その他非数値バンド内のコードポイント順とpeer関係をB9後も維持する

## 7. 未実測

`numberPrecision.digits >= 16` のアプリで次の保存可否とraw REST順を確認する。

```text
9007199254740992
9007199254740993
```

APP4221は12桁設定なので、この境界確認には使用できない。実測未完でも、公式上限が30桁であるためB9の必要性と優先度は下げない。

## 8. リリース判断

- B26とは分離する。B26完了時も「大精度typed numberはB9完了までRESTと完全一致しない」という制限を残す
- B9は比較意味論の変更なので、単なる性能改善として扱わない
- 優先度: **高**
