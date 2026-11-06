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
| 2b 選択肢の有効化 | 🔧 **実行経路は済み（2026-11-06）**＝`optionNames` の公開・同期の能力確認・実行前の preflight・読み書きの包み・クエリの変換。受入基準 AC1〜5 が通る。**`EXPLAIN` との併用は今は拒む**（2c で対応） |
| 2c EXPLAIN | ✅ **決着（2026-11-06）**＝**`canonical` との併用は拒む**（仕様。下の §7.1） |
| 3 ステータス | ✅ **済み（2026-11-06）**＝順序表を `canonical` のときだけキー側（既定名）へ。AC7 が通る |

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

### 2b でやったこと（2026-11-06。実行経路）

| # | 入れたもの | どこ |
|---|---|---|
| 1 | `optionNames?: "raw" \| "canonical"` | `CreateExecutionContextOptions`（`/flow`）と コアの `BatchExecuteOptions` |
| 2 | **同期の能力確認** | `createExecutionContext`（`getOptionNames` が無ければ `ArgumentError`。`/flow` は同期の関数なのでここでは表を作らない） |
| 3 | **最初の文を実行する前の非同期 preflight** | `executeManagedStatement` の冒頭（`ensureManagedOptionNameMaps`）。対象アプリは `analysis.statements[].appIds`。**アプリごとに 1 回**・`"raw"` では 1 回も呼ばない |
| 4 | **読み・書きの包み** | `wrapClientWithOptionNames`（`getRecords` / カーソルの `nextPage` / `postRecords` / `putRecords` / `upsertRecords` の `updateKey` も）。**全部 identity なら包みを通さない** |
| 5 | **クエリの変換** | 対応表を**クライアントに記号で載せて運ぶ**（`OPTION_NAME_MAPS`。`LIMIT_METRICS_SINK` と同じ仕組み）＝クエリを組み立てる所はどこでもクライアントを持っているので、引数を 19 か所に通さずに済み、spread で複製される包みを跨いでも保たれる。`serializeQueryForApp(input, optionNameQuerySource(client))` を**実行経路の 11 か所**に配線し、押し下げ AST のリテラル（`= 'x'` と `in (…)`）と生成述語の値を変換する |

**実行前の拒否は例外で返す**（文の結果ではなく）。`OptionNameMapError` は `executeManagedStatement` の
catch で**投げ直す**ので、呼び出し側は「実行して失敗した」と「実行する前に弾いた」を見分けられる
（依頼元の仕様 §13 と同じ考え）。

**`EXPLAIN` との併用は今は拒む**（`explainScript` が `ArgumentError`）。計画の文は「実際に送るクエリ」を
見せる場所なので、**既定名のクエリを計画として見せるのは誤り**。配線（計画を組み立てる関数へ対応表を通す）は
2c で入れる。依頼元が `explainScript` を呼ぶのは**設定画面の実行計画の表示だけ**で、そこは `optionNames` を
渡さないため影響はない。

**受入試験**（`src/flow-library/__tests__/b205OptionNamesCanonical.test.ts` 10 件）:
AC1（`WHERE` の既定名が表示名で押し下がる）・AC2（`SET` が通る＝検査は既定名・送るのは表示名）・
AC3（`GROUP BY` のキーが既定名で定義順）・AC4（`optionNames` なしは今までと同じ・`getOptionNames` を呼ばない）・
AC5（どちらの表にも無い値はそのまま通る）・恒等の項目は不変・アプリごとに 1 回・能力が無ければ拒否・
一意でない表は実行前に拒否（レコード 0 件）・`EXPLAIN` との併用拒否。

**分かったこと**: 選択肢の `=` は**値が `optionOrder` に無いと元から押し下げない**（JS 評価に落ちる）。
依頼書の「`= '表示名'` は素の `=` で送られて通る」は、実際には**押し下げずに JS で絞っていた**ため通っていた
（`canonical` では既定名が `optionOrder` にあるので**押し下げが効くようになる**＝読む量も減る）。

### 7.1 `EXPLAIN` は `canonical` と併用しない（2026-11-06 の決着）

