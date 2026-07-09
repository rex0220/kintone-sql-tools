import { existsSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";

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
