# B194 `ksql_app_metadata` の `app` 引数が `APP4149` 形式を受け付けず「Invalid logical app reference」で止まる — AI は SQL と同じ表記で渡す

- 状態: 📝 **起票のみ（2026-09-19・実装は判断待ち）**。実測 v3.85.0（MCP・dev profile）。改善（MCP ツール引数の受理範囲とエラー文・結果不変・規模 S）。発見＝Qiita 第 9 回 §6 の実測で、Claude Desktop が `ksql_app_metadata` を `APP4247` 形式で呼んで入力検証エラーになり、別の kintone MCP サーバーで代替した

## 1. 現象

| ツール | `app` の受理 | `"APP4149"` を渡すと |
| :--- | :--- | :--- |
| `ksql_describe_app` | 整数のみ（`app: 4149`） | スキーマで拒否（integer 期待） |
| `ksql_app_metadata` | 整数 または `LAPP_<NAME>` 文字列 | **`Input validation error: … app: Invalid logical app reference, app: Invalid logical app reference`** |

kSQL の SQL ではアプリを `APP4149` と書き、`ksql_describe_app` の出力や `ksql_explain` の `app:` 行にも `APP4149` が出る。AI はその表記のまま `ksql_app_metadata` に渡すので、整数か `LAPP_` しか受けない引数で止まる。エラー文は「論理アプリ参照が不正」で、`APP4149` が論理名として解釈されたことしか分からず、整数で渡せばよいことが読み取れない（同じ文言が 2 回重複して出る）。

Claude Desktop の実測（第 9 回 §6・2 段の指示あり）では、この失敗のあと **別の kintone MCP サーバーの `kintone-get-form-fields` で代替**して選択肢・必須を確認した。kSQL 側の道具が使われなかった形。

## 2. なぜ問題か

- 第 9 回の共通プロンプト 2 番・ルール 1 は「選択肢・必須・計算式は `ksql_app_metadata` で確認」と指示している。AI が最初に書く形（`APP4149`）で止まるのは、B124 以来の「最初に書かれる形が通るか」の型
- `ksql_describe_app` と `ksql_app_metadata` で `app` の受理範囲が違う（前者は整数のみ、後者は整数 + `LAPP_`）。同じ「アプリを指す」引数なので、揃っていないこと自体が発明を誘う

## 3. 対応案

**案 A（受理範囲を広げる・純加法）**: 両ツールの `app` で `APP<digits>`（大文字小文字を区別しない・`app4149` も可）を整数に正規化して受ける。`LAPP_<NAME>` は従来どおり。ツール説明に「4149・"APP4149"・"LAPP_<NAME>" のいずれか」と明記する

**案 B（エラー文だけ直す）**: `app: expected a positive app ID (4149), "APP4149", or LAPP_<NAME>` のように、受ける形を列挙した 1 文にし、重複を消す

推奨は **A + B**。A で最初の形が通り、B で残る失敗（`APP` 無しの誤字など）が自己修正できる。MCP のツール定義の語数予算テスト（B183 の `metadataTools.test.ts`）に説明文の増分が掛かるので、増分を最小にする

## 4. 受入条件

- `ksql_app_metadata` と `ksql_describe_app` の両方で `app: "APP4149"` / `"app4149"` / `4149` が同じ結果を返す。`LAPP_<NAME>` は従来どおり
- 不正な値のエラー文に受ける形が列挙され、重複しない
- ツール説明の増分で語数予算テストが落ちない（落ちるなら予算を根拠つきで更新）
- 既存の `ksql_app_metadata` / `ksql_describe_app` テスト不変

## 5. 経緯

- 2026-09-19: 第 9 回 §6「依頼文を AI に作らせる」の実測（2 段の指示あり）で、Claude Desktop の補足に「`ksql_app_metadata` は `app` 引数の入力検証エラー（Invalid logical app reference）になり使えなかった」。dev で `app: "APP4149"` を渡して再現。`ksql_describe_app` は integer のみのスキーマ
- 関連: B124（最初に書かれる形が通るか）、B183（MCP instructions の語数予算）