**`optionNames: "canonical"` と `EXPLAIN` の併用を拒みます**（`explainScript` と、バッチの `EXPLAIN` 文の両方）。

- 理由: **計画の文は「実際に送るクエリ」を見せる場所**。`canonical` では実際に送るのは表示名なので、
  既定名の計画を見せると**計画と実行がずれる**（レビューの MAJOR 3 が求めた一致が崩れる）。
  表示名で出す配線（計画を組み立てる関数 9 本ほどへ対応表を通す）は**費用が大きく、今の利用者がいない**。
- 依頼元が `explainScript` を呼ぶのは**設定画面の実行計画の表示だけ**で、そこは `optionNames` を渡さない
  （`ksql-action/src/config/sql-check.ts` の `explainActionSql`）。**実害は無い**。
- 拒むのは **`createExecutionContext`（同期）** と `explainScript` の入口。
  **実行前に分かることは実行前に弾く**（B198 の「`confirm` と IMPORT の併用」と同じ形）。
  コアの実行時にも内部の守りを残してある（コアを直に叩く経路のため）。
- 将来 `EXPLAIN` でも出したくなったら、**別に起票**して計画の組み立てに対応表を通す
  （そのときは「実行のクエリと計画のクエリが一致する」契約の試験を足す）。

### 7.2 ステータスの正本の切り替え（段階 3）

`loadProcessStatusOrder` は `getProcessStatuses`（**`lang: "user"`**）の `state.name` から順序表を作るので、
**`"raw"` の正本は表示名**（`WHERE ステータス = 'みしょり'` が通り `'未処理'` が落ちる）。
`"canonical"` では**キー（既定名）に引き直す**（`AppOptionNameMap.status.toCanonical`）。
`"raw"` の動きは 1 行も変えていない（対応表が無ければ `state.name` のまま）。

**移行の注意（依頼元へ）**: 今 `みしょり`（表示名）と書いて動いていた設定は、`canonical` にすると
**`未処理`（既定名）に直す**必要があります。ここだけ正本の向きが変わります。

### 7.3 実装レビューで直したこと（2026-11-06。Codex。BLOCKER 1 / MAJOR 2 / MINOR 1）

記録は `kintone-plugin/work-link/codex-review-ksql-b205-impl-2026-11-06.md`。

**BLOCKER（確認済み。直した）＝実送信のクエリが `serializeQueryForApp` を通らない経路が 9 か所残っていた。**
`src/execute.ts` の中は全部通していたが、**converter と optimizer の中で `whereToKintone` を直に呼ぶ**
経路を数え落としていた（`dmlToKintone` の `updateToGetQuery` / `updateToGetQueryForArith` /
`deleteToGetQuery`、`selectToKintone` の `selectToKintoneParams` / `selectToFetchAllParams`、
`korderCursorQuery` の `buildKorderCursorQuery`、`joinPredicatePushdown` の
`serializeJoinPushdownItem`）。**つまり DML の対象選択・REST 窓つき `SELECT`・`KORDER` のカーソル・
JOIN の押し下げは既定名のまま送っていた**（canonical でも効いていなかった）。

- 直し方: 4 ファイルに `optionNames?: OptionQueryTranslatorSource` を通し、`serializeQueryForApp` に置き換え。
  `src/execute.ts` の呼び出し 11 か所と `buildRuntimeJoinPushdownPlan`（3 か所から呼ばれる）に配線。
  `UPDATE … FROM` のキーの `in` も `GeneratedPredicate` に。
- **二度と戻らないようにする**: `src/converter/__tests__/b205QuerySeamGuard.test.ts` で
  **ソースを検査**し、`whereToKintone` を**識別子として**使えるファイルを 2 つに固定した
  （`queryForApp.ts` と定義元）。**参照渡し**（`testSeam.serialize ?? whereToKintone`）も拾う
  ＝実際に残っていた迂回がその形だったため。行ではなく**ファイルで**固定する（無関係な変更で落ちないように）。

**送らない文字列は別の口にした**＝`serializeWhereForDisplay(where)`。使うのは 3 ファイルだけ（試験で固定）:

