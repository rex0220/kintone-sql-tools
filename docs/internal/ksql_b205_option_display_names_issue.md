# B205 選択肢とステータスの「言語ごとの表示名」を、既定の名称を正本にして境目で変換する

- 状態: 🔧 **段階 1（前提整備）に着手（2026-11-06）**。仕様は確定・設計レビュー済み（**BLOCKER 1 / MAJOR 5 / MINOR 3 を全件反映**）。**v3.91.0 見込み**
- 種別: 機能（**オプトイン**。既定 `"raw"` は今とまったく同じ＝純加法）
- 優先: 中（依頼元の Ver.1 は「資料 ＋ 保存で止める ＋ 迂回策」で出せる）
- 版: minor（v3.91.0 想定）。**規模 L**
- 上流の依頼（正）: kintone-plugin の work-link `kSQLエンジンへの依頼-20261106-KJ8-選択肢の言語ごとの表示名.md`（依頼 KJ-8）。
  **回答が設計の正本**＝同じ場所の `kSQLエンジンからの回答-20261106-KJ8-選択肢の言語ごとの表示名.md`。
  設計レビューは `codex-review-ksql-b205-2026-11-06.md`
- 関連: [B203](ksql_b203_array_variable_injection_issue.md)（外部注入）、[B204](ksql_b204_assert_message_variable_issue.md)（KJ-7。同じ 3 か国語対応の流れ）

## 1. なぜ必要か

kintone の項目に「**言語ごとの表示名**」を設定すると、**API が受け付ける値・返す値が利用者の表示言語で変わる**。
エンジンは `form/fields` を **`lang` なし（＝既定の名称）** で取るので、**エンジンが知る選択肢と
kintone が受け付ける値がずれる**。

| 書き方 | 今どうなるか |
|---|---|
| `WHERE 選択肢 = '既定名'` | `optionOrder` にあるので `in ("既定名")` に畳んで押し下げ → **kintone がクエリエラー** |
| `WHERE 選択肢 = '表示名'` | 畳まれず素の `=` で送られて**通る**（ただし 1 言語の利用者だけ） |
| `SET 選択肢 = '既定名'` | 検査は通る → **kintone が 400** |
| `SET 選択肢 = '表示名'` | **エンジンが `ERR_CHOICE_INVALID`**（`src/core/dmlValidation.ts:103-107`）→ kintone に届かない |
| `ORDER BY 選択肢`（既定のモード） | 読んだ値（表示名）が `optionOrder` に無く「未知の帯」に落ちて**定義順にならない**（`src/core/scalarCompare.ts:106-114`） |
| `KORDER BY 選択肢` | **今も正しい**（押し下げるのは項目コードだけ） |

**SQL はプラグインの設定に保存される文字列**で、書くのは管理者 1 人・動かすのは多言語の利用者。
**全員で動く 1 つの値が存在しない**のが問題の本体で、呼び出し側では閉じられない。

**kintone 側に「既定名でやり取りする」指定は無い**（確認済み）。`records.json` に `lang` は無く、
公式文書は「**レコードのデータの言語は認証方式によって決まる**」（API トークン → `Administrator` の表示言語、
それ以外 → 実行したユーザーの表示言語。「ブラウザーに従う」設定なら `Accept-Language`）と書いている。
未設定の言語を選んでも**既定名には落ちない**（設定済みの他言語に落ちる）。

## 2. 出すもの（要点。全文は回答 §3）

1. **オプトイン 1 つ**: `optionNames?: "raw" | "canonical"`（既定 `"raw"`）。置き場所は**実行側**
   （`createExecutionContext` / `explainScript`）。
   **公開面は `/flow` だけに閉じる**（2026-11-06 に変更。下の「§2.1 公開面を `/flow` に閉じた理由」）。
2. **クライアントに任意の口** `getOptionNames?(appId)`。返すのは**最終の対応表ではなく、コアが検算できる生のメタデータ**
   （`lang: "user"` の `form/fields` と、**キーを保てる** status）。`"canonical"` なのに口が無ければ `ArgumentError`。
   **`createExecutionContext` は同期**なので、ここでできるのは能力の存在確認まで＝**表は最初の実行前に非同期 preflight**。
