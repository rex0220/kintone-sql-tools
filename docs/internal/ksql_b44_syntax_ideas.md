# B44 テーブル内外項目の同時更新 — SQL 構文アイデア集

- ステータス: **アイデア出し段階**（2026-07-20・CLAUDE / CODEX が同一の課題文から独立起案・仕様前）
- 課題: [台帳 B44](../ksql_issue_tracker.md) — UPDATE がテーブル外項目とテーブル内項目を同時に（1文=1 PUT で）更新できない＝テーブル内に既存違反を持つレコードは DML だけでは修復不能
- 関連: [B42 spec](ksql_validate_subtable_audit_spec.md)（監査）・B43（DML 事前検証）・[B39 IMPORT spec](ksql_import_statement_spec.md)（現状唯一の main+subtable 1 PUT 経路）

## 1. 前提（両案共通の制約）

- kintone record PUT はレコード全体を再検証する。サブテーブルフィールドの PUT は**全行差し替え**（id 付き行=更新・id 無し行=追加・payload に無い既存行=**削除**）。
- 親 DML（`UPDATE/INSERT/UPSERT APPxxx`）はトップレベル限定（`assertWritableTopLevelDmlFields`）。サブテーブル仮想テーブル DML（`INSERT/UPDATE/DELETE/REORDER APPxxx$テーブル`・`_pid`/`_rid`）はテーブル内限定。
- MCP 面はサブテーブル変異 fail-closed（行削除を伴う操作を対話承認なしに実行できない）。**行削除を伴わない**操作（セル書き換えのみ）は緩和余地がある。
- 重点ユースケース: **修復書き込み**（制約違反セルへ妥当な値を同時セットし PUT 全体を valid 化）。B42 監査の行ロケータ（`$err_subrow_id`=`_rid`）が修復対象の特定に直結する。

## 2. CLAUDE 案

### 案 C1: セルパス SET（行セレクタ付き修飾参照）— パッチ意味論

親 UPDATE の `SET` に「テーブル[行セレクタ].子フィールド」を書けるようにする。対象行の該当セルだけを書き換え、**行の追加・削除はしない**（read-modify-write のパッチ）。

```sql
UPDATE APP4221
SET 文字列MIN = 'ddd',                       -- テーブル外
    テーブル[_rid = '101'].文字列T2 = 'abc',  -- 特定行（B42 監査の $err_subrow_id をそのまま使える）
    テーブル[文字列T2 = ''].文字列T2 = 'N/A', -- 条件セレクタ（違反セルの一括修復）
    テーブル[*].数値T1 = 0                    -- 全行
WHERE $id = 7
```

- 行アドレッシング: `[_rid = '...']` / `[子フィールド述語]` / `[*]`。仮想テーブル DML の WHERE 意味論（`_rid`・子フィールド参照）を流用。
- 意味論: パッチ。セレクタに合致する行が 0 行でもエラーにしない（UPDATE の WHERE 0 件と同じ扱い）か否かは仕様論点。
- 整合: `テーブル.子 = 値` という素朴な形は「どの行か」が決まらないため**セレクタ必須**にする（`[...]` なしは ParseError）。`[` は現行文法で未使用のため衝突なし。
- MCP: 行削除が構文上あり得ない → fail-closed を**緩和できる**（親項目更新と同格）。
- 長所: 修復ユースケースに最短・安全性が構文で保証される・パーサ増分が SET 左辺に閉じる。
- 短所: 行の追加/削除ができない（それは既存の仮想テーブル DML / 案 C3 の守備範囲）。INSERT には使えない。

### 案 C2: テーブルリテラル `ROWS(...)` — INSERT/UPSERT 向け・置換意味論

列リストにテーブル本体を「子列リスト付き」で書き、値側に行コンストラクタを渡す。

```sql
INSERT INTO APP4221 (タイトル, テーブル(文字列T1, 文字列T2, 数値T1))
VALUES ('新規', ROWS(('a', 'abc', 1), ('b', 'xyz', 2)))

UPDATE APP4221
SET 文字列MIN = 'ddd',
    テーブル(文字列T2) = ROWS(('abc'), ('xyz'))   -- 全行差し替え（危険・fail-closed 維持）
WHERE $id = 7
```

- 意味論: **置換**（IMPORT REPLACE SUBTABLES と同じ）。INSERT では既存行が無いので安全。UPDATE/UPSERT-update では行削除を伴い得るため MCP fail-closed を維持。
- 整合: `VALUES` 内の入れ子タプルは現行パーサに無い形。`ROWS` キーワードで先読みし通常の式と区別（`GROUP_CONCAT`/KLIKE と同じ soft keyword 方式）。
- 長所: INSERT で「テーブル込みの新規レコード」が初めて書ける。UPSERT の insert 側と対称。
- 短所: UPDATE で「既存行を保ちつつ一部だけ」ができない（`_rid` をリテラル列に含める拡張は可能だが IMPORT の役割と重複していく）。

