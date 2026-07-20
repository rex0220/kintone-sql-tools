# B44 C1/C3 比較検討 — テーブル内外項目の同時変更（行追加・削除・INSERT・UPSERT を含む）

- ステータス: 検討ドラフト R1 ＋ **codex レビュー済（2026-07-20・条件付き支持・§7 参照。§3〜§5 の初稿は §7 の修正で読み替える）**・[アイデア集](ksql_b44_syntax_ideas.md) の絞り込みフェーズ・仕様前
- 経緯: ユーザー判断で **C1（セルパス SET）と C3（子操作ブロック）に絞って比較**。X3（子主語 `_p.`）は**複数テーブルの更新に対応できない**ため除外。X1 の破壊性分類（PATCH/APPEND/REPLACE）と X2/C2 の `ROWS(...)` リテラルは部品として取り込む。
- 課題: [台帳 B44](../ksql_issue_tracker.md)

## 1. スコープと共通部品

比較対象の要件（ユーザー指定）:

1. レコード更新（UPDATE）時のテーブル行の**セル更新・行追加・行削除**
2. **INSERT** 時の SQL 記述案（親項目＋テーブル初期行）
3. **UPSERT** 時の SQL 記述案（insert 分岐 / update 分岐）
4. **複数サブテーブル**を同一文（同一 PUT）で扱えること（X3 除外の理由）

両案共通の部品（[アイデア集 §7](ksql_b44_syntax_ideas.md) で確定した方向）:

- **行セレクタ4種**: `_rid = '…'`（行 ID・機械生成向け）／ `_idx = n`（1-based 行位置・手書き向け）／子フィールド述語（`LENGTH(文字列T2) < 3` 等・一括修復向け）／全行。
- **revision ガード**: 1文の中で GET（行順・revision）→解決→同 revision 付き PUT。位置ズレ・競合更新を kintone 側の拒否で排除。
- **破壊性の静的分類**: 行削除を含む文だけを破壊的クラス（MCP fail-closed 維持）、セル更新・行追加のみの文は緩和候補。

## 2. C1 拡張案 — セルパス SET を追加・削除へ広げる

### 2.1 UPDATE（セル更新・行追加・行削除）

セル更新は C1 の中核のまま:

```sql
UPDATE APP4221
SET 文字列MIN = 'ddd',
    テーブル[LENGTH(文字列T2) < 3].文字列T2 = 'NNN',
    テーブル[_idx = 2].数値T1 = 10,
    テーブル2[*].フラグ = '済'          -- 複数テーブルは SET 項目を並べるだけ
WHERE $id = 7
```

**行追加**は代入形に馴染まず、2通りの拡張が要る:

```sql
-- 案 C1-a: 追加擬似セレクタ [+] への行値代入（ROW/ROWS リテラル併用）
UPDATE APP4221
SET テーブル[+](文字列T1, 数値T1) = ROWS(('c', 3), ('d', 4))
WHERE $id = 7

-- 案 C1-b: 追加・削除は SET の外に専用句を置く
UPDATE APP4221
SET 文字列MIN = 'ddd', テーブル[_idx = 1].文字列T2 = 'NNN'
APPEND テーブル (文字列T1, 数値T1) VALUES ('c', 3)
REMOVE テーブル[数値T1 = 0]
WHERE $id = 7
```

- C1-a は「代入」の見た目で行集合を増やす無理があり（`[+]` は参照でなく操作）、複数行・複数テーブルで読みにくい。
- C1-b は実質 **C3 の句を SET と並べたハイブリッド**＝C1 の一貫性（SET だけで完結）が崩れ、文法規模は C3 と同等以上になる。

**行削除**も同様: 代入で表現できず（`テーブル[sel] = DELETE` は不自然）、C1-b の `REMOVE` 句が必要。

### 2.2 INSERT

セルパスは「既存行」前提のため使えない。**`ROWS(...)` リテラル（C2/X2）を借用**する:

