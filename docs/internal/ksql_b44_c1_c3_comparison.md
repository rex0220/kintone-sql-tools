# B44 C1/C3 比較検討 — テーブル内外項目の同時変更（行追加・削除・INSERT・UPSERT を含む）

- ステータス: 検討ドラフト R1（2026-07-20・[アイデア集](ksql_b44_syntax_ideas.md) の絞り込みフェーズ・仕様前）
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