3. **4 つの境目**: 読んだ値（表示名→既定名）／クエリの値（既定名→表示名）／書き込む値（既定名→表示名）／
   `optionOrder` は**既定名のまま**（`ERR_CHOICE_INVALID` を緩めない）。
   **検査（既定名）→ 境目で変換（表示名）→ kintone** の順序で、`SET` が通るようになる。
4. **クエリの値は「1 つの直列化の口」に集める**（§3 と下の「BLOCKER だったところ」）。
5. **ステータスも対象**（読み・クエリ・順序表）。`app/status.json` は `lang` を受け、**キーが既定名・`name` が表示名**。
   今のエンジンは `state.name`（`lang: "user"`）で順序表を作るので**ステータスだけ表示名が正本**＝`"canonical"` のときだけキー側に切り替える。
6. 対応表が一意に決まらない形（**表示名の重複**・空・`index` の不一致・既定名との交差・循環）は**表を作る時点で `ArgumentError`**。
7. 知らない値は**そのまま通す**（言語ごとの表示名を設定する前に入った値で業務を止めない）。
8. `EXPLAIN` は**実行と同じ口**を使う。**`resolveMetadata: false` と `"canonical"` の併用は拒否**。

### 2.1 公開面を `/flow` に閉じた理由（2026-11-06。段階 2 の実装中に決めた）

回答（KJ-8）では「CLI・MCP にも同じ名前で足す」と書いたが、**`/flow` だけに閉じる**に変えた。
B203（配列の注入を `/flow` だけにした）と同じ判断で、根拠は 2 つ。

1. **クライアントを包む所が 10 か所あり、`getOptionNames` を落とす形が多い。**
   `KintoneClient` を**メソッドの明示列挙**で包んでいる所は、新しい任意の能力を**黙って落とす**。
   実測で数えたところ（`getProcessStatuses:` の出現で検索）**10 か所**あり、Codex が挙げた 2 つより多かった。

   | 包み | 形 | `/flow` の経路か |
   |---|---|---|
   | `wrapClientWithMetrics`（`src/execute.ts`） | **明示列挙** → **直した** | はい |
   | `routeClient`（`src/flow-library/index.ts`。論理アプリ） | **明示列挙** → **直した**（`appId` も呼び出し側の番号に戻す） | はい |
   | `wrapClientWithSearchAbort` / `wrapClientWithCursorScope` / `wrapClientWithWriteGate` / `wrapClientWithChunkWrittenCallback` | `{ ...client, 上書き }`＝**spread なので自動で保たれる** | はい |
   | `engine-library/readonlyClient.ts` / `cursorScope.ts` / `logicalApps.ts`・`cli/index.ts`（2 か所）・`api/requestGate.ts`・`node/runtime.ts` | 明示列挙（未対応） | **いいえ**（`/engine`・CLI・MCP・Node の経路） |

   → **`/flow` は 2 か所直すだけで閉じる**。ほかの面まで広げると、落とし穴を 6 か所増やすことになる。

2. **CLI・MCP は認証方式が違い、データの言語が別に決まる。**
   公式文書のとおり **API トークン認証はレコードのデータの言語が `Administrator` の表示言語**になる。
   `lang: "user"` が同じ言語に解決されるかは**面ごとに実測しないと言えない**（回答 §3.2 の申し送り）。
   実需のある依頼元（kSQL アクション）は `/flow` を使うので、**先に `/flow` だけ出す**。
   CLI・MCP・`/engine` は、実需が出たときに**面ごとの実測つきで**別に起票する。

**したがって**: **口を実装するのも `/flow` の `createKintoneClient` だけ**にした。
`/engine`・CLI・プラグインの内製クライアントには**足さない**（使わない能力を公開面に置かない）。

- とくに `/engine` の `ReadonlyKintoneClient` には「**read のメソッドは 6 つだけ**」を固定する番人の試験がある
  （`src/engine-library/__tests__/browserClient.test.ts`）。実装を足すと落ちる＝**設計の意図どおりの警告**だったので、
  実装ごと引っ込めた（`optionNames` を `/engine` に出すときに、その試験と一緒に見直す）。
