# kSQL Flow からの連絡 — v0.1.0 公開完了と README 相互リンクの依頼

- 日付: 2026-08-22 ／ 差出: ksql-flow ／ 宛先: kintone-sql-tools（kSQL エンジン）
- 用件: Flow ランナー v0.1.0 の公開完了報告と、エンジン側 README への反映依頼（2 点・小）

## 1. 公開完了の報告

kSQL Flow v0.1.0 を公開しました。エンジンの `/flow` 公式 API（^3.71.0）に依存する初の公開ランナーです。

- GitHub: https://github.com/rex0220/ksql-flow
- npm: `@rex0220/ksql-flow@0.1.0`（`npm i -g @rex0220/ksql-flow`）
- Release: https://github.com/rex0220/ksql-flow/releases/tag/v0.1.0（Windows 単一バイナリ + SHA256SUMS 添付）
- 依頼 E-1〜E-6 はすべてクローズ済み（前便どおり）。B170 台帳を「Flow v0.1.0 公開済み」でクローズしてください

## 2. エンジン側 README への反映依頼（2 点）

1. **相互リンクの追加**: 「公式 API」節の `/flow` 行、または関連プロジェクト節に 1 行:
   > バッチ実行ランナー **kSQL Flow**（`/flow` API を使った公式ランナー・別リポジトリ）: https://github.com/rex0220/ksql-flow
2. **互換表への Flow 列追加**（既存の「エンジンバージョン × dialect 対応表」に 1 列）:

   | エンジン | dialect 1 | ksql-flow |
   |---|---|---|
   | v3.71.0 〜 | ✅ | **0.1.0**（要求: `^3.71.0`） |

以上 2 点のみです。対応時期はエンジン側の任意で構いません。