| 場所 | なぜ送らないか |
|---|---|
| `relativeDatePrefilterPlan` | 「関数が押し下がったか」の確かめに使い、**文字列は捨てる** |
| `relativeDatePushdownGuard` | 同じ確かめ ＋ `RelativeDatePlanNode.restQuery`（**消費先は `EXPLAIN` の表示行だけ**。grep で確認） |
| `relativeDateExplainLines` / `safeWhereToKintone`（`src/execute.ts`） | `EXPLAIN` と計画の表示。**canonical では `EXPLAIN` 自体を拒む**ので既定名が残ることもない |

**MINOR（直した）＝`appId` 省略の fail-closed が identity の canonical では効かない。**
対応表が全部 identity のときは包み（記号）を載せないので `canonicalOptionNames` が false になり、
「canonical なら必ず拒む」契約と食い違っていた。**記号の有無に頼るのをやめ、`appId` を型で必須**にした
（`SerializeQueryForAppInput.appId: number`。実行時も `Number.isSafeInteger` で確かめる）。
型を必須にした時点で `safeWhereToKintone` の 1 か所が**コンパイルエラーで見つかった**（表示専用に移した）。

**MAJOR（検査。直した）＝対応表の fail-closed が契約より弱い。** 足した検査:

| 拒むもの | どこ | なぜ |
|---|---|---|
| ステータスの `index` の重複・負・非整数 | `assertUsableOptionNamePairs` | 並びが決まらない。**連番性は求めない**＝ステータスは**キーで対にする**ので `index` は並べ替えにしか使わない（選択肢は位置で対にするので `namesByIndex` で連番まで求める） |
| `status.json` の `name` が空・非文字列 | `optionNameSourceFrom` | **既定名で埋めていた**ので「空の表示名を拒む」検査を迂回できた。`lang` 付きなら必ず名称が返るので、空は嘘のメタデータ |
| 表示言語の側に**同じ項目コードが 2 つ** | `buildAppOptionNameMap` | `Map` の後勝ちで黙って決まる |
| 同じ項目コードで**型が違う** | 同上 | 別のアプリか嘘のメタデータ。値の意味が変わる |
| ~~ステータスの対応が**一部だけ**（件数・取りこぼし）~~ | ~~`loadProcessStatusOrder`~~ | **やめた（§7.4）**。`getProcessStatuses` との突き合わせは**同じ endpoint の別の取得**で、「REST の追加呼び出しは無い」も誤りだった |
| `getFields` に `STATUS` があるのに対応表が無い（**この判定は誤り。§7.4 で直した**） | `buildAppOptionNameMap` | `form/fields` は**プロセス管理が無効でも `STATUS` を返す**ので、ふつうのアプリが全部拒まれていた |

**MAJOR（試験。直した）＝モックが本物より甘い。**
`b205OptionNamesStrict.test.ts`（11 件）の**番人モック**を足した＝**クエリや書き込みに既定名が現れたら
その場で `GAIA_CU03` / 400 を投げる**（本物の kintone と同じ厳しさ）。これで未変換の経路は自動的に落ちる。
REST 窓つき `SELECT`・`KORDER` のカーソル・`UPDATE` / `DELETE` の対象選択・`previewStatement`・
`VALIDATE ONLY`・`UPDATE … FROM` の対象側の絞り込みを固定した。

**canonical でも「表示名で書く」形は通さない**ことも試験に固定した（正本は既定名のまま）:
`SET 選択 = '表示名'` は `ERR_CHOICE_INVALID` で拒み、`WHERE 選択 = '表示名'` は 0 件になる
（`raw` では押し下げずに JS で絞っていたため当たっていた＝**移行で書き換えが要る所**）。
`optionOrder` を表示名側へ差し替えれば表示名も書けるが、**検査の網が実行する人の言語で変わる**ので採らない。

試験で分かった**元からの制限**（B205 の穴ではない。記録として試験に残した）:

- **DML の対象選択に選択肢の `=` は `raw` でも書けない**（`WHERE_RESIDUAL` で実行前に拒否）。
  `IN ('a1')` なら押し下がる。kintone の `query` が選択肢に `=` を持たないため。
- `UPDATE … FROM` の**結合キーに選択肢は使えない**（`does not support target join field type DROP_DOWN`）。