- `KintoneClient`（コアの型）にだけ**任意のメソッド**として宣言する（コアが呼ぶため）。
  自作クライアントは実装しなくてよく、`"canonical"` を渡したときだけ実行開始前に拒まれる。

## 3. BLOCKER だったところ（設計レビュー。検算済み）

**kintone へ送る選択肢の値は AST だけから出てこない。**

| 経路 | 事実 |
|---|---|
| **JOIN キーの押し下げ** | 読んだ値から `選択肢 in ("…")` を**直接組み立てる**（`src/core/optimization/joinKeyPrefilter.ts` の `buildJoinKeyPrefilterQueries`、呼び出しは `src/execute.ts:8490` 付近）。しかも **JOIN キーの対象型に `DROP_DOWN` / `RADIO_BUTTON` / `CHECK_BOX` / `MULTI_SELECT` / `STATUS` が明示で入っている**（同 `JOIN_KEY_EMPTY_IN_FIELD_TYPES`） |
| 非ネイティブ `UPSERT` の既存照合 | `キー in (…)` / `キー = …` を直接組み立てる（`src/execute.ts:8339` / `8351`）。ただし kintone の `updateKey` は重複禁止の項目だけで**選択肢は重複禁止にできない**ので実害は小さい |

→ 「`whereToKintone` の手前で AST を変換」では、**ローカルの JOIN キーは既定名・押し下げだけ既定名で送信**という
**一部だけ canonical な中間状態**になる。だから**アプリを知っている直列化の口を 1 つ作り、そこを全部通す**。
**生成述語は文字列になる前に `{ field, op, values }` の形で渡す**（文字列の置換はしない）。

## 4. 段階分け

| 段階 | 中身 | 公開 |
|---|---|---|
| **1** | **前提整備**＝app を知るクエリ直列化の口・生成述語の構造化・レコードの再帰の変換・対応表の契約と検査 | **しない**（内部の部品だけ） |
| 2 | **選択肢**＝読み・**すべてのクエリ生成**・すべての書き込みを**同時に**有効化 ＋ 包みの配線 | ここで `optionNames` を公開 |
| 3 | **ステータス**＝読み・クエリ・順序表の切り替え・移行の案内 | 追加で公開 |

**「読みだけ」「ふつうの `WHERE` だけ」は公開しない**（一部だけ既定名という最も危ない状態になる）。

**段階 1 は B205 を入れると決める前でも価値がある**＝今は JOIN キーと `UPSERT` がそれぞれ独自にクエリ文字列を
組み立てていて、**`EXPLAIN` が見せるクエリと実際に送るクエリがずれる余地が B205 と無関係に存在する**。
直列化の口を 1 つにするのは、`canonical` を公開しなくても回帰のリスクを下げる片付け。

## 5. 実装で落とさないこと（レビューの MAJOR 5）

| 直す所 | 何が起きるか |
|---|---|
| `routeClient`（論理アプリ。`src/flow-library/index.ts:406-425`） | メソッドを**明示列挙**しているので新しい能力が**黙って落ちる**。**依頼元は論理アプリ（`LAPP_`）で書くので、ここが落ちると `canonical` が効かない** |
| `wrapClientWithMetrics`（`src/execute.ts:1034`） | 同じく明示列挙。**包む順序を固定**し、能力が保たれることを試験で押さえる |
| `loadUpdateModeSnapshots`（`src/execute.ts:841`。公開オプション） | クライアントの包みを**迂回してレコードを注入できる**。`VALIDATE` の更新後の像だけ表示名のまま残る恐れ |
| サブテーブルの値 | 実体は `value[].value[項目].value` の**入れ子**（`src/execute.ts:12109` 付近はキャスト）。**明示の再帰関数**にする |
| `"raw"` の非退行 | 入口で分岐を固定し、loader・変換の包み・新しいキャッシュに**一切入らない**。既存の golden（SELECT / DML / JOIN / STATUS / EXPLAIN / metrics）をそのまま流す |
| 面ごとの言語の解決 | **API トークン認証はデータの言語が `Administrator` の表示言語**。`lang: "user"` が同じ言語に解決されるかを**面ごとに実測してから**段階 2 を公開する（揃わない面は `canonical` を拒否） |

