# B76 実装計画 — JOIN の述語押し下げ拡張（Phase A）と相対日付の JOIN 対応（Phase B）

- 作成: 2026-07-26（Claude 起草・**Step 0 の調査と仕様起草は codex 担当**）
- ステータス: 📝 **計画（未着手）**。**2026-07-27 に方針を A-1 → A-2 → A-2' へ二段階で見直し**（§0.2・§0.3）。codex レビューで A-2 の前提の一部が否定され、ハイブリッド案 A-2' に確定。B75/B77/B78 の後に着手。
- 評価: [B76 eval](ksql_b76_join_predicate_pushdown_extension_evaluation.md)

## 0. 本計画の性格

B75 と違い、**着手前に未解決の調査項目がある**。押し下げの安全性は kSQL が過去に
事故を起こしている領域（v2.0.0 で全 `LIKE` の押し下げを撤回）であり、
**調査を済ませずに実装計画を確定してはならない。**

したがって本書は「Step 0（調査）＋その結果で決まる Phase A の骨格」を定める。
**Step 0 の成果として codex が Phase A の詳細仕様を起草し、Claude がレビューする**運用とする。

## 0.2 【2026-07-27 方針変更】A-1（リーフ拡張）→ A-2（別名スコープ分解）

実測により、**問題は「日付が押し下げられない」ではなく「JOIN の押し下げ機構が単一表と分断されている」**
ことが判明した（[eval §2.4](ksql_b76_join_predicate_pushdown_extension_evaluation.md)）。

| 述語 | 単一表 | JOIN |
|---|---|---|
| DATE `=` | 押し下げ | **全件取得** |
| TEXT `=` | 押し下げ | **全件取得** |
| DROP_DOWN `in` | 押し下げ | **全件取得** |
| NUMBER `>` | 押し下げ | 押し下げ |

単一表は WHERE 全体を `whereToKintone()` で丸ごと文字列化するのに対し、
JOIN は AND スパインから安全なリーフだけを抽出する**別機構**である。

### 新方針 A-2

**WHERE を別名スコープごとに分解し、各部分を単一表と同じ
`whereToKintone()` ＋ `whereCapability` で処理する。**

作るべき不変条件:

> **単一表で押し下げられる述語は、JOIN でも押し下げられる。**

述語の種類ごとに能力表が2つある現状は、今後も食い違いを生み続ける。
A-1（リーフ抽出器に DATE / TEXT を足す）は、述語ごとに安全性を再検証する必要があり、
**v2.0.0 の `LIKE` 全廃のような事故を繰り返しやすい**ため採らない。

### Step 0 の論点も差し替え

**日付比較セマンティクスの調査（旧 調査 A / B / C）は不要**になる。
単一表で既に押し下げており、kintone 側の挙動は実績で確認済みだからである。

新しい中心論点は「**WHERE を別名スコープで安全に分解できるか**」:

1. **`OR` を跨ぐ述語**の扱い（分解すると結果が変わる。旧ドラフト `perf-where-pushdown-join.md` は
   「`OR` の両辺が異なるテーブル → 不可」としており、この判断は流用できる）
2. **クロステーブル述語**（`a.x = b.y`）は JOIN 後でないと評価できない
3. **`NOT` / `GROUP`** の扱い
4. 分解後の各部分に対する `whereCapability` の適用方法（exact / superset / unsupported の合成規則）
5. **残余の client 評価をどう残すか**。exact と確定した部分だけ residual から除去し、
   少しでも疑いがあれば superset として押し下げ**残余評価を必ず残す**（B67 Phase2 A と同型）
6. 外部結合（LEFT / RIGHT）で non-nullable 側にしか押し下げてはいけない制約
   （B6「KLIKE 外部結合 非 nullable 側の押し下げ解禁」が却下された経緯を確認すること）

### 旧 Step 0（調査 A〜D）の扱い

**調査 D（JOIN 側の型メタ解決）だけは A-2 でも必要**。分解した各部分に `whereCapability` を
適用するには型メタが要る。調査 A / B / C は不要。

