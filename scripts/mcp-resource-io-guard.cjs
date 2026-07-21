"use strict";

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");

const guardLog = process.env.KSQL_RESOURCE_IO_GUARD_LOG;
const guardActive = process.env.KSQL_RESOURCE_IO_GUARD_ACTIVE;
const originalReadFileSync = fs.readFileSync;
const originalReadFile = fs.readFile;
const originalPromisesReadFile = fs.promises.readFile.bind(fs.promises);
const originalAppendFileSync = fs.appendFileSync;
const originalExistsSync = fs.existsSync;
const originalFetch = globalThis.fetch?.bind(globalThis);

function isActive() {
  return Boolean(guardActive && originalExistsSync(guardActive));
}

function block(kind, detail) {
  if (guardLog) originalAppendFileSync(guardLog, `${kind}: ${detail}\n`, "utf8");
  throw new Error(`KSQL_RESOURCE_IO_GUARD blocked ${kind}: ${detail}`);
}

fs.readFileSync = function guardedReadFileSync(path, ...args) {
  const value = String(path);
  if (isActive()) return block("readFileSync", value);
  return originalReadFileSync.call(this, path, ...args);
};

fs.readFile = function guardedReadFile(path, ...args) {
  if (isActive()) return block("readFile", String(path));
  return originalReadFile.call(this, path, ...args);
};

fs.promises.readFile = async function guardedPromisesReadFile(path, ...args) {
  if (isActive()) return block("fs.promises.readFile", String(path));
  return originalPromisesReadFile(path, ...args);
};

globalThis.fetch = async function guardedFetch(input, ...args) {
  if (isActive()) return block("fetch", String(input));
  return originalFetch(input, ...args);
};

for (const transport of [http, https]) {
  for (const method of ["request", "get"]) {
    const original = transport[method];
    transport[method] = function guardedNetwork(input, ...args) {
      if (isActive()) return block(`${transport === http ? "http" : "https"}.${method}`, String(input));
      return original.call(this, input, ...args);
    };
  }
}
