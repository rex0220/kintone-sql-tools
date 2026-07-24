# B67 — kintone REST クエリ関数（相対日付・組織）対応 評価

- 起票日: 2026-07-24
- ステータス: **📝【A: 評価】起票**（仕様前・優先度未確定）
- 種別: 改善（新機能・WHERE 述語）
- 効果種別: 機能
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B67
- 参照: [kintone クエリの関数](https://cybozu.dev/ja/kintone/docs/overview/query/#function)
- 関連: B32（WHERE 型×演算子能力表・v3.0.0）／B26（型付き比較）／横断 [文字列の扱い](ksql_string_semantics.md)／[LIKE を JS 判定へ統一](ksql_like_js_default_optin_pushdown_spec.md)

## 1. 提案

kintone の REST クエリで使える**関数**（下記）を kSQL の `WHERE` でも使えるようにする。

```sql
SELECT * FROM APP730
WHERE 作成日時 < FROM_TODAY(5, DAYS)
```

## 2. 現状

kSQL が対応している kintone 専用関数は **`TODAY()` / `NOW()` / `LOGINUSER()` の3つだけ**（`KintoneFuncNode`・`src/types/ast.ts:596`・`whereToKintone.ts` で押し下げ、`evalWhere.ts:429 resolveKintoneFunc` で client 評価）。**それ以外は未対応**（実挙動で確認: `FROM_TODAY(5, DAYS)` / `THIS_MONTH()` は `PARSE_ERROR`、`TODAY()` は受理）。

kintone が提供するが kSQL 未対応の関数:

| 分類 | 関数 |
|---|---|
| 相対日付 | `YESTERDAY()` / `TOMORROW()` / `FROM_TODAY(n, DAYS\|WEEKS\|MONTHS\|YEARS)` |
| 週 | `THIS_WEEK([曜日])` / `LAST_WEEK([曜日])` / `NEXT_WEEK([曜日])` |
| 月 | `THIS_MONTH([1-31\|LAST])` / `LAST_MONTH([...])` / `NEXT_MONTH([...])` |
| 年 | `THIS_YEAR()` / `LAST_YEAR()` / `NEXT_YEAR()` |
| 組織 | `PRIMARY_ORGANIZATION()` |

（`TODAY`/`NOW`/`LOGINUSER` は対応済み。）

## 3. 固有価値

- **「今月」「5日前」「先週月曜以降」等の相対日付フィルタ**を SQL で自然に書ける。ダッシュボード（B66）やレシピで頻出。
- **サーバ評価による効率的な押し下げ**。関数を kintone クエリへそのまま出せば、kintone が**リクエスト時刻・タイムゾーン・ログインユーザー基準**で評価し、絞り込み後だけ取得する（転送量減）。
- `LOGINUSER()` / `PRIMARY_ORGANIZATION()` は**サーバ側のユーザー文脈**が要るため、client 側だけでは再現困難。押し下げが本来の姿。

## 4. 設計上の中心論点＝評価戦略

kSQL は v2.0.0 以降「LIKE は JS 評価・押し下げは安全な範囲だけ」の方針で、多くを client 評価する。一方これらの関数は**本来 kintone クエリ構文＝サーバ評価**である。ここに緊張がある。

### 4.1 選択肢

- **A: 押し下げネイティブ（推奨・Phase1）** — 関数を parse し、既存 `TODAY/NOW/LOGINUSER` と同様に **kintone クエリへ素通し**して kintone に評価させる。押し下げできない位置（FULL_SCAN 必須の複雑クエリ・JOIN 後の残余評価等）では **client 評価にフォールバックせず fail-closed 拒否**（誤評価を避ける）。KLIKE のネイティブ素通しと同じ思想。
- **B: client 評価も実装** — 相対日付を kSQL 側で計算（`FROM_TODAY(5,DAYS)` = 今日+5日）。FULL_SCAN でも使えるが、**kintone のセマンティクス再現が難所**（§4.2）。
- **C: A＋B 併用** — 押し下げ可能なら A、不可なら B。最も柔軟だが実装最大・二経路の一致検証が重い。

推奨は **A（押し下げネイティブ）を Phase1**。相対日付の実需の大半は単純 WHERE で押し下げ可能。client 評価（B）は実需とセマンティクス確度を見て Phase2。

### 4.2 client 評価（B）の難所＝セマンティクス忠実性

client で計算すると kintone と食い違うリスク:

- **タイムゾーン**: kintone はドメインのタイムゾーン基準。client（ブラウザ/Node）のローカル TZ と一致しない場合がある。
- **週の開始曜日 / 月末**: `THIS_WEEK(月曜)` の週境界、`THIS_MONTH(LAST)` の月末など、kintone 定義に厳密一致させる必要。
- **`LOGINUSER()` / `PRIMARY_ORGANIZATION()`**: ユーザー/組織文脈。plugin は `kintone.getLoginUser()` が使えるが、Node/MCP は取得手段がない（現状 `LOGINUSER` は Node/MCP で空文字）。B54（User API）と相乗の可能性。

A（押し下げ）ならこれらは**すべて kintone が評価**するので忠実性の問題は発生しない。

### 4.3 型・位置の制約

- 相対日付関数は **DATE/DATETIME/作成日時/更新日時** フィールドとの比較のみ。`PRIMARY_ORGANIZATION()` は組織系フィールド。型不一致は取得前拒否（B32 の型×演算子能力表を拡張）。
- 使用位置は kintone が許す **WHERE 比較のオペランド**に限定（任意のスカラー式内・SELECT 出力・ORDER BY 等へは広げない＝kintone クエリ関数の制約に合わせる）。

## 5. 実装の見通し（A: 押し下げネイティブ）

- **lexer/parser**: 既存 `KintoneFuncNode`（TODAY/NOW/LOGINUSER）を、引数を取る相対日付関数へ一般化。`FROM_TODAY(n, UNIT)`・`THIS_WEEK([曜日])` 等の引数文法を追加。ソフトキーワード優先で予約語増を最小化。
- **AST**: `KintoneFuncNode` に関数名の union 拡張＋引数フィールド。
- **whereToKintone**: 関数を kintone クエリ表現へ serialize（`作成日時 < FROM_TODAY(5, DAYS)`）。既存の TODAY/NOW/LOGINUSER 素通しの隣に追加。
- **押し下げ能力（B32）**: 型×演算子×関数の許可表を拡張。押し下げ不可の文脈では fail-closed（client 評価しない）。
- **catalog/docs**: B55/B60 の関数カタログに contextual 群として追加・drift guard・語数 guard を同期。言語リファレンス §（日付/WHERE）に反映。
- **面**: Node/CLI/MCP/plugin で同一（押し下げは engine 側の serialize）。`LOGINUSER`/`PRIMARY_ORGANIZATION` の client 文脈差は A では無関係（kintone 評価）。

## 6. 論点・要判断

1. **評価戦略**: A（押し下げのみ・推奨）／B（client 評価も）／C（併用）。押し下げ不可時の挙動（fail-closed 拒否 か client 評価）。
2. **スコープ**: 相対日付の全関数を一括か、`FROM_TODAY`＋`THIS_MONTH`/`THIS_WEEK` 等の高頻度から段階的か。
3. **`PRIMARY_ORGANIZATION()`**: 今回含めるか（B54 User API と相乗・組織文脈依存）。
4. **引数文法**: `FROM_TODAY(n, DAYS)` の単位語、`THIS_WEEK(SUNDAY)` の曜日語をソフトキーワードでどう扱うか（予約語増の最小化）。
5. **押し下げ不可の判定**: JOIN/派生/FULL_SCAN 残余で関数付き比較が残る場合の扱い（拒否 or Phase2 で client 評価）。

## 7. 段階案

- **Phase1（A・押し下げネイティブ）**: 相対日付関数（`FROM_TODAY`/`YESTERDAY`/`TOMORROW`/`THIS_WEEK`/`LAST_WEEK`/`NEXT_WEEK`/`THIS_MONTH`/`LAST_MONTH`/`NEXT_MONTH`/`THIS_YEAR`/`LAST_YEAR`/`NEXT_YEAR`）を parse＋押し下げ。日付系フィールド比較限定・押し下げ不可は fail-closed。
- **Phase2**: `PRIMARY_ORGANIZATION()`（B54 相乗）／必要なら client 評価（FULL_SCAN 対応・セマンティクス忠実性の検証込み）。

## 8. 次アクション

1. 評価戦略（§6-1）と Phase1 スコープの方向確認。
2. 方向が A なら Phase1 仕様 R1（関数文法・押し下げ serialize・型×位置制約・押し下げ不可時 fail-closed・カタログ/docs 同期・面）を起草。
3. kintone クエリ関数の厳密なセマンティクス（曜日語・月末・単位）を公式リファレンスから確定。
