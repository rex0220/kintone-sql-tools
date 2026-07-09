// 分類ヘルパの実体は core へ移動（S3: core/batch.ts が使うため。core は node に依存しない）。
// 既存の import パス互換のため再エクスポートする。
export * from "../core/dmlGuard";
