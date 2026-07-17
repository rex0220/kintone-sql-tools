# kSQL 文字列の扱い（正）

- 作成日: 2026-07-17
- **位置づけ: 本書が文字列の扱いの「正」（single source of truth）。** 個別の仕様・課題文書は**事実を書き写さず本書を参照する**。
- ステータス: **R8.1（B27 の tie-break 契約を確定。SIMPLE は利用者キー末尾へ `$id asc` を明示して FULL_SCAN の安定順へ合わせ、peer 比較器とは分離する。B9 は最大30桁の厳密比較、精度依存の検証・丸めは B29 へ分離。R8.1 で `STATUS` を `equivalent 候補（実装前提あり）` へ訂正＝`states.*.index` を捨てているためローカルが定義順を再現できない。LINK(TEL)・CREATED_TIME/UPDATED_TIME を unknown へ差し戻し。R8.2 で `status.json` を実測＝`index` は**文字列**・`enable: false` でも `states` は返る）。**
- 分担: Claude=仕様/観点、Codex=実装/テスト
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md)

---

## 0. なぜ本書があるか

文字列の扱い（文字数の定義・サロゲートペア・比較順序）は **B12-A / B13 / B14 / B16 / B19 / B20 / B21 / B22 / B23 / B24 / B26 の複数の課題にまたがる**。各文書が同じ事実を書き写していると、**必ず食い違う**。

実際、本書の起票と codex レビューで**既存の不具合が 4 件**見つかった（すべて実機実測）:

| # | 内容 | 節 |
|---|---|---|
| 1 | **`ORDER BY` の複合規則が全順序でない**（`2 < 10 < 1a < 2` の循環・同じ 3 値が入力順で違う結果） | §4.3 |
| 2 | **`ORDER BY` がソート主体を変える**（`LIMIT 500` と `LIMIT 501` で並びが違う） | §4.4 |
| 3 | **`MIN`/`MAX`・`GREATEST`・`ORDER BY` がいずれも kintone の並び順と食い違う**（通常テキストの `"10"`/`"9"` を含む） | §4.2 |
| 4 | **`LIKE '_'` だけ文字の単位が違う** | §3.5 |

**R4 の決定**（§4.5）: 文字列の既定順はコードポイント順とする。ただし、これは「常に kintone が最優先」だからではない。**型で意味を固定し、実行面・実行モードによらず同じ結果を返すため**である。選択肢順・数値順は別の型規則として扱う。

**運用ルール:**

- **本書に書いた事実を、個別文書へコピーしない。** 参照する（例: 「文字数の定義は [文字列の扱い](ksql_string_semantics.md) §2 を参照」）
- 実装や実測で本書の内容が覆ったら、**まず本書を直す**。個別文書はそれに従う
- **利用者向けの記述は `docs/ksql_language_reference.md` に置く**。本書は仕様・実装の根拠を持つ

---

## 1. 基本原則（R4）

### 原則 1: データ保全を最優先する

文字を分割する、値を黙って削除する、比較器の循環で結果を入力順依存にする、といった**不可逆または説明不能な成功を作らない**。安全に意味を確定できなければ、明示的に失敗させる。

### 原則 2: 同じ型・同じ値・同じ SQL は、実行面と実行モードによらず同じ意味を持つ

CLI / MCP / プラグインは同じ `src/core` を使う。SIMPLE / FULL_SCAN、`LIMIT`、Node / ブラウザの違いは、結果を変える理由にならない。押し下げ先の kintone とローカル評価が同じ操作を分担する場合も一致させる。

**kintone との一致は独立した最上位原則ではない。** 次の場合に要求する。

- kintone フィールドの制約・型・選択肢順を再現する操作
- SIMPLE では kintone、FULL_SCAN ではローカルが同じ意味を実行する操作
- kintone 側の結果を変更できず、一致させないと実行モード差になる操作

一方、kintone に存在しない `GREATEST` や `TRANSLATE` の意味まで、根拠なく kintone から導かない。

### 原則 3: 値を見る前に型と操作の契約を決める

`"10"` が数値か文字列かを、比較する相手や同じ列に偶然入った値で変えてはならない。物理フィールド型、式の戻り型、temp/CTE へ伝播した型メタで決める。**型不明は文字列へ倒す**。ペア単位または取得集合単位の自動判定を `ORDER BY` / `WHERE` の既定にしない。

`GREATEST` / `LEAST` は既存の「引数集合を値として比較する関数」であり、この例外を関数契約として明記する（§4.5.3）。

### 原則 4: 単位は操作の契約で明示し、暗黙の「1 文字」を作らない

| 操作 | 契約上の単位 | 守る制約 |
|---|---|---|
| kintone の保存容量・`LENGTH` | UTF-16 コードユニット | `maxLength` と同じ予算 |
| `LENGTH_CHAR`・`TRANSLATE` | Unicode コードポイント | 符号位置単位の計数・1 対 1 写像 |
| 文字列の既定比較 | コードポイント列の辞書式順序 | ホスト非依存・kintone の観測結果と一致 |
| `LEFT` 等 | コードユニット区間を、ペアを割らない側へ縮める | 指定予算以下・新しい孤立サロゲートを作らない |
| 書記素 | 未提供 | Unicode データ版を固定できるまで導入しない |

この非対称は現状追認ではない。`LEFT(x, 64)` は「64 個の人間文字」ではなく、**64 コードユニットの保存予算に収まる最大の安全な部分列**と定義する。人向けの切り出し需要が生じた場合は、別名のコードポイント版または書記素版を追加し、既存関数の単位を再解釈しない。

### 原則 5: 正規化・大文字小文字・空文字を暗黙に同一視しない

- Unicode 正規化は行わない。NFC / NFD、異体字セレクタ、結合文字を入力どおり保持する
- 大文字小文字・全角半角・ひらがな/カタカナを暗黙に畳み込まない
- `=` は型に従う。文字列ではコードユニット列の完全一致であり、正規化等価を意味しない
- kintone の未設定値は空文字で表す。ただし「空文字を数値 0 とみなす」のではなく、数値型の範囲比較に限る既存の最小値規則を明示する（§5.2）

辞書順や大文字小文字を無視した検索が必要なら、将来 `COLLATE` / 正規化関数として**明示的に選ぶ機能**にする。ホスト既定の `localeCompare` を言語仕様にしない。

### 原則 6: 事実・決定・未検証を分離する

「実測」は、通した経路、入力軸、期待した反例を記録して初めて根拠になる。本書では次を区別する。

- **コード確定**: 実装経路から確定できる
- **実測済み**: raw API / 実行結果と経路を確認した
- **設計決定**: kSQL が採る契約。kintone の事実とは別
- **未検証**: 実機確認が終わるまで一般化しない

---

## 2. 文字数の定義

### 2.1 kintone は UTF-16 コードユニットで数え、それを「文字」と呼ぶ（実機実測・確定）

Tier-0 検証（B12-A）は `validateOnly` / `onErrorSkip` のときだけ動く（`execute.ts:456` / `:462`）。**素の `INSERT` は検証を通さず kintone へ直接届く**ため、kintone 本体の計数方式を直接問える。

`APP4221` の `文字列MAX`（`maxLength` = 10）へ **素の INSERT**:

```
INSERT INTO APP4221 (…, 文字列MAX) VALUES (…, '😀😀😀😀😀😀')
→ kintone API 400 CB_VA01
   {"records[0].文字列MAX.value":{"messages":["11文字より短くなければなりません。"]}}
```

`😀`×6 は **コードポイントなら 6**（11 未満で通るはず）／**UTF-16 なら 12**（弾かれる）。**弾かれた。**

> **kintone 本体は UTF-16 コードユニットで数え、それを「文字」と呼ぶ。**

**したがって:**

- **`LENGTH` は UTF-16 でなければならない。** これが「フィールドに収まるか」を判定する唯一の手段
- **B12-A の Tier-0 検証が UTF-16 で数えるのは正しい**（kintone と一致）
- `LENGTH('😀')` = `2` は**バグではない**

### 2.2 3 つの単位

| 単位 | 意味 | JS | `'😀'` | `'👨‍👩‍👧‍👦'` |
|---|---|---|---|---|
| **コードユニット** | UTF-16 の 16bit 単位 | `s.length` | **2** | 11 |
| **コードポイント** | Unicode の符号位置 | `[...s].length` | 1 | 7 |
| **書記素クラスター** | 人が見る 1 文字 | `Intl.Segmenter` | 1 | 1 |

### 2.3 kSQL の関数と単位

| 関数 | 単位 | 状態 |
|---|---|---|
| **`LENGTH`** | **コードユニット**（= kintone の「文字数」） | 出荷済み・**変更しない** |
| **`LENGTH_CHAR`** | コードポイント | [B23](ksql_length_char_spec.md)・未実装 |
| `LENGTH_GRAPHEME` | 書記素 | 将来候補（ホスト依存・§7 制限2） |
| **`LEFT` / `RIGHT` / `SUBSTRING` / `LPAD` / `RPAD`** | **コードユニット** | 出荷済み・**ペアを割る欠陥あり**（[B22](ksql_surrogate_pair_split_issue.md)） |
| **`TRANSLATE`** | コードポイント（写像） | [B24](ksql_translate_spec.md)・未実装 |
| **`LIKE '_'`** | **コードポイント**（`u` フラグ） | 出荷済み・**§3.5 の不整合** |

### 2.4 「正しい文字数」は用途で変わる（実測）

| 値 | 人 | `LENGTH` | `LENGTH_CHAR` | 書記素 |
|---|---|---|---|---|
| `日本語` | 3 | 3 ✓ | 3 ✓ | 3 ✓ |
| **`𠮟`**（2010 年の常用漢字） | 1 | **2 ✗** | **1 ✓** | 1 ✓ |
| `𠮷野家` | 3 | 4 ✗ | 3 ✓ | 3 ✓ |
| `髙橋`（はしごだか・BMP） | 2 | 2 ✓ | 2 ✓ | 2 ✓ |
| **`葛󠄀城`**（IVS 人名） | 2 | 4 ✗ | **3 ✗** | 2 ✓ |
| `が`（NFD） | 1 | 2 ✗ | 2 ✗ | 1 ✓ |
| `😀` | 1 | 2 ✗ | 1 ✓ | 1 ✓ |
| `👨‍👩‍👧‍👦` | 1 | 11 ✗ | 7 ✗ | 1 ✓ |
| **正解数** | — | **2/10** | **7/10** | **10/10** |

**「提出先が何で数えるか」も効く:**

| 相手 | 単位 | 対応 |
|---|---|---|
| **Web フォームの JS**（`.length`）・Java | コードユニット | **`LENGTH`** |
| **Python `len()` / Go `RuneCountInString`** | コードポイント | **`LENGTH_CHAR`** |
| Swift `String.count` | 書記素 | （将来） |

**どちらが正しいかは用途で決まる。だから複数要る。`LENGTH` を置き換えるのではなく足す。**

---

## 3. サロゲートペア

### 3.1 日本語の実データに出る

サロゲートペア（BMP 外・2 コードユニット）は絵文字だけの話ではない:

| 文字 | 符号位置 | 備考 |
|---|---|---|
| **`𠮟`** | U+20B9F | **2010 年に常用漢字表へ追加された「しかる」の正字** |
| `𠮷` | U+20BB7 | つちよし（人名） |
| `𩸽` | U+29E3D | ほっけ |

**`髙`（はしごだか）は BMP** なので問題にならない。**サロゲートかどうかは見た目で分からない。**

### 3.2 切り出しはコードユニット予算内の最大安全部分列（[B22](ksql_surrogate_pair_split_issue.md)）

既存 `LEFT` / `RIGHT` / `SUBSTRING` の長さ引数をコードポイント数へ再解釈してはならない。`LEFT(x, 64)` が最大 128 コードユニットを返し、`maxLength = 64` の保存予算を越え得るためである。人向けのコードポイント切り出しは、必要なら別名の関数として設計する。

> **規則: 結果は常に「n コードユニット以下」かつ「入力中で対になっていたペアを割らない」。**

**判定は「上位かつ下位」の両方を見る:**

```ts
const splitsPair = (x, i) =>
  i > 0 && i < x.length && isHigh(x.charCodeAt(i - 1)) && isLow(x.charCodeAt(i));
```

**片方だけ見ると、入力に既に孤立サロゲートがある場合（本欠陥で壊れた値が保存されている可能性がある）に不必要に短くする。**

### 3.3 写像・数えはコードポイント（[B23](ksql_length_char_spec.md) / [B24](ksql_translate_spec.md)）

```ts
LENGTH_CHAR(x)          = [...x].length
TRANSLATE(x, from, to)  = [...from] / [...to] で整列し [...x] を写像
```

**`TRANSLATE` でコードポイント整列を怠ると、実データ 40 字のうち 25 字が誤変換される**（B24 §2）。

### 3.4 検出

```
LENGTH(x) - LENGTH_CHAR(x) = サロゲートペアの個数（B23 §4）
```

**バイト数（`LENGTHB`）では判定できない。** UTF-8 は「2 バイト / 1 ユニット」の文字（U+0080–U+07FF）を持ち、サロゲートペア（4 バイト / 2 ユニット）とバイト比が同じ 2.0 になるため、`'😀'` と `'éé'` が完全に同値になる（B23 §4.1）。

### 3.5 既知の不整合: `LIKE '_'` だけ単位が違う

```
'😀' LIKE '_'   → 一致    ← matchLike（evalWhere.ts:370）が "u" フラグ＝コードポイント
'ab'  LIKE '_'  → 不一致  （対照・正常）
LENGTH('😀')    = 2       ← コードユニット
```

**`LIKE '_'` はコードポイント、`LENGTH` はコードユニット。** `LIKE` の意味論変更は v2.0.0 級の影響があるため**当面変更しない**。`_` を単独で使う実需は薄い。**本書に記録して、各文書で言い直さない。**

---

## 4. 文字列の比較・並び順

