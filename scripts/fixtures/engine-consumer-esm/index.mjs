import * as engine from "@rex0220/kintone-sql-tools/engine";

if (typeof engine.version !== "string" || engine.version.length === 0) {
  throw new Error("ESM engine version is missing.");
}
for (const name of [
  "createReadonlyKintoneClient",
  "explainQuery",
  "KsqlEngineError",
  "runQuery",
]) {
  if (typeof engine[name] !== "function") {
    throw new Error(`ESM engine export ${name} is missing.`);
  }
}
console.log(`[engine-consumer-esm] ${engine.version}: ok`);