**ステータスの試験**（`b205OptionNamesStatus.test.ts` 3 件）: 既定名で書いた順序比較
（`ステータス >= '処理中'`）が通り読み戻す値も既定名、一部だけ返すクライアントで止まる、件数が合わなければ止まる。

**検証**: `tsc` の新規エラー 0（既存の `src/ui/desktop.ts` 10 件のみ）。
`jest 6814 passed`・失敗は **v3.90.0 のベースラインと同数・同内容**（8 suites / 45 tests＝
接続設定の無い環境の CLI / MCP）。B205 の試験は **7 ファイル 65 件**。

### 7.4 実装レビュー 2 回目で直したこと（2026-11-06。Codex。BLOCKER 1 / MAJOR 1 / MINOR 1）

記録は `kintone-plugin/work-link/codex-review-ksql-b205-impl2-2026-11-06.md`。
**1 回目の 4 件のうち 3 件は「閉じた」判定**で、`appId` の取り違え・`restQuery` の実送信・
ほかの未変換の境目は**追加では見つかりませんでした**。残る 1 件（対応表の検査）は
「不十分。別の穴が開いた」で、§7.3 で足した検査そのものが問題でした。

**BLOCKER（確認済み。直した）＝`STATUS` 項目の有無でプロセス管理を判定していた。**
`form/fields` は**プロセス管理を使っていないアプリでも `STATUS` 項目を返す**（`enabled: false`）。
`flattenFormFieldProperties` は `enabled` を落とすので、`canonicalFields` には必ず `STATUS` が入る。
その結果 §7.3 の検査は「`STATUS` があるのに `statusStates` が無い」として、**プロセス管理が無い
ふつうのアプリで `canonical` を必ず失敗させていた**（レコードを読む前に `ArgumentError`）。

- **実機で確認**（2026-11-06。アプリ 4392）: `app/status.json` は `enable: false` / `states: null`、
  `form/fields` は `ステータス`（`STATUS`・`enabled: false`）・`作業者`・`カテゴリー` を返す。
- 直し方: `OptionNameSource.processEnabled`（`app/status.json` の `enable`）を**正本**にした。
  無効なら `states` は見ない（無効でも状態を返す面があるため）。有効で `STATUS` 項目があるときだけ
  対応表を必須にする。
- **試験が本物より甘かった**のが原因（また同じ罠）。`b205` の 3 つのモックは `getFields` に `STATUS`
  項目を**返していなかった**。実 API の形（無効でも `STATUS` を返す）に直し、`/flow` 水準でも
  「プロセス管理が無効でも `canonical` が通る」を固定した。

**MAJOR（確認済み。直した）＝ステータスを別々に 2 回取っていて、突き合わせが同一スナップショットでない。**
`getOptionNames`（`status.json?lang=user`）はプロセス管理のキャッシュを埋めないので、
ステータスの順序が要るときに `getProcessStatuses` が**同じ endpoint を改めて**取っていた。
§7.3 の「同じ endpoint なので REST の追加呼び出しは無い」は**誤り**で、2 回の間に設定が変わると
**どちらも正しい応答なのに**件数・名称の突き合わせで落ちる形だった。

- 直し方（レビューの案どおり）: 順序表（既定名 → 並び）を **preflight の 1 枚のスナップショットから作る**
  （`AppOptionNameMap.statusOrder`）。`loadProcessStatusOrder` での突き合わせは**やめた**。
- さらに preflight が**プロセス管理のキャッシュも埋める**（`seedProcessStatusCacheFromOptionNames`）。
  `enable` の判定も同じ 1 枚になり、**REST の呼び出しが 1 回減る**（試験で `getProcessStatuses` の
  呼び出しが 0 件になることを固定）。
- 「一部だけ返す custom client」は**信頼境界として受け入れる**（1 回目のレビューも `lang` 無視や
  別アプリの嘘は検知できないとしている）。`/flow` の内製クライアントは `status.json` を丸ごと返す。

