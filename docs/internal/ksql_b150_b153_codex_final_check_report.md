## 指摘

1. **Major — EXPLAIN が `in` の50件チャンク契約を再現しない**

   - 箇所: [src/execute.ts:5960](../../src/execute.ts#L5960)、[src/execute.ts:10264](../../src/execute.ts#L10264)
   - 根拠: 実行時は50件ごとに複数 query へ分割する一方、EXPLAIN は全値を単一の `in (...)` に直列化する。51～300件では実行 query と EXPLAIN 表示が一致せず、B150 §1.7・§9.4の serializer 契約に反する。
   - 修正案: EXPLAIN 側も共有 helper でチャンク化し、複数 fetch query を実行順に表示する。少なくとも51件・300件の逐語テストを追加する。

2. **Medium — 「3経路一致＋全件取得基準」の受入が逐語的に満たされていない**

   - 箇所: [src/__tests__/b150JoinKeyRangePrefilter.test.ts:162](../../src/__tests__/b150JoinKeyRangePrefilter.test.ts#L162)、[src/__tests__/b150JoinKeyRangePrefilter.test.ts:175](../../src/__tests__/b150JoinKeyRangePrefilter.test.ts#L175)、[src/__tests__/b150JoinKeyRangePrefilter.test.ts:193](../../src/__tests__/b150JoinKeyRangePrefilter.test.ts#L193)
   - 根拠: CTE・一時テーブル・APP→APP は個別に確認されているが、同じキー集合・同じJOIN先データを3経路で比較しておらず、全件取得後のJOIN結果との比較もない。B150 §11.2の回帰検出力を満たさない。
   - 修正案: 同一 fixture `{2025-08-04, 2025-08-06}` とgap行を含むJOIN先を共有し、3経路の最終結果を全件取得基準と比較するパラメータ化テストを追加する。

## 観点別結論

1. **型の受けない演算子の全廃: 合格**  
   `nativeWhereOperatorsForType()` を正として `in`、両境界、フォールバックを選択しており、未確認空キー型から `in ("")` が送られる経路は確認されなかった。

2. **範囲 prefilter のsuperset保証: 合格**  
   CTE・一時テーブル・APP→APPは共通実行 helper を通る。空値・非canonical・意味型不整合はフォールバックし、min/maxは `compareCanonicalValues()` を使用している。JOIN後照合も維持されている。

3. **trim廃止: 合格**  
   キー収集はtrimせず、ローカルJOIN評価器も文字列を逐語的にMap照合するため意味論は一致する。空白、quote、backslashのserializer確認も存在する。

4. **`in ("")` の型集合: コード上は合格、実機確認待ち**  
   pure policyは `SINGLE_LINE_TEXT / LINK / NUMBER / CALC / DROP_DOWN / RADIO_BUTTON / CHECK_BOX / MULTI_SELECT / STATUS` に限定され、レコード番号・ユーザー系は `JOIN_KEY_EMPTY_VALUE` でフォールバックする。

5. **受入の逐語照合: 要修正**  
   B150再現形、reason code、range serializer、合成順は固定されているが、51～300件のEXPLAINが実行 serializerと一致しない。

6. **既存回帰: 静的確認では合格、テスト完走未確認**  
   B151/B152のfield-vs-literal分類、`$id`、KLIKE、外部結合gate、300件警告文に破壊的変更は確認されなかった。

## Claudeの実測が必要なもの

- pure policy全9型について、実機で `in ("")` が受理され、未選択行を期待どおり取得すること。特に `LINK / CALC / RADIO_BUTTON / STATUS`。
- 前後空白付きTEXTキーの `in (" ... ")` が保存値を逐語検索し、ローカルJOIN結果と一致すること。
- B150再現形でDATE範囲 queryが実機送信され、`GAIA_IQ03` が発生しないこと。
- 修正前の空キー一致欠落と、修正後の空=空一致出現のbefore-fail／after-pass証跡。
- `npm test` 全体。今回の実行は `.tmp/b110-release-baseline/package/package.json` とのJest module collisionと、読み取り専用環境でのJest一時ファイル書き込み拒否により開始前に失敗した。`tsc --noEmit` も既存の `src/ui/desktop.ts` 型エラーで完走しなかった。