```sql
INSERT INTO APP4221 (タイトル, テーブル(文字列T1, 数値T1), テーブル2(項目A))
VALUES ('新規', ROWS(('a', 1), ('b', 2)), ROWS(('x')))
```

- 書けるが、**UPDATE（セルパス）と INSERT（ROWS リテラル）で文法の系統が変わる**。

### 2.3 UPSERT

```sql
UPSERT INTO APP4221 (顧客コード, タイトル, テーブル(文字列T1, 数値T1))
VALUES ('C001', '更新', ROWS(('a', 1)))
ON DUPLICATE (顧客コード)
```

- insert 分岐は INSERT と同じ（初期行）で自然。
- **update 分岐が決められない**: 既存レコードに当たったとき `ROWS(...)` を（i）置換適用＝行削除を伴い危険（ii）無視＝書いた値が沈黙で捨てられる（iii）分岐句で別指定＝結局 `ON UPDATE` 句（＝C3/X1 系の部品）が要る。**C1 単独では update 分岐に解がない**。

## 3. C3 案 — 子操作ブロック（親構文は現行のまま・後置ブロックを追加）

### 3.1 UPDATE（セル更新・行追加・行削除・複数テーブル）

```sql
UPDATE APP4221
SET 文字列MIN = 'ddd'
TABLE テーブル DO (
  UPDATE SET 文字列T2 = 'NNN' WHERE LENGTH(文字列T2) < 3;
  UPDATE SET 数値T1 = 10 WHERE _idx = 2;
  INSERT (文字列T1, 数値T1) VALUES ('c', 3), ('d', 4);
  DELETE WHERE 数値T1 = 0
)
TABLE テーブル2 DO (
  UPDATE SET フラグ = '済'          -- WHERE 省略 = 全行
)
WHERE $id = 7
```

- ブロック内の動詞は**既存のサブテーブル仮想テーブル DML（`UPDATE/INSERT/DELETE APPxxx$テーブル`）の文法をそのまま流用**。`_pid` はブロックでは書かない（外側 WHERE の親に暗黙束縛）。
- 複数テーブル＝`TABLE … DO (…)` の繰り返し。1 レコード 1 PUT に合成。
- 親項目のみ・子のみ・両方、のどの組み合わせも同じ形（`SET` 省略可 / ブロック省略可）。

### 3.2 INSERT

```sql
INSERT INTO APP4221 (タイトル)
VALUES ('新規')
TABLE テーブル DO (
  INSERT (文字列T1, 数値T1) VALUES ('a', 1), ('b', 2)
)
TABLE テーブル2 DO (
  INSERT (項目A) VALUES ('x')
)
```

- ブロック内は **INSERT のみ許可**（既存行が無いので UPDATE/DELETE は ParseError）。
- v1 は親 `VALUES` 1行限定（複数親×子ブロックの対応関係が曖昧になるため。CODEX X1 と同結論）。`INSERT … SELECT` との併用も v1 対象外。

### 3.3 UPSERT

```sql
UPSERT INTO APP4221 (顧客コード, タイトル)
VALUES ('C001', '更新')
ON DUPLICATE (顧客コード)
ON INSERT TABLE テーブル DO (
  INSERT (文字列T1, 数値T1) VALUES ('a', 1)
)
ON UPDATE TABLE テーブル DO (
  UPDATE SET 数値T1 = 数値T1 + 1 WHERE 文字列T1 = 'a';
  INSERT (文字列T1, 数値T1) VALUES ('b', 0)
)
```

- 既存の `ON DUPLICATE (キー)` の後に分岐句を後置。**insert 分岐＝INSERT ブロックと同規則・update 分岐＝UPDATE ブロックと同規則**（規則の再利用）。
- 分岐を省略したら、その分岐ではサブテーブルに触れない（現行 UPSERT と同じ挙動）。
- 両分岐で同じ初期行を書きたい定型は `ON INSERT` だけ書けばよい（update 分岐は既存行保持）。

## 4. 比較評価