### 案 C3: 子操作ブロック（複合文）— 表現力最大・v2 候補

親 UPDATE に仮想テーブル DML をぶら下げ、まとめて 1 PUT に合成する。

```sql
UPDATE APP4221 SET 文字列MIN = 'ddd'
TABLE テーブル DO (
  UPDATE SET 文字列T2 = 'abc' WHERE _rid = '101';
  DELETE WHERE 数値T1 = 0;
  INSERT (文字列T1, 数値T1) VALUES ('c', 3)
)
WHERE $id = 7
```

- 長所: セル修正＋行追加＋行削除を 1 PUT で完結（IMPORT を書かずに済む唯一の案）。仮想テーブル DML の文法・意味論をそのまま再利用。
- 短所: 文法規模が最大。`WITH` は CTE と衝突するため別導入語が必要（例: `TABLE ... DO`）。DELETE を含み得るため MCP fail-closed は維持。ブロック内の実行順序・同一セル多重更新の解決規則など仕様論点が多い。

### CLAUDE 推奨

**v1 = 案 C1（UPDATE のセルパス SET・パッチ・削除なし）＋案 C2 の INSERT 側のみ**。

- 修復ユースケース（B42→B43→B44 の三段）は C1 だけで完結する: B42 監査 `#err` の `$err_subrow_id` → `テーブル[_rid = @rid].子 = 値` に直結。
- C1 は削除を伴わないため MCP でも解禁でき、「MCP で発見（B42）した違反を MCP で修復（B44）」が閉じる。
- UPSERT と UPDATE の置換系（C2 の UPDATE 側）・C3 は実需を見て v2。行の追加/削除を伴う一括再構成は当面 IMPORT が受け持つ（役割分担が明確）。

## 3. CODEX 案

（codex exec による独立起案・同一課題文から生成・原文のまま）

### 案 X1：親 DML に `PATCH / APPEND / REPLACE SUBTABLE` 句を追加

親レコードを文の主語にしたまま、サブテーブル操作を独立した句として連結する案。

#### UPDATE

```sql
UPDATE APP4221
SET 文字列MIN = 'ddd',
    修復状態 = '完了'
PATCH SUBTABLE テーブル
  SET 文字列T2 = '妥当な値'
  WHERE _rid = '67890'
WHERE $id = 7;
```

複数行を修復する場合:

```sql
UPDATE APP4221
SET 修復状態 = '完了'
PATCH SUBTABLE テーブル
  SET 文字列T2 = CASE
    WHEN _rid = '67890' THEN '修復値A'
    WHEN _rid = '67891' THEN '修復値B'
  END
  WHERE _rid IN ('67890', '67891')
WHERE $id = 7;
```

- 外側の `WHERE` が親レコードを選択する。
- 内側の `WHERE` が、その親に属するサブテーブル行を選択する。
- `_pid` は外側の親から暗黙に決まる。内側で指定するなら、外側の親と一致することを必須にする。
- `PATCH` では、対象外の行、対象行の未指定セル、行 ID、行順をすべて保持する。
- kintone へ送る payload はテーブル全体になるが、SQL 上の意味論は「対象セルだけのパッチ」とする。

#### INSERT

```sql
INSERT INTO APP100 (顧客コード, 状態)
VALUES ('C001', '新規')
APPEND SUBTABLE 明細 (商品コード, 数量)
VALUES ('A-001', 2),
       ('B-001', 1);
```

- 新しい親には既存行がないため、`APPEND SUBTABLE` は初期行の構築を意味する。
- `_pid`、`_rid` は指定しない。親 ID と行 ID は登録後に kintone が採番する。
- 複数親を一度に INSERT すると子行との対応が曖昧になるため、初期版では「親 `VALUES` は1行」に限定するのが安全。

#### UPSERT

```sql
UPSERT INTO APP100 (顧客コード, 状態)
VALUES ('C001', '修復済')
ON DUPLICATE (顧客コード)

ON INSERT
  APPEND SUBTABLE 明細 (商品コード, 数量)
  VALUES ('A-001', 2)

ON UPDATE
  PATCH SUBTABLE 明細
    SET 数量 = 2
    WHERE _rid = '67890';
```

- insert 分岐では `_rid` が存在しないため、新規行を `APPEND` する。
- update 分岐では既存行を `_rid` で `PATCH` する。
- 分岐を省略した場合、その分岐ではサブテーブルを変更しない。
- `ON DUPLICATE` と `ON INSERT` / `ON UPDATE` は語感が近いため、句順を固定する必要がある。

