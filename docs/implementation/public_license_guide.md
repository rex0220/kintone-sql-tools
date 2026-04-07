# 公開ライセンス運用ガイド（Ver.1）

- 作成日: 2026-04-07
- 対象: ksql / cli-ksql を public 公開する場合のライセンス運用

## 1. 目的

public 公開時に、利用条件を明確にし、公開後の運用リスクを減らす。

## 2. 基本方針

1. 公開時は `LICENSE` を必ず同梱する
2. `package.json` の `license` を `LICENSE` と一致させる
3. README にライセンス情報を明記する
4. 依存ライセンスの遵守状況を確認する

## 3. 推奨手順（MIT の場合）

1. ルートに `LICENSE`（MIT本文）を追加する
2. `package.json` に `"license": "MIT"` を設定する
3. README に次を追記する  
   - `Licensed under the MIT License`
   - `LICENSE` への参照
4. `npm pack --dry-run` で公開物を確認する
5. 公開前レビューでライセンス表記の整合を確認する

## 4. 公開前チェック項目

1. `LICENSE` が存在する
2. `package.json` の `license` が正しい
3. README にライセンス節がある
4. 依存ライセンスに重大な不整合がない
5. 配布対象外ファイル（秘密鍵・ローカル設定）が除外されている

## 5. 注意事項

1. 何もライセンスを付けない場合、利用条件が不明確になり公開運用に不向き
2. 一度公開した配布物は完全に回収しにくい
3. public 化前に、公開対象ファイルを必ず固定する

## 6. 関連資料

1. `docs/checklists/public_repo_preparation.md`
2. `docs/checklists/plugin_zip_release_preparation.md`