**本節は「現状の事実」「R4 の設計決定」「実機確認待ち」を分けて書く。** 比較規則は §4.5、未確定の実測ゲートは §4.6 / §9 に置く。

### 4.1 kintone REST API は、検証済み集合ではコードポイント順（実機実測）

`order by <テキストフィールド> asc` を kintone へ押し下げたときの並び:

```
データ: '' '亜'(U+4E9C) 'ｱ'(U+FF71) '😀'(U+1F600) '𠮟'(U+20B9F)
        （挿入順はバラバラにして $id 順との混同を排除）

kintone が返す順: '', 亜, ｱ, 😀, 𠮟
符号位置:              0x4E9C < 0xFF71 < 0x1F600 < 0x20B9F
```

**テキスト型に数値が入っていても文字列として並べる**（実機実測）:

```
データ: '9' '10' '1a'（SINGLE_LINE_TEXT）
kintone が返す順: 10, 1a, 9      ← 文字列順（'1'(0x31) < '9'(0x39)）
```

> **kintone の `SINGLE_LINE_TEXT` は、有効な Unicode 文字列を Unicode コードポイントの昇順で並べる。**
>
> **公式契約**（[数値が意図した順番に並ばない](https://jp.kintone.help/k/ja/trouble_shooting/app_trouble/order_numbers_text_field)）: 「文字列（1行）」の値は **UTF-8 の文字コード順**。[Unicode Standard の Binary Sorting](https://www.unicode.org/versions/Unicode17.0.0/core-spec/chapter-2/) により、**有効な UTF-8 文字列のバイト順 = コードポイント順**。実測 625 組でも不一致 0。
> **日本語の「辞書順」ではない**（`'B'` < `'a'`。ひらがな・カタカナ・半角カナは等価にならない）。
> **検証したテキスト値を数値とは解釈しなかった。**

この 2 集合は、ICU 照合・UTF-16 コードユニット順・値ベース数値判定を反証できる。一方、**コードポイント順という一般則を証明するには不足する**。

#### 共通接頭辞・NFC/NFD・IVS も一致（実測・R4 レビューで追加。§9 の実機項目 1 を解消）

```
データ: 'abc' 'ab' 'abd' 'が'(U+304C) 'か゛'(U+304B U+309B) '葛󠄀'(U+845B U+E0100) '葛'(U+845B)
        （挿入順はバラバラにして $id 順との混同を排除・LIMIT 500 の単発 GET で kintone に並べさせた）

kintone が返す順: ab, abc, abd, か゛, が, 葛, 葛󠄀
```

- **共通接頭辞は短い方が先**（`ab` < `abc`）
- **正規化しない**（`か` + 濁点 = U+304B… が `が` = U+304C より先）
- **異体字セレクタも共通接頭辞扱い**（`葛` < `葛` + VS17）

**コードポイント比較器がこの順を完全再現することを確認済み**（`[...str]` のイテレータ比較）。

**原則 5（正規化・大文字小文字を暗黙に同一視しない）は kintone の実挙動と一致する**＝kSQL の勝手な決定ではない。

**残る未検証**: 複数の補助平面文字どうしの組（`𠮟` vs `𩸽` 等）・結合文字の連続。§9 の実測ゲートに残す。

#### コードユニット順ではない（重要）

**「バイナリ順」には 2 種類あり、サロゲートペアで分かれる。**

```
'𠮟'(U+20B9F = 0xD842 0xDF9F) vs 'ｱ'(U+FF71)
  UTF-16 コードユニット順: 0xD842 < 0xFF71 → 𠮟 < ｱ
  コードポイント順:        0x20B9F > 0xFF71 → 𠮟 > ｱ   ← kintone はこちら
```

**JS の `a < b` は UTF-16 コードユニット順**であり、**kintone と一致しない**。差が出るのは**サロゲートペアが絡む組だけ**（BMP どうしでは両者は完全に一致する）。

#### kintone に一致する比較器（**文字列どうしの比較に限る**）

```ts
function compareCodePoints(a: string, b: string): number {
  const ai = a[Symbol.iterator](), bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next(), y = bi.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0)!, cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}
```

**この比較器単体は全順序**（13 値・2,197 組の推移律・169 組の反対称性・同値の一意性を検証済み）。

> **ただし「比較器が全順序」と「`ORDER BY` 全体が全順序」は別物である**（§4.3）。**この比較器に差し替えるだけでは `ORDER BY` は直らない。**

### 4.2 kSQL 側の現状（**3 系統すべてが kintone と食い違う**）

| 用途 | 比較 | 実装 | kintone との一致 |
|---|---|---|---|
| **`ORDER BY`（JS 経路）** | 型不明なら**値ベースで数値/文字列を毎回判定**、文字列側は **ICU `localeCompare(_, "ja")`** | `process.ts:594-604` / `execute.ts:4117` | **BMP でも不一致** |
| `MIN` / `MAX` | コードユニット順（`>` / `<`） | `process.ts:344` / `:350` | **BMP のみ一致・サロゲートで不一致** |
| `GREATEST` / `LEAST` | 集合モード判定＋コードユニット順 | `core/scalarCompare.ts`（B19） | **BMP のみ一致・サロゲートで不一致** |
| `WHERE` の `<` / `>` | ペア単位モード判定＋コードユニット順 | `core/scalarCompare.ts` | **BMP のみ一致・サロゲートで不一致** |

**実機実測（サロゲート）:**

```
データ: '' 亜 ｱ 😀 𠮟
MAX(文字列)               = 'ｱ'    （コードユニット順）
kintone の最後            = '𠮟'   （コードポイント順）        ★食い違う
GREATEST('𠮟','ｱ')       = 'ｱ'                                ★食い違う
```

**実機実測（ICU・BMP でも食い違う）:**

```
データ: 'a' 'B' 'あ' 'ア' 'ｱ' '亜'
kintone → B, a, あ, ア, 亜, ｱ
JS(ICU) → a, B, ｱ, ア, あ, 亜
```

ICU は `'a' < 'B'` とし、`'あ'`/`'ア'`/`'ｱ'` を**等しい**と判定する（順序が比較器で決まらない）。

#### 4.2.1 型メタは**通常テキストに付かない**（実機実測・R3 で追加）

`detectSortKind`（`core/formFieldInfo.ts:92`）は **NUMBER / RECORD_NUMBER / CALC だけ**を分類し、**通常の `SINGLE_LINE_TEXT` には `undefined` を返す**。

そのため JS 経路では通常テキストも `compareSortKeys`（`process.ts:594`）の**値ベース自動判定**へ落ちる:

```
データ: '9' '10' '1a'（SINGLE_LINE_TEXT）

SIMPLE   (kintone) → 10, 1a, 9    ← 文字列順
FULL_SCAN (JS)     → 9, 10, 1a    ← 数値と自動判定している   ★食い違う
```

**`LIKE` を 1 つ足すだけで並びが変わる。**

**NUMBER 型は一致する**（実測: SIMPLE / FULL_SCAN とも `1, 9, 10`）。

`WHERE` も同様に型メタを使っていない。`evalWhere.ts:101` で `fieldType` を取得しているが、範囲比較は `evalWhere.ts:146` で**型なしの `compareScalarValues`** を呼ぶ。

### 4.3 `ORDER BY` の複合規則は**全順序でない**（**バグ**・実機実測・R3 で追加）

`compareSortKeys`（`process.ts:603`）:

```ts
return a.isNum && b.isNum ? a.n - b.n : a.s.localeCompare(b.s, "ja");
```

**これはペア単位のモード判定であり、B19 で `GREATEST` について確定させた「畳み込みには全順序が要る」の反例そのものである。**

```
'2'  < '10'   （両辺数値 → 数値比較）
'10' < '1a'   （'1a' が非数値 → 文字列比較）
'1a' < '2'    （文字列比較）
→ 2 < 10 < 1a < 2 の循環
```

**推移律違反 12 / 1728 組。実機で同じ 3 値・同じ `ORDER BY s ASC` が入力順で違う結果を返す:**

```
入力 2,10,1a  → 2, 10, 1a
入力 1a,2,10  → 1a, 2, 10
```

> **文字列比較をコードポイント順へ替えるだけでは直らない。** モード判定の構造そのものを変える必要がある（§4.5）。

**B19 §3.1 で `GREATEST` について 4 回改稿して確定させた「集合単位でモードを 1 回だけ決める」が、`ORDER BY` には適用されていない。**

### 4.4 `ORDER BY` はソート主体が変わる（**バグ**・実機実測）

`executeSimpleSelect`（`execute.ts:1288` / `:1328`）:

```ts
const useSingleGet = stmt.limit !== null && stmt.limit <= 500;
…
if (!useSingleGet) {                       // ← 単発 GET のときは JS で並べ直さない
  rows = applyOrderBy(rows, stmt.orderBy, optionOrders, sortKinds);
  rows = applyLimit(rows, stmt.limit, stmt.offset);
}
```

```
ORDER BY 文字列 ASC LIMIT 1     → 'B'                    （kintone）
ORDER BY 文字列 ASC LIMIT 500   → B, a, あ, ア, 亜, ｱ    （kintone）
ORDER BY 文字列 ASC             → a, B, ｱ, ア, あ, 亜    （JS の ICU）
```

> **`LIMIT 500` と `LIMIT 501` で並び順が変わる。`LIMIT` を外しても変わる。**

**v1.14.0 / v2.0.0 が major version を切ってまで潰した「LIKE のモード不一致」とまったく同じ構造。**

#### 影響範囲の限定（R3 で訂正）

**「`LIMIT` ≤ 500 なら kintone の順」は誤り。** kintone の順序をそのまま使うのは **`executeSimpleSelect` が `useSingleGet` になった場合だけ**である。

> **SIMPLE SELECT で `ORDER BY` が kintone へ押し下げられ、かつ単発 GET を使うクエリだけが kintone の順。**

**FULL_SCAN・JOIN・集約・関数 `ORDER BY`・ウィンドウ・temp/CTE は `LIMIT` ≤ 500 でも JS ソート**（`process.ts:1072`）。**したがって JS 経路の方が広い。**

### 4.5 B26 の比較規則（R4 決定）

#### 4.5.1 文字列の既定順

文字列は、正規化・大小文字変換をせず、**コードポイント列を先頭から辞書式比較**する。日本語辞書順ではない。

この決定の根拠は次の順である。

1. SIMPLE と FULL_SCAN を一致させる必要がある
2. コードポイント比較は ECMAScript の文字列イテレータだけで実装でき、Node / ブラウザの ICU データに依存しない
3. 検証済みの kintone 結果と一致する
4. 現行 ICU 照合は意図的な言語設計ではなく、同値を返す異表記もあり全順序の根拠にならない

「日本語として自然な辞書順」は捨てるのではなく、既定順から分離する。必要なら将来、照合データと版を固定した明示的 `COLLATE` として追加する。

#### 4.5.2 型の表

| 対象 | 意味の決定元 | 比較規則 | 備考 |
|---|---|---|---|
| 物理テキスト（SINGLE/MULTI_LINE_TEXT、RICH_TEXT、LINK、文字列 CALC 等） | フィールド定義 | コードポイント順 | 数値らしい値も文字列。`"10" < "9"`。REST が ORDER BY 非対応の型もローカルでは同じ文字列型 |
| 物理数値（NUMBER、RECORD_NUMBER、数値 CALC） | フィールド定義 | 数値順 | REST と完全一致を名乗るには B9 の厳密10進比較が必要 |
| 日付・時刻 | フィールド定義 | 正規化された保存形式のコードポイント順 | kintone の形式が時系列順と一致することが前提 |
| 文字列関数、文字列リテラル、`GROUP_CONCAT` | 式の戻り型 | コードポイント順 | 値による数値推測をしない |
| 算術、`LENGTH`、数値集約、ウィンドウ関数 | 式の戻り型 | 数値順 | temp/CTE に型を伝播する |
| CASE / UNION | 全分岐・全入力の型推論 | 同一型ならその型。混在・不明なら文字列 | 実データ集合を見てモードを変えない |
| temp/CTE の素通し列 | 元列メタ | 元の型を維持 | option metadata も将来含める |
| 真に型不明 | 規定値 | **文字列** | 安定した fail-safe。自動数値判定を廃止 |
| DROP_DOWN / RADIO / STATUS | option/process metadata | 定義順 rank、同 rank はコードポイント順 | 不明値を含む tie-break を決定可能にする |
| MULTI_SELECT / CHECK_BOX | option metadata | **kSQL 独自契約**（§4.6.2） | **release gate 解消**（実測）。**kintone はソート自体を拒否する**（`GAIA_IS02`）ため合わせる相手がない。決定性・strict weak order・4 面同一だけ満たせばよい |
| USER_SELECT / ORGANIZATION_SELECT / GROUP_SELECT / STATUS_ASSIGNEE / CATEGORY / FILE / SUBTABLE / REFERENCE_TABLE | 複合値 | **未決。既定で ORDER BY を拒否** | 配列・オブジェクトの JSON 表現を暗黙の順序にしない。必要な型だけ別途 canonical key を定義する |

通常テキストへ `sortKind="string"` を付与し、式の戻り型と temp/CTE のメタ伝播を拡張する。**データ集合が全て数値に見えるか**でモードを選ぶ案は却下する。行の追加、LIMIT、事前絞り込みで列全体の意味が変わるためである。

#### 4.5.3 `GREATEST` / `LEAST`

この関数は物理列の型ではなく、引数値の集合を比較する既存契約を持つ。互換性を保って次とする。

1. 空文字は常に最小
2. 空文字を除く全引数が `Number` で NaN にならなければ数値モード、それ以外は文字列モード
3. モードは引数集合について 1 回だけ決める
4. 数値が同値なら、元文字列のコードポイント順を二次キーにする
5. 文字列モードはコードポイント順

これにより引数順に依存せず、異なる元文字列にも一意の勝者がある。kintone に対応する関数はないため、物理フィールドの型規則を無理に適用しない。

#### 4.5.4 `WHERE` / `HAVING` / `CASE WHEN` / `ASSERT`

| 左辺 | `=` / `!=` | `<` / `>` / `<=` / `>=` |
|---|---|---|
| typed string | 完全文字列一致 | コードポイント順 |
| typed number | 数値型の等価 | 数値順。空セル規則と厳密10進は B9 と統合して定義 |
| typed option | option value の一致 | kintone が許す演算だけ。順序は option 規則 |
| 型不明 | 完全文字列一致 | コードポイント順 |

右辺の見た目で左辺型を上書きしない。比較不能な型の組合せを黙って数値化せず、パース時または実行時に `ArgumentError` とする。

#### 4.5.5 ソート比較器に必要なのは全順序ではなく strict weak order

`Array.sort` / ランク関数に必要なのは、同値クラスを許す **strict weak order** である。`GREATEST` / `LEAST` が異なる元文字列から一意の勝者を返すには全順序が必要である。この二つを混同しない。

各ソートキーは、型ごとに次のキーへ写像する。

```
string: (type=string, codePointSequence)
number: (type=number, numericValue)
option: (type=option, canonicalOptionVector)
```

同一 ORDER BY 式の全行で `type` は固定する。文字列・option の各成分が全順序なら辞書式積も全順序になる。数値は数値的に同値なら 0 を返すため全順序ではなく total preorder だが、同値関係は推移的なので strict weak order を満たす。これにより `RANK` は `1` / `01` のような数値同値を同順位にできる。複数 ORDER BY キーも辞書式積で同じ性質を保ち、DESC は符号を反転するだけなので性質を保つ。

数値の比較 primitive は `a.n - b.n` ではなく、`<` / `>` による三方比較で `-1 / 0 / 1` のいずれかを返す。`Infinity - Infinity` は `NaN` になるが、**現行 ECMA-262 の `CompareArrayElements` は comparefn の結果が `NaN` なら `+0` として扱う**。したがって「ECMAScript の未定義動作」「V8 が偶然 0 扱い」は誤りであり、6 組で差が出なかった結果とも整合する。

それでも三方比較へ変える理由は、比較 primitive 自体の契約を有限の符号値に固定し、`Array.sort` 以外の消費先を Sort 固有の `NaN → +0` 正規化へ依存させないためである。**現に壊れている誤結果の修正ではなく衛生**であり、受入条件は「primitive が常に `-1 / 0 / 1` を返す」とする。入力値としての `NaN` は文字列比較へ落とさず `ArgumentError` とする。物理数値の空セルは既存契約どおり最小値クラスとして先に処理する。GREATEST/LEAST だけは一意の元文字列を返す必要があるため、§4.5.3 のコードポイント二次キーを使う。kintone NUMBER との10進精度一致は B9 の課題である。

#### 4.5.6 証明と検証方法

形式的確認に加え、比較 primitive と複合 ORDER BY の両方で性質テストを行う。

- 文字列値: 空、ASCII大小、BMP、補助平面、共通接頭辞、NFC/NFD、孤立サロゲート
- 数値値: 負数、0/-0、整数、小数、同値異表記、±Infinity。NaN は必ずエラー
- option: 単一値、同 rank、未知値、複数値、保存配列順の入替え
- 全組で反対称性、全3組で推移律、`cmp(a,a)=0`
- 同値関係 `cmp(a,b)=0` の推移律
- 複数キー、ASC/DESC、全入力順列で結果の同値クラスが不変
- `GREATEST` / `LEAST` は引数の全順列で同じ元文字列を返す

コードポイント比較と、非 NaN の数値比較についてはこの構造で性質を満たす。B26 の受入判定は固定サンプル数本ではなく、上記の直積を property test で通す。

#### 4.5.7 SemVer と課題境界

**major**。通常テキストの数値らしい値、ICU 日本語順、サロゲートを含む MIN/MAX/GREATEST/WHERE、型不明列の順序が変わる。

#### 利用者から見た変化（Claude 実測・リリースノート用）

```
["100","99"]     現状 → 99, 100      R4 → 100, 99     ← テキスト型の採番で最も影響が大きい
["9","10"]       現状 → 9, 10        R4 → 10, 9
["2","10","1a"]  現状 → 2, 10, 1a    R4 → 10, 1a, 2
["a","B"]        現状 → a, B         R4 → B, a
```

**`["100","99"] → 100, 99` を最初に書く。** テキスト型に採番を入れている運用は多く、**「数値順に見えていたものが文字列順になる」が最も驚かれる**。**現状の並びが偶然の産物である**こと（値ベース自動判定・§4.3 の循環）と、**その並びは `LIMIT` や `LIKE` の有無で既に変わっていた**ことを併記する。

数値順が要る列は **NUMBER 型にする**か、**式で数値化する**のが正しい対処であることを案内する。

B26 は比較ディスパッチ、文字列順、型メタ伝播、複合比較器の性質を扱う。**B9（厳密10進比較）は同時実装せず、独立した follow-up とする。** B9 は数値の等価・範囲・集約まで試験面を広げ、B26 の文字列変更と同梱すると回帰範囲が過大になる。B26 の完了時点でも「typed number は大精度で REST と不一致」という制限6を残し、全比較が一致したとは表現しない。

**影響箇所**: `process.ts:594-604` / `execute.ts:4117` / `process.ts:344,350` / `core/scalarCompare.ts`、および `compareScalarValues` の消費先である HAVING / CASE WHEN / サブテーブル DML / ASSERT（`execute.ts:1071`）。WINDOW は `compareSortKeys` を共有する。型メタ生成・伝播（`formFieldInfo.ts` / `execute.ts`）も変更対象である。

**対象外**: UI の一覧表示用 `localeCompare`、MCP 保存クエリ名の表示順、DISTINCT のキー名 `.sort()` は kSQL の値意味論ではない。

### 4.6 選択系の並び順（**release gate は R4 レビューで解消・実機実測**）

#### 4.6.1 `optionOrders` の rank 一致は値の一致を意味しない（R3 で追加・コード確定）

`compareSortKeys`（`process.ts:595-598`）は `orderMap` があるとき rank を第一キーにし、**rank 一致で `localeCompare` へ落ちる**。

**DROP_DOWN なら通常は同 rank ＝ 同値だが、MULTI_SELECT / CHECK_BOX は「最小 option index」を rank にしている**ため、`["Y"]` と `["Y","Z"]` が**同 rank になる**（既存テストにも同 rank になり得る値がある: `process.test.ts:690`）。**このフォールバックは無意味ではなく、変更対象である。**

#### 4.6.2 **kintone は MULTI_SELECT / CHECK_BOX のソートを拒否する**（実測・release gate 解消）

R4 は「kintone が複数選択値を同 rank のときどう並べるかは未実測・release gate」としていたが、**実機で確認したところ kintone はそもそもソートさせない**:

```
SELECT $id, 複数選択 FROM APP4221 ORDER BY 複数選択 ASC LIMIT 500
→ kintone API 400
   GAIA_IS02: 「複数選択」フィールドはソート条件に使用できません。

SELECT $id, チェックボックス FROM APP4221 ORDER BY チェックボックス ASC LIMIT 5
→ kintone API 400
   GAIA_IS02: 「チェックボックス」フィールドはソート条件に使用できません。
```

> **合わせるべき kintone の挙動が存在しない。**

**したがって原則 2 がそのまま適用される**（「kintone に存在しない意味を、根拠なく kintone から導かない」）。**MULTI_SELECT / CHECK_BOX の並び順は kSQL 独自の契約として決めてよい。**

**release gate は解消。** 決定は次を満たせばよい:

- **決定的であること**（同じ入力で同じ結果・入力順に依存しない）
- **strict weak order であること**
- **4 面で同一であること**（JS のみで完結するため自動的に満たす）

**採用する kSQL 独自契約:** 複数選択値を「生の JSON 文字列」ではなく**選択肢の集合**として正規化し、option 定義順のベクトルを辞書式比較する。

1. 各選択値を、既知値なら `(0, option rank, label のコードポイント列)`、未知値なら `(1, 0, label のコードポイント列)` に写像する
2. 重複を除き、この要素キーで昇順に並べて canonical vector を作る。空選択は空 vector
3. vector を要素ごとに辞書式比較し、共通接頭辞なら短い vector を先にする
4. DESC は最終結果の符号だけを反転する

これにより `['Y','Z']` と `['Z','Y']` は同じ集合として等価になり、保存配列順や JSON serialization に意味を引きずられない。option rank とコードポイント順という既存の二つの規則だけで説明できる。各要素キーは全順序、有限 vector の辞書式比較も全順序なので、canonical な選択集合上で全順序（したがって strict weak order）になる。DROP_DOWN / RADIO は同じ要素キーを 1 個だけ使い、未知値は既知 option の後でコードポイント順とする。

#### 4.6.3 **kSQL は押し下げ不能なソートを kintone へ押し下げている**（**新規欠陥**・実測）

`resolveSelectMode`（`selectToKintone.ts:79`）は `stmt.orderBy.some((o) => o.key.type !== "FIELD_NAME")` でしか FULL_SCAN へ落とさないため、**kintone がソートできない型でも SIMPLE のまま押し下げる**:

```
EXPLAIN SELECT $id FROM APP4221 ORDER BY チェックボックス ASC LIMIT 5
→ ok。 kintone query: order by チェックボックス asc limit 5     ← 計画は出る

実行 → kintone API 400 GAIA_IS02
```

**EXPLAIN が `ok` を返し、実行すると必ず失敗する。** B20 §11 論点 4 と同型（`EXPLAIN UPDATE … WHERE LEFT(…)` が計画を表示するが実行は必ず `KintoneQueryError`）。

**正しい挙動は、押し下げ同値性を証明できない ORDER BY を FULL_SCAN へ落として JS で並べること**である。「kintone API がエラーにしない」だけでは不十分で、サーバの順序が §4.5–4.6 の kSQL 契約と一致することまで必要になる。

#### B27 の設計

- 意味型（string / number / option / complex）、ローカル ORDER BY 契約の有無、サーバが ORDER BY を受理するか、サーバ順とローカル順が同値かを分離する。サーバ受理は `supported / rejected / unknown`、押し下げ同値性は `equivalent / non_equivalent / unknown` とする。**ローカル契約あり + supported + equivalent だけを押し下げる**
- `equivalent` は公式契約、または raw REST の ASC/DESC、空値、同値・境界値を測って kSQL comparator と一致した型の allowlist とする。ローカル契約がある型でも `rejected / non_equivalent / unknown` は FULL_SCAN。新しいフィールド型を楽観的に SIMPLE にしない
- SIMPLE に押し下げるトップレベル `ORDER BY` は、利用者指定キーの末尾へ **`$id asc`** を補う（利用者が既に `$id` をキーに含める場合は重複させない）。FULL_SCAN の `$id asc` 取得順と安定ソートに合わせ、同値を含む `LIMIT` / `OFFSET` でも同じ行を返す
- 値比較器は利用者指定キーの同値関係だけを返す。**`$id` を比較器へ混ぜない。** 同じ比較器を使う `RANK` / `DENSE_RANK` の peer 判定と、トップレベル結果列の canonical tie-break を分離する
- ASC / DESC の同値性は「結果列全体が逆順」では判定しない。**非同値グループの順は反転し、同値グループ内の `$id asc` は方向にかかわらず不変**であることを確認する
- ローカル契約が未定義の複合型は FULL_SCAN にせず、planning 時に `ArgumentError`。配列・オブジェクトを `String(...)` / JSON にして暗黙に並べない
- `resolveSelectMode` の構文判定を第一段階、schema 取得後の能力判定を第二段階とする。最終 plan は schema-aware にし、**EXPLAIN と実行が同じ planner 結果を使う**
- FULL_SCAN では base query から ORDER BY を外し、全候補取得後にローカル sort、最後に LIMIT を適用する。取得上限・打切りは既存の明示的エラー/警告契約に従い、部分集合を top-N として黙って返さない
- schema を取得できない場合は SIMPLE を仮定せず明示的に失敗する。system field、CALC の format、SUBTABLE 内フィールドも field code だけで判定しない
- **`STATUS` の rank を実装する（R8.1 で追加・Blocking）。** kintone は `STATUS` を**プロセス定義順**で並べる（R8 で決定的に実測）。公式 API も各状態の **`index`** を返し **`index` 昇順が状態順**と規定している（[プロセス管理設定を取得する](https://cybozu.dev/ja/kintone/docs/rest-api/apps/settings/get-process-management-settings/)）。**しかし現行コードは `index` を捨てている**:
  - `nodeKintoneClient.ts:259` — 型に `index` を含めず `states: … map((state) => state.name)` で名前配列にする
  - `getOptionOrderMapByApp`（`execute.ts:2627`）— フォームの `optionOrder` しか見ない
  - `buildOptionOrdersForSelect`（`execute.ts:2707`）— `STATUS` rank が入らない

  → **FULL_SCAN の `STATUS` はプロセス定義順にならない**＝原則 2 違反。**`states.*.index` を保持し、`STATUS` の `ORDER BY` が実在する場合だけ rank map へ統合する**（`optionOrders` と同じ経路）。取得は `STATUS` を並べ替えるクエリのときだけ（**v2.7.0 の STATUS 押し下げが `status.json` を条件付きで取る前例に倣う**）。**実装しない限り `STATUS` は `non_equivalent`。**

##### R8.2 実測: `status.json` の実レスポンス（Claude・2026-07-17・kintone MCP + 公式ドキュメント）

**dev 環境の実 API と公式ドキュメントの両方で確認した。実装を確定できる。**

**★ `index` は文字列である。数値としてパースすること。**

```
APP4221 (enable: true)   未処理 index:"0" / 処理中 "1" / 完了 "2" / 保留 "3"
公式: states.<ステータス名>.index | 文字列 | ステータスの順番。値は 0 から始まり、昇順で並べ替えられます。
```

型が**文字列**（`"0"` であって `0` ではない）と公式に明記されている。**辞書順のまま rank に使わない** — 状態数が 2 桁に届けば `"10" < "2"` で順序が壊れる。状態数の上限は未確認だが、文字列を辞書順で使う理由はどのみち無い。`Number(index)` で整数化し、`optionOrder`（フォーム側）と同じ数値 rank へ正規化する。

**★ R8 の実測順は `index` 昇順と完全に一致した。**

R8 で観測した `STATUS ASC: 未処理, 処理中, 完了, 保留` は、APP4221 の `index` 0 / 1 / 2 / 3 とそのまま一致する。**kintone 側の「プロセス定義順」＝ `index` 昇順**が、観測と API 定義という独立した 2 つの根拠で確定した（R8.1 で欠けていたのはローカル側であり、kintone 側ではない）。

**★ `enable: false` でも `states` は返る。`enable` を見ないと誤った rank を作る。**

```
APP4148 (enable: false)  未処理 "0" / 処理中 "1" / 追加確認中 "2" / 完了 "3"   ← states は非 null
```

プロセス管理が**無効**なアプリでも、過去の設定が `states` に残る。**`states` の非 null を有効性の判定に使わない。** 公式は「プロセス管理を**一度も設定していない**アプリの場合は `null`」と規定しており、**`null` と `enable: false` は別の状態**。両方を扱う。

**★ 追加の権限は要らない（v2.7.0 の前例が成立する裏付け）。**

必要なアクセス権は「アプリのレコード**閲覧**権限」または「レコード**追加**権限」。**レコードを読めるユーザーは常に `status.json` を読める**ため、条件付き取得を足しても新たな権限エラー経路は生まれない。

**課題境界:** B26 と B27 は型メタ基盤を共有し、同じ major リリースで完了させるのが妥当だが、欠陥と受入条件が異なるため統合しない。B26 は比較意味論、B27 は計画・押し下げ同値性を所有する。

## 5. 文字列リテラルと識別子

### 5.1 リテラルは SQL 標準の `''` エスケープのみ。バックスラッシュは素通し

`lexer.ts:104-125` の `readString` は `''` → `'` だけを処理し、**バックスラッシュをそのまま値へ入れる**。

```sql
SELECT LENGTH('\d+')   → 3     -- バックスラッシュが生き残る
```

**正規表現（[B20](ksql_regexp_function_spec.md)）と相性が良い** — MySQL のような二重エスケープ（`'\\d'`）が要らない。

### 5.2 空文字が NULL 相当

kSQL は SQL NULL を値として持たず、kintone の未設定スカラー値を ProcessRow では空文字へ正規化する。少なくとも検証したテキストフィールドでは **未設定 = 空文字**（B12-A）。

- `NULLIF(x, 0)` によるゼロ除算ガードは効かない（`Number('') = 0` → `NaN`）
- `GREATEST` / `LEAST` は**空文字を常に最小**として先に確定する（B19 §3.1）
- `WHERE` の数値範囲比較で左辺が空のとき、kintone は **−∞ 相当**として扱う（v2.2.0 で JS 評価を合わせた）

### 5.3 Unicode 正規化と大文字小文字

kSQL は入力値に NFC / NFD 正規化を行わず、`UPPER` / `LOWER` を明示しない限り大小文字も変換しない。

```
'é'           -- U+00E9
'e\u0301'     -- U+0065 U+0301
```

この 2 値は見た目が同じでも、`=`・DISTINCT・GROUP BY・既定 ORDER BY では異なる値である。raw REST の ORDER BY 実測では NFC/NFD と IVS 有無を区別し、入力のコードポイント列を保持した（§4.1）。ただし、この結果だけから kintone の全検索演算子へ一般化しない。正規化が必要なら将来 `NORMALIZE(value, form)` のような明示関数を検討する。

### 5.4 ASCII 識別子は小文字化される

```sql
SELECT 顧客No AS ABC, 顧客No AS PLAIN FROM APP4148
→ 出力列は 'abc', 'plain'
```

**日本語の識別子はそのまま。** 既存の一般挙動であり、B19 の `LEFT`/`RIGHT` 追加とは無関係（実測確認済み）。

---

## 6. 4 面の一貫性

### 6.1 実行構造（コード確定）

- プラグイン: `build.mjs` → `src/ui/desktop.ts` → `../core`。browser / ES2020
- CLI: `build-cli.mjs` → `src/cli/index.ts` → `../core`。Node 18 target
- MCP: `build-mcp.mjs` → `src/mcp/index.ts` / `tools.ts` → `../core`。Node 18 target

3 面は同じ parser / planner / evaluator を使う。差が生じるのは、kintone への押し下げ有無、ホスト組み込み API、各面固有の取得能力である。build target は構文変換の指定であり、実行時の ICU / Unicode / RegExp 実装を固定しない。

### 6.2 現状と R4 目標のマトリクス

`—` は REST API 自身に対応する関数がないことを表す。「一貫」は、同じ契約を実行する面どうしの判定である。

| 操作 | kintone REST API | CLI | MCP | プラグイン | 現状 | R4 目標 |
|---|---|---|---|---|---|---|
| 長さ検証（maxLength） | UTF-16 コードユニット（実測） | Tier-0 は `s.length`、素の DML はサーバ | 同左 | 同左 | 一貫 | 維持 |
| `LENGTH` | — | `s.length` | 同左 | 同左 | 3 面で一貫 | 維持 |
| `ORDER BY`（文字列） | 検証集合ではコードポイント順 | SIMPLE は REST、JS は ICU | 同左 | 同左だがブラウザ ICU | 不一致 | 全 JS 経路をコードポイント順 |
| `ORDER BY`（数値らしいテキスト） | 文字列順（実測） | JS は値ベース数値判定 | 同左 | 同左 | 不一致・非推移 | typed string としてコードポイント順 |
| `ORDER BY`（数値型） | 数値順 | JS Number + 型メタ | 同左 | 同左 | 通常値は一致、大精度は B9 | B26 では現状維持。大精度差を制限6へ残し B9 で解消 |
| `ORDER BY`（選択系） | 型により受理/拒否。MULTI_SELECT/CHECK_BOX は拒否 | 現状は field 名なら押し下げ | 同左 | 同左 | B27。実行時400または意味未確認 | `equivalent` 型だけ押し下げ、他は canonical option vector でローカル sort |
| `MIN` / `MAX` | — | typed string は UTF-16順 | 同左 | 同左 | 3 面は一致、REST順とは不一致 | 型表に従う。文字列はコードポイント |
| `GREATEST` / `LEAST` | — | 集合モード + UTF-16 tie | 同左 | 同左 | 3 面で一貫 | §4.5.3 |
| `WHERE` の `<`/`>` | 押し下げ可能時はサーバ | FULL_SCAN は型なしペア判定 | 同左 | 同左 | モード不一致 | 左辺型で固定。文字列はコードポイント |
| `WHERE` の `=` | サーバの型規則 | FULL_SCAN は文字列完全一致、IN は一部型付き | 同左 | 同左 | 型ごとに要再検証 | §4.5.4。正規化なし |
| `LIKE` | —（kSQL `LIKE` は押し下げない） | JS の contains / 生成 RegExp | 同左 | 同左 | 3面で共通コード | 維持。`KLIKE` との同値を要求しない |
| `KLIKE` | 常に kintone `like` | サーバ結果のみ | 同左 | 同左 | 同一サーバ。ただし機能制限差あり | `LIKE` と別契約を維持 |
| `LEFT` 等 | — | 現状はペア分割 | 同左 | 同左 | 3 面で同じ欠陥 | B22 の予算付き安全切り出し |
| `LENGTH_CHAR` / `TRANSLATE` | — | ES コードポイント列 | 同左 | 同左 | 未実装。仕様上はホスト非依存 | B23/B24 |
| 正規表現（B20） | — | Node RegExp | Node RegExp | Browser RegExp | 未実装・設計破綻 | §7 制限1。現案では出荷しない |

### 6.3 「同じコア」だけでは一貫性の証明にならない

同じソースでも、次の軸を直積で確認する。

- 面: CLI / MCP / プラグイン
- モード: SIMPLE / FULL_SCAN / JOIN / temp/CTE / WINDOW / REORDER
- データ: 空、ASCII、BMP、補助平面、NFC/NFD、共通接頭辞、数値らしい文字列、混在値
- 制御: LIMIT 500/501/なし、ASC/DESC、入力順の全順列
- 型: 物理 string / number / option、式由来、型伝播あり、型不明

Node の単体テストだけではブラウザホスト差を捕捉できない。文書だけを唯一の対策とはせず、プラグインのブラウザ smoke test を別途 CI 候補とする。ただし、対応している構文が Unicode データ版により異なる結果を返す問題は capability check だけでは検知できない。

---

## 7. 制限事項

### 制限 1: B20 の任意 ECMAScript 正規表現は安全かつ4面同一には提供できない

- 影響する面: CLI / MCP / プラグイン
- なぜ揃えられないか: JS `RegExp` は同期実行を中断・step制限できず、R-1/R-2 の構文規則には指数時間の反例がある。Node とブラウザで対応構文・Unicodeデータも異なる
- 利用者から見た現れ方: 同じパターンが一方で `SyntaxError`、他方で成功、または画面/プロセスを長時間停止させる
- 検知できるか: 未対応構文は `SyntaxError` を `ArgumentError` に包んで fail-closed にできる。ReDoS と、対応済み構文の意味差は確実に検知できない
- 回避策: **B20 は現方式では出荷しない**。再開条件は、Node/ブラウザ共通の非バックトラックエンジン（WASM等）を固定する、または正規表現ではない限定パターン言語を別機能として設計すること。CLI/MCP限定提供は4面一貫性を捨てるため既定案にしない

### 制限 2: 書記素単位の操作は提供しない

- 影響する面: CLI / MCP / プラグイン
- なぜ揃えられないか: `Intl.Segmenter` の有無と Unicode データ版がホスト依存。未対応だけでなく、対応済みでも境界が変わり得る
- 利用者から見た現れ方: IVS、結合文字、ZWJ絵文字を「見た目の1文字」として数えられない
- 検知できるか: API の不在は fail-closed にできるが、版差による結果差は検知困難
- 回避策: `LENGTH_CHAR` の限界を明記。将来は分割データを依存ライブラリとして固定してから別関数を追加

### 制限 3: `LIKE` と `KLIKE` は同じ演算ではない

- 影響する面: kintone / CLI / MCP / プラグイン
- なぜ揃えられないか: `KLIKE` は kintone の検索・トークン化へ委ねる。JS の contains / `%` / `_` と同じ意味にできない
- 利用者から見た現れ方: 英数字の語境界、日本語の最小文字数、記号で一致集合が異なる可能性がある
- 検知できるか: 一般には不可。クエリ単位の比較実測は可能
- 回避策: `LIKE` は kSQL パターン一致、`KLIKE` は kintone 検索として別名・別契約を維持する。§9 の結果をリファレンスへ掲載

### 制限 4: Shift_JIS のバイト数は `TextEncoder` では得られない

- 影響する面: CLI / MCP / プラグイン
- なぜ揃えられないか: Web標準の `TextEncoder` は UTF-8 固定で、`'shift_jis'` 引数を指定しても採用されない
- 利用者から見た現れ方: `LENGTHB` を Shift_JIS/CP932 の保存可否判定には使えない
- 検知できるか: encoding が常に `utf-8` なので検知可能
- 回避策: `TRANSLATE` で既知の非対応文字を写像する。完全なCP932判定が必要なら、版を固定したエンコーダを別依存として導入

### 制限 5: Unicode 正規化等価を同一視しない

- 影響する面: kintone / CLI / MCP / プラグイン
- なぜ揃えられないか: 暗黙正規化は入力情報を変え、既存値の等価性を変更する。kintone ORDER BY は NFC/NFD・IVS 有無を区別することを実測済みだが、全検索演算子へは一般化していない
- 利用者から見た現れ方: NFC `é` と NFD `e + ◌́` は別値として比較・集約される
- 検知できるか: コードポイント列を表示すれば可能だが、通常表示だけでは困難
- 回避策: 現状は入力側で正規化。将来、明示的 `NORMALIZE` を追加

### 制限 6: typed number の大精度比較は B9 完了まで REST と完全一致しない

- 影響する面: kintone / CLI / MCP / プラグイン
- なぜ揃えられないか: JS は IEEE-754 `Number`、kintone は10進値として比較する
- 利用者から見た現れ方: 16桁級整数・高精度小数の ORDER BY / WHERE / MIN/MAX が SIMPLE と FULL_SCAN でずれ得る
- 検知できるか: 型と桁数から警告は可能。現状は一般的な実行時検知なし
- 回避策: B9 を独立 follow-up として実装する。それまでは大精度値でローカル比較を避け、B26 のリリースノートで制限を明示する

### 制限 7: プラグイン固有の取得能力差

- 影響する面: プラグイン
- なぜ揃えられないか: 検索打ち切りヘッダーを取得できず（B7）、論理アプリにも対応しない。文字列意味論ではなく実行面の能力差
- 利用者から見た現れ方: 検索結果の完全性警告や対象アプリ解決が CLI/MCP と異なる
- 検知できるか: 一部不可
- 回避策: B7 と論理アプリ対応を別課題として維持し、本書の文字列一致達成条件へ混ぜない

### 制限 8: `CREATOR` / `MODIFIER` は現行 kSQL のローカル順を kintone と一致させない（R5 で追加・**公式契約に基づく**）

- 影響する面: kintone / CLI / MCP / プラグイン
- なぜ揃えないか: **公式は「ユーザーID（ユーザー追加時に自動採番される数値）の昇順・降順」と規定している**（[一覧やグラフのソートで作成者・更新者を指定したときの並び順](https://jp.kintone.help/k/ja/trouble_shooting/app_qa/list_graph_sort)）。レコード値は `{"code":…,"name":…}` で ID を含まない。別の [User API](https://cybozu.dev/ja/common/docs/user-api/users/get-users/) は `id` を返すため**原理的には再現可能**だが、現行のレコード取得だけでは完結せず、別 API 呼出し・ページング・キャッシュ・退職/削除ユーザーの扱いが必要になる。User API 自体の必要アクセス権は「なし」であり、「追加権限が必要」は誤り
- 利用者から見た現れ方: **kSQL の `ORDER BY 作成者` は kintone の一覧画面と違う順序になる**（kSQL は code 順、kintone はユーザーID 順＝アカウント作成順）
- 検知できるか: 不可（両者とも「正しく」並んでいるため）
- 回避策: **`CREATOR`/`MODIFIER` は押し下げず常にローカル評価**（code 順・v2.5.0 の既存契約）。**原則 2 には反しない** — 常に FULL_SCAN ならモード差は生じない。kintone の一覧画面と並びが違うことをリファレンスに明記する。将来、User API enrichment を明示オプションとして設計できる

---

## 8. 関連課題

| # | 内容 | 本書との関係 |
|---|---|---|
| [B22](ksql_surrogate_pair_split_issue.md) | 切り出しがサロゲートペアを分割する | §3.2 |
| [B23](ksql_length_char_spec.md) | `LENGTH_CHAR` | §2.3 / §3.3 / §3.4 |
| [B24](ksql_translate_spec.md) | `TRANSLATE` | §3.3 |
| [B21](ksql_update_set_string_func_issue.md) | `UPDATE SET` が文字列関数を受け付けない | §5（文字列関数の書き戻し経路） |
| [B20](ksql_regexp_function_spec.md) | 正規表現関数 | §5.1（リテラルのバックスラッシュ素通し）／ §7 制限 1（**現方式では出荷しない**） |
| [B13](ksql_string_min_max_aggregate_spec.md) | 文字列 `MIN`/`MAX` | §4（**「UTF-16 辞書順」と書いたが `ORDER BY` との差は未記載**） |
| [B12-A](ksql_validate_only_implementation_plan.md) | `VALIDATE ONLY` | §2.1（UTF-16 計数・空文字 = 未設定） |
| ~~B25~~ | `ORDER BY` と `MIN`/`MAX` の比較不整合 | **B26 へ統合**（同根） |
| **B26** | 型付き比較・文字列順・型メタ・ソート比較器を4面で統一（旧 B25 を統合） | **§4.5 で R4 規則を決定。B9 は同時実装しない** |
| **B27** | ORDER BY の押し下げ同値性 | §4.6.3。B26 と基盤・リリースを共有するが別課題 |
| **未起票** | `LIKE '_'` の単位不整合 | §3.5 |
| [B9](ksql_exact_decimal_compare_issue.md) | 最大30桁の厳密10進比較 | 独立 follow-up。完了までは typed number の大精度差を制限6として残す |
| [B29](ksql_number_precision_semantics_issue.md) | kintone数値精度・丸め設定との整合 | `decimalPlaces` / `roundingMode`による入力・算術結果の検証と量子化。B9の比較から分離 |
| [B28](ksql_dml_unary_sign_issue.md) | DML値の単項符号 | INSERT/UPSERT VALUESとUPDATE SETの受理非対称。一時テーブル対象DMLは非対応のまま |

---

## 9. 追加実測の release gate

### 9.0 進捗（Claude 実測・2026-07-17）

| ゲート | 状態 |
|---|---|
| §9.1 共通接頭辞（`ab`/`abc`/`abd`） | **解消**（§4.1） |
| §9.1 正規化・結合・IVS（`が`/`か゛`/`葛`/`葛󠄀`） | **解消**（§4.1）。**kintone は正規化しない** |
| §9.1 補助平面（`ｱ`/`😀`/`𠮟`） | **解消**（§4.1）。**コードポイント順であり UTF-16 コードユニット順ではない** |
| §9.1 ASCII case（`a`/`B`） | **解消**（§4.2）。`'B'` < `'a'` |
| §9.1 数値らしい text（`9`/`10`/`1a`） | **解消**（§4.2.1）。**kintone は数値と解釈しない** |
| §9.1 LIMIT 500/501/なしで主体が分かれる | **解消**（§4.4） |
| **§9.2 optionOrders（MULTI_SELECT / CHECK_BOX）** | **解消 — ただし想定と違う形で。** **kintone はソート自体を拒否する**（`GAIA_IS02`・§4.6.2）。合わせる相手が存在しない |
| **§9.2.1 サーバ ORDER BY の受理/拒否（B27・Blocking）** | **解消**。**29 型を測定し公式リストと 100% 一致**（§9.2.1）。受理 15 / 拒否 12 / LOOKUP は基底型。非自明: **`MULTI_LINE_TEXT` は拒否だが `LINK` は受理**・**`CREATOR`/`MODIFIER` は受理**・**`LOOKUP` は独立型でない** |
| **§9.2.1 R4 comparator との同値（B27・Blocking）** | **一部解消**。RECORD_NUMBERはアプリコードなしで実測一致したが`APPCODE-1`形式待ち。SINGLE_LINE_TEXTは値順が公式契約と一致するが空値/DESC待ち。DROP_DOWNは定義順・空値が実測一致するが未知/削除済みoption待ち。NUMBERは通常値が一致するが最大30桁を扱えないためB9完了までnon-equivalent。CREATOR/MODIFIERはcode順とnon-equivalent。**R8 追加**: LINK（URL）・DATE・DATETIME・TIME は実測一致（空値=最小・tie=`$id`昇順）で `equivalent` 候補／**LINK（TEL）は判別例が不十分で `unknown`**（`"03-"<"043-"` は数値解釈でも同じ結論）／**STATUS はサーバがプロセス定義順だがローカルが `states.*.index` を捨てており再現不能＝実装前提あり**／**RADIO は `A`/`B`/`C` で判別不能**／**CREATED_TIME・UPDATED_TIME は受理のみ確認で並び順は未測定** |
| §9.2.1 `CREATOR`/`MODIFIER` の並び順 | **解消（公式）**。**ユーザーID 順**＝code でも name でもない。サーバは `supported` だが、現行のレコード取得と code 順ローカル契約では `non_equivalent` → §7 制限 8 |
| §9.2.1 各受理型の方向・tie・空値位置 | **一部**。明示`$id asc`が第1キーの方向と独立に効くことを確認。残り型は非同値群反転・tie群不変・空値位置を測る |
| §9.2.1 `RICH_TEXT`/`$revision`/SUBTABLE 内/CALC format 別 | **未**（検証アプリに該当なし）。**`FILE` は測定済み＝拒否** |
| §9.1 補助平面どうしの組（`𠮟` vs `𩸽`）・結合文字の連続 | **未**（非 Blocking） |
| §9.2 DROP_DOWN / RADIO の rank | **一部**。DROP_DOWNは語彙順と逆の既存設定で定義順・空値先頭を確認。RADIOは未 |
| §9.3 `LIKE` と `KLIKE` の差 | **未**（**出荷 blocker にしない**・R4 判断） |
| §9.4 Chromium / Firefox の smoke | **未**（**Claude は実行環境を持たない**。B20 は出荷しないため正規表現の smoke は不要） |

**§4.6.3 で新たな欠陥を発見**: kSQL は kintone がソートできない型でも SIMPLE のまま押し下げ、**EXPLAIN は `ok` を返して実行が必ず失敗する**。

---

実機担当へは「期待する順序」だけでなく、**raw REST と JS 経路が別であることを示す実行方法**を渡す。

### 9.1 kintone の文字列順序

SINGLE_LINE_TEXT に次をバラバラの `$id` 順で保存し、raw REST の `order by field asc, $id asc limit 500` で取得する。kSQL が後処理しないことをログ/コードで確認する。

| 軸 | 最小ケース | 判別する仮説 |
|---|---|---|
| 共通接頭辞 | `a`, `aa`, `a😀`, `aｱ`, `a𠮟` | 先頭だけでなく辞書式比較か |
| 正規化 | `é` (NFC), `e\u0301` (NFD) | 正規化・照合を行うか |
| 結合/IVS | `が`, `か\u3099`, `葛`, `葛󠄀` | コードポイント列を保持するか |
| 補助平面 | `ｱ`, `😀`, `𠮟`, 別の補助平面文字 | UTF-16順との区別 |
| ASCII case | `A`, `B`, `a`, `b` | ICU/大小文字畳み込みとの区別 |
| 数値らしいtext | `2`, `10`, `1a`, `9` | 数値自動判定の有無 |

ASC / DESC では**非同値グループだけが反転し、同値グループ内の `$id asc` は不変**であることを確認する。LIMIT 500/501/なしで SIMPLE/JS の主体が想定どおり分かれることも確認する。

### 9.2 optionOrders

- DROP_DOWN / RADIO は raw REST の ASC/DESC で option 定義順、空値、未知値（作成可能なら）を測り、§4.6.2 の単一 option key と一致するか確認する
- CHECK_BOX / MULTI_SELECT はソート拒否を確認済み。ローカル comparator について、空集合、単一値、共通 rank、未知値、`['Y','Z']` / `['Z','Y']` を全入力順列で property test し、canonical vector 契約を検証する

### 9.2.1 B27 のサーバ ORDER BY 能力

raw REST の `order by <field> asc/desc, $id asc limit 500` を直接使い、EXPLAIN を実行の代わりにしない。暗黙tie-breakは型ごとに再測定せず、明示したcanonical tie-break込みの結果列をFULL_SCANと比較する。

#### 実測結果（Claude・2026-07-17・APP4221 / APP4148）

**方法**: `SELECT $id FROM APPn ORDER BY <field> ASC LIMIT 1`（`LIMIT` ≤ 500 ＝ 単発 GET ＝ kintone が並べる。`execute.ts:1288`）を `continueOnError: true` のバッチで各型 1 本ずつ実行し、**kintone API の生の応答**で受理/拒否を判定した。

| 型 | フィールド | 受理 | 備考 |
|---|---|---|---|
| RECORD_NUMBER | `レコード番号` | **✅ 受理** | |
| SINGLE_LINE_TEXT | `タイトル` | **✅ 受理** | |
| NUMBER | `金額` | **✅ 受理** | |
| CALC | `計算` | **✅ 受理** | format 別は未測定 |
| DATE | `日付` | **✅ 受理** | |
| DATETIME | `日時` | **✅ 受理** | |
| TIME | `時刻` | **✅ 受理** | |
| CREATED_TIME | `作成日時` | **✅ 受理** | |
| UPDATED_TIME | `更新日時` | **✅ 受理** | |
| DROP_DOWN | `ドロップダウン` | **✅ 受理** | |
| RADIO_BUTTON | `ラジオボタン` | **✅ 受理** | |
| STATUS | `ステータス` | **✅ 受理** | |
| **LINK** | `Webサイト` | **✅ 受理** | **MULTI_LINE_TEXT と分かれる** |
| **CREATOR** | `作成者` | **✅ 受理** | **ソートキーが code か name か未確定**（下記） |
| **MODIFIER** | `更新者` | **✅ 受理** | 同上 |
| **MULTI_LINE_TEXT** | `顧客情報メモ欄` | **❌ `GAIA_IS02`** | **LINK と分かれる。テキスト系でも拒否される** |
| MULTI_SELECT | `複数選択` | **❌ `GAIA_IS02`** | |
| CHECK_BOX | `チェックボックス` | **❌ `GAIA_IS02`** | |
| USER_SELECT | `ユーザー選択` | **❌ `GAIA_IS02`** | |
| ORGANIZATION_SELECT | `組織選択` | **❌ `GAIA_IS02`** | |
| GROUP_SELECT | `グループ選択` | **❌ `GAIA_IS02`** | |
| STATUS_ASSIGNEE | `作業者` | **❌ `GAIA_IS02`** | |
| CATEGORY | `カテゴリー` | **❌ `GAIA_IS02`** | |
| REFERENCE_TABLE | `担当者一覧` | **❌ `GAIA_IS02`** | |
| SUBTABLE | `テーブル` | **❌ `GAIA_IS02`** | |
| **FILE** | `添付ファイル`（APP74） | **❌ `GAIA_IS02`** | |
| **GROUP** | `グループ`（APP74） | **❌ `GAIA_IS02`** | フォームの「グループ」（区切り） |
| **LOOKUP（NUMBER 基底）** | `顧客番号`（APP74） | **✅ 受理** | **下記** |
| **LOOKUP（TEXT 基底）** | `顧客名`（APP74） | **✅ 受理** | **下記** |

**拒否メッセージは全型で同一形式**: `GAIA_IS02:「<ラベル>」フィールドはソート条件に使用できません。`

**未測定**: `RICH_TEXT`・`FILE`・`$revision`・SUBTABLE 内フィールド・CALC の format 別（検証アプリに該当フィールドが無い、または要追加）。

#### 公式ドキュメントとの突き合わせ（**実測 15/15 が一致**）

[ソートで選択できるフィールド・項目を知りたい](https://jp.kintone.help/k/ja/trouble_shooting/app_qa/sort)（kintone ヘルプ）

> **対応**: 「レコード番号」「更新者」「作成者」「更新日時」「作成日時」「文字列（1行）」「数値」「計算」「ラジオボタン」「ドロップダウン」「日付」「時刻」「日時」「リンク」「ルックアップ」、プロセス管理の「ステータス」
>
> **非対応**: 関連レコード一覧フィールドおよびテーブルにしたフィールドはソートできません

**§9.2.1 の実測（受理 15 / 拒否 10）は公式リストと完全に一致する。**

- **`文字列（複数行）` が対応リストに無い**ことが、`MULTI_LINE_TEXT` 拒否の理由。**`リンク` は対応リストにある**＝「テキスト系は受理」ではなく**公式が型ごとに列挙している**
- `MULTI_SELECT` / `CHECK_BOX` / `USER_SELECT` / `ORGANIZATION_SELECT` / `GROUP_SELECT` / `STATUS_ASSIGNEE` / `CATEGORY` はいずれも**対応リストに無い**＝拒否と整合

#### `ルックアップ` は独立した型ではない（実測・R5 で追加）

公式リストの `ルックアップ` は、**REST 層では基底型（コピー元フィールドの型）として現れる**。

```
APP74 の DESCRIBE:
  顧客番号（ルックアップ）→ タイプ: NUMBER
  顧客名  （ルックアップ）→ タイプ: SINGLE_LINE_TEXT

ORDER BY 顧客番号 ASC LIMIT 1 → ✅ 受理
ORDER BY 顧客名   ASC LIMIT 1 → ✅ 受理
```

> **`LOOKUP` という型は kSQL から見えない。基底型の規則がそのまま適用される。B26/B27 で `LOOKUP` の特別扱いは不要。**

（公式リストが `ルックアップ` を挙げているのは、フォーム設定上のフィールド種別として列挙しているため。）

#### 公式は「順序の意味論」も規定していた（**R5 で訂正**）

**R4 レビュー時に Claude は「公式は順序の意味論を規定していない」と書いたが、誤りだった。** 別ページに記載がある。

##### `SINGLE_LINE_TEXT` は **UTF-8 の文字コード順**（公式）

[文字列（1行）フィールドの数値が意図した順番に並ばない](https://jp.kintone.help/k/ja/trouble_shooting/app_trouble/order_numbers_text_field)

> 「文字列（1行）」フィールドに入力した数値は、**UTF-8 の文字コード順**で並び替えられる。
> 昇順の例: **`"1", "10", "11", … "2", "3"`**（1, 2, 3 … 10, 11 ではない）
> 回避策: 桁を 0 埋めする（`01`, `02` …）／ドロップダウンを使う（設定の定義順で並ぶ）

**UTF-8 のバイト順は Unicode コードポイント順と一致する**（UTF-8 の設計上の性質）。**実測で確認**: 25 値・625 組で**不一致ゼロ**。公式の例 `1, 10, 11, 2, 3` も比較器で完全再現。

> **したがって R4 §4.5.1 の「文字列はコードポイント順」は、観測ではなく公式の契約に裏付けられる。**

**UTF-16 コードユニット順は UTF-8 バイト順と食い違う**（同 625 組で 6 組）:

```
'ｱ' vs '😀'   UTF-8/コードポイント: ｱ < 😀     UTF-16 ユニット: ｱ > 😀
'ｱ' vs '𠮟'   UTF-8/コードポイント: ｱ < 𠮟     UTF-16 ユニット: ｱ > 𠮟
```

**現状の kSQL（`MIN`/`MAX`/`GREATEST`/`WHERE` の `<`）はここで公式契約から外れている。**

##### `CREATOR` / `MODIFIER` は **ユーザーID 順**（公式）— **code でも表示名でもない**

[一覧やグラフのソートで、作成者や更新者を指定したときの並び順](https://jp.kintone.help/k/ja/trouble_shooting/app_qa/list_graph_sort)

> 一覧やグラフの設定でソートに「作成者」「更新者」を指定した場合、**ユーザーID の昇順・降順**で表示される。ユーザーID はユーザーを追加したときに自動で割り振られる**数値**で、ユーザー名とは別のもの。

**これは §9.2.1 で「測定不能」としていた問いの答えである。**

> **現行 kSQL のレコード取得だけでは、kintone の `CREATOR`/`MODIFIER` の順序を再現できない。**
>
> レコードの値は `{"code":"rex0220","name":"開発太郎"}` であり、**ユーザーID を含まない**。一方、User API は `id` と `code` を返し、必要アクセス権も「なし」と公式に規定される。したがって原理的に再現可能だが、別 API・ページング・キャッシュ・削除済みユーザーの契約が必要になる。

**結論**: `CREATOR` / `MODIFIER` は **`supported + non_equivalent` として押し下げない**。kSQL はローカルで **code 順**（v2.5.0 の既存契約）に並べる。User API enrichment は本課題へ暗黙に追加せず、必要なら別設計とする。

**原則 2 に照らして問題ない**: 常に FULL_SCAN なら**モード差は生じない**。kintone の一覧画面と並びが違うことは**制限事項として明記する**（§7・新規）。

##### 派生: `equivalent` の判定は公式契約に基づける

**公式契約があるため、`equivalent` の判定は観測頼みではない。**

- **`SINGLE_LINE_TEXT`**: 公式が「UTF-8 文字コード順」と規定 → R4 comparator と**同値**と論証できる。有効な Unicode scalar value の列が対象
- **`CREATOR`/`MODIFIER`**: 公式が「ユーザーID 順」と規定 → **現行の code 順ローカル契約とは non-equivalent** と論証できる
- **`LINK` とその他（数値・日付・選択肢）**: 一覧/RESTの順序を直接規定する公式記載を未確認。**引き続き実測ゲート**

#### 判明した非自明な境界

1. **`MULTI_LINE_TEXT` は拒否、`LINK` は受理。** 「テキスト系は受理」という一般化はできない。**型ごとに測る必要がある**
2. **`CREATOR` / `MODIFIER` は受理され、kintone はユーザーID順。** kSQL の既存 code 順とは non-equivalent なので押し下げない（§7 制限8）
3. **`CATEGORY` / `STATUS_ASSIGNEE` は拒否。** `STATUS` は受理

#### `CREATOR` / `MODIFIER` の旧 code/name 実測

既存2ユーザーでは code順とname順が同じ答えになり、観測だけでは切り分けられなかった。しかし公式契約がユーザーID順と確定したため、ユーザー追加による code/name 切り分けは不要になった。

#### `DROP_DOWN` の空値位置（実測）

```
ドロップダウン ASC → '', '', '', '', 'd1', 'd1', 'd2', 'd2'
```

**空（未選択）が先頭。** 選択肢の定義順が `d1` → `d2` かは未確認（フォーム定義との突き合わせが要る）。

公式の[グラフにおける選択式フィールドの並び順](https://jp.kintone.help/k/ja/trouble_shooting/app_qa/graph_sort_selection_fields.html)は、グラフの分類値を option 設定順に並べると規定する。ただし**一覧/RESTの ORDER BY を規定するページではない**ため、DROP_DOWN / RADIO_BUTTON の強い仮説にはなるが、B27 の `equivalent` 根拠には単独で使わない。

#### 分類（§4.6.3 の三要素）

| サーバ受理 + 押し下げ同値性 | 型 |
|---|---|
| `rejected`（`GAIA_IS02`・**12 型**） | MULTI_LINE_TEXT / MULTI_SELECT / CHECK_BOX / USER_SELECT / ORGANIZATION_SELECT / GROUP_SELECT / STATUS_ASSIGNEE / CATEGORY / REFERENCE_TABLE / SUBTABLE / **FILE** / **GROUP** |
| `supported` + **`equivalent` 候補** | **RECORD_NUMBER**（アプリコード付き`APPCODE-1`待ち）/ **SINGLE_LINE_TEXT**（空値・DESC待ち）/ **DROP_DOWN**（未知・削除済みoption待ち）/ **LINK（URL）**（R8・空値待ち）/ **DATE** / **DATETIME** / **TIME**（R8・正規化形の順＝時系列順を実測。空値=最小・tie=`$id`昇順も確認） |
| `supported` + **`equivalent` 候補（実装前提あり）** | **STATUS** — サーバはプロセス定義順（R8 で決定的に実測）だが、**現行コードは `states.*.index` を捨てており**（`nodeKintoneClient.ts:259`）**ローカルで再現できない**。**B27 で index の保持・rank map 統合を実装しない限り `non_equivalent`**（§R8.1） |
| `supported` + **`non_equivalent`** | **CREATOR** / **MODIFIER** — サーバはユーザーID順、現行ローカル契約はcode順（§7 制限8）/ **NUMBER** — 通常値は一致するが最大30桁を現行`Number`比較で区別できない（B9） |
| `supported` + **`unknown`**（一覧/RESTの順序契約を未確認） | **LINK（TEL）**（R8.1・判別例が不十分＝`"03-"<"043-"` は数値解釈でも同じ結論）/ CALC / **CREATED_TIME** / **UPDATED_TIME**（**受理のみ確認・並び順は未測定**）/ **RADIO_BUTTON**（`A`/`B`/`C` では定義順とコードポイント順が一致し判別不能）（**LOOKUP は基底型に含まれる**） |

> **受理されることは `equivalent` の証拠ではない。** 押し下げてよいのは、値順・空値・方向・canonical tieを含めてローカル契約と一致した型だけである。現時点の確定allowlistは空。候補を残存軸の検証前に追加しない。

#### R8 実測: 残り型 × 明示 `$id asc`（Claude・2026-07-17）

**方法**: `ORDER BY <field> ASC, $id ASC LIMIT 500`（≤500 ＝ 単発 GET ＝ kintone が並べる）。R7 で確定した契約どおり末尾に `$id asc` を明示した。

##### 結果（R8.1 で訂正）

> **`equivalent` は「kintone とローカルが一致する」ことである。** kintone 側の並びが分かっただけでは `equivalent` にならない。**ローカルが再現できるか**を別に確かめる必要がある。R8 初稿はこれを混同していた（§10.1.2）。

| 型 | kintone 側の並び（実測） | 空値 | 同値の tie | ローカル再現 | 分類 |
|---|---|---|---|---|---|
| **SINGLE_LINE_TEXT** | **コードポイント順** | 未測定 | （同値なし） | 可（B26 の既定文字列順） | **`equivalent` 候補** |
| **LINK（URL）** | **コードポイント順** | 未測定 | （同値なし） | 可（同上） | **`equivalent` 候補** |
| **LINK（TEL）** | コードポイント順**と矛盾しない** | 未測定 | **`$id` 昇順** ✓ | 可（同上） | **`unknown`**（§下記・判別例が不十分） |
| **DATE** | 日付順（＝正規化形のコードポイント順） | **最小** | **`$id` 昇順** ✓ | 可 | **`equivalent` 候補** |
| **DATETIME** | 時系列順（＝正規化形のコードポイント順） | **最小** | **`$id` 昇順** ✓ | 可 | **`equivalent` 候補** |
| **TIME** | 時刻順（＝正規化形のコードポイント順） | **最小** | **`$id` 昇順** ✓ | 可 | **`equivalent` 候補** |
| **CREATED_TIME / UPDATED_TIME** | **未測定** | — | — | — | **`unknown`** |
| **STATUS** | **プロセス定義順**（決定的・下記） | 未測定 | **`$id` 昇順** ✓ | **不可（現行コード）** | **`equivalent` 候補（実装前提あり）** |
| **RADIO_BUTTON** | **判別不能**（`A`/`B`/`C` は定義順とコードポイント順が一致） | 未測定 | **`$id` 昇順** ✓ | — | **`unknown`** |

**測定した日付時刻型は `DATE` / `DATETIME` / `TIME` の 3 型のみ。** R8 初稿は「日付時刻 6 型」と書いたが誤りで、`CREATED_TIME` / `UPDATED_TIME` は**受理の確認のみ**（§9.2.1）で並び順は未測定。

##### ★ `STATUS` はローカルで再現できない（R8.1 で追加・**コード確定**）

**kintone がプロセス定義順であることは決定的**（下記）。**公式 API も各状態の `index` を返し、`index` 昇順が状態順と規定している**（[プロセス管理設定を取得する](https://cybozu.dev/ja/kintone/docs/rest-api/apps/settings/get-process-management-settings/)）。

**しかし現行コードは `index` を捨てている:**

```ts
// nodeKintoneClient.ts:259 — 型に index が無く、name だけ取り出す
const res = await requestJson<{
  enable: boolean;
  states: Record<string, { name: string }> | null;      // ← index を型に含めていない
}>(`${apiBasePath}/app/status.json?${qs.toString()}`, …);
return {
  enable: res.enable,
  states: Object.values(res.states ?? {}).map((state) => state.name),   // ← index を捨てる
};

// execute.ts:2627 — getOptionOrderMapByApp はフォームの optionOrder しか見ない
for (const field of fields) { if (!field.optionOrder) continue; … }

// execute.ts:2707 — buildOptionOrdersForSelect へ STATUS rank が入らない
```

> **したがって FULL_SCAN の `STATUS` はプロセス定義順にならない。** SIMPLE（kintone）とローカルで**別の順序**になる＝原則 2 違反。

**B27 に追加が要る**: **`states.*.index` を保持し、`STATUS` の `ORDER BY` が実在する場合だけ rank map へ統合する**（`optionOrders` と同じ経路）。取得は `STATUS` を並べ替えるクエリのときだけ（v2.7.0 の STATUS 押し下げが `status.json` を条件付きで取る前例に倣う）。

**分類は `equivalent` 候補（実装前提あり）。** 実装しない限り `non_equivalent`。

##### `LINK（TEL）` の判別例は不十分（R8.1 で訂正）

R8 初稿は次を「数値順ではない」の根拠とした:

```
LINK(TEL) ASC: 03-…, 043-…, 045-…, 048-…, 077-…
```

**これは反証になっていない。** `"03-"` < `"043-"` は**コードポイント順（`'3'`(0x33) < `'4'`(0x34)）でも、数値解釈（3 < 43）でも同じ結論**になる。

**必要なのは順序が逆転する組**（例: `"10"` と `"2"` — コードポイント順なら `"10"` < `"2"`、数値順なら `2` < `10`）。TEL の書式制約が許すかを含めて**要実測**。

**`LINK（TEL）` の分類は `unknown`。** `LINK（URL）` は §下記の `"…www.xxx.xxx.com"` < `"…www.xxxx.com"`（`'.'`(0x2E) < `'x'`(0x78)）が**数値解釈では説明できない**ため `equivalent` 候補のまま。


##### 根拠（コードポイント順であることの決定的な例）

```
SINGLE_LINE_TEXT ASC: A1, A2, A3, A4, "T -1", "T 0", "T 1", "T NULL"
  'A'(0x41) < 'T'(0x54)
  "T " の後: '-'(0x2D) < '0'(0x30) < '1'(0x31) < 'N'(0x4E)   ← 数値順でも辞書順でもない

LINK(URL) ASC: http://… , https://kikkawa… , https://shinomura… , https://www.kin… ,
               https://www.mukaigawa… , https://www.xxx.xxx , https://www.xxx.xxx.com ,
               https://www.xxxx.com
  "http://" < "https://"                    '/'(0x2F) < 's'(0x73)
  "https://www.xxx.xxx" < "…xxx.xxx.com"    共通接頭辞は短い方が先
  "…www.xxx.xxx.com" < "…www.xxxx.com"      '.'(0x2E) < 'x'(0x78)

LINK(TEL) ASC: 03-…, 043-…, 045-…, 048-…, 077-…
  "03-" < "043"    '3'(0x33) < '4'(0x34)   ← 数値順なら 3 < 43 で同じだが、
                                              コードポイント順であることは '-'(0x2D) の位置で分かる
```

##### ★ `STATUS` はプロセス定義順（決定的）

```
STATUS ASC: 未処理, 処理中, 完了, 保留
符号位置  : 保 U+4FDD < 処 U+51E6 < 完 U+5B8C < 未 U+672A

→ コードポイント順なら 保留 が先頭。実際は 未処理（最大の符号位置）が先頭。
→ プロセス管理の定義順（未処理 → 処理中 → 完了、保留は分岐）で並んでいる。
```

**`DROP_DOWN`（R6 の `業種`）と同じ構造。** 選択系・プロセス系は**定義順が第一キー**であり、`optionOrders` / プロセス設定の再現が `equivalent` の条件になる。

##### ★ 明示 `$id asc` は今回測定した全同値グループで効く（R7 契約の裏付け）

```
DATE     ''(1,2,3,4) | 2026-07-08(6,7)
DATETIME ''(1,2,3,4) | 2026-07-20T09:00:00Z(6,7)
TIME     ''(1,2,3,4) | 16:00(6,7,8)
LINK TEL 03-(1,4,7) | 045-(2,8)
RADIO    A(1,2,3,4,5) | C(6,7)
STATUS   未処理(1,5,6) | 処理中(4,7) | 完了(2,8)
```

**今回測定した同値グループはすべて `$id` 昇順。** R7 の契約（SIMPLE 押し下げ時に `$id asc` を明示して FULL_SCAN の基準へ合わせる）は**上記 6 型・この設定のもとで成立する**。

**「全型で成立」とは書かない（R8.1 で狭めた）。** 未確定の軸が残る:

| 軸 | 未確定の理由 |
|---|---|
| `RADIO_BUTTON` | 測ったのは定義順が辞書順と一致する設定のみ。**逆順定義**では第一キー自体が未検証 |
| `RECORD_NUMBER` | **アプリコード付き**（`APPCODE-1`）を未測定 |
| `LINK(TEL)` | 判別例が不十分で第一キーが unknown（下記）。第一キーが不明なら tie 群も不明 |
| `CREATED_TIME` / `UPDATED_TIME` | 未測定 |

tie-break は**第一キーで同値になった集合の中の順**なので、第一キーが未確定な型では tie 群自体を作れない。契約の一般性はこれらを測ってから主張する。

##### 未測定

| 項目 | 理由 |
|---|---|
| `SINGLE_LINE_TEXT` / `LINK` の**空値位置** | 検証アプリに空値のレコードが無い。**`$id asc` 明示時の tie は他型で確認済み**のため優先度は低い |
| `RADIO_BUTTON` の定義順 | `A`/`B`/`C` では判別不能。**語彙順と逆の定義順**が要る（フォーム設定の変更＝kintone MCP または手動） |
| **アプリコード付き `RECORD_NUMBER`**（`APPCODE-1` 形式） | 検証アプリにアプリコードが設定されていない（`レコード番号` は `1`〜`8` の素の数値）。**アプリコードがあると `RECORD_NUMBER` は文字列になる可能性があり、数値順か文字列順かで挙動が変わる。要検証** |
| 補助平面どうしの組（`𠮟` vs `𩸽`）・結合文字の連続 | 非 Blocking |

#### R7 実測: 明示 `$id` 第2キー（Claude・2026-07-17・**B27 の方針確定**）

**codex の指摘により R6 の「ローカル比較器の最終 tie-break を `$id DESC` に」は棄却された。** 理由:

- **比較器へ `$id` を足してはならない。** `process.ts:669` が `sortedResult.compare(sorted[index-1], sorted[index]) !== 0` で **`RANK` / `DENSE_RANK` の peer を判定**している。`$id` を足すとどの 2 行も等しくならず **`RANK` が `ROW_NUMBER` へ退化**する（B17 で実証した `RANK=173/173/173` が壊れる）
- FULL_SCAN は既に `order by $id asc` を基準に取得している（`selectToKintone.ts:130`）
- `$id DESC` へ全面変更すると、カーソルページング・JOIN の元順・`ROW_NUMBER` の同値順まで波及する
- **kintone 公式が保証しているのは `order by` 省略時の ID 降順のみ。** 指定キー同値時の挙動は R6 の観測であって公式契約ではない

##### 実測: 明示した第2キーは同値グループ内でそのまま効く

```
データ: 金額 = ''(1), -1(3), 0(2), 1(4), 1000(5), 3000(6), 3000(7), 5000(8)   ※ () は $id

order by 金額 asc,  $id asc  → 1, 3, 2, 4, 5, [6, 7], 8      同値 3000 は $id 昇順
order by 金額 desc, $id asc  → 8, [6, 7], 5, 4, 2, 3, 1      第1キーが DESC でも第2キーは独立に昇順
order by 金額 asc,  $id desc → 1, 3, 2, 4, 5, [7, 6], 8      同値は $id 降順
order by 金額 desc, $id desc → 8, [7, 6], 5, 4, 2, 3, 1
```

> **`$id ASC` を明示すれば、kintone は同値グループを `$id` 昇順で返す。**
> **= FULL_SCAN の基準（`order by $id asc` + JS の安定ソート）と一致する。**

##### 確定する B27 の tie-break 契約

**kintone の暗黙 `$id DESC` にローカルを合わせるのではなく、現行 FULL_SCAN の `$id ASC` に SIMPLE を合わせる。**

1. 利用者指定キーで比較する
2. 全キー同値なら、**元の安定順を維持**する
3. 実アプリ単表の元順は **`$id ASC`**
4. **SIMPLE 押し下げ時は `order by <利用者キー…>, $id asc` を明示する**

**比較器（peer 判定用）と、トップレベルの結果順（tie-break 込み）を分離する。**

##### 受入条件の訂正

**「ASC と DESC が厳密に逆順」は誤り**（R6 で「未」としていた項目そのものが誤った期待値だった）。正しくは:

- **非同値グループの順は反転する**
- **同値グループ内の canonical tie 順は ASC/DESC で変わらない**（明示第2キーを付けた場合はその第2キーの向きに従う）
- SIMPLEの単一/複数キー、ASC/DESC、LIMIT/OFFSETで、生成query末尾が`$id asc`になる
- 利用者キーに既に`$id`があれば重複追加しない。そのキー方向を尊重する
- 同じデータをSIMPLEとFULL_SCANで実行し、同値群を含む結果行とLIMIT窓が一致する
- `RANK` / `DENSE_RANK`のpeer比較には`$id`が入らず、同値行が同順位のまま。`ROW_NUMBER`だけがcanonical安定順で連番になる
- EXPLAIN表示と実行が同じ補完済みORDER BY計画を使う

##### この確定により、残り型の実測が簡単になる

**暗黙 tie-break を型ごとに再測定する必要はない。** 残り型はすべて **`$id asc` を明示した REST 結果**と FULL_SCAN を比較すればよい。

#### R7 実測: B9 の桁数（**縮小できない**）

**R6 の「16 桁級は kintone へ保存できないので B9 の論点にならない可能性」は誤りだった。**

**誤りの原因**: `12345678901234567` は **17 桁**であり、これが拒否されたことは 16 桁の可否を何も語らない。しかも最初の測定は `数値MAX`（**`maxValue`=1000 の制約付きフィールド**）で行っており、エラーに `1,000以下である必要があります` が併記されていたのに気づかなかった。**制約付きフィールド 1 つの結果を kintone 全体へ一般化した。**

##### 実測（`APP4221` の `金額`）

| 桁数 | 結果 |
|---|---|
| 10 | ✅ |
| 12 | ✅ |
| **13** | **❌ `CB_VA01:「有効桁数を超えています」`** |
| 14 / 16 / 17 | ❌ |

**`APP4221` の `金額` は 12 桁が上限。** ただし **`有効桁数` はアプリ設定で変更でき、16 桁以上も指定可能**（ユーザー情報）。**したがって B9 の代表例は依然として保存可能であり、B9 のスコープは縮小できない。**

```
9007199254740992   (2^53・16 桁)
9007199254740993   (2^53+1・16 桁)
→ JS の Number では区別できない（両方 9007199254740992 になる）
```

##### 桁数は**アプリ設定**（フィールド設定ではない）— 最大30桁・丸めかたも規定（R8で整理）

[アプリの一般設定を取得する](https://cybozu.dev/ja/kintone/docs/rest-api/apps/settings/get-general-settings/):

```
numberPrecision.digits         全体の桁数（1〜30 の整数）
numberPrecision.decimalPlaces  小数部の桁数（0〜10 の整数）
numberPrecision.roundingMode   HALF_EVEN（最近接偶数への丸め）/ UP / DOWN

必要なアクセス権: アプリのレコード閲覧権限 または 追加権限
GET /k/v1/app/settings.json?app=<id>
```

**したがって:**

- **「`金額` は 12 桁上限」は `APP4221` の `numberPrecision.digits` が 12 だっただけ**であり、kintone の制限ではない。**またフィールド 1 つの観測を一般化していた**
- **アプリ単位で最大 30 桁まで設定できる。** `Number` の安全整数は約 15.9 桁（2^53）なので **30 桁は大きく超える**
- **`roundingMode` まで規定されている。** `HALF_EVEN`（銀行丸め）は `Math.round` では再現できない
- 運用環境の設定取得には**レコード閲覧権限または追加権限**が必要。通常のkSQL実行資格と重なるが、無権限ではない

> **B9 は縮小できない。** 最大30桁の既存値を厳密比較する。一方、`decimalPlaces` と `roundingMode` は比較順ではなく入力・算術結果の量子化規則なので、**B29へ分離する**。B9へ10進算術全体を抱え込ませない。

**未測定**: `9007199254740992` / `9007199254740993` の保存可否。**`numberPrecision.digits` を 16 以上に設定したアプリ**が要る（kSQL に app settings API は無いため Claude は設定変更できない）。**検証用アプリの設定変更をお願いしたい。**

**加えて B9 は `ORDER BY` だけの問題ではない**（`WHERE` / `HAVING` / `CASE` / `ASSERT` の厳密比較）。`ORDER BY` の同値性だけを根拠にスコープを縮小してはならない。

##### 副次的な発見: `VALIDATE ONLY` は `有効桁数` を検査しない

```
INSERT … VALUES ('…','…','…','999999999999999'), (…,'9999999999999999'), (…,'99999999999999999') VALIDATE ONLY
→ validRows: 3, errorCount: 0        ← 15/16/17 桁すべて通過

実 INSERT（17 桁） → CB_VA01「有効桁数を超えています」
```

**Tier-0 は「API 拒否の予測」ではない**という B12-A の設計どおりではあるが、**`ON ERROR SKIP` が「合格」と判定した行が kintone で拒否される**ことを意味する。B12-B のfail-fast契約により部分継続はしない。この差を埋める場合は比較のB9ではなく、設定依存検証を所有する **B29** で扱う。

##### 副次的な発見: `ksql_mutate` の `continueOnError` は効かない

DML バッチは**常に fail-fast**（`ksql_mutate` の仕様どおり）。`continueOnError: true` を渡しても後続文は `skipped / fail-fast` になる。**読み取り（`ksql_query`）では効く。**

#### R6 実測: 同値性の判定（Claude・2026-07-17・**R7で設計訂正済みの履歴**）

##### ★ 発見 1: **同値の tie-break は `$id` 降順で、`DESC` でも反転しない**

**測定した全型で観測。R4/R5 のどの節にも書かれていなかった。**（R8.1: ここも当時「全型」と書いたが、根拠は下記の測定範囲に限られる。）

```
金額(NUMBER) ASC : '',''  ,'','' | -5 | -1 | -0.001 | 0, 0 | 0.5 | 1 | 2 | 10 | 1000 | 3000, 3000 | 5000
                   $id: 61,60,59,1        63,2            7,6
金額(NUMBER) DESC: 5000 | 3000, 3000 | 1000 | 10 | 2 | 1 | 0.5 | 0, 0 | -0.001 | -1 | -5 | '','','',''
                         7,6                              63,2                        61,60,59,1

業種(DROP_DOWN) ASC : 製造業(8,5) | 不動産業(3) | 運輸・通信業(6,4,2,1) | 金融業(7)
業種(DROP_DOWN) DESC: 金融業(7) | 運輸・通信業(6,4,2,1) | 不動産業(3) | 製造業(8,5)
```

**同値グループ内は ASC でも DESC でも `$id` の降順で固定**（`61,60,59,1` / `63,2` / `7,6` / `8,5` / `6,4,2,1` がすべて ASC・DESC で同一）。

**公式仕様と整合する**: [クエリの記述方法](https://cybozu.dev/ja/kintone/docs/overview/query/) の `order by` 説明に「**省略すると、レコードIDの降順で並び替えされます**」とあり、これが **`order by` 指定時の同値の tie-break としても効いている**と見える（公式に明記はない＝**推論**）。

> **`equivalent` の判定には tie-break も含めなければならない。**

kSQL の FULL_SCAN は `order by $id asc` を注入して取得し（`selectToKintone.ts:130`）安定ソートするため、**同値は `$id` 昇順**になる。**kintone は `$id` 降順**。→ **同値がある限り SIMPLE と FULL_SCAN は一致しない。**

**当時の二案はいずれも採用しない。** comparatorへ`$id`を足すとRANK/DENSE_RANKのpeerを壊し、`$id desc`押し下げはFULL_SCANの既存基準と逆になる。R7で **SIMPLE末尾へ`$id asc`を明示する**契約に確定した（上記）。

##### ★ 発見 2: **`DROP_DOWN` は選択肢の定義順で並ぶ**（値のコードポイント順ではない）

```
業種 ASC: 製造業, 不動産業, 運輸・通信業, 金融業
符号位置: 製 U+88FD / 不 U+4E0D / 運 U+904B / 金 U+91D1
コードポイント順なら: 不動産業(0x4E0D), 製造業(0x88FD), 運輸・通信業(0x904B), 金融業(0x91D1)
→ 一致しない。定義順で並んでいる。
```

**kSQL の `optionOrders`（v2.6.0）が正しいことの裏付け。** `DROP_DOWN` の `equivalent` 判定は「定義順 rank が一致するか」で行う。

**グラフについては公式ページがある**（[グラフの分類項目に選択肢のフィールドを指定したときの並び順](https://jp.kintone.help/k/ja/trouble_shooting/app_qa/graph_sort_selection_fields.html)）が、**REST の `order by` については規定が無い**。本実測は**観測**であり契約ではない。

##### 型ごとの結果

| 型 | 受理 | 並び | 空値 | ASC/DESC | 同値性 |
|---|---|---|---|---|---|
| **RECORD_NUMBER** | supported | **数値順**（`8 < 59`。文字列順なら `"59" < "8"`） | — | 測定範囲では反転 | **候補**。アプリコード付き`APPCODE-1`形式が未測定 |
| **NUMBER** | supported | **数値順**（`2 < 10`・負数・小数とも） | **最小**（ASC 先頭 / DESC 末尾）＝ **v2.2.0 の −∞ 規則と一致** | 非同値部分は逆順・**同値は不変** | 通常値は一致。ただし最大30桁は現行`Number`で区別できず、**B9完了までnon-equivalent** |
| **DROP_DOWN** | supported | **選択肢の定義順** | **最小**（ASC 先頭） | 群は逆順・**同値は不変** | **候補**。未知・削除済みoptionが未測定 |

##### 測定できなかったもの

| 項目 | 理由 |
|---|---|
| **16桁境界のNUMBER** | R6の測定は12桁設定のフィールドへ17桁を入れただけで、一般化不能。公式上限はアプリ設定で30桁。B9は縮小しない |
| `DROP_DOWN` / `RADIO_BUTTON` の「語彙順と逆になる設定順」 | フォーム定義の変更が要る（kSQL に form API は無い）。**`業種` が偶然それを満たしていた**ため定義順であることは確認できた |
| `STATUS` の「表示文字列順と逆になるプロセス設定順」 | 同上（プロセス管理設定の変更が要る） |

##### 副次的な発見: `INSERT` の `VALUES` が負数リテラルを受け付けない

```
INSERT INTO APP4221 (…, 金額) VALUES (…, -5)
→ ParseError: INSERT の値には文字列・数値・配列リテラル・CASE WHEN が必要です（位置 340、トークン: 「-」）
```

**B15（`IN` の負数リテラル・v2.14.1）と同型の未対応。** `'-5'`（文字列）なら通る。**本仕様の対象外だが起票の価値がある。**

#### 残る実測（Blocking）

- 各受理型で **非同値グループがASC/DESCで反転し、同値グループ内の`$id asc`が不変**か
- 各受理型で **空値の位置**（先頭 / 末尾）
- 各受理型で **R4 comparator と同値**か（`$id` を second key にして tie を固定し、全順列で確認）
- `RICH_TEXT` / `FILE` / `$revision` / SUBTABLE 内フィールド / CALC の format 別

**残り（非 Blocking・取る価値あり）**: `𠮟` vs `𩸽`（補助平面どうし）・結合文字の連続・文字列ASC/DESCでの非同値群反転とtie群不変。

**出荷 blocker にしない**（R4 判断）: `LIKE`/`KLIKE` の差・ブラウザ smoke。B20 は出荷しないため正規表現のブラウザ smoke も不要。

### 9.3 WHERE / LIKE / KLIKE

- typed text / typed number それぞれで `=`, `<`, `>`, `<=`, `>=`
- 空セル、`-1`, `0`, `10`, `1a`, 補助平面文字
- LIKE/KLIKE は英数字1語・語の一部・記号・日本語1文字/2文字・`%`/`_`・NFC/NFD
- SIMPLE 押し下げ結果と、同じ候補集合を JS で再評価した結果を比較

kintone が演算子を許さない型は「比較規則」ではなく「非対応」として記録する。

### 9.4 4面 smoke test

CLI と MCP は同じ Node 版で一致することを確認し、プラグインは最低1つの Chromium と Firefox で実行する。コードポイント比較・LENGTH・B22/B23/B24 は同じ期待値を固定する。B20 は出荷しないため対象外。

---

## 10. 他文書の訂正と、本書自身の誤りの記録

### 10.1 他文書で本書と食い違う記述

| 文書 | 誤り | 正 |
|---|---|---|
| [B20](ksql_regexp_function_spec.md) §3.1 | 「正規表現が『同じ SQL は同じ結果』の原則に構造的に反する**最初の**機能になる」 | **既に `ORDER BY` で起きている**（§4.4）。正規表現は最初ではない。**訂正済み** |
| **B20** §4.3 | **安全部分集合 R-1/R-2 で指数時間を塞げる** | **誤り。** 量化グループも後方参照も無い `^a?×n a×n b$` が指数時間になる（§10.3）。**B20 は現方式では出荷しない**（§7 制限1） |
| [B13](ksql_string_min_max_aggregate_spec.md) | `MIN`/`MAX` は「UTF-16 辞書順」 | 記述自体は正しいが、**`ORDER BY` との差も、kintone との差（サロゲート）も記載していない** |
| [B21](ksql_update_set_string_func_issue.md) | 「評価機構は完成済み・parser 側が主」 | **誤り。** 単純 UPDATE は `buildUpdateRecord`（`dmlToKintone.ts:172`）が**行を持たずに** `toKintoneValue` へ渡す。CASE 版が動くのは `:539` が取得済み `row` を渡す**別経路**だから（§10.3） |

### 10.1.1 R4 レビュー時の Claude の誤り（R5 で判明）

| Claude の記述 | 実際 |
|---|---|
| 「**公式は順序の意味論を規定していない**。§4.1 のコードポイント順は観測であって契約ではない」 | **SINGLE_LINE_TEXT について誤り。** 別ページに **UTF-8 の文字コード順**との規定がある（公式の例: `1, 10, 11, 2, 3`）。有効な Unicode 文字列では **UTF-8 バイト順 = コードポイント順**（実測 625 組で不一致 0）→ この型の R4 設計は公式契約に裏付けられる。**LINK や他型へは一般化しない** |
| 「`CREATOR`/`MODIFIER` の code/name は測定不能」 | **code/name の二択自体が誤り。** 公式契約は**ユーザーID 順**。現行のレコード値だけでは ID を得られないが、User API による再現は原理的に可能。現行 code 順とは `non_equivalent`（§7 制限 8） |
| 「`equivalent` の判定は本質的に脆い（公式契約が無いため観測を固定し続ける必要がある）」 | **SINGLE_LINE_TEXT と CREATOR/MODIFIER について前提が誤り。** 公式契約から equivalent / non_equivalent を論証できる。他型は未確認のまま |

**原因**: 「ソートで選択できるフィールド」のページだけを見て「公式は順序を規定していない」と一般化した。**1 ページの不在を、ドキュメント全体の不在と読み替えた。** ユーザーが別の 2 ページを提示して判明した。

**教訓**: **「公式に記載が無い」と書く前に、その主題で検索したか確認する。** 1 ページに無いことは「規定が無い」ことを意味しない。**「無いことの証明」は「あることの証明」より慎重に扱う。**

### 10.1.2 R8 実測時の Claude の誤り（R8.1 で判明）

| Claude の記述 | 実際 |
|---|---|
| 「**`STATUS` は `equivalent` 候補**」 | **誤り。** kintone がプロセス定義順であることは実測したが、**ローカルが再現できるかを確かめていない**。`nodeKintoneClient.ts:259` は `states.*.index` を型にすら含めず捨てており、`getOptionOrderMapByApp`（`execute.ts:2627`）はフォームの `optionOrder` しか見ない。**FULL_SCAN の `STATUS` はプロセス定義順にならない**＝`equivalent` ではなく `non_equivalent`（実装すれば候補） |
| 「**日付時刻 6 型**が `equivalent` 候補」 | **誤り。測定したのは `DATE` / `DATETIME` / `TIME` の 3 型のみ。** `CREATED_TIME` / `UPDATED_TIME` は §9.2.1 で**受理を確認しただけ**で並び順は未測定。**受理の確認を並び順の確認と混同した** |
| 「`LINK（TEL）` の `"03-" < "043-"` は**数値順ではない**ことの根拠」 | **反証になっていない。** コードポイント順（`'3'`(0x33) < `'4'`(0x34)）でも数値解釈（3 < 43）でも**同じ結論**になる。順序が逆転する組（`"10"` vs `"2"` 等）が要る |

**原因**: **`equivalent` の定義を取り違えた。** `equivalent` は「**kintone とローカルが一致する**」ことであり、**kintone 側の並びが分かっただけでは半分**でしかない。R4 §4.6.3 が「意味型 / ローカル契約の有無 / サーバ能力」を**3 要素に分離**したのは、まさにこの混同を防ぐためだったのに、実測では kintone 側しか見ていなかった。

**教訓**: **「両者が一致するか」を確かめるときは、両者を別々に確認する。** 片側だけ測って一致を主張しない。これは R1 で犯した「比較しているつもりの 2 つが同じ経路だった」（§10.2）と同じ形である。

### 10.2 本書 R1 → R2 → R3 の誤りの記録

**本書は §4 を 2 回、全面的に誤った。** 同じ穴を繰り返さないため記録する。

#### R1 の誤り

| R1 の記述 | 実際 |
|---|---|
| 「`ORDER BY` は ICU 照合」 | **`LIMIT` ≤ 500 の単発 GET では kintone の順**。JS 経路のときだけ ICU |
| 「浮いているのは `MIN`/`MAX`」 | **逆。`ORDER BY` の JS 経路が浮いている** |

**原因**: 検証で **`LIMIT` を軸として振らなかった**。「`ORDER BY` の全件」と「`WHERE … LIKE` 付きの全件」を比較して「kintone と JS は一致」と結論したが、**どちらも JS 経路**だった（`LIMIT` が無いためページング経路＝`applyOrderBy` を通る）。**比較しているつもりの 2 つが同じ経路だった。**

#### R2 の誤り

| R2 の記述 | 実際 |
|---|---|
| 「`MIN`/`MAX`・`GREATEST`・`WHERE` は kintone のバイナリ順と整合している」 | **BMP でしか成り立たない。** サロゲートが絡むと全系統が食い違う（§4.2） |
| 「すべてコードポイント順へ統一する」 | **不正確。** 選択肢では**定義順 rank が第一キー**（§4.6）。正しくは「**文字列フォールバックをコードポイント順へ統一**」 |
| 「`LIMIT` ≤ 500 のクエリは変わらない」 | **範囲が広すぎる。** kintone の順を使うのは **`executeSimpleSelect` が `useSingleGet` になった場合だけ**（§4.4） |
| 「比較器の全順序を検証済み」 | **`compareCodePoints` 単体の話でしかない。** `ORDER BY` の複合規則は**全順序でない**（§4.3） |

**原因**: 「バイナリ順」に**コードユニット順とコードポイント順の 2 種類がある**ことを見落とし、**検証データにサロゲートペアを入れなかった**。サロゲートペアを主題にした検討の中で、である。

### 10.3 codex レビューで判明した設計上の破綻（R3 で追加）

**本書とその周辺で、私（Claude）が形式的な主張を誤った箇所が 2 つある。** どちらも codex が反例・コード経路の追跡で発見した。

#### ① B20 の「安全部分集合」は成立しない

> ~~指数時間には量化グループまたは量化された選択が必要~~

**誤り。** 量化グループも後方参照も無い次のパターンが指数時間になる（実測・Node v24）:

```
^a?a?a?…a?  aaa…a  b$        （a? を n 個、必須 a を n 個、末尾 b）
入力: a×(2n)

n=14: 0.1ms → n=18: 1.4ms → n=22: 24.8ms → n=26: 469.5ms
（既知の (a+)+$ とほぼ同じ増え方）
```

**量化された原子の連鎖だけで曖昧性が生じる。** グループは不要。R-1/R-2 はこれを通過させる。

**R-1/R-2 のような局所的な構文規則だけでは、曖昧性を健全に判定できない。** 完全な解析器を作る、非バックトラックエンジンを使う、または明らかに線形な別言語へ制限する必要がある。**B20 は現在の「安全部分集合」から見直す。**

**注**: 初回の再現試行では入力を `a×n` にしたため線形になり、私は「再現できない」と誤って判断しかけた。**入力長も軸である。**

#### ② `ORDER BY` の複合規則が全順序でないことを見落とした

§4.3 の循環（`2 < 10 < 1a < 2`）は、**B19 §3.1 で `GREATEST` について 4 回改稿して確定させた欠陥とまったく同じ形**である。

**「既存の仕組みを再利用する際は、その性質が新用途の要件を満たすか最初に確認する」という B19 の教訓を、既存コードの読み取りに適用できていなかった。** `compareSortKeys` を「ORDER BY の比較器」として読み、その内部が B19 で潰したのと同じペア単位モード判定であることに気づかなかった。

### 10.4 教訓

- **「A と B が一致するか」を確かめる前に、A と B が本当に別経路を通っているかを確認する**（EXPLAIN・コードで）。R1 の誤りの原因
- **軸を列挙する。** データの形（BMP / サロゲート）・`LIMIT`・入力長・入力順は、すべて軸である。R2 と §10.3① の原因
- **「比較器が全順序」と「その比較器を使う仕組み全体が全順序」は別物。** 複合規則全体で検証する
- **既知の欠陥パターンは、他の場所にも同じ形で存在すると疑う**（B19 の循環 → `ORDER BY` の循環）