## 6. 受入基準（依頼 KJ-8 §6 ＋ こちらで追加）

1. `WHERE 選択肢 = '既定名'` が hit（今はクエリエラー）。
2. `SET 選択肢 = '既定名'` が書ける（今は `ERR_CHOICE_INVALID`）。
3. `GROUP BY 選択肢` のキーが既定名（今は表示名）。
4. 言語ごとの表示名を**設定していない**アプリは `"raw"` と**まったく同じ結果**。
5. どちらの表にも無い値（設定前に入った値）は**例外にならず、そのまま通る**。
6. 利用者の表示言語を 日 → 英 → 繁體 と変えても 1〜3 が同じ。
7. （追加）`ステータス = '既定名'` が hit。
8. （追加）**`ORDER BY 選択肢` が定義順になる**（`KORDER BY` は今も正しく、変わらない）。
9. （追加）**選択肢を JOIN のキーにした形**（別アプリ）が通る＝§3 の穴。

## 7. 進み具合

| 段階 | 状態 |
|---|---|
| 1 前提整備 | ✅ **済み（2026-11-06）**＝クエリの口・レコードの再帰の変換・対応表の契約と検査。**公開面は 1 つも変えていない** |
| 2a クライアントの口 | ✅ **済み（2026-11-06）**＝`KintoneClient.getOptionNames?`・`/flow` の実装・`routeClient` と metrics の包みへの転送・公開面を `/flow` に閉じる判断（§2.1） |
| 2b 選択肢の有効化 | 📋 **未着手（次はここ）**。**5 つが同時に入って初めて意味を持つ**（下） |
| 3 ステータス | 📋 未着手 |

### 2b は分けられない 1 塊（2026-11-06 に着手して分かったこと）

**`optionNames` の型だけ先に出すのは罠**なので戻した＝`"canonical"` を渡せるのに変換が効かない状態は、
この設計がいちばん避けたい「**黙って一部だけ canonical**」そのものになる。

**なぜ分けられないか: クエリの変換が同期だから。**
`serializeQueryForApp` はクエリの組み立て時に**同期**で呼ばれるので、**対応表がその時点でメモリにある**必要がある。
つまり「レコード API を呼ぶ直前に遅延で取る」ではなく、**文を実行する前に preflight で対象アプリ分を作る**。
`createExecutionContext` は**同期**なので（レビューの MAJOR）、そこでできるのは能力の確認だけで、
preflight は**最初の `executeStatement` / `previewStatement` の冒頭**に置く。

| # | 2b で同時に入れるもの |
|---|---|
| 1 | `optionNames?: "raw" \| "canonical"` の型（`CreateExecutionContextOptions` と `ExplainScriptOptions`）＋ コアの `BatchExecuteOptions` |
| 2 | `createExecutionContext` の**同期の能力確認**（`getOptionNames` が無ければ `ArgumentError`） |
| 3 | **最初の実行前の非同期 preflight**（対象アプリ分の対応表を作る。`identity` なら以降は素通し） |
| 4 | **読み・書きの包み**（`mapRecordsOptionValues` を使う。`getRecords` / カーソルの `nextPage` / `postRecords` / `putRecords` / `upsertRecords`。**包む順序を固定**） |
| 5 | **クエリの口に変換器**（`serializeQueryForApp` の第 2 引数・押し下げ AST のリテラル変換・**`appId` 省略を拒む fail-closed**・`relativeDateExplainLines` に app を通す） |

続いて `EXPLAIN` の扱い（`resolveMetadata: false` との併用拒否・実行と計画の一致の試験）と、
`/flow` 水準の受入試験（§6 の AC1〜9）。**段階 1 の 3 本分くらいの量**。

### 段階 1 でやったこと（2026-11-06）

**`src/converter/queryForApp.ts`（新規）＝クエリの条件部を作る唯一の口。**

```ts
serializeQueryForApp({ appId, where, generated })   // 段階 2 で変換器を第 2 引数に足す
```