#### 置換

```sql
UPDATE APP100
SET 状態 = '再構築済'
REPLACE SUBTABLE 明細 (商品コード, 数量, _rid)
VALUES ('A-001', 5, '67890'),
       ('C-001', 1, NULL)
WHERE $id = 7;
```

- `_rid` ありは既存行の維持・更新、`NULL` または省略は追加。
- payload にない既存行は削除。
- `REPLACE` は IMPORT の `REPLACE SUBTABLES` と同じ破壊的意味論にそろえられる。
- `PATCH` と `APPEND` は行削除なし、`REPLACE` は行削除あり、と構文から判別できる。

#### 整合性・長所・短所

- `APP100$明細` の `_rid` 契約をそのまま利用できる。
- 親の `WHERE` と子の `WHERE` が分離され、誤って別親の行を触りにくい。
- UPDATE、INSERT、UPSERT の分岐差を明示でき、修復書き込みに最も向く。
- CTE や既存 `VALUES` の意味を変えない。
- 一方、SQL 標準にはない句が増え、UPSERT はやや長くなる。
- 複数サブテーブルや複数親の一括処理では、句の繰り返しと親子対応規則が必要。

MCP は当面、現行 IMPORT と同様にサブテーブル mutation 全体を fail-closed とし、`VALIDATE ONLY` / `EXPLAIN` のみ許可するのが安全。将来、削除・追加・並べ替えがない `PATCH` だけを別 capability で解禁しやすい点は、この案の大きな利点である。

---

### 案 X2：サブテーブルを行集合値 `ROWS(...)` として親 DML に埋め込む

IMPORT の `明細(品名, 数量)` に近いネスト表現を、通常 DML の列値へ拡張する案。

#### UPDATE

```sql
UPDATE APP4221
SET 文字列MIN = 'ddd',
    修復状態 = '完了',
    テーブル PATCH (_rid, 文字列T2) =
      ROWS(
        ('67890', '妥当な値'),
        ('67891', '別の妥当な値')
      )
WHERE $id = 7;
```

#### INSERT

```sql
INSERT INTO APP100 (
  顧客コード,
  状態,
  明細(商品コード, 数量)
)
VALUES (
  'C001',
  '新規',
  ROWS(
    ('A-001', 2),
    ('B-001', 1)
  )
);
```

#### UPSERT

```sql
UPSERT INTO APP100 (
  顧客コード,
  状態,
  明細 ON INSERT APPEND (商品コード, 数量),
  明細 ON UPDATE PATCH (_rid, 数量)
)
VALUES (
  'C001',
  '修復済',
  ROWS(('A-001', 2)),
  ROWS(('67890', 2))
)
ON DUPLICATE (顧客コード);
```

#### アドレッシングと意味論

- 既存行のパッチは `ROWS` の `_rid` 列で指定する。
- `_pid` は各親 `VALUES` 行から暗黙に決まる。
- INSERT の行集合には `_rid` を許可しない。
- `PATCH` は指定された `_rid` の指定セルだけを変更し、他の行とセルを保持する。
- `APPEND` は新規行だけを追加する。
- `REPLACE` を付けた場合は、行集合に含まれない既存行を削除する。

```sql
UPDATE APP100
SET 状態 = '再構築済',
    明細 REPLACE (_rid, 商品コード, 数量) =
      ROWS(
        ('67890', 'A-001', 5),
        (NULL,    'C-001', 1)
      )
WHERE $id = 7;
```

#### 整合性・長所・短所

- IMPORT のネスト対象 `明細(子1, 子2)` と形が近い。
- 複数親 INSERT でも、各親 `VALUES` 行の中に子行集合が入るため対応が明確。
- JSON のネスト配列に慣れた利用者には理解しやすい。
- 親レコードを一つの構造値として表現でき、複数サブテーブルにも自然に拡張できる。

一方で、現行 kSQL の `VALUES` はスカラー列の並びであり、`ROWS(...)` という新しい値カテゴリが必要になる。`SET 明細 PATCH (...) = ROWS(...)` も通常の代入式とはかなり異なる。また、条件に基づいて既存行を更新するより、既知の `_rid` ごとのデータ投入に向いた構文である。

MCP では `PATCH` / `APPEND` / `REPLACE` を構文解析時点で分類できる。ただし `ROWS` に同一 `_rid` が重複する場合や、存在しない `_rid` の扱いを fail-closed で定義する必要がある。`REPLACE` は必ず対話承認可能な面に限定する。

---

### 案 X3：`APPxxx$テーブル` DML から `_p.親項目` への書き込みを許可