| 軸 | C1（セルパス＋拡張） | C3（子操作ブロック） |
|---|---|---|
| 修復（セル更新）の簡潔さ | **◎** 4行・SET に混在 | ○ 6行（ブロック1層分） |
| 行追加 | △ `[+]` 擬似代入は無理があり、句を足すと C3 化（C1-b） | **◎** ブロック内 `INSERT`（既存文法流用） |
| 行削除 | ×〜△ 代入で表現不能・`REMOVE` 句が必須 | **◎** ブロック内 `DELETE` |
| 複数テーブル | ○ SET 項目を並べる（更新のみなら簡潔） | **◎** `TABLE … DO` の繰り返し（全操作対応） |
| INSERT | △ `ROWS(...)` 借用＝**文法の系統が UPDATE と分裂** | **◎** 同じブロックを後置（INSERT のみ許可） |
| UPSERT 分岐 | **×** update 分岐に単独解なし（分岐句を借りると C3 化） | **◎** `ON INSERT` / `ON UPDATE` ＋同一ブロック規則 |
| 文法の一貫性・学習コスト | △ セル=SET・追加/削除=句・INSERT=ROWS と3系統 | **◎** 全文型で「現行構文＋後置ブロック」の1規則 |
| 破壊性の静的判定（MCP 分類） | ○ `REMOVE` 句の有無で判定 | **◎** ブロック内の動詞で判定（`DELETE` を含む文だけ fail-closed・X1 の利点を継承） |
| 実装規模 | 中〜大（SET 左辺のセルパス文法＋ROW/ROWS＋追加句） | 中（ブロックの外枠＋既存仮想テーブル DML パーサの再利用。`ROWS` 不要） |
| B42/B43 連携 | ○ セレクタに `_rid` | ○ 同左（子 WHERE に `_rid`） |

**評価の要点**:

1. ユーザー要件を「セル更新」から「**追加・削除・INSERT・UPSERT**」へ広げた時点で、C1 は純粋な代入構文では完結できず、句や `ROWS` を借りて **C3 に漸近しながら3系統の文法を抱える**。C3 は最初から全操作を1規則（後置ブロック）で覆う。
2. C1 が勝るのは「セル更新のみ」の簡潔さ（4行 vs 6行）だけで、その差はブロック1層分。
3. C3 のブロック内文法は**既存のサブテーブル仮想テーブル DML と同一**なので、利用者の学習も実装（パーサ・検証・kintone 変換）も再利用が効く。

## 5. 推奨

**C3 を主構文として仕様化する**ことを推奨する。

- v1 スコープ案: UPDATE ＋ `TABLE … DO (UPDATE/INSERT/DELETE)`（複数テーブル対応・行セレクタ4種・revision ガード・`DELETE` を含む文は MCP fail-closed）。
- v1.1: INSERT ブロック（親 VALUES 1行限定）→ UPSERT の `ON INSERT`/`ON UPDATE` 分岐。
- C1 のセルパスは、修復の頻度が高いと分かった時点で「UPDATE の SET に書けるシンタックスシュガー（内部的に単文ブロックへ脱糖）」として v2 追加できる。**C3 と排他ではない**。

## 6. 仕様 R1 へ持ち越す論点

1. ブロック導入語の確定（`TABLE テーブル DO ( … )` は仮。`SUBTABLE`・`DO` 省略等の代案と、`CREATE TEMP TABLE` の `TABLE` トークンとの衝突有無）。
2. ブロック内の実行順序と同一セル多重更新の解決規則（記述順に適用・後勝ちで確定か、重複を ArgumentError にするか）。
3. 追加行の挿入位置（末尾固定か・`REORDER` との関係）。
4. UPDATE の親 WHERE が複数レコードに当たる場合のブロック適用（各レコードへ独立適用・`dmlMaxRows` は親レコード単位）。
5. `_idx` の解決タイミング（GET 時点の行順）と revision ガードの既定 ON/OFF。
6. `VALIDATE ONLY`（B43）と `EXPLAIN` の出力形式（ブロック内の操作別件数・削除予定行の明示）。
7. IMPORT（REPLACE SUBTABLES）との役割分担の明文化（全置換は IMPORT・部分操作は C3）。
8. MCP fail-closed の細分化（`DELETE` を含むブロックのみ fail-closed とし、UPDATE/INSERT のみのブロックを解禁するか）。

