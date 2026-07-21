import {
  assertApplyExecutionScope,
  assertApplyInternalWriteScope,
  assertApplyPublicWriteScope,
  assertApplyScope,
  assertApplyTargetFieldType,
  assertApplyV1Scope,
  isSinglePositiveRecordIdWhere,
} from "../applyPatchScope";
import type { InsertStatement, UpdateStatement, UpsertStatement } from "../../types/ast";
import { Lexer } from "../../lexer/lexer";
import { Parser } from "../../parser/parser";
import { execute, type KintoneClient } from "../../execute";

const sql = (parentWhere: string, operation: string, tail = "") =>
  `UPDATE APP4221 SET 親 = 'x' WHERE ${parentWhere} APPLY テーブル (${operation}) ${tail}`;

function validate(text: string): void {
  assertApplyV1Scope(new Parser(new Lexer(text).tokenize()).parse());
}

describe("assertApplyV1Scope", () => {
  test.each([
    "PATCH SET 子 = 'x' WHERE _rid = '101'",
    "PATCH SET 子 = 'x' WHERE LENGTH(子) < 3",
    "PATCH SET 子 = 'x' ALL ROWS",
  ])("v1 PATCH scope を許可する: %s", (operation) => {
    expect(() => validate(sql("$id = 8", operation))).not.toThrow();
  });

  test.each([
    ["APPEND", "APPEND (子) VALUES ('x')"],
    ["REMOVE", "REMOVE ALL ROWS"],
    ["EXPECT ROWS", "PATCH SET 子 = 'x' ALL ROWS EXPECT ROWS 1"],
    ["_idx", "PATCH SET 子 = 'x' WHERE _idx = 0"],
    ["parent ref", "PATCH SET 子 = 'x' WHERE _p.親 = 'x'"],
    ["subquery", "PATCH SET 子 = 'x' WHERE 子 IN (SELECT 子 FROM APP2)"],
    ["aggregate", "PATCH SET 子 = 'x' WHERE COUNT(*) > 0"],
    ["KLIKE", "PATCH SET 子 = 'x' WHERE 子 KLIKE 'x'"],
  ])("v1 外 child capability を対象フェーズ付きで拒否する: %s", (_label, operation) => {
    expect(() => validate(sql("$id = 8", operation))).toThrow(/^UnsupportedError: APPLY v1 scope/);
  });

  test.each([
    "$id = 0",
    "$id = -1",
    "$id = 1.5",
    "$id = 8 AND 状態 = 'open'",
    "状態 = 'open'",
  ])("単一の正の安全な整数 $id 以外を拒否する: %s", (where) => {
    expect(() => validate(sql(where, "PATCH SET 子 = 'x' ALL ROWS"))).toThrow(/^UnsupportedError: APPLY v1 scope/);
  });

  test("複数ブロックを拒否し、同一テーブル重複は ArgumentError を優先する", () => {
    const distinct = `${sql("$id = 8", "PATCH SET 子 = 'x' ALL ROWS")} APPLY 別表 (PATCH SET 子 = 'y' ALL ROWS)`;
    expect(() => validate(distinct)).toThrow(/UnsupportedError: APPLY v1 scope.*multiple APPLY/);

    const duplicate = `${sql("$id = 8", "PATCH SET 子 = 'x' ALL ROWS")} APPLY テーブル (PATCH SET 子 = 'y' ALL ROWS)`;
    expect(() => validate(duplicate)).toThrow(/^ArgumentError: APPLY v1 scope/);
  });

  test("UPDATE FROM / CHECK / ON ERROR SKIP / REJECT LIMIT の AST 併用を拒否する", () => {
    const base = new Parser(new Lexer(sql("$id = 8", "PATCH SET 子 = 'x' ALL ROWS")).tokenize()).parse() as UpdateStatement;
    const variants: UpdateStatement[] = [
      { ...base, from: { appId: 2, cteName: null, alias: "s", targetJoinField: "$id", joinKeyField: "$id", targetFilter: null } },
      { ...base, checkGroups: [{ rules: [] }] },
      { ...base, onErrorSkip: true, errorTable: "#e" },
      { ...base, rejectLimit: 1 },
    ];
    for (const stmt of variants) expect(() => assertApplyV1Scope(stmt)).toThrow(/^UnsupportedError: APPLY v1 scope/);
  });

  test("parser が AST 化した UPDATE FROM + APPLY を scope で明示拒否する", () => {
    expect(() => validate(
      "UPDATE APP4221 SET 親 = s.親 FROM APP2 s WHERE APP4221.$id = s.$id "
      + "APPLY テーブル (PATCH SET 子 = 'x' ALL ROWS)"
    )).toThrow(/UnsupportedError: APPLY v1 scope does not support UPDATE \.\.\. FROM/);
  });

  test("EXPLAIN executor は APPLY metadata だけを読み records/mutation API 0", async () => {
      const calls = {
        getRecords: jest.fn(), openCursor: jest.fn(), postRecords: jest.fn(), putRecords: jest.fn(),
        deleteRecords: jest.fn(), getApps: jest.fn(), getFields: jest.fn(async () => [
          { code: "親", label: "親", fieldType: "SINGLE_LINE_TEXT", writable: true },
          { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE", writable: false },
          { code: "子", label: "子", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "テーブル" },
        ]),
        getNumberPrecision: jest.fn(), getProcessStatuses: jest.fn(),
      };
      const client = calls as unknown as KintoneClient;
      const statement = sql("$id = 8", "PATCH SET 子 = 'x' ALL ROWS");
      await expect(execute(`EXPLAIN ${statement}`, client)).resolves.toMatchObject({ type: "SELECT" });
      expect(calls.getFields).toHaveBeenCalledWith(4221);
      for (const fn of [calls.getRecords, calls.openCursor, calls.postRecords, calls.putRecords, calls.deleteRecords]) {
        expect(fn).not.toHaveBeenCalled();
      }
  });
});

describe("assertApplyScope v1.1", () => {
  const validateV11 = (text: string): void => {
    assertApplyScope("v1.1", new Parser(new Lexer(text).tokenize()).parse());
  };

  test("異なるtableの複数blockとPATCH/APPENDだけを明示許可する", () => {
    expect(() => validateV11(
      `${sql("$id = 8", "PATCH SET 子 = 'x' ALL ROWS; APPEND (子) VALUES ('a'), ('b')")}`
      + " APPLY 別表 (APPEND (別子) VALUES ('y'))"
    )).not.toThrow();
  });

  test("同一table複数blockはArgumentError、REMOVE/EXPECT/_idx/複数親はv1.1 UnsupportedError", () => {
    expect(() => validateV11(`${sql("$id = 8", "PATCH SET 子='x' ALL ROWS")} APPLY テーブル (APPEND (子) VALUES ('y'))`))
      .toThrow(/^ArgumentError: APPLY v1\.1 scope allows only one block for table テーブル/);
    for (const statement of [
      sql("$id = 8", "REMOVE ALL ROWS"),
      sql("$id = 8", "PATCH SET 子='x' ALL ROWS EXPECT ROWS 1"),
      sql("$id = 8", "PATCH SET 子='x' WHERE _idx=0"),
      sql("$id = 8 OR $id = 9", "APPEND (子) VALUES ('x')"),
    ]) expect(() => validateV11(statement)).toThrow(/^UnsupportedError: APPLY v1\.1 scope/);
  });
});

describe("assertApplyScope v1.2", () => {
  const validateV12 = (text: string): void => {
    assertApplyScope("v1.2", new Parser(new Lexer(text).tokenize()).parse());
  };

  test("v1.1集合にREMOVE WHERE/ALL ROWSを加法許可する", () => {
    expect(() => validateV12(sql("$id = 8", "REMOVE WHERE 子 = 'x'; APPEND (子) VALUES ('new')"))).not.toThrow();
    expect(() => validateV12(sql("$id = 8", "REMOVE ALL ROWS"))).not.toThrow();
  });

  test("EXPECT ROWS/_idx/複数親はv1.2でも明示拒否する", () => {
    for (const statement of [
      sql("$id = 8", "REMOVE ALL ROWS EXPECT ROWS 1"),
      sql("$id = 8", "REMOVE WHERE _idx=0"),
      sql("$id = 8 OR $id = 9", "REMOVE ALL ROWS"),
    ]) expect(() => validateV12(statement)).toThrow(/^UnsupportedError: APPLY v1\.2 scope/);
  });
});

describe("Phase 10a syntax/execution capabilities", () => {
  const parse = (text: string): UpdateStatement =>
    new Parser(new Lexer(text).tokenize()).parse() as UpdateStatement;

  test.each([
    "状態 = 'open'",
    "金額 >= 10 AND 金額 <= 20",
    "金額 BETWEEN 10 AND 20",
    "状態 IN ('open', 'hold')",
    "備考 IS NULL",
    "件名 LIKE 'A%'",
  ])("安全な一般親WHEREをsyntax capabilityで許可する: %s", (where) => {
    const stmt = parse(sql(where, "PATCH SET 子='x' ALL ROWS"));
    expect(() => assertApplyScope("phase10a", stmt)).not.toThrow();
    expect(() => assertApplyExecutionScope("phase10a", stmt))
      .toThrow("UnsupportedError: APPLY Phase 10a execution does not support multiple-parent APPLY");
    expect(() => assertApplyExecutionScope("phase10b", stmt)).not.toThrow();
    expect(() => assertApplyExecutionScope("phase10c", stmt)).not.toThrow();
    expect(() => assertApplyExecutionScope("phase10d", stmt)).not.toThrow();
    expect(() => assertApplyPublicWriteScope("phase10b", stmt))
      .toThrow("UnsupportedError: APPLY Phase 10b public multiple-parent write is not connected");
    expect(() => assertApplyPublicWriteScope("phase10c", stmt))
      .toThrow("UnsupportedError: APPLY Phase 10c public multiple-parent write is not connected");
    expect(() => assertApplyPublicWriteScope("phase10d", stmt)).not.toThrow();
    expect(() => assertApplyInternalWriteScope("phase10b"))
      .toThrow("UnsupportedError: APPLY Phase 10b internal prepared write is not available");
    expect(() => assertApplyInternalWriteScope("phase10c")).not.toThrow();
    expect(() => assertApplyInternalWriteScope("phase10d")).not.toThrow();
  });

  test.each([
    "$id IN (SELECT $id FROM APP2)",
    "COUNT(*) > 0",
  ])("危険な一般親WHEREはsyntax capabilityでも拒否する: %s", (where) => {
    expect(() => assertApplyScope("phase10a", parse(sql(where, "PATCH SET 子='x' ALL ROWS"))))
      .toThrow(/^UnsupportedError: APPLY phase10a scope/);
  });

  test("B47-P3: 親KLIKEは複数親能力を持つUPDATE APPLYだけsyntax gateを通す", () => {
    const stmt = parse(sql("件名 KLIKE 'A'", "PATCH SET 子='x' ALL ROWS"));
    expect(() => assertApplyScope("phase10a", stmt)).not.toThrow();
    expect(() => assertApplyExecutionScope("phase10a", stmt))
      .toThrow("UnsupportedError: APPLY Phase 10a execution does not support multiple-parent APPLY");
    expect(() => assertApplyScope("phase15b", stmt)).not.toThrow();
  });

  test("単一$id完全一致を構文判定し、既存execution capabilityを維持する", () => {
    const exact = parse(sql("$id = 8", "PATCH SET 子='x' ALL ROWS"));
    const general = parse(sql("$id = 8 AND 状態='open'", "PATCH SET 子='x' ALL ROWS"));
    expect(isSinglePositiveRecordIdWhere(exact.where)).toBe(true);
    expect(isSinglePositiveRecordIdWhere(general.where)).toBe(false);
    expect(() => assertApplyScope("phase10a", exact)).not.toThrow();
    expect(() => assertApplyExecutionScope("phase10a", exact)).not.toThrow();
  });

  test.each(["$id = 0", "$id = -1", "$id = 1.5"])(
    "不正な単一$idは一般WHEREへ格上げしない: %s",
    (where) => expect(() => assertApplyScope("phase10a", parse(sql(where, "PATCH SET 子='x' ALL ROWS"))))
      .toThrow(/^UnsupportedError: APPLY phase10a scope/)
  );
});

describe("Phase 11 _idx syntax/execution capability", () => {
  const parse = (text: string): UpdateStatement =>
    new Parser(new Lexer(text).tokenize()).parse() as UpdateStatement;

  test.each([
    "PATCH SET 子='x' WHERE _idx=0",
    "PATCH SET 子='x' WHERE _idx IN (0,2)",
    "REMOVE WHERE _idx=0",
    "REMOVE WHERE _idx IN (0,2)",
  ])("PATCH/REMOVEの子selectorで_idxを許可する: %s", (operation) => {
    const stmt = parse(sql("状態='open'", operation));
    expect(() => assertApplyScope("phase11", stmt)).not.toThrow();
    expect(() => assertApplyExecutionScope("phase11", stmt)).not.toThrow();
    expect(() => assertApplyPublicWriteScope("phase11", stmt)).not.toThrow();
  });

  test("_idx代入先はsystem fieldとして拒否し、Phase 10aではselector解禁を先取りしない", () => {
    expect(() => assertApplyScope("phase11", parse(sql("$id=8", "PATCH SET _idx=1 ALL ROWS"))))
      .toThrow("ArgumentError: APPLY assignment target _idx is a system field");
    expect(() => assertApplyScope("phase10a", parse(sql("$id=8", "PATCH SET 子='x' WHERE _idx=0"))))
      .toThrow(/^UnsupportedError: APPLY phase10a scope/);
  });

  test.each([
    "PATCH SET 子='x' WHERE _p.親='x'",
    "PATCH SET 子='x' WHERE 子 IN (SELECT 子 FROM APP2)",
    "PATCH SET 子='x' WHERE COUNT(*)>0",
    "PATCH SET 子='x' WHERE 子 KLIKE 'x'",
  ])("既存の危険な子selectorは継続拒否する: %s", (operation) => {
    expect(() => assertApplyScope("phase11", parse(sql("$id=8", operation))))
      .toThrow(/^UnsupportedError: APPLY phase11 scope/);
  });
});

describe("Phase 12 EXPECT ROWS syntax/execution capability", () => {
  const parse = (text: string): UpdateStatement =>
    new Parser(new Lexer(text).tokenize()).parse() as UpdateStatement;

  test.each([
    "PATCH SET 子='x' ALL ROWS EXPECT ROWS 2",
    "PATCH SET 子='x' ALL ROWS EXPECT ROWS BETWEEN 1 AND 2",
    "REMOVE ALL ROWS EXPECT ROWS AT LEAST 1",
    "REMOVE ALL ROWS EXPECT ROWS AT MOST 2",
  ])("PATCH/REMOVEのEXPECT ROWS 4形をsyntax/executionとも許可する: %s", (operation) => {
    const stmt = parse(sql("状態='open'", operation));
    expect(() => assertApplyScope("phase12", stmt)).not.toThrow();
    expect(() => assertApplyExecutionScope("phase12", stmt)).not.toThrow();
    expect(() => assertApplyPublicWriteScope("phase12", stmt)).not.toThrow();
  });

  test("Phase 11ではEXPECTを継続拒否し、APPENDにはEXPECT ROWS文法がない", () => {
    const guardedPatch = parse(sql("$id=8", "PATCH SET 子='x' ALL ROWS EXPECT ROWS 1"));
    expect(() => assertApplyScope("phase11", guardedPatch))
      .toThrow("UnsupportedError: APPLY phase11 scope does not support EXPECT ROWS");
    expect(() => parse(sql("$id=8", "APPEND (子) VALUES ('x') EXPECT ROWS 1"))).toThrow();
  });
});

describe("Phase 13a INSERT syntax/execution capabilities", () => {
  const parseInsert = (text: string): InsertStatement =>
    new Parser(new Lexer(text).tokenize()).parse() as InsertStatement;
  const insert = (operation: string, tail = "") =>
    `INSERT INTO APP4221 (親) VALUES ('x') APPLY テーブル (${operation}) ${tail}`;

  test("INSERT APPLY は APPEND のみ syntax capability で許可する", () => {
    const stmt = parseInsert(insert("APPEND (子) VALUES ('a'), ('b')"));
    expect(() => assertApplyScope("phase13a", stmt)).not.toThrow();
    expect(() => assertApplyExecutionScope("phase13a", stmt))
      .toThrow("UnsupportedError: APPLY Phase 13a INSERT execution is not connected");
  });

  test.each([
    ["PATCH", "PATCH SET 子='x' ALL ROWS"],
    ["REMOVE", "REMOVE ALL ROWS"],
    ["EXPECT ROWS", "PATCH SET 子='x' ALL ROWS EXPECT ROWS 1"],
    ["_idx", "REMOVE WHERE _idx=0"],
  ])("INSERT APPLY の %s を scope で拒否する", (_label, operation) => {
    expect(() => assertApplyScope("phase13a", parseInsert(insert(operation))))
      .toThrow(/^UnsupportedError: APPLY phase13a scope does not support/);
  });

  test("VALIDATE ONLY は execution gate を通し、CHECK/ON ERROR は静的に閉じる", () => {
    const validation = parseInsert(insert("APPEND (子) VALUES ('a')", "VALIDATE ONLY"));
    expect(() => assertApplyScope("phase13a", validation)).not.toThrow();
    expect(() => assertApplyExecutionScope("phase13a", validation)).not.toThrow();

    const base = parseInsert(insert("APPEND (子) VALUES ('a')"));
    for (const variant of [
      { ...base, checkGroups: [{ rules: [] }] },
      { ...base, onErrorSkip: true as const, errorTable: "#e" },
    ]) {
      expect(() => assertApplyScope("phase13a", variant)).toThrow(/^UnsupportedError: APPLY phase13a scope/);
    }
  });

  test("Phase 12 は INSERT APPLY を先取りせず、APPLY なし INSERT は非回帰", () => {
    expect(() => assertApplyScope("phase12", parseInsert(insert("APPEND (子) VALUES ('a')"))))
      .toThrow("UnsupportedError: APPLY phase12 scope does not support INSERT in this phase");
    const plain = parseInsert("INSERT INTO APP4221 (APPLY) VALUES ('x')");
    expect(() => assertApplyScope("phase13a", plain)).not.toThrow();
    expect(() => assertApplyExecutionScope("phase13a", plain)).not.toThrow();
  });
});

describe("Phase 14a UPSERT branch syntax/execution capabilities", () => {
  const parseUpsert = (text: string): UpsertStatement =>
    new Parser(new Lexer(text).tokenize()).parse() as UpsertStatement;
  const upsert = (branches = "") =>
    `UPSERT INTO APP4221 (key, 親) VALUES ('K1', 'x') ON DUPLICATE (key) ${branches}`;

  test("ON INSERT は APPEND のみ、ON UPDATE は PATCH/APPEND/REMOVE を許可する", () => {
    const stmt = parseUpsert(upsert(
      "ON INSERT APPLY 表 (APPEND (子) VALUES ('initial')) "
      + "ON UPDATE APPLY 表 (PATCH SET 子='x' ALL ROWS; APPEND (子) VALUES ('new'); REMOVE WHERE 子='old')"
    ));
    expect(() => assertApplyScope("phase14a", stmt)).not.toThrow();
    expect(() => assertApplyExecutionScope("phase14a", stmt))
      .toThrow("UnsupportedError: APPLY Phase 14a UPSERT execution is not connected");
  });

  test.each([
    ["ON INSERT PATCH", "ON INSERT APPLY 表 (PATCH SET 子='x' ALL ROWS)"],
    ["ON INSERT REMOVE", "ON INSERT APPLY 表 (REMOVE ALL ROWS)"],
    ["ON UPDATE EXPECT", "ON UPDATE APPLY 表 (PATCH SET 子='x' ALL ROWS EXPECT ROWS 1)"],
    ["ON UPDATE _idx", "ON UPDATE APPLY 表 (REMOVE WHERE _idx=0)"],
  ])("UPSERT APPLY の未解禁 capability を拒否する: %s", (_label, branches) => {
    expect(() => assertApplyScope("phase14a", parseUpsert(upsert(branches))))
      .toThrow(/^UnsupportedError: APPLY phase14a scope/);
  });

  test("将来の多値 operation node も phase14a では fail-closed にする", () => {
    const base = parseUpsert(upsert("ON UPDATE APPLY 表 (APPEND (子) VALUES ('x'))"));
    const futureMultiValue = {
      ...base,
      onUpdateApplyBlocks: [{ field: "複数選択", operations: [{ kind: "ADD", value: "重要" }] }],
    } as unknown as UpsertStatement;
    expect(() => assertApplyScope("phase14a", futureMultiValue))
      .toThrow("UnsupportedError: APPLY phase14a scope does not support ADD in this phase");
  });

  test("VALIDATE ONLY と分岐省略は許可し、Phase 13a は UPSERT APPLY を先取りしない", () => {
    const validation = parseUpsert(upsert("ON UPDATE APPLY 表 (REMOVE ALL ROWS) VALIDATE ONLY"));
    expect(() => assertApplyScope("phase14a", validation)).not.toThrow();
    expect(() => assertApplyExecutionScope("phase14a", validation)).not.toThrow();
    expect(validation.onInsertApplyBlocks).toBeUndefined();

    const plain = parseUpsert(upsert());
    expect(() => assertApplyScope("phase14a", plain)).not.toThrow();
    expect(() => assertApplyExecutionScope("phase14a", plain)).not.toThrow();
    expect(() => assertApplyScope("phase13a", parseUpsert(upsert(
      "ON INSERT APPLY 表 (APPEND (子) VALUES ('a'))"
    )))).toThrow("UnsupportedError: APPLY phase13a scope does not support UPSERT in this phase");
  });
});

describe("Phase 15a multi-value syntax/execution capabilities", () => {
  const parseUpdate = (text: string): UpdateStatement =>
    new Parser(new Lexer(text).tokenize()).parse() as UpdateStatement;
  const update = (operations: string, tail = "") => parseUpdate(
    `UPDATE APP4221 SET 親='x' WHERE $id=8 APPLY 複数選択 (${operations}) ${tail}`
  );

  test("ADD/REMOVE_VALUEだけをMULTI_VALUE targetとして許可し、row targetとtagged unionで分ける", () => {
    const multi = update("ADD '重要'; REMOVE '新規'");
    expect(multi.applyBlocks?.[0]).toMatchObject({
      targetKind: "MULTI_VALUE",
      operations: [{ kind: "ADD" }, { kind: "REMOVE_VALUE" }],
    });
    expect(() => assertApplyScope("phase15a", multi)).not.toThrow();

    const rows = parseUpdate(sql("$id=8", "PATCH SET 子='x' ALL ROWS; REMOVE WHERE 子='old'"));
    expect(rows.applyBlocks?.[0]).toMatchObject({ targetKind: "SUBTABLE" });
    expect(() => assertApplyScope("phase15a", rows)).not.toThrow();
  });

  test.each(["MULTI_SELECT", "CHECK_BOX", "USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT"])(
    "multi-value targetの5型matrixを許可する: %s",
    (fieldType) => expect(() => assertApplyTargetFieldType(update("ADD 'x'").applyBlocks![0], fieldType)).not.toThrow()
  );

  test("型×動詞matrixはmulti op→SUBTABLEとrow op→multi-value型をArgumentErrorにする", () => {
    expect(() => assertApplyTargetFieldType(update("REMOVE 'x'").applyBlocks![0], "SUBTABLE"))
      .toThrow(/multi-value operations require/);
    expect(() => assertApplyTargetFieldType(parseUpdate(sql("$id=8", "REMOVE ALL ROWS")).applyBlocks![0], "MULTI_SELECT"))
      .toThrow(/row operations require a SUBTABLE/);
  });

  test("手組みASTでも行操作/値操作の混在をscopeで拒否する", () => {
    const statement = update("ADD 'x'");
    (statement.applyBlocks![0].operations as unknown[]).push({ kind: "REMOVE", selector: { kind: "ALL_ROWS" } });
    expect(() => assertApplyScope("phase15a", statement))
      .toThrow("ArgumentError: APPLY block cannot mix row operations and multi-value operations.");
  });

  test("multi-value mutation executionは閉じ、VALIDATE ONLYはgateを通し、SUBTABLE executionは非回帰", () => {
    const mutation = update("ADD '重要'");
    expect(() => assertApplyExecutionScope("phase15a", mutation))
      .toThrow("UnsupportedError: APPLY Phase 15a multi-value execution is not connected");
    expect(() => assertApplyExecutionScope("phase15a", update("REMOVE '新規'", "VALIDATE ONLY"))).not.toThrow();
    expect(() => assertApplyExecutionScope("phase15a", parseUpdate(sql("$id=8", "REMOVE ALL ROWS")))).not.toThrow();
  });

  test("Phase 15b は同じsyntax matrixのcore mutation executionを開通する", () => {
    const mutation = update("ADD '重要'; REMOVE '新規'");
    expect(() => assertApplyScope("phase15b", mutation)).not.toThrow();
    expect(() => assertApplyExecutionScope("phase15b", mutation)).not.toThrow();
    expect(() => assertApplyPublicWriteScope("phase15b", mutation)).not.toThrow();
  });
});