既存のサブテーブル仮想テーブルを主語にし、現在は参照専用の `_p.項目` を書き込み可能にする案。

#### UPDATE

```sql
UPDATE APP4221$テーブル
SET _p.文字列MIN = 'ddd',
    _p.修復状態 = '完了',
    文字列T2 = '妥当な値'
WHERE _pid = 7
  AND _rid = '67890';
```

- `_pid` と `_rid` は現行サブテーブル UPDATE と同じ。
- 子行の更新と `_p.` の親更新を、同じ親 record PUT にまとめる。
- 同じ親の複数子行が対象になり、親項目に異なる値を代入しようとした場合は文全体を拒否する。

#### INSERT

```sql
INSERT INTO APP100$明細 (
  _p.顧客コード,
  _p.状態,
  商品コード,
  数量
)
VALUES ('C001', '新規', 'A-001', 2)
CREATE PARENT;
```

- `CREATE PARENT` を付けた場合は、親レコードと最初の子行を同時に POST する。
- 既存のサブテーブル INSERT と区別するため、`_pid` との併用は禁止する。
- `CREATE PARENT` なしでは、従来どおり `_pid` 必須の既存親への行追加とする。

複数子行を持つ親の作成には、親グループを示す追加構文が必要になるため、単純な VALUES だけでは弱い。

#### UPSERT

```sql
UPSERT INTO APP100$明細 (
  _p.顧客コード,
  _p.状態,
  商品コード,
  数量
)
VALUES ('C001', '修復済', 'A-001', 2)
ON DUPLICATE PARENT (_p.顧客コード)
ON UPDATE ROW (_rid = '67890');
```

- `ON DUPLICATE PARENT` は親レコードの照合キー。
- 親がなければ親＋子行を作成。
- 親があれば `ON UPDATE ROW` の `_rid` を更新。
- `_rid` がなければ追加とする案も可能だが、誤追加を避けるなら `APPEND ROW` の明示を必須にした方が安全。

#### 置換・パッチ

通常の `UPDATE APPxxx$テーブル` はパッチであり、対象外行を保持する。全置換は別構文に分ける。

```sql
REPLACE APP100$明細
WITH VALUES
  (7, '67890', 'A-001', 5),
  (7, NULL,    'C-001', 1);
```

これは payload にない既存行を削除するため、IMPORT の `REPLACE SUBTABLES` と同じ破壊的クラスとして扱う。

#### 整合性・長所・短所

- `APPxxx$テーブル`、`_pid`、`_rid`、`_p.項目` を最大限再利用できる。
- B42 の `$err_subrow_id = _rid` から修復文へ直結する。
- UPDATE の修復ユースケースは非常に短く、既存利用者にも理解しやすい。
- 子行パッチなので、通常は行削除を伴わない。

ただし、主語がサブテーブルなので、親 INSERT や親 UPSERT の表現が不自然になる。複数サブテーブルを同じ親 PUT に含めることも難しい。親だけ更新したい場合に「どの子行を起点にするか」という不要な問題も生じるため、B44 全体の統一構文というより、UPDATE 修復専用の小さな拡張に向く。

MCP では、既存のサブテーブル DML と同じ分類になるため、現状方針を変えない限り mutation は fail-closed となる。将来 `_p.`＋子セルの `UPDATE` だけを解禁する場合も、対象 `_rid` の存在、行数不変、行順不変を事前計画で証明する必要がある。

---

### CODEX 推奨：案 X1

親レコードが kintone PUT の原子単位であるため、言語上も親 DML を主語にする案 X1 が最も自然である。

特に、次の区別を構文に明示できる点が重要。

| 操作 | 意味 | 既存行削除 |
|---|---|---:|
| `PATCH SUBTABLE` | `_rid` で既存行の指定セルだけ更新 | なし |
| `APPEND SUBTABLE` | 新規行を末尾へ追加 | なし |
| `REPLACE SUBTABLE` | 指定した完全な行集合へ置換 | あり |

これにより、SQL を実行する前に破壊性を判定できる。修復書き込みでは `PATCH SUBTABLE` を使い、トップレベル違反と子セル違反を同じ PUT で同時に解消できる。

### CODEX 段階的リリース案

**B44 v1：修復書き込みに集中**

- `UPDATE APP... SET ... PATCH SUBTABLE ... WHERE _rid ... WHERE 親条件`
- 1文につき1サブテーブル。
- 既存行のセル更新のみ。追加、削除、置換、並べ替えは不可。
- 子行の選択には `_rid` を必須とし、 `_idx` による更新は禁止。
- 親条件は `$id = ...`、子条件は `_rid = ...` または限定的な `IN (...)` から開始。
- 対象外行、未指定セル、行 ID、行順を必ず保持。
- `VALIDATE ONLY` と `EXPLAIN` を同時提供。
- MCP の実 mutation は従来どおり fail-closed。CLI／確認 UI を持つプラグインから開始する。

