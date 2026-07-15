# 仕様案: 選択系 `IN` の型メタ付きプレフィルタ（述語分割 第2段）

- 作成日: 2026-07-15
- ステータス: **仕様案 R4（STATUS は `enabled` 検出で対応可・全 in 可能型を 2 フェーズで。実装可否は要判断）**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- 更新履歴:
  - 2026-07-15 R1: 初版
  - 2026-07-15 R2: codex レビュー反映（空文字・存在しない値のゲート追加、NOT IN 根拠訂正、flatten 根拠、型メタ取得観測の訂正）。
  - 2026-07-15 R3: **実機ゲート実施（MCP・APP4148/4221）＝重要**。**全選択系で kintone は IN の値が実在選択肢かを検証しエラー**（DROP_DOWN/RADIO=`GAIA_IQ10`「項目に『…』は存在しません」・STATUS=`GAIA_ST02`「プロセス管理が無効」）。FULL_SCAN の JS は検証せず 0 件 → **存在しない値/無効状態の `IN` 押し下げは「0 件」を「エラー」に化けさせる**。設計を「**型だけでなく選択肢メタで全 IN 値の実在を検証**」へ変更。
  - 2026-07-15 R4: **範囲を「in / not in 可能な全項目タイプ」へ拡張（ユーザー方針）**。2 つの追加事実を反映:
    - **複数値/オブジェクト型（`CHECK_BOX`/`MULTI_SELECT`/USER/組織/グループ選択）は FULL_SCAN の `in` が現状壊れている**（実機: `主担当 IN ('rex0220')` が SIMPLE=20 件 / FULL_SCAN=0 件）。JS 値が JSON 文字列（`[{"code":"rex0220",...}]`）で要素一致しないため。→ **フェーズ1で JS `in`/`not in` を「要素/コードに含まれる」意味論へ修正**（押し下げと独立の正しさ修正・`SIMPLE==FULL_SCAN` 回復）。
    - **STATUS は `enabled` で対応可**。プロセス管理の有効/無効は form fields の `properties.<code>.enabled`（[get-form-fields](https://cybozu.dev/ja/kintone/docs/rest-api/apps/form/get-form-fields/)）で取得できる。→ `KintoneFieldInfo` に `enabled` を追加し、**無効時は非押し下げ**。有効時は状態値の検証が要る（下記）。
    - **選択肢メタは既に取得済み**: `KintoneFieldInfo.optionOrder`（[execute.ts:96](../../src/execute.ts#L96)）が DROP_DOWN/RADIO/CHECK_BOX/MULTI_SELECT の選択肢集合を保持（**値の実在検証に追加 API 不要**）。

## ⚠ R3 の要点（実機ゲートで判明した設計変更）

当初の「型が選択系なら任意文字列を押し下げ」は**不可**。kintone は `フィールド in ("値")` の**値がフィールド定義の選択肢に存在するかを検証**し、存在しなければクエリエラーを返す:

| 実機（MCP） | SIMPLE（押し下げ相当） | FULL_SCAN（JS） |
|---|---|---|
| `業種 IN ('存在しない')`（DROP_DOWN・APP4148） | **エラー GAIA_IQ10** | 0 件 |
| `顧客ランク IN ('存在しない')`（RADIO・APP4148） | **エラー GAIA_IQ10** | 0 件 |
| `ステータス IN ('')` / `IN ('存在しない')`（STATUS・APP4221） | **エラー GAIA_ST02**（プロセス管理無効） | 4 件 / 0 件 |

→ **押し下げの条件に「全 IN 値がフィールドの選択肢に実在する」検証を追加**しないと、FULL_SCAN で 0 件になるクエリがエラーに化ける。**STATUS はプロセス管理状態依存で危険なため除外**。
- SemVer: **後方互換の最適化 → minor（v2.5.0 想定）**
- 位置づけ: 述語分割の続き。① 第0段（`$id`・`5c987e0`）／② 空セル −∞（`1c73828`）／③ 型メタ付き**数値**プレフィルタ（`30ff297`）に続く**選択系 `IN`**。親仕様 [ksql_like_predicate_pushdown_spec.md](ksql_like_predicate_pushdown_spec.md) R3 の「第1段（選択系 in）」の詳細。
- 関連コード: `src/core/optimization/wherePredicatePushdown.ts`（`extractSafePushdownLeaves` / `extractNumericPushdownCandidates`）、`src/execute.ts`（`extractMainSafePushdown` / `loadNumericPushdownFieldTypes` / EXPLAIN）、`src/converter/whereToKintone.ts`（`convertInList`）

## 0. 目的

`LIKE` 等で FULL_SCAN になるクエリでも、**型メタで確定したスカラー文字列型の選択系フィールドの `IN`** を kintone へプレフィルタ押し下げして取得件数を削減する。

```sql
SELECT 件名, 担当 FROM APP100 WHERE ステータス IN ('対応中') AND 件名 LIKE '%至急%'
-- ステータス IN ('対応中') を kintone に押し下げ →「対応中」だけ取得 → LIKE は JS 評価
```

`ステータス`（ワークフロー状態）・カテゴリ等の絞り込みは多用されるため、`LIKE 検索 ＋ 選択系絞り込み`で実用的な削減効果がある。

## 1. スコープ（R4・in/not in 可能な全型を 2 フェーズで）

対象: kintone の `in` / `not in` が使える項目タイプ（[query 仕様](https://cybozu.dev/ja/kintone/docs/overview/query/)）＝スカラー選択（DROP_DOWN/RADIO/STATUS）・複数値選択（CHECK_BOX/MULTI_SELECT）・USER/組織/グループ選択・レコード番号/作成者/更新者 等。

### フェーズ1（正しさ・押し下げと独立）＝**独立仕様に分離**
- **FULL_SCAN の `IN`/`NOT IN` を型メタ付きで正しく評価**する（複数値/オブジェクト型は要素/`code` 比較。**ナイーブ JSON parse は不可**＝テキストの `["A"]` 誤配列化を防ぐため型メタを JS 評価まで渡す）。→ 実機 `主担当 IN` の 20 vs 0 バグを解消し `SIMPLE==FULL_SCAN` 回復。
- **詳細は独立仕様 [ksql_fullscan_in_typed_eval_spec.md](ksql_fullscan_in_typed_eval_spec.md)**（フェーズ1＝押し下げの前提）。**先にこれを完成・実機確認**してからフェーズ2へ。

### フェーズ2（押し下げ・最適化）
- フェーズ1で JS と一致した型の `in`/`not in` を kintone にプレフィルタ押し下げ。**選択肢/状態の実在検証で GAIA エラーを回避**:
  - **DROP_DOWN / RADIO / CHECK_BOX / MULTI_SELECT**: `KintoneFieldInfo.optionOrder`（取得済み）で全 IN 値が実在選択肢か検証。非実在/空文字を含めば非押し下げ。
  - **STATUS**: `KintoneFieldInfo.enabled`（新規追加・form fields の `enabled`）が **有効なときのみ**対象。状態値の実在検証は状態一覧（プロセス管理設定 API＝**追加取得**）で行う。無効なら非押し下げ（FULL_SCAN が正しく処理）。
  - **USER/組織/グループ選択**: 固定選択肢がない（実在検証の対象外）。kintone が未知コードでエラーを返すか 0 件かを**実機確認**し、エラーなら非押し下げ、0 件なら押し下げ可。
- **`NOT IN`**: フェーズ2 で肯定 IN と同じ検証を通せば対象化（否定でも実在検証は同様に必要）。

### 段階導入の指針
- **まずフェーズ1（正しさ）** で `in`/`not in` を全型で正しくし、`SIMPLE==FULL_SCAN` を回復（それ自体で価値）。
- **次にフェーズ2** で、検証が確立した型から順に押し下げを解禁（optionOrder のある型が先・STATUS/USER 系は追加メタ/実機確認の後）。
> **本文書はフェーズ2（押し下げ）の親仕様**。フェーズ1（正しさ）の詳細は独立仕様 [ksql_fullscan_in_typed_eval_spec.md](ksql_fullscan_in_typed_eval_spec.md) に分離した。以下はフェーズ2 の概要で、**フェーズ1 完成後に詳細化**する（旧 R2/R3 の「配列型・STATUS・NOT IN を一律除外」記述は R4 で撤回済み）。

## 2. フェーズ2 概要（フェーズ1 完成後に詳細化）

前提: フェーズ1 で `IN`/`NOT IN` が型メタ付きに正しく評価され、`SIMPLE==FULL_SCAN` が回復していること。その上で、③（数値プレフィルタ）の基盤（`extractSafePushdownLeaves` / 候補抽出 / `loadNumericPushdownFieldTypes` / EXPLAIN 候補行）に選択系 `IN`/`NOT IN` を載せる。

### 2.1 押し下げ可否（型 × 実在検証）
`field IN (...)` は WhereExpr の `BINARY`（`op:"IN"`・右 `IN_LIST`。`NOT IN` は否定 op）。押し下げ可の条件:
- 左辺が単純フィールド参照（非 `$id`・対象テーブル）、右辺 `IN_LIST` の全要素が文字列リテラル。
- 型 × 実在検証（[query 仕様](https://cybozu.dev/ja/kintone/docs/overview/query/) の in/not in 可能型）:
  - **DROP_DOWN / RADIO / CHECK_BOX / MULTI_SELECT**: `optionOrder`（取得済み・§9）で**全 IN 値が実在選択肢**か検証。非実在/空文字を含めば非押し下げ（FULL_SCAN が正しく処理）。
  - **STATUS**: `enabled`（新規・§9）が有効時のみ、状態一覧（プロセス管理設定 API・§9）で実在検証。無効・非実在は非押し下げ。
  - **USER / 組織 / グループ選択**: 固定選択肢なし。**実機で未知コードの挙動（エラー or 0 件）を確認**し、エラーなら非押し下げ。
- kintone 変換は既存 `convertInList`（[whereToKintone.ts:212](../../src/converter/whereToKintone.ts#L212)）で対応済み（`NOT IN` 含む）＝**変換側の追加不要**。

### 2.2 抽出器・EXPLAIN
- 候補抽出（現 `extractNumericPushdownCandidates`）を **数値 ∪ 選択系 IN/NOT IN** に一般化（`extractTypedPushdownCandidates` 等）。`loadNumericPushdownFieldTypes` の候補判定も一般化（候補のあるアプリだけ型/選択肢/enabled/状態メタを取得・キャッシュ再利用・追加 API を出さない）。
- EXPLAIN は選択系 IN も **`pushdown candidate` 行**（型/実在は実行時確定・`$id` は確定表示）。

### 2.3 規模・注意（当初「小」ではなく中規模）
STATUS 対応は横断的:
- `enabled` を `KintoneFieldInfo` に追加し、**CLI/UI 両クライアント経路**で取得（form fields）。
- **プロセス管理設定 API のクライアント境界**（`KintoneClient` に状態一覧取得を追加）・**APP/profile 別キャッシュ**・**MCP/CLI/plugin の API 配線**。
- **状態一覧取得失敗時は非押し下げ or 例外**の方針を明記。

### 2.4 受入（フェーズ2）
- 型 × 実在値で押し下げ後 == 全件 JS 評価（フェーズ1 で JS が正しい前提）。実在選択肢・空/非実在（非押し下げ）・複数値・0 件・`NOT IN`・JOIN・型メタ/enabled/状態取得の限定・EXPLAIN 候補・回帰。

## 9. メタデータの入手先（R4 まとめ）

| 型 | JS `in` 修正（P1） | 実在検証メタ（P2） | 入手先 |
|---|---|---|---|
| DROP_DOWN / RADIO | 不要（スカラー文字列） | 選択肢集合 | `optionOrder`（取得済み） |
| CHECK_BOX / MULTI_SELECT | **要**（JSON→要素） | 選択肢集合 | `optionOrder`（取得済み） |
| STATUS | 不要（スカラー） | `enabled` ＋ 状態一覧 | `enabled`（form fields・**要追加**）＋ 状態一覧（プロセス管理設定 API・**追加取得**） |
| USER / 組織 / グループ | **要**（JSON→code） | 固定選択肢なし | 実機で未知コード挙動を確認（エラーなら非押下） |

## 10. 実装可否・進め方（R4・要ユーザー確認）
- ユーザー方針（in/not in 可能な全型サポート・選択肢定義型は値チェック）は妥当。**STATUS も `enabled` 検出で対応可**（R3 の「除外」は撤回）。
- ただし実体は**「フェーズ1＝FULL_SCAN の `in`/`not in` 正しさ修正（複数値/オブジェクト型の JSON 要素判定）」という独立した正しさ改善**が土台で、その上に**フェーズ2＝実在検証付き押し下げ**が載る構成。
- **推奨の進め方**: まず**フェーズ1を課題化・実装**（現状の `主担当 IN` 20 vs 0 等の実バグを解消・`SIMPLE==FULL_SCAN` 回復＝押し下げなしでも価値）。次にフェーズ2を optionOrder のある型（DROP_DOWN/RADIO/CHECK_BOX/MULTI_SELECT）から解禁し、STATUS（enabled＋状態一覧）・USER 系（実機確認）を順次。
- この段階構成でよいか、フェーズ1から着手してよいかを確認して進める。
