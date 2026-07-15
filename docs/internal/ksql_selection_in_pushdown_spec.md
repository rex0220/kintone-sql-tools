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

### フェーズ1（正しさ・押し下げと独立）
- **FULL_SCAN の `in`/`not in` を全対象型で正しく評価**する。特に**複数値/オブジェクト型（CHECK_BOX/MULTI_SELECT/USER/組織/グループ）**は、`flatten`（[process.ts:59](../../src/engine/process.ts#L59)）で JSON 文字列になっているため、**JSON を解して「要素のコード/値に含まれるか」判定**へ修正。→ 現状の「SIMPLE=一致 / FULL_SCAN=0 件」バグ（実機 `主担当 IN` の 20 vs 0）を解消し `SIMPLE==FULL_SCAN` を回復。

### フェーズ2（押し下げ・最適化）
- フェーズ1で JS と一致した型の `in`/`not in` を kintone にプレフィルタ押し下げ。**選択肢/状態の実在検証で GAIA エラーを回避**:
  - **DROP_DOWN / RADIO / CHECK_BOX / MULTI_SELECT**: `KintoneFieldInfo.optionOrder`（取得済み）で全 IN 値が実在選択肢か検証。非実在/空文字を含めば非押し下げ。
  - **STATUS**: `KintoneFieldInfo.enabled`（新規追加・form fields の `enabled`）が **有効なときのみ**対象。状態値の実在検証は状態一覧（プロセス管理設定 API＝**追加取得**）で行う。無効なら非押し下げ（FULL_SCAN が正しく処理）。
  - **USER/組織/グループ選択**: 固定選択肢がない（実在検証の対象外）。kintone が未知コードでエラーを返すか 0 件かを**実機確認**し、エラーなら非押し下げ、0 件なら押し下げ可。
- **`NOT IN`**: フェーズ2 で肯定 IN と同じ検証を通せば対象化（否定でも実在検証は同様に必要）。

### 段階導入の指針
- **まずフェーズ1（正しさ）** で `in`/`not in` を全型で正しくし、`SIMPLE==FULL_SCAN` を回復（それ自体で価値）。
- **次にフェーズ2** で、検証が確立した型から順に押し下げを解禁（optionOrder のある型が先・STATUS/USER 系は追加メタ/実機確認の後）。
- **入れない**:
  - **配列/オブジェクト型の選択系**（`CHECK_BOX` / `MULTI_SELECT` / USER・組織・グループ選択）。JS 側で **JSON 文字列**（例 `["A"]`。[execute.ts:2099](../../src/execute.ts#L2099) / [dmlToKintone.ts:58](../../src/converter/dmlToKintone.ts#L58) の `ARRAY_TYPES`）になり、kintone の `in`（選択肢要素判定）と**述語の対象単位が違う**ため。
  - **`NOT IN`**（将来拡張。今回は**肯定 IN だけに検証範囲を限定**し、存在しない値・空値のエラー意味論を確認してから解禁する。※「否定で超集合性が反転」ではない＝肯定 IN が kintone-P==JS-P なら補集合の NOT IN も同領域では一致するが、エラー意味論の検証を絞るため今回は対象外）。
  - テキスト `IN`（テキスト照合の全角半角・正規化で超集合性が不確実。③のテキスト等値と同じ理由で対象外）。
  - 右辺に非文字列リテラル・サブクエリ（`IN (SELECT ...)`）を含むもの。

## 2. 正しさ（超集合性）

押し下げる `P = field IN (v1, v2, ...)` について「kintone の P 集合 ⊇ JS の P 集合」（親仕様 §2）。

- **スカラー文字列型選択系**: JS 側の値は**選択肢コードのスカラー文字列**（例 `"対応中"`）。JS の `IN` は `row[field] ∈ {v...}` を判定。kintone の `in` も選択肢コードの一致判定。**通常値では両者が一致**（kintone-P == JS-P）→ 超集合性 OK。
- **配列型を除外する理由（[Low]・裏取りは flatten）**: `CHECK_BOX` / `MULTI_SELECT` / USER・組織・グループ選択は kintone の値が**配列/オブジェクト**で、SELECT/FULL_SCAN の `flatten`（[process.ts:59-64](../../src/engine/process.ts#L59)）が **`typeof val === "string" ? val : JSON.stringify(...)`** で JS 側を **JSON 文字列**（`["A"]`）にする。`row[field] === "A"` にならず `IN` の対象単位が違う → 超集合性を保証できない。**公式フィールド仕様でも DROP_DOWN/RADIO/STATUS は文字列、CHECK_BOX/MULTI_SELECT は配列**（[field-types](https://cybozu.dev/ja/kintone/docs/overview/field-types/)）。CATEGORY・ユーザー系も非文字列だが、**型ホワイトリスト方式のため誤押し下げは起きない**。

### 2.1 空文字・存在しない値の境界（[Medium]・今回唯一の実質的な正しさ境界）

型だけ確認して**任意の文字列**を押し下げると、次で FULL_SCAN と挙動が食い違い得る:

- **空文字 `IN ('')`**: 全要素 STRING を満たす。**DROP_DOWN の `IN ("")` は未選択レコードを抽出する正式構文**（[query 仕様](https://cybozu.dev/ja/kintone/docs/overview/query/)）だが、**RADIO_BUTTON / STATUS には通常「未選択」がない**。JS FULL_SCAN（空文字比較）と kintone の結果が型で食い違う可能性。
- **存在しない選択肢/ステータス `IN ('存在しない値')`**: 従来 FULL_SCAN は **JS 評価で 0 件**。押し下げ後は kintone 側で **0 件 or クエリエラー**になり得る（**「0 件」が「エラー」に化けると回帰**）。
- **STATUS の候補メタ**: DROP_DOWN/RADIO の選択肢は既存の `optionOrder`（フィールド定義）から確認できるが、**STATUS の候補値は別のプロセス管理メタ取得が要る可能性**。存在しない STATUS で kintone がエラーを返すなら、**STATUS を一旦除外**するか、候補メタまで検証する。

> **実機ゲート（実装前）**: DROP_DOWN / RADIO_BUTTON / STATUS それぞれで `IN ('')` と `IN ('存在しない値')` を **SIMPLE と FULL_SCAN で比較**し、**結果件数 or エラー分類が一致**することを確認する。食い違う型（特に STATUS）があれば、その型を対象から外すか、空文字/存在チェックを加えてから解禁する。

- **同値性は取得打ち切りなし前提**（親仕様 §2.1）。

## 3. 抽出器の拡張（③の基盤に載せる）

現行 `extractSafePushdownLeaves`（[wherePredicatePushdown.ts](../../src/core/optimization/wherePredicatePushdown.ts)）は `$id`（静的）と NUMBER（型メタ）を押し下げる。ここに**選択系 `IN`** を追加する。

### 3.1 リーフ判定
- `field IN (...)` は WhereExpr の **`BINARY`**（`op: "IN"`・右 `InList { type:"IN_LIST", values }`）。
- **選択系 `IN` 候補**（型メタなしで構文判定・`isSelectionInCandidate`）:
  - 左辺が単純フィールド参照（`$id` 以外・対象テーブル）。
  - `op === "IN"`（**`NOT IN` は不可**）。
  - 右辺が `IN_LIST` で、**全要素が文字列リテラル**（`STRING`。数値・サブクエリ・変数未解決は不可。変数は実行前に `resolveVariableRefs` で `STRING` へ解決済み）。
- **押し下げ可**（`isSafeComparison` 内・**型＋選択肢メタ確定**・R3）: 上記候補 かつ
  1. **`fieldType ∈ {"DROP_DOWN","RADIO_BUTTON"}`**（STATUS 除外）、かつ
  2. **`IN` の全リテラル値が、そのフィールドの選択肢集合に実在**する（空文字を含まない）。1 つでも非選択肢/空文字があれば**押し下げない**（FULL_SCAN で正しく 0 件）。
- このため抽出器には**フィールド型だけでなく選択肢集合が要る**。`FieldTypeMap`（型のみ）に加え、**選択肢メタ**（`DROP_DOWN`/`RADIO_BUTTON` の `options` キー集合）を渡す。両者とも同じ `getFields` のフィールド定義から得られる（**追加 API 不要**）。

### 3.2 候補抽出・型メタ取得の一般化
- 現行の `extractNumericPushdownCandidates`（型メタなし・EXPLAIN と型メタ取得判定に使用）を、**数値候補 ∪ 選択系 IN 候補**へ一般化する（例 `extractTypedPushdownCandidates` にリネーム、または選択系候補を OR 追加）。
- `loadNumericPushdownFieldTypes`（[execute.ts](../../src/execute.ts)）＝「候補のある物理アプリだけ `getFieldTypeMap` を取得」も、選択系候補を含めて判定するよう一般化（候補があるアプリだけ取得の方針は不変）。
- **メタ空/型不明 → 非押し下げ**、**`getFields` reject → 例外伝播**（③と同じ）。

## 4. kintone クエリ変換
- `field IN ('A','B')` の変換は既存の `convertInList`（[whereToKintone.ts:212](../../src/converter/whereToKintone.ts#L212)）で対応済み（`in ("A","B")`）。**変換側の追加実装は不要**。抽出器が選択系 IN を通すだけ。

## 5. EXPLAIN
- 型メタが async のため、EXPLAIN では NUMBER と同様に**選択系 IN も `pushdown candidate` 行**に表示（`$id` は `kintone query` に確定）。実行時に型確定して押し下げる。no-API 契約は維持。

## 6. 受入・実機テスト（打ち切りなし前提で 押し下げ後 == 全件 JS 評価）
- **単体（抽出器 × 型メタ）**: `fieldTypes` に `ステータス:STATUS` / `区分:DROP_DOWN` / `優先度:RADIO_BUTTON` を与えたとき `ステータス IN ('対応中')` を押し下げる。**`CHECK_BOX`/`MULTI_SELECT`/USER 型・テキスト型・型不明は押し下げない**。**`NOT IN`・非文字列 IN・`IN (SELECT ...)` は押し下げない**。`fieldTypes` 空・未指定は非押し下げ。
- **超集合性（結合・打ち切りなし）**: `ステータス IN ('対応中') AND … LIKE …`（無エイリアス/エイリアス/JOIN）で押し下げ結果 == 全件 JS 評価。**未選択（空）行・複数値 IN・該当 0 件**を含めて一致。
- **[Medium] 空文字・存在しない値（実機ゲート）**: 型別に
  - DROP_DOWN `IN ('')` / RADIO_BUTTON `IN ('')` / STATUS `IN ('')`
  - 各型の存在しない値 `IN ('存在しない値')`
  を **SIMPLE と FULL_SCAN で比較**し、**結果件数 or エラー分類が一致**すること。食い違う型は対象から外す判断材料にする。
- **実機（型別）**: DROP_DOWN / RADIO_BUTTON / STATUS で SIMPLE（`WHERE 選択 IN (...)`）と FULL_SCAN（`… AND $id LIKE '%'`）が一致。**CHECK_BOX で押し下げない**こと（誤って押すと配列不一致で欠落）。
- **[Low] 型メタ取得の観測**（訂正）: FULL_SCAN のユーザーフィールドは `validateSelectFieldCodes` が先に `getFieldsCached` を呼ぶため「候補なしで `getFields` 0 回」は一般に成立しない。要件は:
  - **候補のないアプリを typed pushdown の型メタ取得対象に足さない**。
  - フィールド検証で**既に取得した定義はキャッシュ再利用**し、**追加の API 呼び出しを発生させない**。
  - **`$id` だけのクエリ**では従来どおり `getFields` 不要（システムフィールドのみ）。
- **EXPLAIN**: 選択系 IN が `pushdown candidate` に出て `kintone query` には出ない。`$id` は確定。
- **回帰**: ①（$id）②（空セル）③（数値）と既存 SIMPLE/FULL_SCAN が不変。

## 7. 実装メモ（Codex 向け）
- `wherePredicatePushdown.ts`:
  - `isSelectionInCandidate(expr)`: 左辺フィールド（非 $id）・`op==="IN"`・右辺 `IN_LIST` かつ全要素 `STRING`。
  - `isSafeComparison` に「選択系候補 かつ `fieldTypes.get(field)` がスカラー文字列選択型（`DROP_DOWN`/`RADIO_BUTTON`/`STATUS`）」を追加。
  - 候補抽出（`extractNumericPushdownCandidates`）を数値 ∪ 選択系 IN に一般化（EXPLAIN・型メタ取得判定で使用）。名前は `extractTypedPushdownCandidates` 等へ。
- `execute.ts`: `loadNumericPushdownFieldTypes` の候補判定を一般化（選択系候補を含める）。`extractMainSafePushdown`/JOIN は fieldTypes を渡す既存経路のまま。EXPLAIN の候補行も一般化。
- スカラー文字列選択型の集合は定数化（`SCALAR_STRING_SELECTION_TYPES = new Set(["DROP_DOWN","RADIO_BUTTON","STATUS"])`）。配列型（`CHECK_BOX`/`MULTI_SELECT`）は既存の `ARRAY_TYPES` を参照/共有。
- プラグイン: FULL_SCAN/押し下げ/EXPLAIN エンジンをバンドルするため **`npm run build`（plugin 含む）** で `desktop.js` 再生成。
- ドキュメント: 言語リファレンスの押し下げ節・EXPLAIN 表記。

## 8. 効果・リスク（R3 で再評価）
- **効果（縮小）**: `LIKE 等 FULL_SCAN ＋ DROP_DOWN/RADIO の IN（実在選択肢）` で取得件数を削減。**STATUS（ワークフロー状態）は除外**されたため、当初想定した「ステータス絞り込み」は対象外＝実用価値は当初より縮小。カテゴリ・ランク等の DROP_DOWN/RADIO 絞り込みには効く。
- **リスク・コスト（増加）**: ③の型メタ基盤は流用できるが、**選択肢メタ（options）による全 IN 値の実在検証**が新規に必要（getFields から取得＝追加 API はないが、型だけでなく選択肢集合を抽出器へ渡す配線・検証ロジックが増える）。正しさは「実在選択肢のみ押し下げ・非実在/空は非押し下げ」で担保。
- **非対象**: `STATUS`・`CHECK_BOX`/`MULTI_SELECT`/USER 等の配列型・`NOT IN`・空文字/非実在値・テキスト IN・日時・`<=`/`>=`（案B）。

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