**B44.1：生成系**

- INSERT の `APPEND SUBTABLE`。
- UPSERT の `ON INSERT APPEND SUBTABLE`。
- 最初は親 `VALUES` 1行に限定し、親子相関の問題を避ける。

**B44.2：一括・破壊的操作**

- UPDATE/UPSERT の複数親、`UPDATE ... FROM`、CTE／一時テーブルからの `_pid`・`_rid` 修復データ供給。
- 複数サブテーブル。
- `APPEND SUBTABLE` と `REPLACE SUBTABLE`。
- `REPLACE` は削除予定行 ID と件数を表示できる面だけで実行し、MCP は引き続き fail-closed。
- 非削除 `PATCH` の MCP 解禁は、別 capability として安全性を評価する。

この順序なら、B42 が返す `$id` と `$err_subrow_id` をそのまま親 `$id`／子 `_rid` に接続し、B44 の中心目的である「相互にブロックし合う既存違反の原子的修復」を最小スコープで先に提供できる。

## 4. 突き合わせメモ（CLAUDE 記・独立起案後の比較）

両者が独立に一致した点（＝設計の芯とみなせる）:

- **パッチ（削除なし）とリプレース（削除あり）を構文レベルで分離**し、破壊性を実行前に判定可能にする（C1/C2 ⇔ X1 の PATCH/APPEND/REPLACE 三分類）。
- **修復ユースケース（削除なしのセルパッチ）を v1 の中心**に置き、行追加・置換・複数親は後段へ。
- **`_rid` を行アドレスの正とし、B42 の `$err_subrow_id` から修復文へ直結**させる。
- INSERT のテーブル初期行は **`ROWS(...)` 型の行コンストラクタ**が自然（C2 ⇔ X2 はほぼ同型）。
- 削除を伴わないパッチのみ **MCP fail-closed の緩和候補**（C1 ⇔ X1 の締めの指摘が一致）。

主な相違点（次の絞り込みの論点）:

- **UPDATE の書き味**: CLAUDE C1 は SET 内の行セレクタ付きセルパス（`テーブル[_rid='101'].文字列T2 = ...`・1つの SET に混在）／CODEX X1 は独立句（`PATCH SUBTABLE ... SET ... WHERE _rid ...`・親 SET と分離）。X1 は子 WHERE と親 WHERE の分離が明確で複数セル更新が書きやすく、C1 は単発修復が短く書ける。
- **条件セレクタの扱い**: C1 は `テーブル[文字列T2 = ''].文字列T2 = 'N/A'` のような述語ベース一括修復を v1 に含める／X1 v1 は `_rid` 必須（述語は CASE + `_rid IN` で表現）。fail-closed 観点では X1 の `_rid` 必須が保守的。
- **CODEX X3（`_p.` 書き込み）は CLAUDE に無い視点**: 既存構文の再利用が最大で修復文が最短になるが、親 INSERT/UPSERT が不自然になるため「UPDATE 修復専用の小拡張」と自己評価している。C1 とは鏡像関係（親主語 vs 子主語）。
- **UPSERT の分岐**: X1/X2 は `ON INSERT` / `ON UPDATE` 分岐を明示（CLAUDE は v1 対象外に退避）。分岐構文は表現力が高い分、句順・省略時挙動の仕様点が増える。

## 5. 他 RDB の類似構文（前例調査・2026-07-20・Web 裏取り済み）

「親行＋ネスト構造（コレクション/子行/文書）を UPDATE する」構文の前例。B44 の各案が先行例に対応することが確認できた。

### 5.1 Couchbase N1QL / SQL++ — 親フィールドと配列要素の同一文 SET（B44 要件に最も近い前例）

```sql
UPDATE route t USE KEYS "route_10003"
SET meta(t).expiration = 7*24*60*60,
    s.codeshare = NULL FOR s IN schedule END;
```

- **1つの UPDATE の SET に、通常の代入と `FOR var IN 配列 (WHEN 条件)? END` 付きの配列要素代入を混在**できる（公式ドキュメント Example 7）。`WHEN` が行セレクタ（`UPDATE … SET er.firstName='x' FOR er IN recipients.emailRecipients WHEN er.emailAddress='abc@gmail.com' END`）。
- 文書（=レコード）単位の原子更新で、削除は `UNSET`（同じく FOR 対応）に分離＝**パッチと削除の構文分離**まで B44 の芯と一致。
- 対応: CLAUDE C1（条件セレクタ付きセルパス）・CODEX X1 の PATCH に相当。**「親＋子を同一文・パッチ意味論」は実在する**ことの実証。