## 0.3 【2026-07-27 codex レビュー】A-2 → A-2'（ハイブリッド）へ確定

§0.2 の A-2 を codex がレビューし、**前提の一部が否定された**。指摘は妥当なので受け入れる。

### 0.3.1 却下された Claude の主張

| 主張 | 判定 | 理由 |
|---|---|---|
| 「旧 調査 A / B / C（日付・TEXT のセマンティクス）は不要」 | **誤り** | 単一表で押し下がる事実が示すのは「**kintone がその述語を受理する**」ことだけで、「**サーバー評価 ≡ JS 評価**」ではない。同値性が要るのは**押し下げた述語を client 残余から除去するとき**。単一表の EXACT_PUSHDOWN は残余が存在しないため同値性が問題にならず、そこを混同していた |
| 「能力表が2つあるのが問題」 | **誤った整理** | `whereCapability` は **REST 受理性・型妥当性**、`wherePredicatePushdown` は **JOIN プレフィルタの安全性**（超集合性・実在選択肢検証・KLIKE 規則）で、**異なる契約**である。無理に一つへ統合するほうが危険 |
| 「A-1 は切り捨てる」 | **不適切** | 段階実装として価値がある。DATE リテラル比較を既存の安全抽出器へ限定追加し**元 WHERE の residual を残す**案は、A-2 全面刷新より小さく監査できる |
| Phase A 2〜3 人日 | **過小** | 旧 A-1 相当の見積もり。A-2 系では大幅に増える（§0.3.4） |

### 0.3.2 実コードで確認した A-2 の制約

`whereToKintone` の `convertField()` は `quoteIdentifier(field.field)` を使い、**別名を黙って捨てる**。
別名除去して直列化すること自体は機械的に可能だが、**両アプリに同名フィールドがある場合に
誤ったアプリへ送られる**危険がある。分解時の別名スコープ強制が前提条件になる。

JOIN 側の押し下げ呼び出しに `fieldTypes` が渡されていないことも確認済み
（`extractTypedPushdownCandidates(stmt.where, { tableAlias: join.table.alias })`）。

### 0.3.3 確定方針＝A-2'（ハイブリッド）

**A-2 の「別名スコープ分解」は採用するが、`whereCapability` を唯一の安全判定にはしない。**

- AND から各物理 APP に属する因子を分解する
- 同一別名内で完結する `OR` / `GROUP` は、**サブツリー全体が安全と証明できる場合だけ**採用
- `whereCapability` は **REST 受理性・型妥当性**の判定に使う
- `wherePredicatePushdown` の**超集合性・実在選択肢検証・KLIKE 規則は維持**する
- **通常のリテラル述語は元 WHERE の residual を残す**（既定）
- **residual 除去は、INNER JOIN か保存側で、完全同値性を別途証明したノードだけ**
- 相対日付・`LOGINUSER` 等は適用済みノード集合を共有し、client 評価到達を fail-closed
- **外部結合の KLIKE は現状どおり除外**

**不変条件は下方修正する。** 「単一表で押し下げられる述語は JOIN でも押し下げられる」は
**residual を残す前提でのみ**目標とし、residual 除去まで含めた同値性は個別証明とする。

### 0.3.4 見積もり（codex 提示・採用）

| 作業 | 見積もり |
|---|---:|
| Step 0・Phase A 詳細仕様 | 3〜5 人日 |
| A-2' Phase A（INNER JOIN 中心・residual 維持） | 5〜8 人日 |
| **Phase A 合計** | **8〜13 人日** |
| 外部結合の nullability 来歴解析まで含む場合 | 10〜16 人日 |
| **Phase B**（相対日付・INNER JOIN 限定） | **5〜8 人日** |
| Phase B で外部結合も扱う場合 | 8〜12 人日 |

### 0.3.5 B6 との関係

