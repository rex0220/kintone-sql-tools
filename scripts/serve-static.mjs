#!/usr/bin/env node
/**
 * 依存ゼロの静的ファイルサーバ（B66 browser smoke 用）。
 *
 *   node scripts/serve-static.mjs [port] [rootDir]
 *   既定: port=8765, rootDir=リポジトリルート
 *
 * python -m http.server の代替。Windows で python が未導入／ストア版スタブでも動く。
 * ローカル確認専用（127.0.0.1 のみ待受・パストラバーサル拒否）。
 */
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const port = Number.parseInt(process.argv[2] ?? "8765", 10);
const root = resolve(process.argv[3] ?? join(HERE, ".."));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "cache-control": "no-store", ...headers });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    // パストラバーサル拒否: 正規化後に root 配下であることを必須にする
    const candidate = resolve(join(root, normalize(urlPath)));
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      return send(res, 403, "403 Forbidden");
    }

    let target = candidate;
    let info = await stat(target).catch(() => null);
    if (info?.isDirectory()) {
      target = join(target, "index.html");
      info = await stat(target).catch(() => null);
    }
    if (!info?.isFile()) return send(res, 404, `404 Not Found: ${urlPath}`);

    res.writeHead(200, {
      "content-type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
      "content-length": info.size,
      "cache-control": "no-store",
    });
    createReadStream(target).pipe(res);
  } catch (error) {
    send(res, 500, `500 Internal Server Error\n${String(error)}`);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`serving ${root}`);
  console.log(`http://localhost:${port}/`);
  console.log(`browser smoke: http://localhost:${port}/scripts/engine-browser-smoke/`);
  console.log("stop: Ctrl+C");
});