### 5.2 Oracle オブジェクトリレーショナル（NESTED TABLE / VARRAY）— 構造の最類似・二本立て構文

kintone サブテーブルに構造が最も近い（子行集合が親の列）。構文は**二本立て**:

```sql
-- (a) piecewise: TABLE() 式で子を主語にして行単位 UPDATE（親列は同時更新不可）
UPDATE TABLE(SELECT d.dept_emps FROM department_persons d
             WHERE d.dept_no = 101) p
   SET VALUE(p) = person_typ(2, 'Diane Smith', '1-650-555-0148')
 WHERE p.idno = 2;

-- (b) atomic: コレクションコンストラクタで全置換（VARRAY はこちらのみ）
UPDATE region_tab r SET r.countries = v_country WHERE r.region_id = 2;
```

- (a) は kSQL の `APPxxx$テーブル` / CODEX X3 と同型（**親項目を同時更新できない弱点まで一致**。公式ドキュメントに親＋piecewise の複合例は無い）。
- (b) は C2/X2 の `ROWS(...)` と同型（置換意味論・親列との同時 SET は通常の複数代入として可能）。

### 5.3 BigQuery（GoogleSQL）— ARRAY&lt;STRUCT&gt; 列を式で再構築

```sql
UPDATE t
SET 状態 = '再構築済',
    comments = ARRAY(SELECT AS STRUCT * REPLACE('fixed' AS text)
                     FROM UNNEST(comments))
WHERE id = 7;
```

- 配列列への代入は常に**全体再構築（置換）**だが、`UNNEST → SELECT AS STRUCT * REPLACE → ARRAY()` で実質パッチを表現。追加は `ARRAY_CONCAT`。親列との同時 SET は通常の複数代入。
- 対応: C2/X2 の置換意味論＋「既存行を SELECT で運ぶ」発想。専用構文を増やさない代わりに書き味が重い（B44 でいえば「IMPORT で全行書き直し」に近い体験）。

### 5.4 PostgreSQL — 配列添字・複合型フィールドへの直接代入

```sql
UPDATE contacts SET phones[2] = '(408)-589-5843';
UPDATE t SET compcol[2].x = 24;  -- 複合型配列の要素フィールド（制限あり）
```

- SQL:1999 系の配列要素代入。**セルパス代入（C1 の形）は標準系にも前例がある**。行セレクタが「添字」であり、kintone のような行 ID/述語ベースではない点が相違。

### 5.5 SQL Server / MySQL — JSON パッチ関数

```sql
-- SQL Server（1呼び出し1パス・ネストで複数）
UPDATE Products SET ProductData = JSON_MODIFY(ProductData, '$.suppliers[0].rating', 4.9) WHERE …;
-- MySQL（1呼び出しで複数パス可）
UPDATE users SET profile = JSON_SET(profile, '$.roles[0]', 'superadmin', '$.name', 'x') WHERE …;
```

- 構文でなく**関数適用**でネスト文書をパッチ。パス言語（`$.a[0].b`）が行アドレッシング。親列との同時 SET は通常の複数代入で可能。
- 対応: 「関数で逃がす」第4の選択肢だが、kSQL はフィールド型検証（B43）と統合したいので構文案（C1/X1）の方が筋が良い。

### 5.6 まとめ（B44 各案と前例の対応）

| B44 案 | 前例 | 示唆 |
|---|---|---|
| C1 セルパス SET（パッチ） | N1QL FOR/WHEN・PostgreSQL 添字代入 | 親＋子の同一文パッチは実在。条件セレクタも N1QL WHEN が前例 |
| X1 PATCH/APPEND/REPLACE 句 | N1QL（SET/UNSET の分離）・SQL 標準外の句追加は Oracle TABLE() も同類 | 破壊性の構文分離は N1QL の SET/UNSET 分離と同じ発想 |
| C2/X2 ROWS リテラル（置換） | Oracle コレクションコンストラクタ・BigQuery ARRAY() 再構築 | 置換意味論の前例は厚い。INSERT 初期行にも自然 |
| X3 子主語＋`_p.` 書き込み | Oracle TABLE() piecewise | **Oracle も親列は同時更新不可**＝X3 の弱点は前例でも未解決 |

- どの主要 RDB にも「**子行 ID＋述語で選んでパッチ**」と「**全置換**」の対は存在し、B44 の PATCH/REPLACE 分離は業界慣行と整合する。
- SQL 標準（SQL:2023 まで）には「ネスト表の部分更新 DML」は無い＝**どの前例もベンダー拡張**。kSQL が独自句（X1）や独自セレクタ（C1）を足すことは特異ではない。

