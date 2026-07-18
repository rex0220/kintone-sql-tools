# B40 Phase1 — プロパティグラフ / GRAPH_TABLE MATCH（固定長・循環検出）仕様

- 作成日: 2026-07-19
- ステータス: **仕様 R1・codex レビュー済（要 R2・工数確定）**。**判定＝技術的に実装可能だが「新規評価器だけの小規模」ではなく「新 FROM ソース＋バッチスコープ定義＋型付き副言語」。工数 19〜31 人日 ≈ B37 単体の 2〜3 倍（B37+B38 合同 v3.4.0 の 1.2〜1.8 倍）**。R1 の楽観を訂正＝**爆発は「回避」でなく「有界で fail-closed」**（分岐係数^ホップ）・**面配管は完全不要ではない**（LAPP はプラグイン非対応・上限を設定可にするなら ExecuteOptions/CLI/MCP/プラグイン配管）・**EXPLAIN は実件数を出せない**（レコード API を呼ばない契約）・**パターン WHERE は物理アプリ resolver をそのまま流用不可**（graph スコープ resolver 要）・**FROM は `PhysicalTableRef | GraphTableSource` 分離＋MaterializedTable への lowering**。R2 で 10 点確定後に実装判断。
- 分担: Claude=仕様/観点・Codex=実装/テスト
- 台帳: [ksql_issue_tracker.md](../ksql_issue_tracker.md) B40
- 評価: [ksql_property_graph_evaluation.md](ksql_property_graph_evaluation.md)
- 関連: [横断: 文字列の扱い](ksql_string_semantics.md)（型付き比較）・[論理アプリ参照 LAPP_](ksql_logical_app_id_mapping_spec.md)

## 1. スコープ（Phase1）

SQL:2023 SQL/PGQ のサブセット。**固定長パターン＋循環検出**を engine 側（全件取得＋メモリ走査）で提供する。**規模 小（数千件以下）前提・境界と fail-closed 必須**。

- **対象**：`CREATE PROPERTY GRAPH`（バッチスコープ）＋`FROM GRAPH_TABLE(g MATCH <固定長パターン> [WHERE] COLUMNS(...))`。有向 `->`・ラベル・プロパティ参照・循環 `->(a)`。
- **対象外（Phase2 以降）**：可変長 `{m,n}`・到達可能性/推移閉包・最短経路・無向 `-`/逆向き `<-`・複数ラベル・永続グラフカタログ・巨大グラフ・グラフ書込み。

## 2. グラフ定義（バッチスコープ）

`CREATE PROPERTY GRAPH` を**バッチスコープの定義**（一時テーブルと同様にバッチ内で有効・永続カタログは Phase2+）とする。

```sql
CREATE PROPERTY GRAPH bank_graph
  VERTEX TABLES (
    APP101 KEY (account_id) LABEL Account PROPERTIES (account_id, owner_name)
  )
  EDGE TABLES (
    APP102 KEY (transfer_id)
      SOURCE KEY (from_account) REFERENCES APP101 (account_id)
      DESTINATION KEY (to_account) REFERENCES APP101 (account_id)
      LABEL transfer PROPERTIES (amount, transfer_date)
  );
```

- **VERTEX TABLES**：`<app> KEY (<keyField>) LABEL <Label> PROPERTIES (<f>, ...)`。`<app>` は `APPxxx`/`LAPP_<NAME>`。`KEY` はノード同一性のフィールド（単一フィールド・v1）。`PROPERTIES` は MATCH/COLUMNS で参照可能な列（省略時は全フィールド）。
- **EDGE TABLES**：`<app> KEY (<keyField>) SOURCE KEY (<f>) REFERENCES <vertexApp> (<keyField>) DESTINATION KEY (<f>) REFERENCES <vertexApp> (<keyField>) LABEL <Label> PROPERTIES (...)`。SOURCE/DESTINATION は単一フィールド（v1）。
- ラベルは MATCH で参照する識別子。同一ラベルの重複定義はエラー。
- v1 は**1 グラフあたり VERTEX/EDGE 各 1 種類以上**（複数ノード/エッジラベル可）。サブテーブル/複合キーは非対応。

## 3. GRAPH_TABLE + MATCH（固定長）

```sql
SELECT owner_b, amount
FROM GRAPH_TABLE ( bank_graph
  MATCH (a:Account) -[t:transfer]-> (b:Account)
  WHERE a.owner_name = '田中太郎'
  COLUMNS (b.owner_name AS owner_b, t.amount AS amount)
);
```

- **ノード** `(<var>[:<Label>])`：丸括弧・任意ラベル・任意変数。
- **エッジ** `-[<var>[:<Label>]]->`：角括弧・有向 `->`（v1 は `->` のみ）・任意ラベル・任意変数。
- **固定長チェーン**：`(a)-[t1]->(b)-[t2]->(c)...`。ホップ数は構文で確定（可変長 `{m,n}` は Phase2）。
- **循環**：末尾で既出変数へ戻す `... -[t3]-> (a)`（`a` の同一ノード制約）。
- **WHERE**：パターン内の変数プロパティで絞り込み（`a.owner_name = '…'`・型付き比較）。
- **COLUMNS**：`<var>.<property> [AS alias]` の射影。出力列＝GRAPH_TABLE の結果列。
- `FROM GRAPH_TABLE(...)` は**通常 SELECT の FROM ソース**（外側 WHERE/ORDER BY/集約と合成可）。v1 は GRAPH_TABLE を JOIN の一辺にしない（単独 FROM）。

## 4. 意味論

