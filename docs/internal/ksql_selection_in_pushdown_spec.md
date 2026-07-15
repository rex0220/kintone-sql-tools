# 仕様案: 選択系 `IN` の型メタ付きプレフィルタ（述語分割 第2段）

- 作成日: 2026-07-15
- ステータス: **仕様案 R5（フェーズ1＝[ksql_fullscan_in_typed_eval_spec.md](ksql_fullscan_in_typed_eval_spec.md) は v2.5.0 でリリース済。本書はフェーズ2＝押し下げの実装着手可能な詳細。実機ゲートで対象を確定）**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- 更新履歴:
  - 2026-07-15 R1: 初版
  - 2026-07-15 R2: codex レビュー反映（空文字・存在しない値のゲート追加、NOT IN 根拠訂正、flatten 根拠、型メタ取得観測の訂正）。
  - 2026-07-15 R3: 実機ゲート（DROP_DOWN/RADIO＝`GAIA_IQ10`・STATUS＝`GAIA_ST02`）。設計を「型だけでなく選択肢メタで全 IN 値の実在を検証」へ変更。
  - 2026-07-15 R4: 範囲を「in / not in 可能な全項目タイプ」へ拡張（ユーザー方針）。P1（正しさ）と P2（押し下げ）の 2 フェーズ確定。STATUS は `enabled` で条件付き対応。
  - 2026-07-15 R5: **フェーズ1 リリース済（v2.5.0）を反映。実機ゲート追加実施＝押し下げ対象を確定**。
    - **全選択型が非実在値でエラー**を返す（FULL_SCAN の JS は 0 件）。エラーコードは型で異なる:
      - DROP_DOWN / RADIO / CHECK_BOX / MULTI_SELECT → **`GAIA_IQ10`**「項目に『…』は存在しません」＝**フィールド選択肢**の照合。`optionOrder`（取得済）で静的検証可能。
      - USER_SELECT → **`GAIA_IL26`**／ORGANIZATION_SELECT → **`GAIA_IL28`**／GROUP_SELECT → **`GAIA_IL27`**「指定した〜（code：…）が見つかりません」＝**組織のディレクトリ**照合。フィールドに固定選択肢がなく `getFields` では検証不可。
    - **結論**: 押し下げ対象は **`optionOrder` を持つ 4 型（DROP_DOWN / RADIO_BUTTON / CHECK_BOX / MULTI_SELECT）に限定**（フェーズ2a）。**USER/組織/グループは押し下げ非対象**（ディレクトリ照合の静的検証が不可能・FULL_SCAN の JS が 0 件で正しく処理）。**STATUS は enabled＋状態一覧 API が要るためフェーズ2b に分離**。
    - **MULTI_SELECT の NOT IN 含め `SIMPLE==FULL_SCAN` を再確認**（`複数選択 IN ('M2')`＝5,6／`NOT IN ('M2')`＝1,2,3,4（空レコード包含）／`IN ('M1','M4')`＝5,6）。→ **kintone-IN == JS-IN（フェーズ1 で確立）ゆえ、押し下げプレフィルタ集合＝JS 一致集合で超集合性が自明に成立**。

- SemVer: 後方互換の最適化 → **minor（フェーズ2a＝v2.6.0 想定）**
- 位置づけ: 述語分割の続き。① 第0段（`$id`・`5c987e0`）／② 空セル −∞（`1c73828`）／③ 型メタ付き**数値**プレフィルタ（`30ff297`）／フェーズ1（型メタ付き IN 評価・`b9842bf`・**v2.5.0 リリース済**）に続く**選択系 `IN` 押し下げ**。
- 関連コード: `src/core/optimization/wherePredicatePushdown.ts`（`extractSafePushdownLeaves` / `extractNumericPushdownCandidates`）、`src/execute.ts`（`extractMainSafePushdown` / `loadNumericPushdownFieldTypes` / `getOptionOrderMapByApp`:2138 / EXPLAIN:3571）、`src/converter/whereToKintone.ts`（`convertInList`:212＝変更不要）

## 0. 目的

`LIKE` 等で FULL_SCAN になるクエリでも、**型メタで確定した選択系フィールドの `IN` / `NOT IN`（全値が実在選択肢）** を kintone へプレフィルタ押し下げして取得件数を削減する。

```sql
SELECT 件名, 担当 FROM APP100 WHERE 区分 IN ('対応中','保留') AND 件名 LIKE '%至急%'
-- 区分 IN ('対応中','保留') を kintone に押し下げ → 該当だけ取得 → LIKE は JS で再評価
```

## 1. 正しさの根拠（実機で確立）

押し下げの安全性は「**プレフィルタ集合 ⊇ JS 最終一致集合**（超集合性）」に依存する。選択系 `IN` ではこれが**自明に成立**する:

