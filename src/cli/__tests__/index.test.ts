import {
  CLI_IMPORT_SOURCE_REQUIRED_MESSAGE,
  CLI_HELP_TEXT,
  buildReplExecArgv,
  buildValidationOutput,
  extractAppIds,
  normalizeAppKey,
  normalizeSqlAppProfiles,
  parseConfirmAnswer,
  parseArgs,
  parseConsoleMetaCommand,
  parseTokenMap,
  shouldExitOnEmpty,
  runWithArgv,
  toCliImportError,
} from "../index";

const DML_VALIDATION_COLUMNS = [
  "code", "$err_statement", "$err_operation", "$err_row", "$err_field", "$err_code", "$err_message",
  "$err_value", "$err_subtable", "$err_subrow", "$err_subrow_id",
];

async function runCliCaptured(argv: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
  let stderr = "";
  let stdout = "";
  const errSpy = jest.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  const outSpy = jest.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  try {
    return { code: await runWithArgv(argv), stderr, stdout };
  } finally {
    errSpy.mockRestore();
    outSpy.mockRestore();
  }
}

describe("cli helpers", () => {
  test.each([
    ["単文", ["-e", "IMPORT INTO APP100 (name) FROM CSV people"]],
    ["EXPLAIN", ["--dry-run", "-e", "IMPORT INTO APP100 (name) FROM CSV people"]],
    ["バッチ", ["-e", "SELECT 1; IMPORT INTO APP100 (name) FROM CSV people"]],
  ])("IMPORT gate はソース未指定の%s経路で CLI 案内になる", async (_label, argv) => {
    const result = await runCliCaptured(argv);
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe(CLI_IMPORT_SOURCE_REQUIRED_MESSAGE);
  });

  test("CLI IMPORT 案内は gate かつソース未指定の場合だけ適用する", () => {
    const gateError = new Error("IMPORT is not supported (capability is disabled).");
    const syntaxError = new Error("ParseError: unexpected token");
    expect(toCliImportError(syntaxError, false)).toBe(syntaxError);
    expect(toCliImportError(gateError, true)).toBe(gateError);
    expect(gateError.message).toContain("capability is disabled");
  });

  test("VALIDATION resultをJSON契約とtableへ整形する", () => {
    const result = {
      type: "VALIDATION" as const,
      operation: "INSERT" as const,
      validatedRows: 1, validRows: 0, invalidRows: 1, errorCount: 1,
      columns: DML_VALIDATION_COLUMNS,
      errors: [{
        code: "", $err_statement: "1", $err_operation: "INSERT", $err_row: "1",
        $err_field: "code", $err_code: "ERR_REQUIRED", $err_message: "required", $err_value: "",
        $err_subtable: "", $err_subrow: "", $err_subrow_id: "",
      }],
    };
    expect(JSON.parse(buildValidationOutput(result, "json", false, false, {}))).toMatchObject({
      ok: true, type: "VALIDATION", errorCount: 1,
    });
    expect(buildValidationOutput(result, "table", false, false, {})).toContain("ERR_REQUIRED");
    expect(buildValidationOutput(result, "table", false, false, {})).toContain("$err_subrow_id");
  });
  test("parseTokenMap normalizes app keys", () => {
    const m = parseTokenMap("APP100=t1,101=t2");
    expect(m.APP100).toBe("t1");
    expect(m.APP101).toBe("t2");
  });

  test("normalizeAppKey accepts APP prefix and numeric key", () => {
    expect(normalizeAppKey("APP88")).toBe("APP88");
    expect(normalizeAppKey("88")).toBe("APP88");
  });

  test("extractAppIds scans SQL", () => {
    const ids = extractAppIds("SELECT * FROM APP100 JOIN APP101 ON APP100.レコード番号 = APP101.レコード番号");
    expect(ids).toEqual([100, 101]);
  });

  test("extractAppIds はコメント内の APPxxx を無視する", () => {
    expect(extractAppIds("-- 通知(APP4206)\nSELECT * FROM APP4205")).toEqual([4205]);
    expect(extractAppIds("/* APP4207 */ SELECT * FROM APP4205")).toEqual([4205]);
  });

  test("extractAppIds は文字列リテラル内の APPxxx を無視する", () => {
    expect(extractAppIds("SELECT 'APP4206の件' AS x FROM APP4205")).toEqual([4205]);
  });

  test("extractAppIds はバッククォート識別子内の APPxxx を無視する", () => {
    expect(extractAppIds("SELECT `APP4206` FROM APP4205")).toEqual([4205]);
  });

  test("extractAppIds は @profile / $subtable を含む有効な APP 参照も従来どおり拾う", () => {
    // 修正前の正規表現でも AppId を取得できるため回帰検出ではなく、
    // 境界判定を collectAppProfileTokens に一本化した後も有効参照が壊れないことの固定
    expect(extractAppIds("SELECT * FROM APP100@dev")).toEqual([100]);
    expect(extractAppIds("SELECT * FROM APP100$明細")).toEqual([100]);
  });

  test("normalizeSqlAppProfiles strips @profile from app refs", () => {
    const parsed = normalizeSqlAppProfiles("SELECT * FROM APP100@guest JOIN app80$明細@dev ON 1=1");
    expect(parsed.normalizedSql).toContain("APP100");
    expect(parsed.normalizedSql).toContain("app80$明細");
    expect(parsed.normalizedSql).not.toContain("@guest");
    expect(parsed.normalizedSql).not.toContain("@dev");
    expect(parsed.hasProfileSyntax).toBe(true);
    expect(parsed.appBindingByMappedApp.size).toBeGreaterThanOrEqual(2);
  });

  test("normalizeSqlAppProfiles ignores literals and comments", () => {
    const sql = "SELECT 'APP100@guest' AS x FROM APP88 -- APP99@dev";
    const parsed = normalizeSqlAppProfiles(sql);
    expect(parsed.normalizedSql).toContain("'APP100@guest'");
    expect(parsed.normalizedSql).toContain("-- APP99@dev");
    expect(parsed.appBindingByMappedApp.size).toBe(1);
  });

  test("normalizeSqlAppProfiles allows same app with different profiles", () => {
    const parsed = normalizeSqlAppProfiles("SELECT * FROM APP88@dev a JOIN APP88@guest b ON a.$id=b.$id", "dev");
    expect(parsed.hasProfileSyntax).toBe(true);
    expect(parsed.normalizedSql).not.toContain("@dev");
    expect(parsed.normalizedSql).not.toContain("@guest");
    const bindings = [...parsed.appBindingByMappedApp.values()];
    const profiles = new Set(bindings.map((b) => b.profile));
    expect(profiles.has("dev")).toBe(true);
    expect(profiles.has("guest")).toBe(true);
  });

  test("parseArgs parses requestGate flags（バッチ強化第1弾 C2）", () => {
    const args = parseArgs([
      "--max-concurrent", "5",
      "--cursor-max-active", "4",
      "--retry", "0",
      "--retry-base-delay", "100",
      "--retry-max-delay", "2000",
      "-e", "SELECT * FROM APP100",
    ]);
    expect(args.maxConcurrent).toBe(5);
    expect(args.cursorMaxActive).toBe(4);
    expect(args.retry).toBe(0); // 0 = リトライ無効は有効値
    expect(args.retryBaseDelay).toBe(100);
    expect(args.retryMaxDelay).toBe(2000);
  });

  test("B173 AC-20: --native-upsert は実行ごとの boolean で既定 OFF、CLI help にだけ表示する", () => {
    expect(parseArgs(["-e", "SELECT 1"]).nativeUpsert).toBe(false);
    expect(parseArgs(["--native-upsert", "-e", "SELECT 1"]).nativeUpsert).toBe(true);
    expect(CLI_HELP_TEXT).toContain("--native-upsert");
  });

  test("B173 AC-15: --native-upsert 単独では DML safety gate を迂回しない", async () => {
    const result = await runCliCaptured([
      "--native-upsert",
      "-e",
      "UPSERT INTO APP1 (key) VALUES ('K1') ON DUPLICATE (key)",
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("DML is disabled. Use --allow-dml");
    expect(result.stdout).toBe("");
  });

  test("B173 AC-16/20/21/22: offline dry-run は CLI opt-in と UNKNOWN を公開 plan に反映する", async () => {
    const sql = "UPSERT INTO APP1 (key) VALUES ('K1') ON DUPLICATE (key)";
    const optedIn = await runCliCaptured(["--allow-dml", "--native-upsert", "--dry-run", "-e", sql]);
    expect(optedIn.code).toBe(0);
    expect(optedIn.stdout).toContain("native UPSERT eligibility: UNKNOWN");
    expect(optedIn.stdout).toContain("条件 3: KEY_SCHEMA — フォームメタデータ未取得");
    expect(optedIn.stdout).not.toContain("条件 2: OPT_IN");

    const defaultOff = await runCliCaptured(["--allow-dml", "--dry-run", "-e", sql]);
    expect(defaultOff.code).toBe(0);
    expect(defaultOff.stdout).toContain("native UPSERT eligibility: INELIGIBLE（条件 2: OPT_IN");
    expect(defaultOff.stdout).toContain("native UPSERT statement/data eligibility: UNKNOWN");
  });

  test("parseArgs は --var を正規化し、最初の = だけで分割する", () => {
    const args = parseArgs(["--var", "Since=2026-07-01 12:00", "--var", "empty=", "--var", "x=a=b", "--var", "__proto__=safe"]);
    expect(args.variables.since).toBe("2026-07-01 12:00");
    expect(args.variables.empty).toBe("");
    expect(args.variables.x).toBe("a=b");
    expect(args.variables.__proto__).toBe("safe");
    expect(Object.prototype.hasOwnProperty.call(args.variables, "__proto__")).toBe(true);
    expect(() => parseArgs(["--var", "x=1", "--var", "X=2"])).toThrow(/specified more than once/);
    expect(() => parseArgs(["--var", "@x=1"])).toThrow(/invalid variable name/);
    expect(() => parseArgs(["--var", "x"])).toThrow(/name=value/);
  });

  test("parseArgs requestGate flags のデフォルトは null（未指定 = profile / 既定に委ねる）", () => {
    const args = parseArgs(["-e", "SELECT 1"]);
    expect(args.maxConcurrent).toBeNull();
    expect(args.cursorMaxActive).toBeNull();
    expect(args.retry).toBeNull();
    expect(args.retryBaseDelay).toBeNull();
    expect(args.retryMaxDelay).toBeNull();
  });

  test("parseArgs requestGate flags の範囲検証", () => {
    expect(() => parseArgs(["--max-concurrent", "0"])).toThrow(/--max-concurrent must be an integer between 1 and 50/);
    expect(() => parseArgs(["--max-concurrent", "51"])).toThrow(/between 1 and 50/);
    expect(() => parseArgs(["--cursor-max-active", "0"])).toThrow(/between 1 and 5/);
    expect(() => parseArgs(["--cursor-max-active", "6"])).toThrow(/between 1 and 5/);
    expect(() => parseArgs(["--retry", "-1"])).toThrow(/--retry must be an integer between 0 and 10/);
    expect(() => parseArgs(["--retry", "11"])).toThrow(/between 0 and 10/);
    expect(() => parseArgs(["--retry-base-delay", "0"])).toThrow(/--retry-base-delay must be a positive integer/);
    expect(() => parseArgs(["--retry-max-delay", "abc"])).toThrow(/--retry-max-delay must be a positive integer/);
  });

  test("parseArgs parses output and flags", () => {
    const args = parseArgs([
      "--auth", "userpass",
      "--username", "user1",
      "--password", "pass1",
      "--format", "json",
      "--output", "out.json",
      "--no-color",
      "--debug",
      "--debug-url",
      "--debug-headers",
      "--guest-space-id", "12",
      "--diag-record-id", "1",
      "--exit-on-empty",
      "--allow-dml",
      "--yes",
      "--allow-without-where",
      "--dml-max-rows", "55",
      "--dml-max-subtable-rows", "77",
      "--user-format", "name",
      "--array-format", "join",
      "-e", "SELECT * FROM APP100",
    ]);
    expect(args.format).toBe("json");
    expect(args.auth).toBe("userpass");
    expect(args.username).toBe("user1");
    expect(args.password).toBe("pass1");
    expect(args.outputPath).toBe("out.json");
    expect(args.noColor).toBe(true);
    expect(args.debug).toBe(true);
    expect(args.debugUrl).toBe(true);
    expect(args.debugHeaders).toBe(true);
    expect(args.guestSpaceId).toBe(12);
    expect(args.diagRecordId).toBe(1);
    expect(args.exitOnEmpty).toBe(true);
    expect(args.allowDml).toBe(true);
    expect(args.yes).toBe(true);
    expect(args.allowWithoutWhere).toBe(true);
    expect(args.dmlMaxRows).toBe(55);
    expect(args.dmlMaxSubtableRows).toBe(77);
    expect(args.userFormat).toBe("name");
    expect(args.arrayFormat).toBe("join");
    expect(args.executeSql).toContain("SELECT");
  });

  test("parseArgs normalizes markdown alias", () => {
    const args = parseArgs(["--format", "md", "-e", "SELECT * FROM APP100"]);
    expect(args.format).toBe("markdown");
  });

  test("parseArgs parses query limits", () => {
    const args = parseArgs([
      "--max-records", "123",
      "--on-limit", "truncate",
      "--timeout", "45000",
      "-e", "SELECT * FROM APP100",
    ]);
    expect(args.maxRecords).toBe(123);
    expect(args.onLimit).toBe("truncate");
    expect(args.timeout).toBe(45000);
  });

  test("parseArgs parses fetch-parallel", () => {
    const args = parseArgs(["--fetch-parallel", "5", "-e", "SELECT * FROM APP100"]);
    expect(args.fetchParallel).toBe(5);
  });

  test("parseArgs parses temp-table-max-rows", () => {
    const args = parseArgs(["--temp-table-max-rows", "20000", "-e", "SELECT * FROM APP100"]);
    expect(args.tempTableMaxRows).toBe(20000);
  });

  test("parseArgs validates temp-table-max-rows as positive integer", () => {
    for (const invalid of ["0", "-1", "1.5", "abc"]) {
      expect(() => parseArgs(["--temp-table-max-rows", invalid, "-e", "SELECT 1"]))
        .toThrow(/--temp-table-max-rows must be a positive integer/);
    }
  });

  test("parseArgs validates dml-max-subtable-rows as positive safe integer", () => {
    expect(parseArgs(["--dml-max-subtable-rows", "100", "-e", "SELECT 1"]).dmlMaxSubtableRows).toBe(100);
    for (const invalid of ["0", "-1", "1.5", "abc", "9007199254740992"]) {
      expect(() => parseArgs(["--dml-max-subtable-rows", invalid, "-e", "SELECT 1"]))
        .toThrow(/--dml-max-subtable-rows must be a positive integer/);
    }
  });

  test("buildReplExecArgv propagates temp/subtable guards to console child exec", () => {
    const base = parseArgs(["--console", "--temp-table-max-rows", "20000", "--dml-max-subtable-rows", "77"]);
    const argv = buildReplExecArgv(base, "SELECT 1", false, null);
    const idx = argv.indexOf("--temp-table-max-rows");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("20000");
    const subtableIdx = argv.indexOf("--dml-max-subtable-rows");
    expect(subtableIdx).toBeGreaterThan(-1);
    expect(argv[subtableIdx + 1]).toBe("77");
    // 未指定なら子実行 argv に現れない
    const argvDefault = buildReplExecArgv(parseArgs(["--console"]), "SELECT 1", false, null);
    expect(argvDefault).not.toContain("--temp-table-max-rows");
    expect(argvDefault).not.toContain("--dml-max-subtable-rows");
  });

  test("B173 AC-15/20: buildReplExecArgv は session opt-in のときだけ native flag を転送する", () => {
    const enabled = buildReplExecArgv(parseArgs(["--console", "--native-upsert"]), "SELECT 1", false, null);
    const disabled = buildReplExecArgv(parseArgs(["--console"]), "SELECT 1", false, null);
    expect(enabled).toContain("--native-upsert");
    expect(disabled).not.toContain("--native-upsert");
  });

  test("parseArgs validates fetch-parallel range", () => {
    expect(() => parseArgs(["--fetch-parallel", "0", "-e", "SELECT * FROM APP100"])).toThrow(/--fetch-parallel/);
    expect(() => parseArgs(["--fetch-parallel", "11", "-e", "SELECT * FROM APP100"])).toThrow(/--fetch-parallel/);
    expect(() => parseArgs(["--fetch-parallel", "1.5", "-e", "SELECT * FROM APP100"])).toThrow(/--fetch-parallel/);
  });

  test("parseArgs throws for unknown option", () => {
    expect(() => parseArgs(["--unknown"])).toThrow(/unknown option/);
  });

  test("parseArgs validates auth mode", () => {
    expect(() => parseArgs(["--auth", "invalid", "-e", "SELECT * FROM APP100"])).toThrow(/--auth/);
  });

  test("parseArgs validates guest space id", () => {
    expect(() => parseArgs(["--guest-space-id", "0", "-e", "SELECT * FROM APP100"])).toThrow(/--guest-space-id/);
  });

  test("shouldExitOnEmpty ignores dry-run", () => {
    expect(shouldExitOnEmpty(true, true, 0)).toBe(false);
    expect(shouldExitOnEmpty(false, true, 0)).toBe(true);
    expect(shouldExitOnEmpty(false, true, 1)).toBe(false);
  });

  test("parseConsoleMetaCommand handles format and dryrun", () => {
    expect(parseConsoleMetaCommand(":format json")).toEqual({ kind: "set-format", format: "json" });
    expect(parseConsoleMetaCommand(":format md")).toEqual({ kind: "set-format", format: "markdown" });
    expect(parseConsoleMetaCommand(":dryrun on")).toEqual({ kind: "set-dryrun", enabled: true });
    expect(parseConsoleMetaCommand(":dryrun off")).toEqual({ kind: "set-dryrun", enabled: false });
  });

  test("parseConsoleMetaCommand handles help and exit", () => {
    expect(parseConsoleMetaCommand(":help")).toEqual({ kind: "help" });
    expect(parseConsoleMetaCommand(":exit")).toEqual({ kind: "exit" });
    expect(parseConsoleMetaCommand(":quit")).toEqual({ kind: "exit" });
    expect(parseConsoleMetaCommand(":clear")).toEqual({ kind: "clear" });
    expect(parseConsoleMetaCommand(":last")).toEqual({ kind: "show-last" });
    expect(parseConsoleMetaCommand(":buffer")).toEqual({ kind: "show-buffer" });
    expect(parseConsoleMetaCommand(":edit")).toEqual({ kind: "edit-buffer" });
    expect(parseConsoleMetaCommand(":show config")).toEqual({ kind: "show-config" });
    expect(parseConsoleMetaCommand(":history")).toEqual({ kind: "show-history", limit: null, find: null });
    expect(parseConsoleMetaCommand(":history 20")).toEqual({ kind: "show-history", limit: 20, find: null });
    expect(parseConsoleMetaCommand(":history find APP88")).toEqual({ kind: "show-history", limit: null, find: "APP88" });
    expect(parseConsoleMetaCommand(":rerun 2")).toEqual({ kind: "rerun", index: 2 });
    expect(parseConsoleMetaCommand(":save out.txt")).toEqual({ kind: "save", path: "out.txt", append: false });
    expect(parseConsoleMetaCommand(":save --append out.txt")).toEqual({ kind: "save", path: "out.txt", append: true });
    expect(parseConsoleMetaCommand(":profile dev")).toEqual({ kind: "set-profile", profile: "dev" });
  });

  test("parseConsoleMetaCommand invalid command", () => {
    const res = parseConsoleMetaCommand(":format bad");
    expect(res.kind).toBe("error");
    const res2 = parseConsoleMetaCommand(":history nope");
    expect(res2.kind).toBe("error");
  });

  test("parseConfirmAnswer handles duplicated typing", () => {
    expect(parseConfirmAnswer("yes")).toBe(true);
    expect(parseConfirmAnswer(" yyeess ")).toBe(true);
    expect(parseConfirmAnswer("no")).toBe(false);
  });
});