- **生成述語は文字列になる前に `{ field, op, values }`** で渡す（`GeneratedPredicate`。
  `in` / `not in` / `=` / `>=` / `<=`）。文字列の置換はしない。
- 値の引用（`\` と `"` の退避）も `quoteKintoneValue` に 1 つだけ置いた
  （`sqlQuote`・`whereToKintone` の中・`joinKeyPrefilter` の注入関数に 3 つ散っていた）。
- **`appId` は必須にしていない**＝アプリが文脈から決まらない表示専用の経路が 1 か所だけ残っている
  （`relativeDateExplainLines`。`src/execute.ts:13588`）。**段階 2 の変換器は `appId` の無い入力を拒む**
  （fail-closed）ので、そのときに呼び出し元（3 か所）からアプリを通す。

**通した経路（全部）**

| 経路 | 直した所 |
|---|---|
| **JOIN キーの押し下げ**（BLOCKER） | `buildJoinKeyPrefilterQueries`（文字列を返す）→ **`buildJoinKeyPrefilterPredicates`（述語を返す）**。実行（`src/execute.ts:8492`）と **EXPLAIN（`13147`）の両方** |
| **非ネイティブ `UPSERT` の既存照合**（BLOCKER） | `in` のチャンクと、空文字キーの行ごとの `=` |
| ふつうの `WHERE`・DML の `WHERE`・集計の `totalCount`・共有プラン・`APPLY` の親の選択 | `whereToKintone` の直呼びを全廃（**19 か所**）。`appId` を明示に渡す |
| `EXPLAIN` の表示 | 同じ口に統一（`safeWhereToKintone` にも `appId` を足して 5 か所から渡す） |

**検証**: `jest 6749 passed`・失敗は **v3.90.0 のベースラインと同数・同内容**（8 suites / 45 tests＝
接続設定の無い環境の CLI / MCP）。`tsc` の新規エラー 0。**段階 1 は文字列が今までとまったく同じ**
（変換器がまだ無いので、出力はバイト一致）。

**`src/core/recordOptionValues.ts`（新規）＝レコードの値を項目ごとに変換する明示の再帰関数。**

- 読み（表示名 → 既定名）と書き（既定名 → 表示名）で**同じ関数**を使う（向きは `translate` が決める）。
- **サブテーブルの入れ子**（`value[].value[項目].value`）を辿る。行の `id` は保つ。
  入れ子を取りこぼすと「親だけ既定名・子は表示名」という一部だけ canonical な状態になる（レビューの指摘）。
- `CHECK_BOX` / `MULTI_SELECT` は**要素ごと**。`USER_SELECT` などの `{ code }` の配列・`null`・数値は触らない。
- **変わらなければ同じ参照を返す**（大きな結果で無駄な複製をしない）。元のレコードは書き換えない。
- 試験 9 件（`src/core/__tests__/b205RecordOptionValues.test.ts`）。

**`src/core/optionNameMap.ts`（新規）＝対応表の契約と検査。**

- `buildAppOptionNameMap(appId, canonicalFields, source)`＝**既定名の側はコアが既に持っている
  `getFields` を再利用**し、表示名の側（クライアントの生のメタデータ）と **`index` で突き合わせる**。
- **一意に決まらない形は実行前に `ArgumentError`**（レコードを 1 件も読まない）: 別アプリの表・
  選択肢の項目が足りない・選択肢の数が違う・`index` の欠落 / 重複 / 負・**表示名の重複**（逆変換が多対一）・
  表示名が空・**既定名と表示名の交差**（交換・循環・恒等との衝突）。
  交差を拒む理由は「向きが決まらない」ではなく、**言語ごとの表示名を設定する前に入った生の値と
  表示名を区別できなくなる**から。
- **`identity`**（言語ごとの表示名が 1 つも無い）を返すので、段階 2 で**包み自体を通さない**判断に使える。
- ステータスは `app/status.json` の**キー（既定名）と `name`（表示名）**を `index` 順で入れる。
- 試験 14 件（`src/core/__tests__/b205OptionNameMap.test.ts`）。