1. フェーズ1（v2.5.0）で **kintone の `in`/`not in` と JS 評価が一致**することを実機で確立した（`SIMPLE==FULL_SCAN`）。DROP_DOWN/RADIO＝スカラー一致、CHECK_BOX/MULTI_SELECT＝要素 contains-any、NOT IN の空レコード包含まで一致。
2. 押し下げはこの `in`/`not in` リーフをそのまま kintone に送る。プレフィルタ集合＝kintone-IN 集合＝JS-IN 集合。よってプレフィルタ集合は JS 最終一致集合（他述語で更に絞る前）の**超集合**（等しいか広い）。truncate なし。
3. 残る唯一のリスクは **非実在値による GAIA エラー**（§0/R5）。これを `optionOrder` の実在検証（§3）で塞ぐ。全 IN 値が実在するリーフだけを押し下げ、そうでなければ非押し下げ（FULL_SCAN の JS が正しく 0 件処理）。

> `=` の書式差（数値プレフィルタ③で問題化した `"100"` vs `"100.0"`）は選択系にはない。選択肢の照合は**選択肢コードの完全一致**で、kintone・JS とも同じコード集合を使うため書式ゆれが生じない。

## 2. フェーズ分割（R5 確定）

| フェーズ | 対象型 | 実在検証メタ | 追加 API | 版 |
|---|---|---|---|---|
| **2a** | DROP_DOWN / RADIO_BUTTON / CHECK_BOX / MULTI_SELECT | `optionOrder`（**取得済**・`getFields`） | **なし** | v2.6.0 |
| **2b** | STATUS（`enabled` 有効時のみ） | `enabled`（新規）＋状態一覧（プロセス管理設定 API） | あり（新クライアント境界） | 後続 |
| 非対象 | USER / 組織 / グループ選択 | ディレクトリ照合（静的検証不可） | — | 押し下げ対象外（FULL_SCAN JS が処理） |

**フェーズ2a を先行実装**（追加 API ゼロ・`optionOrder` は既に `KintoneFieldInfo` にあり ORDER BY 用に取得・キャッシュ済）。STATUS（2b）は enabled 検出＋プロセス管理設定 API＋APP/profile 別キャッシュ＋CLI/UI/plugin 配線が要り、かつ検証にプロセス管理有効アプリが必要なため分離する。

## 3. フェーズ2a 詳細（実装着手可能）

### 3.1 押し下げ可否（`isSelectionInComparison`）
`field IN (...)` は WhereExpr の `BINARY`（`op:"IN"` / `NOT_IN`・右 `IN_LIST`）。押し下げ可の条件（AND リーフ単位）:
- 左辺が**単純フィールド参照**（`type:"FIELD"`・非 `$id`・対象テーブル＝`isTargetField` 準拠）。
- 右辺 `IN_LIST` の**全要素が文字列リテラル**（`STRING`）。空リスト・変数未解決・数値リテラル混在は非押し下げ。
- 型メタで左辺型 ∈ **{DROP_DOWN, RADIO_BUTTON, CHECK_BOX, MULTI_SELECT}**。
- **実在検証**: そのフィールドの選択肢集合（`optionOrder` のキー集合）が存在し、**全 IN 値がその集合に含まれる**。1 つでも非実在・空文字なら**リーフごと非押し下げ**（他の安全リーフは押し下げ継続）。
- `op` は `IN` / `NOT_IN` の両方可（実在検証は否定でも同様に必要）。

### 3.2 抽出器（`wherePredicatePushdown.ts`）
- `SafePushdownOptions` に **`fieldOptions?: ReadonlyMap<string, ReadonlySet<string>>`**（フィールドコード→実在選択肢コード集合）を追加。
- `isSafeComparison` = `isSafeIdComparison` ∨ 数値（既存）∨ **`isSelectionInComparison`**（新）。`isSelectionInComparison` は `fieldTypes`（型）と `fieldOptions`（実在集合）の両方を参照。両方が渡されないと選択系は抽出しない（型メタ・選択肢メタ未取得なら非押し下げ）。
- 候補抽出（EXPLAIN・型メタ取得判定用）: 現 `extractNumericPushdownCandidates` を **数値 ∪ 選択系 IN/NOT IN の構文候補**に一般化（`extractTypedPushdownCandidates` へ改名 or 併設）。候補判定は**型メタ非依存の構文形**（数値＝`FIELD op NUMBER`、選択系＝`FIELD IN/NOT_IN IN_LIST(全 STRING)`）。`$id` は数値候補から除外（既存どおり・$id は確定押し下げ）。

