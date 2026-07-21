# B55 — MCP resources 非対応クライアント向けドキュメント到達手段（tool フォールバック）

- 起票日: 2026-07-21
- ステータス: **仕様 R2 済（2026-07-21・codex レビュー反映・実装承認待ち）**（[仕様](ksql_b55_mcp_docs_tool_spec.md)）
- 種別: 改善（MCP discoverability の残課題）
- 効果種別: 機能（discoverability・回答の正確さ）
- 関連: **B50**（MCP discoverability・言語リファレンス/レシピの MCP resource 公開＝v3.9.0）／**B49**（read-only ツールの前例 `ksql_app_metadata`）

## 1. 事象（2026-07-21・Claude Desktop 実測）

Claude Desktop で「kSQL で利用できる関数」を質問したところ、クライアントの MCP resource 列挙が **`No resources found`** を返し、B50 で公開した言語リファレンス resource（`ksql://language-reference` ほか章別 resource）に**到達できなかった**。その結果、モデルは `ksql_validate` へ関数を1つずつ流す**総当たりプローブ**で独自に関数一覧を洗い出した。

## 2. 何が問題か

プローブによる洗い出しは「パーサが受理するか」の実測にすぎず、**結果が不完全・不正確**になる。実際の洗い出し結果を言語リファレンスと突合すると:

- **実在する関数を「なし」と誤認（洗い出し漏れ）**: `GREATEST` / `LEAST` / `RPAD` / `TRUNCATE` / `TRANSLATE` / `LENGTH_CHAR` / `LAST_DAY` / `DATE_ADD` / `REGEXP_LIKE` / `REGEXP_SUBSTR` / `RANK` / `DENSE_RANK` など（言語リファレンス §関数表に記載あり）。
- **綴り違いによる誤判定**: `DATEADD` を試して拒否→日付加算不可と結論（実際は `DATE_ADD` が存在）。`NOW` も文脈（`SET @var` での時刻固定）を試せず不可と結論。
- **コスト**: 数十回の validate 呼び出しを消費。ユーザーには「ドキュメントが読めないツール」という体験になる。

B50 の実機確認（Claude・codex クライアント）では resources 到達を確認済みだが、**MCP resources はクライアント任意機能**であり、Claude Desktop のリモート接続/プロキシ経路など **resources/list を表示しない・空を返す経路が現実に存在する**。tools はどのクライアントでも使えるため、**ドキュメントへ tool 経由で到達できる導線がない**ことが根本ギャップ。

## 3. 改善案（Phase 案）

1. **read-only ツール `ksql_docs`（本命）**: 引数 `section`（B50 の章別 resource template と同じキー体系）で、embed 済みドキュメントの該当章テキストを返す。未知キーは fail-closed で有効キー一覧を返す（B50 と同思想）。実装は `docsResourceBuilder` の embed 資産をそのまま再利用でき、追加コストは薄い tool ラッパのみ。kintone API 呼び出しゼロ・書き込みゼロ。
2. **server instructions への最小索引追記（補完）**: instructions はほぼ全クライアントがモデルへ提示するため、「関数一覧・方言ルールは `ksql_docs` で読める」導線＋関数名のコンパクトカタログ（名前のみ）を追記し、プローブ行動自体を抑止する。

## 4. 受入条件（スケッチ）

- resources 非対応（列挙が空になる）クライアントでも、`ksql_docs` だけで関数一覧・方言ルール・レシピ索引へ到達できる。
- 未知 `section` キーは実行前拒否＋有効キー列挙（fail-closed）。
- 既存 resource 公開（B50）は不変。core interface / SQL / plugin 非改変（Node MCP のみ）。

## 5. 次アクション

- ~~仕様 R1 → codex レビュー~~ 済（2026-07-21・[仕様 R2](ksql_b55_mcp_docs_tool_spec.md) へ反映）。次＝R2 承認 → codex 実装 → Claude コードレビュー → MCP 実機（resources 非対応経路含む）。

## 6. 追加証跡（2026-07-21・Claude Desktop 続報＝根本原因の確定）

Claude Desktop 側での追加調査により、事象の正確な経路が確定した:

- **構成**: kSQL はユーザー PC 上のローカル MCP サーバーとして動作し、Claude Desktop からは**デバイスブリッジ（`remote-devices`）経由でプロキシ**されていた。
- **根本原因**: このプロキシは **tools は中継するが resources / prompts を中継しない**。resource 読み取りは `Server "remote-devices" does not support resources` エラー、列挙は `No resources found`。つまり「resource が空」ではなく、**中継層が resources capability 自体を宣言・転送していない**（サーバー側 B50 実装の不具合ではない）。
- **MCP 仕様（2025-06-18 版・現行 latest）上の裏付け**: `initialize` の `capabilities` に `resources`/`prompts` が入って初めて当該機能が使える＝**どちらもクライアント/中継の任意機能**。tools（`tools/list` の `description`/`inputSchema`）が**最も確実に届く経路**であることは仕様構造からも支持される。prompts も同じ理由で落ちるため、**代替導線として prompts を使う案は不成立**（tool 一択）。

**前例調査（2026-07-21・kintone 公式 MCP サーバー 2 種＝どちらも tools-only）**: ①[kintone MCP サーバー](https://cybozu.dev/ja/kintone/ai/kintone-mcp-server/)（公式ローカル OSS・[kintone/mcp-server](https://github.com/kintone/mcp-server)）は 24 tools のみで resources/prompts なし（配布=MCPB/Docker/npm）。②[kintone Documentation MCP サーバー](https://cybozu.dev/ja/kintone/ai/kintone-documentation-mcp-overview/)（β・2026-06-15）は**ドキュメント提供専用なのに resources を使わず** `search_docs`/`search_resources`/`get_page` の 3 tools（検索→本文取得の 2 段導線・本体はリモート `https://mcp.cybozu.dev/mcp`・MCPB 版もリモートへの薄いプロキシ）。「過剰な呼び出し防止のためサーバー側で AI 向けにツールの使い方を説明」と明記＝instructions＋厚い description で誘導する設計。ロードマップも tool 追加のみ。**含意**=公式勢は最初から resources 非依存で本課題の capability 非中継を構造的に回避しており、B55 の tool 一択方針は公式実装慣行と一致する。ksql_docs の差別化=embed 済み完全オフライン（公式は cybozu.dev 到達必須）・kSQL 方言固有コンテンツ・固定章キーで決定的（検索揺らぎなし）＝公式 Documentation MCP と競合せず補完（[併用ユースケース記事](https://cybozu.dev/ja/kintone/ai/reliable-kintone-customization-with-mcp/)の構図とも一致）。

**仕様 R2 へ反映すべき示唆（3点）**:
1. `ksql_docs` に **`annotations`（`readOnlyHint: true` 等・2025-06-18 で整理済み）**を付与する（read-only 性のヒント。ただし annotations はクライアントが信用しない場合もあるためガードの代替ではなく表示補助）。
2. structuredContent の扱いは 2025-06-18 の推奨（**structuredContent を返す場合は同じ JSON を text ブロックにも入れる**）と整合させる＝R1 §3.4 の「小メタのみ structuredContent・本文は text」構成は、`outputSchema` を宣言するなら text 側とのミラー関係を仕様どおりに定義するか、**structuredContent/outputSchema を持たない純テキストツール**に倒すかを R2 で確定する。
3. 事象説明の文言を「resource 列挙が空」→「**中継プロキシが resources capability を通さない**」へ正確化（§1 も本節を正とする）。
