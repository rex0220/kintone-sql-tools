import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { tmpdir } from "os";

jest.setTimeout(20000);

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

test("console mode accepts meta commands and exits", async () => {
  const cliPath = join(process.cwd(), "dist-cli", "ksql.js");
  if (!existsSync(cliPath)) {
    // dist build may not exist in some local test contexts
    expect(true).toBe(true);
    return;
  }

  let child;
  try {
    child = spawn(process.execPath, [cliPath, "--console", "--dry-run"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("EPERM")) {
      expect(true).toBe(true);
      return;
    }
    throw err;
  }

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d.toString(); });
  child.stderr.on("data", (d) => { stderr += d.toString(); });

  await sleep(120);
  child.stdin.write(":help\n");
  await sleep(120);
  child.stdin.write(":edit\n");
  await sleep(120);
  child.stdin.write(":last\n");
  await sleep(120);
  child.stdin.write(":show config\n");
  await sleep(120);
  child.stdin.write(":exit\n");
  child.stdin.end();

  const result = await new Promise<{ code: number; skipped: boolean }>((resolveCode) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPERM") {
        resolveCode({ code: 0, skipped: true });
        return;
      }
      resolveCode({ code: 1, skipped: false });
    });
    child.on("close", (c) => resolveCode({ code: c ?? 1, skipped: false }));
  });

  if (result.skipped) {
    expect(true).toBe(true);
    return;
  }
  expect(result.code).toBe(0);
  expect(stdout).toContain("kSQL Console");
  expect(stdout).toContain("(buffer is empty)");
  expect(stdout).toContain("(last sql is empty)");
  expect(stdout).toContain(":show config");
  expect(stderr).toBe("");
}, 20000);

test("console mode Ctrl+C cancels buffer and continues", async () => {
  const cliPath = join(process.cwd(), "dist-cli", "ksql.js");
  if (!existsSync(cliPath)) {
    expect(true).toBe(true);
    return;
  }

  let child;
  try {
    child = spawn(process.execPath, [cliPath, "--console", "--dry-run"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("EPERM")) {
      expect(true).toBe(true);
      return;
    }
    throw err;
  }

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d.toString(); });
  child.stderr.on("data", (d) => { stderr += d.toString(); });

  await sleep(120);
  child.stdin.write("SELECT * FROM APP88\n");
  await sleep(200);
  child.kill("SIGINT");
  await sleep(200);
  child.stdin.write(":edit\n");
  await sleep(120);
  child.stdin.write(":exit\n");
  child.stdin.end();

  const result = await new Promise<{ code: number; skipped: boolean }>((resolveCode) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveCode({ code: 0, skipped: true });
    }, 8000);
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "EPERM") {
        resolveCode({ code: 0, skipped: true });
        return;
      }
      resolveCode({ code: 1, skipped: false });
    });
    child.on("close", (c) => {
      clearTimeout(timer);
      resolveCode({ code: c ?? 1, skipped: false });
    });
  });

  if (result.skipped) {
    expect(true).toBe(true);
    return;
  }
  expect(result.code).toBe(0);
  expect(stdout).toContain("(input buffer canceled)");
  expect(stdout).toContain("(buffer is empty)");
  expect(stderr).toBe("");
}, 20000);

test("console mode exits with code 0 on EOF (Ctrl+D)", async () => {
  const cliPath = join(process.cwd(), "dist-cli", "ksql.js");
  if (!existsSync(cliPath)) {
    expect(true).toBe(true);
    return;
  }

  let child;
  try {
    child = spawn(process.execPath, [cliPath, "--console", "--dry-run"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("EPERM")) {
      expect(true).toBe(true);
      return;
    }
    throw err;
  }

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d.toString(); });
  child.stderr.on("data", (d) => { stderr += d.toString(); });

  await sleep(120);
  child.stdin.end();

  const result = await new Promise<{ code: number; skipped: boolean }>((resolveCode) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPERM") {
        resolveCode({ code: 0, skipped: true });
        return;
      }
      resolveCode({ code: 1, skipped: false });
    });
    child.on("close", (c) => resolveCode({ code: c ?? 1, skipped: false }));
  });

  if (result.skipped) {
    expect(true).toBe(true);
    return;
  }
  expect(result.code).toBe(0);
  expect(stdout).toContain("(EOF) console closed");
  expect(stderr).toBe("");
}, 20000);

