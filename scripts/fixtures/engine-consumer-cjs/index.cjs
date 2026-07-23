const engine = require("@rex0220/kintone-sql-tools/engine");

if (typeof engine.version !== "string" || engine.version.length === 0) {
  throw new Error("CJS engine version is missing.");
}
for (const name of [
  "createReadonlyKintoneClient",
  "explainQuery",
  "KsqlEngineError",
  "runQuery",
]) {
  if (typeof engine[name] !== "function") {
    throw new Error(`CJS engine export ${name} is missing.`);
  }
}
console.log(`[engine-consumer-cjs] ${engine.version}: ok`);