## 7. codex レビュー結果（2026-07-20・Claude が主要引用を全て裏取り済み・一致）

**総合判定 = C3 の骨格（親 DML に子操作ブロックを付加し、1 親の 1 PUT record へ合成）は条件付き支持。ただし §3〜§5 初稿のままの採用は不支持**で、以下を覆す。

### P1（採用前に必ず解決・全て裏取り一致）

- **P1-1 「既存サブテーブル DML 文法をそのまま流用」は不成立**。ブロック内は対象名・`_pid` の暗黙化に加え、①現行 UPDATE/DELETE は**安全のため `_rid` 条件必須**（言語リファレンス §19・[execute.ts:5729](../../src/execute.ts#L5729) `hasRidCondition`）＝C3 の述語/`_idx`/WHERE 省略セレクタは**新規の意味論**②現行サブテーブル DML は `VALIDATE ONLY`/`ON ERROR SKIP` を明示拒否（[parser.ts:2452](../../src/parser/parser.ts#L2452)）＝B43 連携も新設。**再利用できるのは式 AST・WHERE 評価器・型変換の一部**で、ブロック AST・スコープ解決・静的検証・実行計画は新設＝§4 の「実装規模: 中」は楽観的。
- **P1-2 既存 executor の逐次呼び出しでは 1 親=1 PUT にならない**。現行のサブテーブル INSERT/UPDATE/DELETE は各自が親 GET→PUT する独立 executor・親 UPDATE 通常経路は `$id` のみ取得し revision 無しで 100 件チャンク PUT（[dmlToKintone.ts:149-168](../../src/converter/dmlToKintone.ts#L149-L168)）。**専用の合成プランナー（親対象の全件スナップショット→メモリ上合成→全件検証→1 親 1 PUT record）が必要**。
- **P1-3 「記述順・後勝ち」の手続き的意味論は危険→スナップショット意味論で固定**: 全 UPDATE/DELETE セレクタは GET 時点の同一スナップショットに対して評価・INSERT 行は同文の UPDATE/DELETE から不可視・同一セル多重更新や UPDATE/DELETE 対象の重複は ArgumentError・同一テーブルのブロック重複禁止。ブロックは「逐次実行する DO」でなく**「1 つの変更計画を宣言する APPLY」**。
- **P1-4 B43 連携は「更新値だけの検証」では不十分**: PUT 後状態（post-image）＝親の非更新項目・全サブテーブルの全存続行・INSERT 行の必須/既定値/数値精度・複数テーブル合成後の最終レコードを検証する必要。`validateAndNormalizeDmlValue` はセル単位で流用可だが候補生成・エラー行ロケータ・親単位隔離は新実装。**C3 v1 は B42 の子フィールドメタ処理を共有し B43 相当の post-image 検証と同時提供すべき**。
- **P1-5 MCP 解禁は「DELETE トークンの有無」だけでは弱い**: サブテーブル PUT は行集合 payload で**既存行 ID の欠落=削除**。緩和は実行計画から `deletedRows=0`・既存行 ID 集合の完全保存・行順不変・`_rid` 不明/重複/別親は書き込み前拒否・revision 必須・EXPLAIN/VALIDATE ONLY で件数開示、を証明できる場合に限定。既存仮想テーブル DML を含め **MCP capability 判定を AST レベルで統一**する。
- **P1-6 `dmlMaxRows`=親件数のみは安全性後退**（1 親に数千子行なら `dmlMaxRows=1` で大量変更が通る。現行サブテーブル DML の確認件数は**子対象行数**＝[execute.ts:5757](../../src/execute.ts#L5757)）→**二重ガード**: `dmlMaxRows`=親レコード数＋`dmlMaxSubtableRows`=子行変更合計（削除解禁面では `dmlMaxDeletedSubtableRows` も）。全件数は最初の PUT 前に確定。
- **P1-7 原子性の正確な表現**: kintone PUT は 100 レコード単位分割のため「1 文=1 PUT」ではなく**「1 対象親=1 PUT record・API は 100 親ずつ・文全体はトランザクションでない」**と明記（チャンク間失敗で先行分が残る）。

### P2（仕様 R1 で明記）

- **P2-1 導入語**: `TABLE`/`DO` は予約語でなく字句衝突は無いが、`DO` は逐次実行を連想させスナップショット意味論と不整合・「TABLE」が 3 用法目→ **`APPLY SUBTABLE <code> ( … )` を推奨**（soft keyword）。
- **P2-2 親 WHERE はブロックより前**（`UPDATE … SET … WHERE 親条件 APPLY SUBTABLE …`）。`VALIDATE ONLY` 等は全ブロックの後。
- **P2-3 ブロック内 `;`**: 括弧深度を理解するブロックパーサが所有すれば衝突回避可。回帰テスト必須（バッチ `;` 併用・文字列/コメント内 `;`・コンソール継続入力・末尾 `;` 省略・空ブロック）。
- **P2-4 セレクタ規則**: `_idx` は**既存契約どおり 0-based**（言語リファレンス §19・[subtableAdapter.ts:28](../../src/converter/subtableAdapter.ts#L28)。比較文書初稿の 1-based は誤り→アイデア集 §7 も訂正済み）・`_idx` 使用時 revision 必須・`_rid`/`_idx` の 0 行マッチは既定エラー（修復対象消失を沈黙させない）・一般述語の 0 行は no-op・全行は WHERE 省略でなく **`ALL ROWS` で明示**・任意で `EXPECT ROWS n` 期待件数句。
- **P2-5 複数親**: 各親のサブテーブルを独立名前空間として評価。固定 `_rid` は通常 1 親にしか存在しない→ v1 は親条件 `$id = …` 限定か、複数親では述語/全行のみ許可が安全。
- **P2-6 UPSERT 分岐の省略時挙動**: `ON INSERT` 省略=新規親のテーブルは kintone 既定・`ON UPDATE` 省略=既存テーブル完全保持・両省略=現行 UPSERT と同一・insert 分岐では PATCH/REMOVE 禁止・分岐判定と post-image 検証と件数ガードは最初の POST/PUT 前に完了。

### P3（任意）

- **P3-1 内部動詞を `PATCH` / `APPEND` / `REMOVE` に**（既存 DML と誤解されない・EXPLAIN/MCP 分類と一致）。
- **P3-2 C1 セルパスは同一プランナーへの脱糖として将来追加可**（C3 executor 完成前に別実装を作らないことが条件）。

### 改善後の推奨構文（codex 案・R1 のベースライン）

```sql
UPDATE APP4221
SET 文字列MIN = 'ddd'
WHERE $id = 7

APPLY SUBTABLE テーブル (
  PATCH SET 文字列T2 = 'NNN' WHERE LENGTH(文字列T2) < 3 EXPECT ROWS BETWEEN 1 AND 10;
  PATCH SET 数値T1 = 10 WHERE _rid = '67890' EXPECT ROWS 1;
  APPEND (文字列T1, 数値T1) VALUES ('c', 3), ('d', 4);
  REMOVE WHERE 数値T1 = 0 EXPECT ROWS AT MOST 5
)

APPLY SUBTABLE テーブル2 (
  PATCH SET フラグ = '済' ALL ROWS
)

VALIDATE ONLY;
```

### 段階リリース（codex 案）

1. **v1**: 親 UPDATE＋1 サブテーブル＋`PATCH` のみ（親 `$id` 条件・子 `_rid` または安全な述語・revision 必須・VALIDATE ONLY/EXPLAIN 同時提供・MCP mutation は閉じたまま）。
2. **v1.1**: 複数サブテーブル・`APPEND`。削除ゼロを計画で証明できる PATCH のみ MCP 別 capability を検討。
3. **v1.2**: `REMOVE`（削除内訳を表示・承認できる CLI/プラグインのみ）。
4. **v2**: INSERT 初期行・UPSERT 分岐・複数親・`_idx`・一般述語・期待件数句。

## 8. 導入語の再検討 — `APPLY SUBTABLE` の `SUBTABLE` は不要（2026-07-20・ユーザー指摘）

**結論: `APPLY <フィールドコード> ( … )` を採用**（`SUBTABLE` noun を落とす）。

1. **解析上不要**: soft keyword `APPLY` ＋識別子＋ `(` の3トークン先読みで確定（KLIKE・B42 `SUMMARY`・`GROUP_CONCAT` と同じ手法）。出現位置も親 WHERE 消費後の文末尾で固定。
2. **型検証は実行時で一貫**: kSQL のパーサはメタデータ非依存が既存方針（DML 対象の存在・型チェックは execute 側＝`assertWritableTopLevelDmlFields` 等）。`APPLY x` の x が集合値フィールドでなければ ArgumentError（fail-closed）。仮想テーブル `APP100$明細` も noun を書かない前例。
3. **`SUBTABLE` を残す利点は自己文書性のみ**（読者への明示・SQL Server `CROSS APPLY` との混同回避）。技術的必然はない。
4. **noun を外す方が応用に有利**: APPLY の本質は「レコード内の**集合値フィールド**への変更計画の宣言」。第2ターゲットとして**複数値フィールド**（CHECK_BOX/MULTI_SELECT/USER_SELECT/ORGANIZATION_SELECT/GROUP_SELECT）の要素パッチが現実的:

   ```sql
   UPDATE APP100 SET 状態 = '対応中' WHERE $id = 7
   APPLY 複数選択 (
     ADD '重要';
     REMOVE '新規'
   )
   ```

   - 現行は `SET タグ = ARRAY('A','B')` の**全置換のみ**で「既存を保持して1要素追加」が書けない（読み取り→再構築が必要）＝タグ運用の実需。スナップショット意味論・post-image 検証（選択肢実在チェック＝P2a の optionOrder 検証を流用）・EXPECT ROWS もそのまま適用可。行 ID が無い分サブテーブルより単純（集合 ADD/REMOVE・重複 ADD は no-op か ArgumentError を仕様点に）。
   - 動詞でサブ文法を分離: サブテーブル=`PATCH/APPEND/REMOVE WHERE`・多値=`ADD '値'`/`REMOVE '値'`（共有する `REMOVE` は後続トークン WHERE/文字列で区別）。動詞集合×フィールド型の整合は実行時検証。
   - noun 方式だと拡張のたびにキーワードが増える（`APPLY MULTISELECT`?）。**一般形 `APPLY <field> (動詞…)` なら v1 サブテーブル限定→後方互換で拡張**。
   - FILE（添付）は現行 kSQL が書き込み対象外のため当面対象外。

### Claude の裏取りメモ

サンプリングした引用（`_rid` 条件必須 [execute.ts:5729](../../src/execute.ts#L5729)・VALIDATE ONLY 拒否 [parser.ts:2452](../../src/parser/parser.ts#L2452)・`_idx` 既存 0-based [subtableAdapter.ts:28](../../src/converter/subtableAdapter.ts#L28)・確認件数=子行数 [execute.ts:5757](../../src/execute.ts#L5757)・UPDATE は `$id` のみ取得/100 件チャンク/revision 無し [dmlToKintone.ts:149-168](../../src/converter/dmlToKintone.ts#L149-L168)）は**全て一致**。特に P1-1 は本文書 §3.1「既存文法をそのまま流用」・§4「実装規模: 中」の根拠を直接崩しており、**§4 の C3 実装規模は「中〜大」（合成プランナー・post-image 検証・ブロックパーサ新設）へ訂正**する。C3 推奨自体は覆らない（C1 との相対比較は不変＝C1 でも同じプランナーが必要になるため）。