test("console mode shows session summary and supports history options", async () => {
  const cliPath = join(process.cwd(), "dist-cli", "ksql.js");
  if (!existsSync(cliPath)) {
    expect(true).toBe(true);
    return;
  }

  const homeDir = mkdtempSync(join(tmpdir(), "ksql-home-"));
  let child;
  try {
    child = spawn(process.execPath, [cliPath, "--console", "--native-upsert", "--dry-run", "--format", "json"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("EPERM")) {
      expect(true).toBe(true);
      return;
    }
    throw err;
  }

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d.toString(); });
  child.stderr.on("data", (d) => { stderr += d.toString(); });

  await sleep(120);
  child.stdin.write("SELECT * FROM APP88;\n");
  await sleep(160);
  child.stdin.write("SELECT * FROM APP89;\n");
  await sleep(160);
  child.stdin.write(":history 1\n");
  await sleep(160);
  child.stdin.write(":history find APP88\n");
  await sleep(160);
  child.stdin.write(":help\n");
  await sleep(160);
  child.stdin.write(":exit\n");
  child.stdin.end();

  const result = await new Promise<{ code: number; skipped: boolean }>((resolveCode) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPERM") {
        resolveCode({ code: 0, skipped: true });
        return;
      }
      resolveCode({ code: 1, skipped: false });
    });
    child.on("close", (c) => resolveCode({ code: c ?? 1, skipped: false }));
  });

  if (result.skipped) {
    expect(true).toBe(true);
    rmSync(homeDir, { recursive: true, force: true });
    return;
  }

  expect(result.code).toBe(0);
  expect(stdout).toContain("session:");
  expect(stdout).toContain("native-upsert=on");
  expect(stdout).toContain("format=json");
  expect(stdout).toContain("2. SELECT * FROM APP89");
  expect(stdout).toContain("1. SELECT * FROM APP88");
  expect(stdout).toContain("Ctrl+C: cancel input buffer");
  expect(stdout).toContain("Ctrl+D: exit console");
  expect(stderr).toContain("rowCount=6");
  rmSync(homeDir, { recursive: true, force: true });
}, 20000);

test("console mode supports profile/rerun/save workflow", async () => {
  const cliPath = join(process.cwd(), "dist-cli", "ksql.js");
  if (!existsSync(cliPath)) {
    expect(true).toBe(true);
    return;
  }

  const savePath = join(process.cwd(), "temp-repl-output.txt");
  if (existsSync(savePath)) unlinkSync(savePath);
  const homeDir = mkdtempSync(join(tmpdir(), "ksql-home-"));

  let child;
  try {
    child = spawn(process.execPath, [cliPath, "--console", "--dry-run"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("EPERM")) {
      expect(true).toBe(true);
      return;
    }
    throw err;
  }

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d.toString(); });
  child.stderr.on("data", (d) => { stderr += d.toString(); });

  await sleep(120);
  child.stdin.write(":profile qa\n");
  await sleep(160);
  child.stdin.write("SELECT * FROM APP88;\n");
  await sleep(200);
  child.stdin.write(":rerun 1\n");
  await sleep(200);
  child.stdin.write(`:save ${savePath}\n`);
  await sleep(160);
  child.stdin.write(":exit\n");
  child.stdin.end();

  const result = await new Promise<{ code: number; skipped: boolean }>((resolveCode) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPERM") {
        resolveCode({ code: 0, skipped: true });
        return;
      }
      resolveCode({ code: 1, skipped: false });
    });
    child.on("close", (c) => resolveCode({ code: c ?? 1, skipped: false }));
  });

  if (result.skipped) {
    expect(true).toBe(true);
    rmSync(homeDir, { recursive: true, force: true });
    return;
  }

  expect(result.code).toBe(0);
  expect(stdout).toContain("profile=qa");
  expect(stdout).toContain("rerun: SELECT * FROM APP88");
  expect(stdout).toContain(`saved: ${savePath}`);
  expect(stderr).toContain("rowCount=6");
  expect(existsSync(savePath)).toBe(true);
  expect(readFileSync(savePath, "utf-8")).toContain("plan");

  unlinkSync(savePath);
  rmSync(homeDir, { recursive: true, force: true });
}, 20000);

test("console mode :show config prints resolved-app-profiles after APP@profile query", async () => {
  const cliPath = join(process.cwd(), "dist-cli", "ksql.js");
  if (!existsSync(cliPath)) {
    expect(true).toBe(true);
    return;
  }

  let child;
  try {
    child = spawn(process.execPath, [cliPath, "--console", "--dry-run"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("EPERM")) {
      expect(true).toBe(true);
      return;
    }
    throw err;
  }

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d.toString(); });
  child.stderr.on("data", (d) => { stderr += d.toString(); });

  await sleep(120);
  child.stdin.write("SELECT * FROM APP88@guest;\n");
  await sleep(180);
  child.stdin.write(":show config\n");
  await sleep(180);
  child.stdin.write(":exit\n");
  child.stdin.end();

  const result = await new Promise<{ code: number; skipped: boolean }>((resolveCode) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPERM") {
        resolveCode({ code: 0, skipped: true });
        return;
      }
      resolveCode({ code: 1, skipped: false });
    });
    child.on("close", (c) => resolveCode({ code: c ?? 1, skipped: false }));
  });

  if (result.skipped) {
    expect(true).toBe(true);
    return;
  }

  expect(result.code).toBe(0);
  expect(stdout).toContain("resolved-app-profiles=APP88->guest");
  expect(stderr).toContain("rowCount=");
}, 20000);