外部結合の押し下げは **B6（KLIKE 外部結合 非 nullable 側の押し下げ解禁）が却下**された領域である。
A-2' では**外部結合を Phase A のスコープから外す**（INNER JOIN 中心）。
外部結合まで扱うなら **B6 を正式に再オープンし、複数 JOIN を含む nullability provenance を
スコープと見積もりへ加える**必要がある。**前者（スコープから外す）を推奨**。

### 0.3.6 Step 0 の追加論点（codex 提示）

§0.2 で挙げた6点は必要だが不足している。次を追加する。

1. `whereCapability.EXACT_PUSHDOWN` と JOIN residual 除去可能性は同じ契約か
2. サーバー集合と JS 集合の exact / superset / unsafe 対応表
3. NUMBER の表記差・IEEE-754・`>=` / `<=` の扱い
4. 選択系の実在値検証と GAIA 回避を維持する方法
5. KLIKE の AST identity 集合と fail-closed gate
6. JOIN の非修飾フィールドの一意性
7. CTE・一時表・サブテーブル・インライン化後 AST
8. INNER / LEFT / RIGHT の各段階での nullability provenance
9. EXPLAIN と runtime が同じ生成済み計画を参照する契約
10. `maxRecords` / truncate / SearchAborted 時の母集合完全性
11. バッチ変数・サブクエリ解決後に計画を再生成するタイミング
12. 非実在選択肢・同名フィールド・複数 JOIN・外部結合を含む負の回帰ケース

### 0.3.7 A-1 の位置づけ（段階案として保持）

A-1 を切り捨てず、**A-2' に至る段階**として次の順で扱う。

1. DATE / DATETIME の超集合性を確認する
2. **INNER JOIN の単一別名 AND リーフに限定**する
3. **元 WHERE の residual を維持**する
4. TEXT `=` は正規化・空白・文字比較の実測後に別段とする
5. **server-only の相対日付は Phase B まで解禁しない**

### 0.3.8 旧ドラフトの扱い

`perf-where-pushdown-join.md` は「`LIKE` は押し下げ可」など**現在の契約と矛盾**する。
**設計根拠として再利用せず、履歴扱い**とする。

## Step 0 — 調査（codex 担当・成果物＝Phase A 仕様 R1）

### 調査 A: kintone の日付比較セマンティクス

`whereToKintone` が生成するクエリを kintone が評価する規則と、
kSQL のクライアント側評価（`evalWhere`）の規則が**一致するか**を確定する。

| 論点 | 確認すること |
|---|---|
| DATE 型の `=` `>` `>=` `<` `<=` | 日単位比較か。境界（当日）の扱い |
| DATETIME / CREATED_TIME / UPDATED_TIME | 時刻を含む比較か。**タイムゾーン**（アプリ設定 / ユーザー設定 / UTC のどれ基準か） |
| 空セル（未入力） | kintone 側と JS 側で真偽が一致するか。数値では `IN ('')` 空セル評価・−∞ 準拠の前例あり（v2.2.0 / v2.6.0） |
| 文字列リテラルの引用・エスケープ | `whereToKintone` の既存実装で日付リテラルが正しく引用されるか |

**結論の型**: 各型・各演算子について「exact に一致する / superset として安全 / 押し下げ不可」の3値で表を作ること。

> 参考: 既存の押し下げ判断は `src/core/optimization/wherePredicatePushdown.ts` の
> `isSafeComparison` / `isNumericCandidate` / `isSelectionInComparison`。
> 型メタ確定を要求する設計（`options.fieldTypes?.get(...) === "NUMBER"`）が前例。

### 調査 B: なぜ日付が現在除外されているのか

v2.0.0〜v2.2.0 の押し下げ絞り込みの経緯を確認し、**日付が意図的に外されたのか、
単に未対応なのか**を確定する。意図的なら理由（当時の不一致事例）を掘り起こすこと。
関連文書: `docs/internal/ksql_numeric_*`・`ksql_like_js_*`・`ksql_selection_*`（台帳 §2 の v2.x 行からリンク）。