- 各 MATCH は**固定長パターンの全マッチ**を行として返す。変数はノード/エッジに束縛され、`COLUMNS` で射影。
- **循環**：戻り先変数はノード同一性（KEY）で一致判定。
- **多重度**：同じ経路の重複は出さない（マッチ単位で 1 行）。自己ループ・重複エッジは KEY/エッジ KEY で区別。
- **NULL/欠損**：SOURCE/DESTINATION が対応ノードを持たないエッジはそのホップで不成立（INNER 相当）。
- **型**：プロパティはフォーム定義由来の型（既存の型付き比較 B26/B9）。パターン WHERE・COLUMNS は既存 evalWhere/スカラー評価を流用。

## 5. 実行・エンジン（engine 側・全件取得）

1. `CREATE PROPERTY GRAPH` を解析し**グラフメタ**（ノード/エッジ→アプリ・KEY・ラベル・プロパティ）をバッチスコープに登録。
2. GRAPH_TABLE 実行時、パターンが参照する**ノード/エッジのアプリを `fetchAll` で全件取得**（既存 fetch・Cursor 含む）。境界（§6）超過は fail-closed。
3. メモリ内に**隣接構造**（エッジを SOURCE/DESTINATION KEY でインデックス化）を構築。
4. **パターン評価器（新規）**：先頭ノード集合（ラベル/WHERE で絞る）から、ホップごとに「現ノード集合 ⋈ エッジ ⋈ 次ノード」を**ハッシュ展開**（`applyJoin` 相当の結合を固定回数）。循環制約・変数束縛・パターン WHERE を適用し、`COLUMNS` を射影。
5. 結果を GRAPH_TABLE の行として外側 SELECT へ渡す。
- 再帰なし（固定長）＝**有界展開**。可変長（Phase2）はここに BFS/DFS＋訪問管理を足す設計。

## 6. 境界・fail-closed（第一級要件）

- **最大ノード/エッジ取得数**：`tempTableMaxRows` 相当（既定 10000・調整可）。超過は fail-closed（planning/実行エラー・無音打ち切りしない＝B1/B30 と整合）。
- **最大ホップ数**：固定長でも上限（例 ≤ 8・設定可）。超過は ParseError。
- **最大結果行/中間展開数**：上限を設け超過は実行エラー（爆発防止）。
- EXPLAIN に取得アプリ・ノード/エッジ件数・ホップ数・上限を表示。

## 7. パーサ・予約語

- 追加構文：`CREATE PROPERTY GRAPH`・`VERTEX/EDGE TABLES`・`KEY`・`SOURCE`・`DESTINATION`・`REFERENCES`・`LABEL`・`PROPERTIES`・`GRAPH_TABLE`・`MATCH`・`COLUMNS`。
- **新規予約語を最小化**：可能な限り**ソフトキーワード**（`CREATE PROPERTY GRAPH`・`GRAPH_TABLE(` の文脈でのみキーワード化）。`KEY`/`SOURCE`/`LABEL` 等は同名フィールドが有り得るためソフト化必須・バッククォート退避。トークン衝突（`SOURCE`/`DESTINATION` は既存に無い・`REFERENCES` も）を実装時に精査。
- AST：`CreatePropertyGraph` 文＋`GraphTableSource`（FROM の新ソース＝`TableRef` union へ追加）＋`MatchPattern`（ノード/エッジ列・循環・WHERE）＋`GraphColumns`。

## 8. 面

全面（CLI/MCP/プラグイン）で同一＝engine 側の純計算。面ごとの配管は不要。小規模前提のため走査コストは実用範囲（プラグインの大規模走査は将来の注意点）。

## 9. 受入条件（テスト化）

- 定義：`CREATE PROPERTY GRAPH` で VERTEX/EDGE を登録・ラベル重複エラー・LAPP_ 対応。
- 1 ホップ `MATCH (a:Account)-[t:transfer]->(b:Account)`＋パターン WHERE＋COLUMNS。
- 多ホップ固定長（2〜3 ホップ）。
- **循環** `(a)-[t1]->(b)-[t2]->(c)-[t3]->(a)`（戻り先ノード同一性）。
- 型付き比較（`a.owner_name='…'`・数値プロパティ）・欠損ノードで不成立（INNER）。
- 外側 SELECT 合成（WHERE/ORDER BY/集約）。
- 境界：最大ノード/エッジ超過 fail-closed・最大ホップ超過 ParseError・爆発上限。
- 予約語：`KEY`/`SOURCE` 等の同名フィールドがバッククォートで使える・GRAPH 構文外で非キーワード。
- 全面一致（CLI/MCP/プラグインで同一結果）。
- 非回帰：GRAPH 構文なしの既存クエリ不変。

## 10. Phase2 引き継ぎ（対象外）

可変長 `{m,n}`・到達可能性/推移閉包（BFS/DFS＋訪問管理＋パス上限）・最短経路・無向/逆向き・永続グラフカタログ。Phase1 のパターン評価器を有界 BFS へ拡張する設計。

## 11. 工数の目安（本 R1 の目的）

- **パーサ**：CREATE PROPERTY GRAPH＋GRAPH_TABLE/MATCH の新文法（中〜大・ソフトキーワード多数）。
- **AST/バッチ**：グラフメタのバッチスコープ登録（temp table 機構に類似）。
- **エンジン**：fetchAll 流用＋**新規パターン評価器**（固定長ハッシュ展開・循環・境界）＝**本体の新規部分**。
- **型/評価**：既存 evalWhere/型解決を流用。
- 総じて **B37 級かそれ以上**（新副言語＋新評価器）。ただし小規模・engine 側・固定長で**難所（性能爆発・面配管・再帰）は Phase1 では回避**。codex レビューで各点の実現性・工数を裏取りして実装可否を判断する。