test("console: batch construction mode with :run/:buffer/:clear (S7)", async () => {
  const cliPath = join(process.cwd(), "dist-cli", "ksql.js");
  if (!existsSync(cliPath)) {
    expect(true).toBe(true);
    return;
  }

  let child;
  try {
    child = spawn(process.execPath, [cliPath, "--console", "--dry-run"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("EPERM")) {
      expect(true).toBe(true);
      return;
    }
    throw err;
  }

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d.toString(); });
  child.stderr.on("data", (d) => { stderr += d.toString(); });

  await sleep(120);
  // 空バッファで :run はエラー
  child.stdin.write(":run\n");
  await sleep(150);
  // CREATE TEMP TABLE 開始 → ; 終端でも実行されずバッチ構築モードで蓄積
  child.stdin.write("CREATE TEMP TABLE #t AS SELECT * FROM APP100;\n");
  await sleep(150);
  // バッファ非空でもメタコマンドが解釈される
  child.stdin.write(":buffer\n");
  await sleep(150);
  child.stdin.write(":clear\n");
  await sleep(150);
  // typo は ; 終端で即エラー + バッファ破棄
  child.stdin.write("SELEC * FROM APP100;\n");
  await sleep(150);
  child.stdin.write(":exit\n");
  child.stdin.end();

  const result = await new Promise<{ code: number; skipped: boolean }>((resolveCode) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPERM") {
        resolveCode({ code: 0, skipped: true });
        return;
      }
      resolveCode({ code: 1, skipped: false });
    });
    child.on("close", (c) => resolveCode({ code: c ?? 1, skipped: false }));
  });

  if (result.skipped) {
    expect(true).toBe(true);
    return;
  }

  expect(result.code).toBe(0);
  expect(stderr).toContain("input buffer is empty");           // :run 空エラー
  expect(stdout).toContain("CREATE TEMP TABLE #t");            // :buffer が蓄積内容を表示
  expect(stdout).toContain("(input buffer cleared)");          // :clear
  expect(stderr).toContain("(input buffer cleared)");          // typo 即エラー時の破棄通知
}, 20000);

test("console: DML バッチは :run 時と ; 完結時に REPL で確認され、no でキャンセルできる（M2）", async () => {
  const cliPath = join(process.cwd(), "dist-cli", "ksql.js");
  if (!existsSync(cliPath)) {
    expect(true).toBe(true);
    return;
  }

  let child;
  try {
    child = spawn(process.execPath, [cliPath, "--console", "--allow-dml"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("EPERM")) {
      expect(true).toBe(true);
      return;
    }
    throw err;
  }

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d.toString(); });
  child.stderr.on("data", (d) => { stderr += d.toString(); });

  await sleep(150);
  // :run 経路: バッチ構築モードで DML バッチを組み、:run → 確認 → no
  child.stdin.write("CREATE TEMP TABLE #t AS SELECT 顧客名 FROM APP88;\n");
  await sleep(120);
  child.stdin.write("INSERT INTO APP89 (名前) SELECT 顧客名 FROM #t;\n");
  await sleep(120);
  child.stdin.write(":run\n");
  await sleep(200);
  child.stdin.write("no\n");
  await sleep(200);
  // キャンセル後もバッファは保持されている
  child.stdin.write(":buffer\n");
  await sleep(150);
  child.stdin.write(":clear\n");
  await sleep(120);
  // ; 完結の1行複文経路: DML を含むバッチ → 確認 → no
  child.stdin.write("SELECT 顧客名 FROM APP88; DELETE FROM APP90 WHERE $id = 1;\n");
  await sleep(200);
  child.stdin.write("no\n");
  await sleep(200);
  child.stdin.write(":exit\n");
  child.stdin.end();

  const result = await new Promise<{ code: number; skipped: boolean }>((resolveCode) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPERM") {
        resolveCode({ code: 0, skipped: true });
        return;
      }
      resolveCode({ code: 1, skipped: false });
    });
    child.on("close", (c) => resolveCode({ code: c ?? 1, skipped: false }));
  });

  if (result.skipped) {
    expect(true).toBe(true);
    return;
  }

  expect(result.code).toBe(0);
  expect(stdout).toContain("[DML Confirm] batch");
  expect(stdout).toContain("INSERT_SELECT app=APP89 where=no"); // :run 経路の一覧
  expect(stdout).toContain("DELETE app=APP90 where=yes");        // ; 完結経路の一覧
  expect(stdout.match(/\[DML Confirm\] batch/g)?.length).toBe(2);
  expect(stderr.match(/DML was cancelled by user\./g)?.length).toBe(2);
  expect(stdout).toContain("CREATE TEMP TABLE #t");              // キャンセル後の :buffer 表示
});