### 3.3 実行側配線（`execute.ts`）
- `loadNumericPushdownFieldTypes` を一般化（`loadTypedPushdownMeta` 等）: 候補（数値∪選択系）のあるアプリについて、`getFieldTypeMap`（型）と **`getOptionOrderMapByApp`（選択肢・既存:2138）** を取得。両者は `getFieldsCached`（:2121）由来で **同一 getFields 結果を共有＝追加 API を出さない**。
- `getOptionOrderMapByApp` は `Map<fieldCode, Map<optionValue, order>>` を返す。**実在検証にはキー集合だけ必要**なので `Map<fieldCode, Set<optionValue>>` へ射影して `fieldOptions` として渡す（新規ヘルパー or 射影）。
- `extractMainSafePushdown` / 各 JOIN の `extractSafePushdownLeaves` 呼び出しに `fieldOptions`（該当アプリ分）を追加で渡す。JOIN の型解決規則（`tableAlias` / 非修飾は単一テーブルのみ）は数値と同一。
- kintone 変換は既存 `convertInList`（:212）が `IN`/`NOT IN` を `(v1,v2)` に変換済み＝**変換側の追加不要**。`whereToKintone` が `field in (...)` / `field not in (...)` を出力。

### 3.4 EXPLAIN
- 選択系 IN も **`pushdown candidate` 行**（`whereToKintone` 出力・「実行時の型/実在確認待ち」）。型・実在は実行時に確定するため確定行（kintone query）には出さない（`$id` は従来どおり確定表示）。既存の数値候補と同じ扱い。

### 3.5 受入（フェーズ2a）
1. **実在値で押し下げ後 == 全件 JS 評価**（DROP_DOWN/RADIO/CHECK_BOX/MULTI_SELECT・単一/複数値・`IN`/`NOT IN`）。
2. **非実在値を含む IN はリーフ非押し下げ**（GAIA_IQ10 を出さず、他の安全リーフは押し下げ・FULL_SCAN で JS 評価）。空文字を含む IN も非押し下げ。
3. **型メタ or 選択肢メタ未取得 → 非押し下げ**（メタ空とフィールド非存在を区別）。
4. **USER/組織/グループ IN は押し下げない**（型が対象外・FULL_SCAN JS が処理）。STATUS も 2a では押し下げない。
5. **CHECK_BOX/MULTI_SELECT の NOT IN**（空レコード包含）・**LIKE 併記**（`区分 IN (...) AND 件名 LIKE '%…%'`）で最終結果が全件 JS と一致。
6. **JOIN**（対象テーブルの選択系 IN・非修飾は単一テーブル時のみ）。
7. **EXPLAIN** に選択系 IN が `pushdown candidate` として現れる。
8. 回帰: 数値プレフィルタ③・$id 押し下げ・LIKE 述語分割・既存テストが不変。**追加 API を出していない**（getFields 回数が数値のみの場合と同じ・`getFieldsCount` 検証）。

## 4. フェーズ2b（STATUS・後続）
- `enabled` を `KintoneFieldInfo` に追加（form fields `properties.<code>.enabled`）。CLI/UI 両クライアント経路で取得（[nodeKintoneClient](../../src/cli/nodeKintoneClient.ts) / [kintoneClient](../../src/ui/kintoneClient.ts)）。
- 有効時のみ、状態一覧（プロセス管理設定 API）で状態値の実在検証。無効なら非押し下げ（FULL_SCAN が正しく処理・GAIA_ST02 回避）。
- **プロセス管理設定 API のクライアント境界**（`KintoneClient` に状態一覧取得を追加）・**APP/profile 別キャッシュ**・**MCP/CLI/plugin の API 配線**・**取得失敗時は非押し下げ**の方針を明記。
- 検証にはプロセス管理**有効**アプリが必要（現状のテスト用 APP4221 は無効＝`GAIA_ST02`）。

## 5. 非対象（明示）
- **USER / 組織 / グループ選択の押し下げ**（ディレクトリ照合・静的検証不可・R5 実機で `GAIA_IL26/27/28` 確認）。フェーズ1 で JS が正しく評価するため機能上の欠落はない。
- **テキスト型の IN 押し下げ**（選択系ではない・別途検討）。
- **一時テーブル / CTE 経由**（型来歴なし＝フェーズ1 で文字列比較・押し下げ対象外）。
- 数値の `<=` / `>=`・厳密 10 進（案B・別課題 [ksql_exact_decimal_compare_issue.md](ksql_exact_decimal_compare_issue.md)）。

## 6. 進め方
- **フェーズ2a を codex レビュー → 実装（独立コミット）→ 実装レビュー → 実機確認（EXPLAIN で選択系 IN が pushdown candidate・非実在値は非押し下げ・LIKE 併記で全件一致・追加 API なし）→ v2.6.0 リリース**。
- **フェーズ2b（STATUS）は 2a リリース後**に、プロセス管理有効アプリを用意して詳細化・実装。
