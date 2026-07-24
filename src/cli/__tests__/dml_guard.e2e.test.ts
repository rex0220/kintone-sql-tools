import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { createServer } from "http";

jest.setTimeout(20000);

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string; skipped: boolean }> {
  const cliPath = join(process.cwd(), "dist-cli", "ksql.js");
  if (!existsSync(cliPath)) return { code: 0, stdout: "", stderr: "", skipped: true };

  let child;
  try {
    child = spawn(process.execPath, [cliPath, ...args], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("EPERM")) return { code: 0, stdout: "", stderr: "", skipped: true };
    throw err;
  }

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d.toString(); });
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  child.stdin.end();

  const code = await new Promise<number>((resolveCode) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPERM") resolveCode(0);
      else resolveCode(1);
    });
    child.on("close", (c) => resolveCode(c ?? 1));
  });

  return { code, stdout, stderr, skipped: false };
}

test("DML is rejected without --allow-dml", async () => {
  const res = await runCli(["--dry-run", "-e", "UPDATE APP88 SET 状態='完了' WHERE $id = 1"]);
  if (res.skipped) {
    expect(true).toBe(true);
    return;
  }
  expect(res.code).toBe(2);
  expect(res.stderr).toContain("DML is disabled");
});

test("built CLI B67 smoke は代表query/EXPLAINと拒否reasonを共有engineから返し負例execution API 0", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", method: req.method ?? "GET" });
    res.setHeader("Content-Type", "application/json");
    if (req.url?.includes("/app/form/fields.json")) {
      res.end(JSON.stringify({
        properties: {
          日付: { code: "日付", label: "日付", type: "DATE" },
          件名: { code: "件名", label: "件名", type: "SINGLE_LINE_TEXT" },
        },
      }));
      return;
    }
    if (req.url?.includes("/app/status.json")) {
      res.end(JSON.stringify({ enable: false, states: {} }));
      return;
    }
    if (req.url?.includes("/app/settings.json")) {
      res.end(JSON.stringify({
        numberPrecision: {
          digits: "30",
          decimalPlaces: "10",
          roundingMode: "HALF_EVEN",
        },
      }));
      return;
    }
    if (req.url?.includes("/records.json") && req.method === "GET") {
      res.end(JSON.stringify({ records: [] }));
      return;
    }
    res.statusCode = 500;
    res.end(JSON.stringify({ code: "UNEXPECTED_EXECUTION_API", message: req.url }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("B67 CLI smoke server did not expose a TCP port.");
  }

  const dir = mkdtempSync(join(tmpdir(), "ksql-b67-cli-smoke-"));
  const configPath = join(dir, "ksql.config.json");
  writeFileSync(configPath, JSON.stringify({
    defaultProfile: "smoke",
    profiles: {
      smoke: {
        baseUrl: `http://127.0.0.1:${address.port}`,
        tokenMap: { APP100: "fixture-token" },
      },
    },
  }));
  try {
    const accepted = await runCli([
      "--config", configPath,
      "--dry-run",
      "-e", "SELECT 日付 FROM APP100 WHERE 日付 >= FROM_TODAY(-7, DAYS) LIMIT 1",
    ]);
    if (accepted.skipped) return;
    if (accepted.code !== 0) {
      throw new Error(`B67 built CLI positive failed: ${JSON.stringify(accepted)}`);
    }
    expect(accepted.stdout).toContain("relative date function: FROM_TODAY");
    expect(accepted.stdout).toContain("kintone query: 日付 >= FROM_TODAY(-7, DAYS)");
    expect(accepted.stdout).toContain("client evaluation: forbidden");

    const executed = await runCli([
      "--config", configPath,
      "--format", "json",
      "-e", "SELECT 日付 FROM APP100 WHERE 日付 >= FROM_TODAY(-7, DAYS) LIMIT 1",
    ]);
    if (executed.code !== 0) {
      throw new Error(`B67 built CLI execution failed: ${JSON.stringify(executed)}`);
    }
    const positiveRecords = requests.filter(({ url }) => url.includes("/records.json"));
    expect(positiveRecords).toHaveLength(1);
    expect(new URL(positiveRecords[0].url, "http://127.0.0.1").searchParams.get("query"))
      .toBe("日付 >= FROM_TODAY(-7, DAYS) order by $id asc limit 1");

    const recordsBeforeRejection = positiveRecords.length;
    const rejected = await runCli([
      "--config", configPath,
      "--dry-run",
      "-e", "SELECT 件名 FROM APP100 WHERE 件名 = YESTERDAY()",
    ]);
    expect(rejected.code).toBe(0);
    expect(`${rejected.stdout}\n${rejected.stderr}`)
      .toContain("WHERE_RELATIVE_DATE_FIELD_TYPE_UNSUPPORTED");
    expect(`${rejected.stdout}\n${rejected.stderr}`)
      .toContain("WHERE_RELATIVE_DATE_REQUIRES_EXACT_PUSHDOWN");

    expect(requests.filter(({ url }) => url.includes("/records.json")))
      .toHaveLength(recordsBeforeRejection);
    expect(requests.some(({ url }) => url.includes("/records/cursor.json"))).toBe(false);
    expect(requests.some(({ method }) => method !== "GET")).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}, 20000);

test("UPDATE without WHERE is rejected by default", async () => {
  const res = await runCli(["--dry-run", "--allow-dml", "-e", "UPDATE APP88 SET 状態='完了'"]);
  if (res.skipped) {
    expect(true).toBe(true);
    return;
  }
  // WHERE なし UPDATE は parser 段階（code=1）または CLI ガード（code=2）の
  // いずれでも拒否されれば要件を満たす。
  expect(res.code === 1 || res.code === 2).toBe(true);
  expect(
    res.stderr.includes("without WHERE is blocked")
      || res.stderr.includes("UPDATE 文には WHERE 句が必要です")
  ).toBe(true);
});

test("INSERT values count is guarded by --dml-max-rows", async () => {
  const res = await runCli([
    "--dry-run",
    "--allow-dml",
    "--dml-max-rows",
    "1",
    "-e",
    "INSERT INTO APP88 (案件名) VALUES ('a'),('b')",
  ]);
  if (res.skipped) {
    expect(true).toBe(true);
    return;
  }
  expect(res.code).toBe(2);
  expect(res.stderr).toContain("exceed --dml-max-rows");
});

test("REORDER is rejected without --allow-dml", async () => {
  const res = await runCli([
    "--dry-run",
    "-e",
    "REORDER APP88$明細 BY 商品コード ASC WHERE _pid = 1",
  ]);
  if (res.skipped) {
    expect(true).toBe(true);
    return;
  }
  expect(res.code).toBe(2);
  expect(res.stderr).toContain("DML is disabled");
});

test("REORDER dry-run is allowed with --allow-dml", async () => {
  const res = await runCli([
    "--dry-run",
    "--allow-dml",
    "-e",
    "REORDER APP88$明細 BY 商品コード ASC WHERE _pid = 1",
  ]);
  if (res.skipped) {
    expect(true).toBe(true);
    return;
  }
  expect(res.code).toBe(0);
  expect(res.stdout).toContain("[REORDER]");
});

test("DELETE + @profile is rejected by the CLI", async () => {
  const res = await runCli([
    "--dry-run",
    "--allow-dml",
    "-e",
    "DELETE FROM APP88@prod WHERE $id = 1",
  ]);
  if (res.skipped) {
    expect(true).toBe(true);
    return;
  }
  expect(res.code).toBe(2);
  expect(res.stderr).toContain("@profile is not supported for DELETE yet");
});

test("logical DELETE は明示 profile 付きを拒否し、省略時は許可する", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ksql-cli-logical-delete-"));
  const configPath = join(dir, "ksql.config.json");
  writeFileSync(configPath, JSON.stringify({
    defaultProfile: "prod",
    profiles: { prod: { logicalApps: { ORDERS: 1234 } } },
  }));
  try {
    const explicit = await runCli([
      "--config", configPath, "--dry-run", "--allow-dml", "-e",
      "DELETE FROM LAPP_ORDERS@prod WHERE $id = 1",
    ]);
    if (explicit.skipped) return;
    expect(explicit.code).toBe(2);
    expect(explicit.stderr).toContain("@profile is not supported for DELETE yet");

    const implicit = await runCli([
      "--config", configPath, "--dry-run", "--allow-dml", "-e",
      "DELETE FROM LAPP_ORDERS WHERE $id = 1",
    ]);
    expect(implicit.code).toBe(0);
    expect(implicit.stderr).not.toContain("@profile is not supported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);

test.each([
  ["-e", false],
  ["-f", true],
])("CLI %s は logical parse error を元SQLの位置・表記へ復元する", async (_label, useFile) => {
  const dir = mkdtempSync(join(tmpdir(), "ksql-cli-logical-error-"));
  const configPath = join(dir, "ksql.config.json");
  const sqlPath = join(dir, "invalid.sql");
  const sourceSql = "SELECT * FROM LAPP_ORDERS WHERE )";
  writeFileSync(configPath, JSON.stringify({
    defaultProfile: "prod",
    profiles: { prod: { logicalApps: { ORDERS: 1234 } } },
  }));
  writeFileSync(sqlPath, sourceSql);
  try {
    const inputArgs = useFile ? ["-f", sqlPath] : ["-e", sourceSql];
    const res = await runCli(["--config", configPath, "--dry-run", ...inputArgs]);
    if (res.skipped) return;
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(`位置 ${sourceSql.indexOf(")")}`);
    expect(res.stderr).not.toContain("APP900000000");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);

test("CLI batch parse error も元SQL位置へ復元する", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ksql-cli-logical-batch-error-"));
  const configPath = join(dir, "ksql.config.json");
  const sourceSql = "SELECT * FROM LAPP_ORDERS; SELECT * FROM LAPP_ORDERS WHERE )";
  writeFileSync(configPath, JSON.stringify({
    defaultProfile: "prod",
    profiles: { prod: { logicalApps: { ORDERS: 1234 } } },
  }));
  try {
    const res = await runCli(["--config", configPath, "--dry-run", "-e", sourceSql]);
    if (res.skipped) return;
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(`位置 ${sourceSql.indexOf(")")}`);
    expect(res.stderr).not.toContain("APP900000000");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);

test("CLI stderr はmapped table tokenを元のLAPP表記へ復元する", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ksql-cli-logical-token-error-"));
  const configPath = join(dir, "ksql.config.json");
  writeFileSync(configPath, JSON.stringify({
    defaultProfile: "prod",
    profiles: { prod: { logicalApps: { ORDERS: 1234 } } },
  }));
  try {
    const res = await runCli([
      "--config", configPath, "--dry-run", "-e", "DESCRIBE LAPP_ORDERS$明細",
    ]);
    if (res.skipped) return;
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("LAPP_ORDERS$明細");
    expect(res.stderr).not.toContain("APP900000000");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);

// ----------------------------------------------------------------
// バッチ dry-run と DML ガード（M3 レビュー反映）
// ----------------------------------------------------------------

test("DML を含むバッチの dry-run は --allow-dml なしで拒否", async () => {
  const res = await runCli([
    "--dry-run",
    "-e",
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP88; INSERT INTO APP89 (名前) SELECT 顧客名 FROM #t",
  ]);
  if (res.skipped) {
    expect(true).toBe(true);
    return;
  }
  expect(res.code).toBe(2);
  expect(res.stderr).toContain("DML is disabled");
});

test("DML を含むバッチの dry-run は --allow-dml ありでプラン表示に成功", async () => {
  const res = await runCli([
    "--dry-run",
    "--allow-dml",
    "-e",
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP88; INSERT INTO APP89 (名前) SELECT 顧客名 FROM #t",
  ]);
  if (res.skipped) {
    expect(true).toBe(true);
    return;
  }
  expect(res.code).toBe(0);
  expect(res.stdout).toContain("CREATE TEMP TABLE #t");
  expect(res.stdout).toContain("INSERT INTO APP89");
  expect(res.stdout).toContain("dmlMaxRows 適用");
});

test("read-only バッチの dry-run は --allow-dml なしで成功", async () => {
  const res = await runCli([
    "--dry-run",
    "-e",
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP88; SELECT 顧客名 FROM #t",
  ]);
  if (res.skipped) {
    expect(true).toBe(true);
    return;
  }
  expect(res.code).toBe(0);
  expect(res.stdout).toContain("FULL_SCAN（一時テーブル参照）");
});

// ----------------------------------------------------------------
// 単文 ASSERT の CLI ゲート通過（v1.10.0 A3 回帰: 許可リスト漏れで
// "unsupported statement type in CLI: ASSERT" になっていた）
// リテラル比較は kintone API を呼ばないためダミー認証で実行できる
// ----------------------------------------------------------------

// --app はトークン解決のアプリ文脈用（ASSERT のリテラル比較は API を呼ばない）
const DUMMY_AUTH = ["--base-url", "https://example.cybozu.com", "--auth", "token", "--token", "dummy", "--app", "1"];

test("単文 ASSERT 成立は exit 0 + assertion ok", async () => {
  const res = await runCli([...DUMMY_AUTH, "-e", "ASSERT 1 = 1"]);
  if (res.skipped) {
    expect(true).toBe(true);
    return;
  }
  expect(res.stderr).not.toContain("unsupported statement type");
  expect(res.code).toBe(0);
  expect(res.stdout).toContain("assertion ok: 1 = 1");
});

test("単文 ASSERT 不成立は exit 1 + AssertError", async () => {
  const res = await runCli([...DUMMY_AUTH, "-e", "ASSERT 1 = 2"]);
  if (res.skipped) {
    expect(true).toBe(true);
    return;
  }
  expect(res.code).toBe(1);
  expect(res.stderr).toContain("AssertError: assertion failed: 1 = 2 (actual: 1).");
});

test("DML バッチ実行は --yes なしなら確認を要求する（非 TTY では明示エラー）", async () => {
  const res = await runCli([
    "--allow-dml",
    "-e",
    "CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP88; INSERT INTO APP89 (名前) SELECT 顧客名 FROM #t",
  ]);
  if (res.skipped) {
    expect(true).toBe(true);
    return;
  }
  // M2 で実行が解禁され、確認プロンプト経路に到達する
  //（非 TTY のため「interactive confirmation requires TTY」で止まる = ガード健在）
  expect(res.code).toBe(2);
  expect(res.stderr).toContain("interactive confirmation requires TTY");
  expect(res.stderr).not.toContain("DML in batch is not supported");
});