**MINOR（対応しない。2026-11-07 Takashi「そのままで OK」）＝ソース検査は「手組みクエリの新設」を防げない。**
今の番人は `whereToKintone` と `serializeWhereForDisplay` の参照先を固定するが、
`query: \`${field} in (…)\`` と**手で組み立てる新しい経路**は止められない。
レビューの案は**送信クエリを branded type にする**（`type AppQuery = string & { __appQuery }`。
内部の `fetchAll` / `fetchRecordsForSharedPlan` / カーソル起動だけが受け取る）。
**入れません**＝現時点で手組みの実送信クエリは `$id` の数値条件だけで**選択肢の穴ではなく**、
`whereToKintone` を通す類の退行は §7.3 のソース検査で止まる。送信経路の型を広く触る費用に対して
守れる範囲が狭い。将来この形の穴が実際に出たら、そのときに起票する。

**検証**: `tsc` の新規エラー 0。`jest 6816 passed`・失敗はベースラインと同数・同内容
（8 suites / 45 tests）。B205 の試験は **7 ファイル 67 件**。

### 7.5 実装レビュー 3 回目（2026-11-07。Codex。BLOCKER 0 / MAJOR 2 / MINOR 3）

記録は `kintone-plugin/work-link/codex-review-ksql-b205-impl3-2026-11-07.md`。
**2 回目の 3 件は全部「閉じた」判定**（branded type を入れない判断も支持された）。
依頼の芯は「**言語に依る名称の集合・順序をどこから作っているかの全数確認**」で、
19 か所の表が返ってきた。要対応は 2 件。

**こちらで先に見つけて直した穴（投げる前）: `ORDER BY ステータス` が canonical で壊れていた。**
項目意味解決が `process.states`（**表示名**）から `optionOrder` を直に作っていたので、
読み戻した既定名が当たらず「未知の帯」に落ちていた（`DESC` で並ばない）。
`loadProcessStatusOrder` から取る形に直した。**AC8 は選択肢と `WHERE` 経由のステータス比較しか
踏んでいなかった**のが見落としの原因。

**MAJOR 1（直した）＝typed pushdown の `STATUS` の存在集合だけ表示名のままだった。**
`loadTypedPushdownMeta` が `process.states[].name`（表示名）で集合を作っていたため、
canonical の AST のリテラル（既定名）が「実在しない値」と判定され、**押し下げの対象から外れて
全件取得に退行**する（`classifySupportedLeaf` が `fieldOptions.has(値)` を要求する）。
JOIN では読み取り上限に当たって失敗し得る。単一アプリの `SELECT` が通っていたのは、
`=` → `IN` の正規化が先に `loadProcessStatusOrder`（既定名）で行われるためで、**無害ではなかった**。

- 直し方: 集合も `loadProcessStatusOrder` のキーから作る（`"raw"` は表示名・canonical は既定名）。
- 試験: **2 アプリ JOIN**（アプリ 1 は `みしょり`、アプリ 2 は `未A` と**別の表示名**）で
  それぞれの表示名で押し下がることを固定。**直す前に落ちることも確かめた**（番人として有効）。

**MAJOR 2（直さない。2026-11-07 Takashi）＝選択肢の既定名側と表示名側を、別の revision から index で結べる。**
既定名側は `getFields`、表示名側は後続の `getOptionNames`（`form/fields?lang=user`）で**別々に取得**し、
どちらも `revision` を捨てている。2 回の取得の間に選択肢を**並べ替えて**デプロイされると、
件数・`index` の全単射検査を通りながら**誤った対応表**ができる（拒否ではなく**誤変換**）。
ステータス側で直した「別のスナップショットを比べる」問題の、選択肢版。

- 窓は「2 本の HTTP 呼び出しの間にアプリを更新してデプロイする」ミリ秒なので、起こる確率は極小。
  ただし失敗の形が**黙って違う値を書く**なので、レビューは MAJOR（リリース前）としている。
- 直し方の案（**追加の通信なし**。入れないが、必要になったときのために残す）: `/flow` のクライアントが
  `getFields` のときに `form/fields` の `revision` を**アプリごとに覚えておき**、`getOptionNames` の
  `lang: "user"` の `revision` と**一致しなければ `ArgumentError`**。覚えている revision は
  「キャッシュに入っている既定名側を作った応答」のものなので、比べるべき 2 枚をちょうど比べられる。