出典: [Oracle: Operations on Collection Data Types](https://docs.oracle.com/en/database/oracle/oracle-database/18/adobj/operations-on-collection-data-types.html) / [Couchbase N1QL UPDATE](https://docs.couchbase.com/cloud/n1ql/n1ql-language-reference/update.html) / [BigQuery DML syntax](https://cloud.google.com/bigquery/docs/reference/standard-sql/dml-syntax) / [PostgreSQL Arrays](https://www.postgresql.org/docs/current/arrays.html) / [SQL Server JSON_MODIFY](https://learn.microsoft.com/en-us/sql/t-sql/functions/json-modify-transact-sql?view=sql-server-ver17) / [MySQL JSON_SET](https://dev.mysql.com/doc/refman/8.0/en/json-modification-functions.html)

## 6. 評価: 修復ユースケースでの「簡潔さ」（2026-07-20・ユーザー指示の評価軸）

評価軸 = **制約違反のあるレコードでテーブル内外の項目を同時に変更する目的で、どれだけ簡潔に書けるか**。全案を同一シナリオ（実機 B43 の APP4221 $id=7: 親 `文字列MIN='ddd'` ＋ テーブル内 `文字列T2` の minLength 違反 2 行を修復）で書き比べる。

### 6.1 同一シナリオの書き比べ

```sql
-- C1: セルパス SET（述語セレクタ利用時・4行）
UPDATE APP4221
SET 文字列MIN = 'ddd',
    テーブル[LENGTH(文字列T2) < 3].文字列T2 = 'NNN'
WHERE $id = 7

-- X3: 子主語 + _p.（4行・新構文は SET 内の _p. のみ）
UPDATE APP4221$テーブル
SET _p.文字列MIN = 'ddd',
    文字列T2 = 'NNN'
WHERE _pid = 7 AND LENGTH(文字列T2) < 3

-- X1: PATCH SUBTABLE 句（6行・codex v1 案のまま=_rid 必須なので事前 SELECT がもう1文要る）
UPDATE APP4221
SET 文字列MIN = 'ddd'
PATCH SUBTABLE テーブル
  SET 文字列T2 = 'NNN'
  WHERE _rid IN ('101', '102')   -- ←この '101','102' を得る SELECT が別途必要
WHERE $id = 7

-- C3: 子操作ブロック（6行・述語可）
UPDATE APP4221 SET 文字列MIN = 'ddd'
TABLE テーブル DO (
  UPDATE SET 文字列T2 = 'NNN' WHERE LENGTH(文字列T2) < 3
)
WHERE $id = 7

-- X2: ROWS PATCH（_rid 列挙が本体・事前 SELECT 必須）
UPDATE APP4221
SET 文字列MIN = 'ddd',
    テーブル PATCH (_rid, 文字列T2) = ROWS(('101','NNN'), ('102','NNN'))
WHERE $id = 7

-- C2: ROWS 置換（全行の全列を列挙し直す必要＝修復用途では書けない）
```

### 6.2 評価表

| 案 | 簡潔さ | `_rid` 事前取得 | 評価 |
|---|---|---|---|
| **C1 セルパス** | **◎**（1セル=SET 1行・親と混在・複数テーブルも可） | **不要**（述語/位置セレクタ） | 手書き修復と汎用性の両立で最良 |
| **X3 子主語 `_p.`** | **◎**（最短・新構文最小＝既存仮想テーブル DML の SET に `_p.` を足すだけ・WHERE は既存意味論そのまま） | **不要**（既存 WHERE に述語） | 修復専用なら最有力。ただし親のみ更新・複数サブテーブル・INSERT/UPSERT に伸びない構造的制約 |
| C3 ブロック | ○（ブロック1層分長い・述語可） | 不要 | 表現力最大だが修復には過剰 |
| X1 PATCH 句 | ○〜△（句形式で長め。**codex v1 の `_rid` 必須が簡潔さを大きく損なう**＝事前 SELECT で実質2文・行別値は CASE でさらに冗長） | 案のまま=必須 → **述語/位置を許可すれば不要化できる** | 破壊性の句名分類は残す価値あり |
| X2 ROWS PATCH | △（`_rid` 列挙が本体） | 必須 | 手書きには不向き。B42 `#err` から機械生成する一括修復では逆に最適（`$err_subrow_id`→`_rid` 直結） |
| C2 ROWS 置換 | ×（保持したい行も全列挙＝置換意味論が修復と根本的に不整合） | 必須＋全行内容 | 修復用途から除外（INSERT 初期行専用） |

**結論**: 簡潔さの軸では **X3 と C1 が双璧**。X3 は「今回の目的（修復）」に限れば最短・実装最小だが、B44 全体（INSERT/UPSERT・複数テーブル・親のみ更新）へ伸びない。**汎用形は C1（または X1 に述語/位置セレクタを許可した形）、修復専用の速効形として X3 を先行**、という2段構えが有力。X1 v1 の「`_rid` 必須」は安全側だが、本評価軸（簡潔さ）とユーザーの運用（事前取得なしで書きたい）に反するため、採るなら述語/位置セレクタの解禁が前提。

## 7. 行アドレッシングの再検討 — `_rid` 事前取得問題と行位置指定（2026-07-20・ユーザー指摘）

**問題**: `_rid` は安定した行 ID だが、値を知るには先に `SELECT _rid FROM APPxxx$テーブル WHERE …` でテーブル情報を取得する必要がある（=手書き修復が実質2文になる）。B42 監査経由なら `$err_subrow_id` として自動で手に入るが、**レコード画面を見ながら「3行目を直したい」と書く人間には `_rid` は見えない**（kintone UI は行 ID を表示しない。REST GET には含まれる＝MCP/プログラム経路では取得済みのことが多い、という非対称）。

候補となる行の特定方法（セレクタはどの案に載せても共通部品にできる）:

| 方法 | 例 | 事前取得 | 安全性 | 用途 |
|---|---|---|---|---|
| ① `_rid`（行 ID） | `[_rid = '101']` / `WHERE _rid = '101'` | 必要 | ◎ 行の増減・並べ替えに不変。消えた行は fail-closed（対象なし） | B42 `#err` 駆動の機械生成・一括修復 |
| ② **行位置 `_idx`（1-based・読み取り専用擬似列）** | `[_idx = 2]` / `WHERE _idx IN (1, 3)` | **不要**（画面で数えられる） | △ 実行間で行の追加/削除/REORDER があるとズレて**別の行を静かに更新**し得る → **revision ガードで◎に引き上げ可**（下記） | 人間の手書き・単発修復 |
| ③ 述語（子フィールド条件） | `[LENGTH(文字列T2) < 3]` / `WHERE 文字列T2 = ''` | **不要** | ○ 意図した行「集合」に当たる。想定外マッチは `VALIDATE ONLY` プレビューで確認 | 違反セルの一括修復（B44 の中心） |
| ④ 全行 `[*]` | `[*]` / WHERE 省略 | 不要 | ○ 対象が明示的に全行 | 列一括の正規化 |

**②の安全化 = kintone の楽観ロック（revision）を使う**: エンジンは 1 文の中で「レコード GET（行順・revision 取得）→ 位置を解決 → 同 revision 付きで PUT」を行う。読み取りと書き込みの間に他者が更新していれば kintone が PUT を拒否（GAIA_CO*）＝**位置ズレの静かな誤更新を構造的に排除できる**。この revision ガードは②に限らず B44 のパッチ書き込み全般（①③④）に既定で付ける価値がある（現行 DML は revision を使っていない）。なお codex X1 v1 は `_idx` 禁止を提案していたが、それは revision ガード無し前提の判断であり、ガード導入で再考の余地がある。

**設計方針（提案)**: 行セレクタを**共通文法**（`_rid` / `_idx` / 述語 / `*`）として定義し、採用する構文案（C1 の `[…]`・X1/C3 の子 WHERE・X3 の WHERE）のどれにも同じものを載せる。`_idx` は読み取り専用擬似列として `SELECT`（`APPxxx$テーブル` の出力列）にも追加すると、事前確認 SELECT →修復文の往復が同じ語彙で書ける。既存のサブテーブル仮想テーブル DML への `_idx` 追加は B44 本体と独立に先行出荷も可能（小型・後方互換）。

## 8. 次のステップ

1. ~~両案を突き合わせて構文候補を 1〜2 案に絞る（ユーザー判断）~~ → **絞り込み済（2026-07-20）**: **C1/C3 に絞って比較検討へ**（[比較文書](ksql_b44_c1_c3_comparison.md)）。**X3 は複数テーブルの更新に対応できないため除外**（ユーザー判断）。X1 の破壊性分類・X2/C2 の `ROWS(...)` は部品として比較文書に取り込み。
2. 比較文書の推奨（C3 主構文）をユーザーが判断 → 仕様 R1 起草 → codex レビュー（B42 実装との順序も決める: 行ロケータ `_rid` の露出は B42 が先）。
3. デッドロック（テーブル内外の両領域違反）の実機確認用フィクスチャを APP4221 に別途作成（$id=7 は B42/B43 の証拠フィクスチャのため温存）。
