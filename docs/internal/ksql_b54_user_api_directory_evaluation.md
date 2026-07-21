# B54 — User API（ユーザー・組織・グループ情報）対応 評価

- 起票日: 2026-07-21
- ステータス: **起票（評価・仕様前・優先度未確定）**
- 種別: 改善（新機能）
- 効果種別: 機能
- 一次情報: [cybozu.com 共通 User API](https://cybozu.dev/ja/common/docs/user-api/)
- 関連: **B49**（MCP 読み取り専用メタデータ API `ksql_app_metadata`・read-only GET allowlist の前例）／**B53**（再帰 CTE＝組織階層 `parentCode` の展開に好相性）／USER_SELECT・ORGANIZATION_SELECT・GROUP_SELECT フィールド

## 1. 提案

cybozu.com 共通の **User API**（`/v1/` 配下・ユーザー/組織/グループ/役職と所属関係）を kSQL から**読み取り**クエリできるようにする候補。現状 kSQL はアプリのレコード（`/k/v1/records.json` 等）しか対象にできず、ユーザー・組織・グループの**ディレクトリ情報や階層・所属関係**を扱えない。

```sql
-- 例: レコードの担当者コードを User API のユーザー属性へ解決
SELECT r.タイトル, u.name, u.email, u.employeeNumber
FROM APP100 r JOIN __USERS__ u ON r.担当者 = u.code;

-- 例: 組織階層を展開（B53 再帰 CTE と組み合わせ）
WITH RECURSIVE 組織木 AS (
  SELECT code, name, parentCode FROM __ORGS__ WHERE code = 'DEV'
  UNION ALL
  SELECT o.code, o.name, o.parentCode FROM __ORGS__ o JOIN 組織木 t ON o.parentCode = t.code
)
SELECT * FROM 組織木;
```

## 2. User API の構造（一次情報・data-structure）

- **エンドポイント（GET・`/v1/`）**: `users.json`（ユーザー一覧）・`organizations.json`（組織一覧）・`groups.json`（グループ一覧）＋所属関係 `user/organizations.json`（ユーザーの所属組織＋役職）・`organization/users.json`（組織の所属ユーザー）・`user/groups.json`（ユーザーの所属グループ）・`group/users.json`（グループの所属ユーザー）。※`/k/v1/` ではなく `/v1/` 配下（cybozu.com 共通）。
- **主なデータ型**:
  - **User**: `id`・`code`(ログイン名)・`name`(表示名)・`surName`/`givenName`・`email`・`employeeNumber`・`primaryOrganization`・`valid`・`phone` 等。
  - **Organization**: `id`・`code`・`name`・**`parentCode`（親組織のコード・root は null）** ＝**階層（木構造）**。
  - **Group**: `id`・`code`・`name`・`description`。
  - **Title（役職）**: `id`・`code`・`name`。
  - **所属**: OrganizationTitle（組織＋役職）・UserTitle（ユーザー＋役職）で user↔org↔title、user↔group を表現。

## 3. 何を解決するか（固有価値）

- **コード→属性の解決**: アプリの USER_SELECT/ORG_SELECT/GROUP_SELECT は `{code, name}` を保持するが、`email`・`employeeNumber`・所属組織・役職・有効/無効などは**レコードに無い**。User API で authoritative な属性へ解決・結合できる。
- **組織階層の展開**: `parentCode` の木を辿って「ある組織配下の全ユーザー」「上位組織」等（**B53 再帰 CTE の看板ユースケース**）。
- **所属・ロールの照会**: 「グループ X の所属ユーザー」「ユーザーの所属組織と役職」をレコードと結合。
- **ディレクトリ単体のクエリ**: 無効ユーザーの棚卸し、組織別人数、役職別集計など。

## 4. 設計案

### 4.1 仮想テーブルとして SELECT/JOIN（推奨方向）

`__USERS__` / `__ORGS__` / `__GROUPS__`（エンティティ一覧）を**仮想テーブル**として FROM/JOIN に使えるようにする（サブテーブル仮想テーブル `APPx$table` の前例に近い発想）。所属関係（user↔org↔title・user↔group）は Phase 2 で関係テーブル化。

- **読み取り専用**（B49 と同じ思想）: ディレクトリの書き込み（ユーザー/組織/グループの更新）は**恒久非対応**とし、固定 GET allowlist のみ。
- 取得は既存 JOIN と同じ「一括取得＋メモリ結合」（B53 §5 の戦略 B）。件数上限（`maxRecords`）内が前提。組織/グループは通常小さく、ユーザーも中小ドメインは maxRecords 内に収まりやすい。
- カラムは data-structure の型に対応（`code`・`name`・`email`・`parentCode` 等）。ネスト（customItemValues 等）は Phase 1 では平坦な主要列のみでも可。

### 4.2 代替: 読み取りツール（B49 拡張型）

MCP の `ksql_app_metadata` 的な read-only ツールで users/organizations/groups の生 JSON を返す案。SQL で JOIN できない（SELECT の合成が主目的なら 4.1 が優る）。B49 のように「SQL 構築前の参照」用途なら補完的にあり得る。

## 5. 技術課題

- **別ベースパス `/v1/`**: 既存クライアントは `/k/v1/` を叩く。User API の `/v1/` を扱う経路を追加（Node/CLI/MCP・プラグインの各面で `kintone.api.url` 等の対応）。B7 の raw fetch 対応（プラグイン）と同様に面ごとの確認が要る。
- **権限**: User API の一部は cybozu.com 共通管理者権限が必要（一覧取得は概ね可・詳細/所属は要確認）。権限不足は明確なエラーにする。read-only でも**取得可否は権限依存**である点を明記。
- **ページング**: User API は offset/size（size 上限はエンティティ別・records API の 500 とは別）。B53 の戦略 B/C と同じく一括取得 or targeted 取得を選ぶ。
- **型/結合キー**: USER_SELECT 等は `code`（ログイン名）で保持。`__USERS__.code` と結合。ID/コードの整合、複数選択（配列）フィールドとの結合意味論を定義。
- **キャッシュ**: ディレクトリは変化が緩いため、実行内での一括取得＋メモリ再利用（B53 戦略 B）が有効。

## 6. API 発行回数

- **エンティティ一覧（`__USERS__`/`__ORGS__`/`__GROUPS__`）**: それぞれ `⌈件数/ページサイズ⌉` を **1 回**（B53 戦略 B と同じ・実行内でキャッシュ）。組織/グループは通常小さく数回、ユーザーはドメイン規模次第。
- **所属関係（Phase 2）**: targeted 取得（特定ユーザー/組織/グループの所属）＝frontier 分（B53 戦略 C）か、全件一括か選択。
- **B53 との相乗**: 組織階層展開は `__ORGS__` を 1 回取得してメモリで再帰（戦略 B）＝**API 回数は深さ非依存**。

## 7. スコープ案（段階）

- **Phase 1（MVP）**: `__USERS__` / `__ORGS__` / `__GROUPS__` の read-only 仮想テーブル（主要平坦列）＋ SELECT/JOIN。一括取得＋メモリ（戦略 B・maxRecords 内）。書き込みは恒久非対応。Node/CLI/MCP 対応（プラグインは面確認後）。
- **Phase 2**: 所属関係テーブル（user↔org↔title・user↔group・org↔users・group↔users）・targeted 取得・customItemValues 等の拡張・B53 と組んだ組織階層レシピ。

## 8. 次アクション

1. 実需の確認（コード→属性解決／組織階層／所属照会のどれが主か）。
2. 権限・面（プラグインの `/v1/` 取得可否）を実機で確認。
3. 方向確定なら Phase 1 仕様 R1（仮想テーブル名・列マッピング・read-only allowlist・ページング・結合意味論・面別対応・EXPLAIN）を起草。

## 9. 現時点の位置づけ

- 📝 **評価・仕様前・優先度未確定**。read-only 参照は B49 の前例があり比較的低リスク。**組織階層は B53（再帰 CTE）と強く相乗**するため、B53 の方向判断と併せて検討すると効果的。
- 書き込み（ディレクトリ更新）は本課題のスコープ外（恒久非対応）とするのが安全。