- **決定（2026-11-07 Takashi「直さない」）**: 窓が極小なので入れない。**実機確認の項目にだけ残す**
  （設定変更中の取得で誤変換が起きないか）。この形の不具合が実際に出たら、上の案で起票する。

**MINOR 3 件（全部対応）**

| 指摘 | 直したこと |
|---|---|
| 公開の `FlowKintoneClient` に `getOptionNames` が無く、**自作クライアントでは canonical を実装できない** | 型を公開するのではなく、**資料に「自作のクライアントでは `"canonical"` を使えない」と明記**（README と言語リファレンス）。信頼境界の判断（§7.4）と揃える |
| `processStatusCalls === 0` は **`app/status.json` の通信 0 ではない**（preflight が 1 回呼ぶ） | 「**メソッドの呼出し回数**で通信回数ではない」と資料に明記。計数の意味は変えない（互換） |
| プロセス管理が**無効**の試験のレコードに `STATUS` が入っていた（実測では**出ない**） | 無効のときはモックの行から `STATUS` を外し、`SELECT *` の列にも出ないことを固定 |

**キャッシュの相乗り・`processEnabled` の判定・`"raw"` の非退行**は「確認済みで問題なし」。
プロセス管理を**後から無効化した**アプリも、既存の実測（B88 の 3 アプリ）では
レコードに `STATUS` / `STATUS_ASSIGNEE` が出ないので穴は無い（実機確認に残す）。

**検証**: `tsc` の新規エラー 0。`jest 6822 passed`・失敗はベースラインと同数・同内容
（8 suites / 45 tests）。B205 の試験は **7 ファイル 73 件**。

### 段階 1 でやったこと（2026-11-06）

**`src/converter/queryForApp.ts`（新規）＝クエリの条件部を作る唯一の口。**

```ts
serializeQueryForApp({ appId, where, generated })   // 段階 2 で変換器を第 2 引数に足す
```

- **生成述語は文字列になる前に `{ field, op, values }`** で渡す（`GeneratedPredicate`。
  `in` / `not in` / `=` / `>=` / `<=`）。文字列の置換はしない。
- 値の引用（`\` と `"` の退避）も `quoteKintoneValue` に 1 つだけ置いた
  （`sqlQuote`・`whereToKintone` の中・`joinKeyPrefilter` の注入関数に 3 つ散っていた）。
- **`appId` は必須にしていない**（段階 1 の時点）＝アプリが文脈から決まらない表示専用の経路が
  残っているため。**段階 2 の変換器は `appId` の無い入力を拒む**（fail-closed）。
  → **実装レビューの後に必須へ変えた**（§7.3）。表示専用は `serializeWhereForDisplay` に分けた。

**通した経路（全部）**

| 経路 | 直した所 |
|---|---|
| **JOIN キーの押し下げ**（BLOCKER） | `buildJoinKeyPrefilterQueries`（文字列を返す）→ **`buildJoinKeyPrefilterPredicates`（述語を返す）**。実行（`src/execute.ts:8492`）と **EXPLAIN（`13147`）の両方** |
| **非ネイティブ `UPSERT` の既存照合**（BLOCKER） | `in` のチャンクと、空文字キーの行ごとの `=` |
| ふつうの `WHERE`・DML の `WHERE`・集計の `totalCount`・共有プラン・`APPLY` の親の選択 | **`src/execute.ts` の**直呼びを置き換え（**19 か所**）。`appId` を明示に渡す |
| `EXPLAIN` の表示 | 同じ口に統一（`safeWhereToKintone` にも `appId` を足して 5 か所から渡す） |

**訂正（2026-11-06。実装レビュー）**: ここを「`whereToKintone` の直呼びを**全廃**」と書いていたが、
**数えていたのは `src/execute.ts` の中だけ**だった。converter（`dmlToKintone` / `selectToKintone` /
`korderCursorQuery`）と optimizer（`joinPredicatePushdown`）に**実送信の 9 か所が残っていた**
（実装レビューの BLOCKER）。§7.3 で塞ぎ、**ソースを検査する試験**で固定した。
`safeWhereToKintone` も表示専用だったので `appId` を外した。

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
