// ============================================================
// build-mcpb.mjs — configPath 指定型 MCPB を生成する
// ============================================================

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { basename, join, resolve } from "path";

const rootDir = process.cwd();
const packageJsonPath = resolve(rootDir, "package.json");
const mcpServerPath = resolve(rootDir, "dist-mcp", "ksql-mcp.js");
const outDir = resolve(rootDir, "dist-mcpb");
const outPath = resolve(outDir, "ksql-mcp.mcpb");

if (!existsSync(mcpServerPath)) {
  throw new Error("[kSQL] Missing dist-mcp/ksql-mcp.js. Run npm run build:mcp first.");
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const version = String(packageJson.version ?? "0.0.0");
const CRC32_TABLE = createCrc32Table();

const manifest = {
  manifest_version: "0.3",
  name: "ksql-mcp",
  display_name: "kSQL MCP",
  version,
  description: "Run kSQL against kintone apps through MCP.",
  long_description: [
    "kSQL MCP exposes kintone-sql-tools as local MCP tools.",
    "Use a ksql.config.json file to configure kintone profiles, token maps, query defaults, and saved query catalog location.",
  ].join("\n\n"),
  author: {
    name: "rex0220",
  },
  repository: packageJson.repository,
  homepage: packageJson.homepage,
  support: packageJson.bugs?.url,
  license: packageJson.license ?? "MIT",
  server: {
    type: "node",
    entry_point: "server/index.js",
    mcp_config: {
      command: "node",
      args: [
        "${__dirname}/server/index.js",
        "--config",
        "${user_config.configPath}",
      ],
      env: {},
    },
  },
  tools: [
    { name: "ksql_validate", description: "Validate kSQL without calling kintone APIs." },
    { name: "ksql_explain", description: "Return a schema-aware plan using form/status metadata only; never read or write records." },
    { name: "ksql_query", description: "Execute read-only kSQL." },
    { name: "ksql_mutate", description: "Execute DML kSQL with explicit safety approvals." },
    { name: "ksql_describe_app", description: "Describe a kintone app." },
    { name: "ksql_app_metadata", description: "Inspect raw read-only app metadata and field constraints before generating SQL or DML." },
    { name: "ksql_show_apps", description: "Show kintone apps." },
    { name: "ksql_save_query", description: "Save a kSQL query." },
    { name: "ksql_list_queries", description: "List saved kSQL queries." },
    { name: "ksql_get_query", description: "Get a saved kSQL query." },
    { name: "ksql_run_saved_query", description: "Run a saved kSQL query." },
    { name: "ksql_delete_query", description: "Delete a saved kSQL query." },
  ],
  tools_generated: false,
  keywords: ["kintone", "ksql", "sql", "mcp"],
  compatibility: {
    claude_desktop: ">=0.10.0",
    platforms: ["darwin", "win32"],
    runtimes: {
      node: ">=18.0.0",
    },
  },
  user_config: {
    configPath: {
      type: "file",
      title: "ksql.config.json",
      description: "Absolute path to your ksql.config.json file.",
      required: true,
    },
  },
};

const bundleReadme = `# kSQL MCP

This MCPB runs kintone-sql-tools as a local MCP server.

Configure the extension with the absolute path to your \`ksql.config.json\`.
Keep API tokens out of the bundle by using \`env:\` references in \`ksql.config.json\`.
`;

const launcher = `#!/usr/bin/env node

const { main } = require("./ksql-mcp.js");

main().catch((err) => {
  process.stderr.write(\`\${err instanceof Error ? err.message : String(err)}\\n\`);
  process.exitCode = 1;
});
`;

const files = [
  {
    path: "manifest.json",
    data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  },
  {
    path: "server/index.js",
    data: Buffer.from(launcher, "utf8"),
  },
  {
    path: "server/ksql-mcp.js",
    data: readFileSync(mcpServerPath),
  },
  {
    path: "README.md",
    data: Buffer.from(bundleReadme, "utf8"),
  },
  {
    path: "LICENSE",
    data: readFileSync(resolve(rootDir, "LICENSE")),
  },
];

if (!isDistMcpbIgnored()) {
  throw new Error("[kSQL] .gitignore must include /dist-mcpb before building MCPB artifacts.");
}

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, createZip(files));

console.log(`[kSQL] mcpb build complete -> ${join("dist-mcpb", basename(outPath))}`);

function isDistMcpbIgnored() {
  const gitignorePath = resolve(rootDir, ".gitignore");
  if (!existsSync(gitignorePath)) return false;
  return readFileSync(gitignorePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === "/dist-mcpb" || line === "dist-mcpb/" || line === "/dist-mcpb/");
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = entry.path.replace(/\\/g, "/");
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + data.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createCrc32Table() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
}
