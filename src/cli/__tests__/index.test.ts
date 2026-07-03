import {
  extractAppIds,
  normalizeAppKey,
  normalizeSqlAppProfiles,
  parseConfirmAnswer,
  parseArgs,
  parseConsoleMetaCommand,
  parseTokenMap,
  shouldExitOnEmpty,
} from "../index";

describe("cli helpers", () => {
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