### 調査 C: TEXT `=` の押し下げ可否

Pro のレシピは `t.年月 = '2026-07'`（SINGLE_LINE_TEXT）を使う。
文字列完全一致が押し下げ可能かは日付と独立の論点。**全角/半角・大文字小文字・
前後空白の正規化**が kintone 側と JS 側で一致するかを確認する。
一致しないなら Phase A のスコープから外す。

### 調査 D: JOIN 側の型メタ解決

現在 JOIN テーブルへの押し下げ呼び出しは `extractTypedPushdownCandidates(stmt.where, { tableAlias: join.table.alias })`
で **`fieldTypes` を渡していない**（`src/execute.ts` 付近）。
このため選択系 `IN` は型メタ確定が必要な条件を満たせず押し下げられない（実測で確認済み）。
日付押し下げも型メタを要するため、**JOIN 側で型メタを解決して渡す配線が必要かどうか**を確定する。

## Phase A — 日付述語の押し下げ拡張（相対日付とは独立）

> **Step 0 の結論次第でスコープが変わる。** 以下は「DATE の比較が exact に一致した場合」の骨格。

### A-1 リーフ判定の拡張

`wherePredicatePushdown.ts` に日付比較の判定を追加。型メタで DATE 系と確定した場合のみ許可。

### A-2 JOIN 側への型メタ配線

調査 D の結論により、JOIN テーブルの `fieldTypes` を解決して
`extractTypedPushdownCandidates` に渡す（選択系 `IN` の押し下げも同時に有効化される副産物あり）。

### A-3 EXPLAIN 表示

各テーブルの `kintone query:` に押し下げられた日付述語が現れること。

### A-4 4面 parity・docs

**受入条件**:

1. **exact と確定した形のみ residual から除去する。** 少しでも不一致の疑いがあれば
   **superset として押し下げ、client 残余評価を必ず残す**（B67 Phase2 A と同型）。
   これが本 Phase の最重要方針。
2. JOIN の各テーブルに対し個別に押し下がること（既に NUMBER で実現している形）。
3. 既存の押し下げ挙動（NUMBER・`$id`・KLIKE・選択系 IN）に回帰がないこと。
4. `npm test` 全件 green・snapshot 差分は意図したものだけ。
5. fields を尊重するモックで検証すること。

**見積もり**: 2〜3 人日（調査 Step 0 を除く）。**単独でリリース可能**（相対日付を待たない）。
SemVer=**minor**（性能改善・結果は不変）。ただし押し下げにより
**取得件数が変わるため上限（`maxRecords`）到達の有無が変わりうる**点は CHANGELOG に明記すること。

## Phase B — JOIN での相対日付許可（第5許可形）

Phase A で日付が exact に押し下げられるようになって初めて成立する。

- B67 Phase2 A の**リーフ採用＋残余からの除去**を JOIN の駆動表へ適用する
- 相対日付リーフが**単一の別名だけを参照**すること（複数テーブルにまたがる相対日付は拒否）
- 採用したリーフを client 残余から確実に除去し、**相対日付の client 評価を 0** にする
- `OR` / `NOT` にまたがる相対日付は従来どおり拒否
- guard の3許可形すべてが持つ `joins.length === 0` 前提を、第5許可形でのみ解除する

**見積もり**: 3〜5 人日。**Phase A なしでは着手不可。**

## 優先順位

**B75 → B76 Phase A → B76 Phase B** を推奨。

- B75 は guard のみで完了し、Pro の CTE 用途を直接解消する（費用対効果が最大）
- B76 Phase A は相対日付と無関係に JOIN の取得件数を減らす純粋な性能改善
- B76 Phase B は Pro の本命だが最も重い

## 実装時の注意

- **押し下げは事故歴のある領域。** exact を主張するのは Step 0 の検証を経てからに限る。
  迷ったら superset＋残余評価に倒す。
- B72 の教訓どおり、**リテラル日付と相対日付で挙動が非対称にならないこと**を
  Phase B の受入条件に含める。
