import { Lexer } from "../../../lexer/lexer";
import { Parser } from "../../../parser/parser";
import type { BinaryExpr, SelectStatement, WhereExpr } from "../../../types/ast";
import {
  bindJoinServerFunctionFetches,
  buildJoinPushdownPlan,
  buildJoinPushdownStep2Plan,
  classifyJoinPushdownLeaf,
  classifyJoinServerFunctionLeaf,
  isJoinServerFunctionFetchPlan,
  resolveJoinFieldOwner,
  serializeJoinPushdownItem,
  type JoinPushdownItem,
  type JoinPushdownSource,
  type JoinPushdownSourceKind,
} from "../joinPredicatePushdown";

interface FieldResponse {
  readonly code: string;
  readonly fieldType: string;
  readonly optionOrder?: Readonly<Record<string, number>>;
}

function source(
  alias: string,
  appId: number,
  fields: readonly FieldResponse[],
  options: {
    sourceKind?: JoinPushdownSourceKind;
  } = {}
): JoinPushdownSource {
  return {
    alias,
    appId,
    sourceKind: options.sourceKind ?? "APP",
    fieldTypes: new Map(fields.map((field) => [field.code, field.fieldType])),
    fieldOptions: new Map(fields.flatMap((field) => field.optionOrder
      ? [[field.code, new Set(Object.keys(field.optionOrder))] as const]
      : [])),
  };
}

function where(sql: string): WhereExpr {
  return (new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement).where!;
}

function binary(sql: string): BinaryExpr {
  const expr = where(sql);
  if (expr.type !== "BINARY") throw new Error("expected binary");
  return expr;
}

function relation(sql: string, sources: readonly JoinPushdownSource[]) {
  return classifyJoinPushdownLeaf(binary(sql), sources).relation;
}

const core = source("a", 100, [
  { code: "$id", fieldType: "__ID__" },
  { code: "recordNo", fieldType: "RECORD_NUMBER" },
  { code: "number", fieldType: "NUMBER" },
  { code: "calc", fieldType: "CALC" },
  { code: "text", fieldType: "SINGLE_LINE_TEXT" },
  { code: "link", fieldType: "LINK" },
  { code: "multi", fieldType: "MULTI_LINE_TEXT" },
  { code: "rich", fieldType: "RICH_TEXT" },
  { code: "date", fieldType: "DATE" },
  { code: "time", fieldType: "TIME" },
  { code: "datetime", fieldType: "DATETIME" },
  { code: "created", fieldType: "CREATED_TIME" },
  { code: "updated", fieldType: "UPDATED_TIME" },
  { code: "drop", fieldType: "DROP_DOWN", optionOrder: { A: 0, B: 1 } },
  { code: "radio", fieldType: "RADIO_BUTTON", optionOrder: { A: 0 } },
  { code: "check", fieldType: "CHECK_BOX", optionOrder: { A: 0 } },
  { code: "multiSelect", fieldType: "MULTI_SELECT", optionOrder: { A: 0 } },
  { code: "status", fieldType: "STATUS", optionOrder: { Open: 0, Done: 1 } },
  { code: "creator", fieldType: "CREATOR" },
  { code: "modifier", fieldType: "MODIFIER" },
  { code: "user", fieldType: "USER_SELECT" },
  { code: "organization", fieldType: "ORGANIZATION_SELECT" },
  { code: "teamGroup", fieldType: "GROUP_SELECT" },
  { code: "file", fieldType: "FILE" },
  { code: "assignee", fieldType: "STATUS_ASSIGNEE" },
  { code: "category", fieldType: "CATEGORY" },
]);

describe("B76 §5.2 leaf relation matrix", () => {
  test.each([
    ["$id", "=", "1", "exact"],
    ["recordNo", "=", "1", "unsafe"],
    ["number", "=", "1", "exact"],
    ["calc", "=", "1", "unsafe"],
    ["text", "=", "'A'", "exact"],
    ["link", "=", "'A'", "exact"],
    ["multi", "=", "'A'", "unsafe"],
    ["rich", "=", "'A'", "unsafe"],
    ["date", "=", "'2026-07-27'", "exact"],
    ["time", "=", "'09:30'", "exact"],
    ["datetime", "=", "'2026-07-27T00:30:00Z'", "exact"],
    ["created", "=", "'2026-07-27T00:30:00Z'", "exact"],
    ["updated", "=", "'2026-07-27T00:30:00Z'", "exact"],
    ["creator", "IN", "('u1')", "unsafe"],
    ["modifier", "IN", "('u1')", "unsafe"],
    ["user", "IN", "('u1')", "unsafe"],
    ["organization", "IN", "('o1')", "unsafe"],
    ["teamGroup", "IN", "('g1')", "unsafe"],
    ["assignee", "IN", "('u1')", "unsafe"],
    ["category", "IN", "('c1')", "unsafe"],
  ] as const)("%s %s は %s", (field, op, rhs, expected) => {
    expect(relation(`SELECT * FROM APP100 AS a WHERE a.${field} ${op} ${rhs}`, [core]))
      .toBe(expected);
  });

  test.each([
    ["drop", "IN", "('A', 'B')"],
    ["radio", "NOT IN", "('A')"],
    ["check", "IN", "('A')"],
    ["multiSelect", "NOT IN", "('A')"],
    ["status", "IN", "('Open', 'Done')"],
  ] as const)("%s の実在選択肢 %s は exact", (field, op, rhs) => {
    expect(relation(`SELECT * FROM APP100 AS a WHERE a.${field} ${op} ${rhs}`, [core]))
      .toBe("exact");
  });

  test.each(["text", "link", "multi", "rich", "file"])(
    "%s の KLIKE / NOT KLIKE は exact",
    (field) => {
      for (const op of ["KLIKE", "NOT KLIKE"]) {
        expect(relation(
          `SELECT * FROM APP100 AS a WHERE a.${field} ${op} 'needle'`,
          [core]
        )).toBe("exact");
      }
    }
  );

  test.each([
    "a.text LIKE 'A%'",
    "a.text NOT LIKE 'A%'",
    "a.$id != 1",
    "a.drop = 'A'",
    "a.drop IN ('missing')",
    "a.drop IN ('')",
  ])("Phase A 対象外を unsafe にする: %s", (predicate) => {
    expect(relation(`SELECT * FROM APP100 AS a WHERE ${predicate}`, [core])).toBe("unsafe");
  });

  test("B152 の逐語一致確認後は text の = / != をともに exact にする", () => {
    expect(relation("SELECT * FROM APP100 AS a WHERE a.text = 'A'", [core]))
      .toBe("exact");
    expect(relation("SELECT * FROM APP100 AS a WHERE a.text != 'A'", [core]))
      .toBe("exact");
  });

  test("B151 NUMBER は8演算子を許可10進 literalで exact にする", () => {
    for (const predicate of [
      "a.number = 1",
      "a.number != 1",
      "a.number < 1.5",
      "a.number > 9007199254740992",
      "a.number <= -5",
      "a.number >= 1e3",
      "a.number IN (-5, 0, 1e3)",
      "a.number NOT IN (-5, 0, 1e3)",
    ]) {
      expect(relation(`SELECT * FROM APP100 AS a WHERE ${predicate}`, [core]))
        .toBe("exact");
    }
  });

  test("$id は正の安全整数 domain、RECORD_NUMBER は証明経路が無いため unsafe", () => {
    expect(relation("SELECT * FROM APP100 AS a WHERE a.$id = 0", [core])).toBe("unsafe");
    expect(relation("SELECT * FROM APP100 AS a WHERE a.recordNo = 1", [core]))
      .toBe("unsafe");
  });

  test("canonical でない日付・時刻・日時 literal は unsafe", () => {
    expect(relation("SELECT * FROM APP100 AS a WHERE a.date = '2026-02-30'", [core]))
      .toBe("unsafe");
    expect(relation("SELECT * FROM APP100 AS a WHERE a.time = '24:00'", [core]))
      .toBe("unsafe");
    expect(relation("SELECT * FROM APP100 AS a WHERE a.datetime = '2026-07-27'", [core]))
      .toBe("unsafe");
  });
});

describe("B76 §6.1 ownership", () => {
  const left = source("a", 100, [
    { code: "onlyA", fieldType: "NUMBER" },
    { code: "same", fieldType: "SINGLE_LINE_TEXT" },
  ]);
  const right = source("b", 200, [
    { code: "onlyB", fieldType: "NUMBER" },
    { code: "same", fieldType: "SINGLE_LINE_TEXT" },
  ]);

  test("修飾 field は alias↔APP↔field の対応が揃った場合だけ OWNED", () => {
    expect(resolveJoinFieldOwner(
      { type: "FIELD", tableAlias: "a", field: "onlyA" },
      [left, right]
    )).toMatchObject({ status: "OWNED", alias: "a", appId: 100, fieldCode: "onlyA" });
    expect(resolveJoinFieldOwner(
      { type: "FIELD", tableAlias: "a", field: "onlyB" },
      [left, right]
    )).toEqual({ status: "UNKNOWN" });
    expect(resolveJoinFieldOwner(
      { type: "FIELD", tableAlias: "missing", field: "onlyA" },
      [left, right]
    )).toEqual({ status: "UNKNOWN" });
  });

  test("非修飾 field は実在 source がちょうど1つの場合だけ OWNED", () => {
    expect(resolveJoinFieldOwner(
      { type: "FIELD", tableAlias: null, field: "onlyA" },
      [left, right]
    )).toMatchObject({ status: "OWNED", alias: "a", appId: 100 });
    expect(resolveJoinFieldOwner(
      { type: "FIELD", tableAlias: null, field: "missing" },
      [left, right]
    )).toEqual({ status: "UNKNOWN" });
    expect(resolveJoinFieldOwner(
      { type: "FIELD", tableAlias: null, field: "same" },
      [left, right]
    )).toEqual({ status: "AMBIGUOUS" });
  });

  test("両 APP の同名 field は修飾時だけ正しい APP へ解決し、非修飾時は採用しない", () => {
    const qualified = buildJoinPushdownPlan(
      where("SELECT * FROM APP100 AS a WHERE a.same = 'A'"),
      [left, right]
    );
    expect(qualified.items).toHaveLength(1);
    expect(qualified.items[0]).toMatchObject({ targetAlias: "a", appId: 100 });

    const unqualified = buildJoinPushdownPlan(
      where("SELECT * FROM APP100 AS a WHERE same = 'A'"),
      [left, right]
    );
    expect(unqualified.items).toEqual([]);
  });
});

describe("B76 §5.4 tree composition", () => {
  const left = source("a", 100, [
    { code: "$id", fieldType: "__ID__" },
    { code: "text", fieldType: "SINGLE_LINE_TEXT" },
    { code: "number", fieldType: "NUMBER" },
  ]);
  const right = source("b", 200, [
    { code: "$id", fieldType: "__ID__" },
    { code: "text", fieldType: "SINGLE_LINE_TEXT" },
  ]);

  test("B152 exact leaf と既存 exact leaf の AND は exact", () => {
    const exact = buildJoinPushdownPlan(
      where("SELECT * FROM APP100 AS a WHERE a.$id = 1 AND a.$id < 10"),
      [left, right]
    );
    expect(exact.items).toHaveLength(1);
    expect(exact.items[0].relation).toBe("exact");

    const mixed = buildJoinPushdownPlan(
      where("SELECT * FROM APP100 AS a WHERE a.$id = 1 AND a.text = 'A'"),
      [left, right]
    );
    expect(mixed.items).toHaveLength(1);
    expect(mixed.items[0].relation).toBe("exact");
  });

  test("AND は alias ごとに安全因子を個別抽出する", () => {
    const plan = buildJoinPushdownPlan(
      where("SELECT * FROM APP100 AS a WHERE a.$id = 1 AND b.text = 'B'"),
      [left, right]
    );
    expect(plan.items.map((item) => [item.targetAlias, item.relation])).toEqual([
      ["a", "exact"],
      ["b", "exact"],
    ]);
  });

  test("同一 alias OR は subtree 全体が E/S の場合だけ丸ごと採用する", () => {
    const exact = buildJoinPushdownPlan(
      where("SELECT * FROM APP100 AS a WHERE (a.$id = 1 OR a.$id = 2)"),
      [left, right]
    );
    expect(exact.items).toHaveLength(1);
    expect(exact.items[0].relation).toBe("exact");
    expect(exact.items[0].predicate.type).toBe("GROUP");

    const mixed = buildJoinPushdownPlan(
      where("SELECT * FROM APP100 AS a WHERE a.$id = 1 OR a.text = 'A'"),
      [left, right]
    );
    expect(mixed.items).toHaveLength(1);
    expect(mixed.items[0].relation).toBe("exact");

    const unsafeSide = buildJoinPushdownPlan(
      where("SELECT * FROM APP100 AS a WHERE a.$id = 1 OR a.text != 'A'"),
      [left, right]
    );
    expect(unsafeSide.items).toHaveLength(1);
    expect(unsafeSide.items[0].relation).toBe("exact");
  });

  test("cross-alias OR は片辺だけを押さない", () => {
    const plan = buildJoinPushdownPlan(
      where("SELECT * FROM APP100 AS a WHERE a.$id = 1 OR b.$id = 2"),
      [left, right]
    );
    expect(plan.items).toEqual([]);
  });

  test.each(["KLIKE", "NOT KLIKE"] as const)(
    "%s を含む同一 alias OR は subtree 全体を採用しない",
    (op) => {
      const plan = buildJoinPushdownPlan(
        where(`SELECT * FROM APP100 AS a WHERE a.text ${op} 'urgent' OR a.text = 'A'`),
        [left, right]
      );
      expect(plan.items).toEqual([]);
      expect(plan.appliedKlikes.size).toBe(0);
      expect(plan.allKlikes).toHaveLength(1);
    }
  );

  test("AND spine の KLIKE は元 node identity のまま plan に統合する", () => {
    const expr = where(
      "SELECT * FROM APP100 AS a WHERE a.text KLIKE 'urgent' AND a.$id = 1"
    );
    const klike = expr.type === "LOGICAL" ? expr.left : null;
    const plan = buildJoinPushdownPlan(expr, [left, right]);
    expect(plan.items).toHaveLength(1);
    expect(klike).not.toBeNull();
    expect(plan.appliedKlikes.has(klike as any)).toBe(true);
    expect(plan.allKlikes[0]).toBe(klike);
  });

  test("NOT は対象外、AND の他の安全因子へは影響させない", () => {
    expect(buildJoinPushdownPlan(
      where("SELECT * FROM APP100 AS a WHERE NOT (a.$id = 1)"),
      [left, right]
    ).items).toEqual([]);

    const plan = buildJoinPushdownPlan(
      where("SELECT * FROM APP100 AS a WHERE NOT (a.$id = 1) AND b.$id = 2"),
      [left, right]
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].targetAlias).toBe("b");
  });

  test("cross-table binary RHS は unsafe", () => {
    const crossTable: BinaryExpr = {
      type: "BINARY",
      op: "=",
      left: { type: "FIELD", tableAlias: "a", field: "number" },
      right: {
        type: "ARITH_VALUE",
        expr: { type: "FIELD_REF", field: "b.$id" },
      },
    };
    expect(classifyJoinPushdownLeaf(crossTable, [left, right]).relation).toBe("unsafe");
    expect(buildJoinPushdownPlan(crossTable, [left, right]).items).toEqual([]);
  });

  test("plan と items は immutable で、入力 AST node を保持する", () => {
    const expr = where("SELECT * FROM APP100 AS a WHERE a.$id = 1");
    const plan = buildJoinPushdownPlan(expr, [left, right]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.items)).toBe(true);
    expect(Object.isFrozen(plan.items[0])).toBe(true);
    expect(plan.items[0].predicate).toBe(expr);
  });
});

describe("B76 Phase B Step 3 exact function consumption", () => {
  test.each([
    ["DATE + relative", "a.date = THIS_MONTH()"],
    ["DATE + TODAY", "a.date >= TODAY()"],
    ["DATETIME + relative/TODAY/NOW", "a.datetime < NOW()"],
    ["CREATED_TIME + relative/TODAY/NOW", "a.created >= FROM_TODAY(-7, DAYS)"],
    ["UPDATED_TIME + relative/TODAY/NOW", "a.updated <= TODAY()"],
    ["CREATOR + LOGINUSER singleton", "a.creator IN (LOGINUSER())"],
    ["MODIFIER + LOGINUSER singleton", "a.modifier NOT IN (LOGINUSER())"],
    ["USER_SELECT + LOGINUSER singleton", "a.user IN (LOGINUSER())"],
  ] as const)("§5.1 exact row: %s", (_label, predicate) => {
    const expr = binary(`SELECT * FROM APP100 AS a WHERE ${predicate}`);
    const classification = classifyJoinServerFunctionLeaf(expr, [core]);
    expect(classification).toMatchObject({
      relation: "function-leaf-exact",
      owner: { status: "OWNED", alias: "a", appId: 100 },
    });

    const plan = buildJoinPushdownPlan(expr, [core]);
    expect(plan.serverFunctionCandidate).toEqual({
      variant: "WHOLE_WHERE_EXACT",
      staticContract: "CONFIRMED",
      fetchContract: "PENDING_STEP_2",
    });
    expect(plan.serverFunctionConsumptions).toHaveLength(1);
    expect(plan.serverFunctionConsumptions[0]).toMatchObject({
      predicate: expr,
      relation: "function-leaf-exact",
      consumption: "whole-where",
      fetchBinding: "PENDING_STEP_2",
      staticProof: {
        classifier: "EXACT_PUSHDOWN",
        ownership: "OWNED",
        serialization: "OCCURRENCE_MULTISET_EXACT",
        residualIdentityConsumption: "CONFIRMED",
      },
    });
    expect(plan.residualWhere).toBeNull();
    expect(plan.residualServerFunctionOccurrences).toEqual([]);
  });

  test.each([
    ["DATE × NOW", "a.date = NOW()"],
    ["TIME × TODAY", "a.time = TODAY()"],
    ["GROUP_SELECT × LOGINUSER", "a.teamGroup IN (LOGINUSER())"],
    ["CREATOR wrong operator", "a.creator = LOGINUSER()"],
  ] as const)("§5.1 unsafe row: %s", (_label, predicate) => {
    const expr = binary(`SELECT * FROM APP100 AS a WHERE ${predicate}`);
    expect(classifyJoinServerFunctionLeaf(expr, [core]).relation).toBe("unsafe");
    const plan = buildJoinPushdownPlan(expr, [core]);
    expect(plan.serverFunctionConsumptions).toEqual([]);
    expect(plan.serverFunctionCandidate).toEqual({
      variant: "EXACT_LEAF",
      staticContract: "INCOMPLETE",
      fetchContract: "PENDING_STEP_2",
    });
    expect(plan.residualWhere).toBe(expr);
    expect(plan.residualServerFunctionOccurrences).toHaveLength(1);
  });

  test("同名関数 occurrence multiset を重複込みで serialize・採用する", () => {
    const expr = where(
      "SELECT * FROM APP100 AS a "
      + "WHERE a.date >= TODAY() AND a.date <= TODAY()"
    );
    const plan = buildJoinPushdownPlan(expr, [core]);
    expect(plan.allServerFunctionOccurrences).toEqual(["TODAY", "TODAY"]);
    expect(plan.adoptedServerFunctionOccurrences).toEqual(["TODAY", "TODAY"]);
    expect(plan.serverFunctionCandidate?.variant).toBe("WHOLE_WHERE_EXACT");
    expect(plan.serverFunctionConsumptions).toHaveLength(1);
    expect(plan.serverFunctionConsumptions[0].functionOccurrences)
      .toEqual(["TODAY", "TODAY"]);
    expect(plan.serverFunctionConsumptions[0].serializedPredicate)
      .toBe("date >= TODAY() and date <= TODAY()");
    expect(plan.residualWhere).toBeNull();
  });

  test("複数 APP の exact leaf を alias ごとに OWNED と証明して原子的に保持する", () => {
    const left = source("a", 100, [{ code: "date", fieldType: "DATE" }]);
    const right = source("b", 200, [{ code: "updated", fieldType: "UPDATED_TIME" }]);
    const expr = where(
      "SELECT * FROM APP100 a INNER JOIN APP200 b ON a.date = b.updated "
      + "WHERE a.date = TODAY() AND b.updated >= NOW()"
    );
    const plan = buildJoinPushdownPlan(expr, [left, right]);
    expect(plan.serverFunctionConsumptions.map((consumption) => [
      consumption.targetAlias,
      consumption.appId,
      consumption.functionOccurrences,
    ])).toEqual([
      ["a", 100, ["TODAY"]],
      ["b", 200, ["NOW"]],
    ]);
    expect(plan.serverFunctionCandidate?.staticContract).toBe("CONFIRMED");
    expect(plan.residualWhere).toBeNull();
  });

  test("非修飾同名 field が AMBIGUOUS なら関数 leaf を採用しない", () => {
    const left = source("a", 100, [{ code: "date", fieldType: "DATE" }]);
    const right = source("b", 200, [{ code: "date", fieldType: "DATE" }]);
    const expr = binary(
      "SELECT * FROM APP100 a INNER JOIN APP200 b ON a.date = b.date "
      + "WHERE date = TODAY()"
    );
    const plan = buildJoinPushdownPlan(expr, [left, right]);
    expect(classifyJoinServerFunctionLeaf(expr, [left, right]).relation).toBe("unsafe");
    expect(plan.serverFunctionConsumptions).toEqual([]);
    expect(plan.serverFunctionCandidate?.staticContract).toBe("INCOMPLETE");
    expect(plan.residualWhere).toBe(expr);
  });

  test("AND-spine surgery は採用 leaf だけを除去し、通常 local leaf identity を保つ", () => {
    const expr = where(
      "SELECT * FROM APP100 AS a "
      + "WHERE a.date = THIS_MONTH() AND LENGTH(a.text) > 1"
    );
    if (expr.type !== "LOGICAL") throw new Error("expected AND");
    const functionLeaf = expr.left;
    const localLeaf = expr.right;
    const plan = buildJoinPushdownPlan(expr, [core]);
    expect(plan.serverFunctionConsumptions[0].predicate).toBe(functionLeaf);
    expect(plan.residualWhere).toBe(localLeaf);
    expect(plan.residualServerFunctionOccurrences).toEqual([]);
  });

  test("B152 exact predicate と server-only leaf の whole WHERE は既存第5-Wで消費する", () => {
    const expr = where(
      "SELECT * FROM APP100 AS a "
      + "WHERE a.date = TODAY() AND a.text = 'A'"
    );
    if (expr.type !== "LOGICAL") throw new Error("expected AND");
    const normalExactLeaf = expr.right;
    const plan = buildJoinPushdownPlan(expr, [core]);

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      targetAlias: "a",
      relation: "exact",
      predicate: normalExactLeaf,
    });
    expect(plan.serverFunctionConsumptions[0]).toMatchObject({
      predicate: expr,
      relation: "function-leaf-exact",
      consumption: "whole-where",
    });
    expect(plan.residualWhere).toBeNull();
  });

  test("同一aliasのexact OR / NOTは第5-Wでwhole WHEREを消費する", () => {
    for (const sql of [
      "SELECT * FROM APP100 a WHERE a.date = TODAY() OR a.date = TOMORROW()",
      "SELECT * FROM APP100 a WHERE NOT (a.date = TODAY())",
    ]) {
      const expr = where(sql);
      const plan = buildJoinPushdownPlan(expr, [core]);
      expect(plan.serverFunctionCandidate?.variant).toBe("WHOLE_WHERE_EXACT");
      expect(plan.serverFunctionConsumptions).toHaveLength(1);
      expect(plan.serverFunctionConsumptions[0].predicate).toBe(expr);
      expect(plan.serverFunctionConsumptions[0].consumption).toBe("whole-where");
      expect(plan.residualWhere).toBeNull();
      expect(plan.residualServerFunctionOccurrences).toEqual([]);
    }
  });

  test("whole exactのKLIKEは全identityを適用しresidual nullにする", () => {
    const expr = where(
      "SELECT * FROM APP100 a "
      + "WHERE a.date = TODAY() AND a.text KLIKE 'urgent'"
    );
    if (expr.type !== "LOGICAL") throw new Error("expected AND");
    const klike = expr.right;
    const plan = buildJoinPushdownPlan(expr, [core]);
    expect(plan.appliedKlikes.has(klike as any)).toBe(true);
    expect(plan.serverFunctionCandidate?.variant).toBe("WHOLE_WHERE_EXACT");
    expect(plan.residualWhere).toBeNull();
    expect(plan.serverFunctionCandidate?.staticContract).toBe("CONFIRMED");
  });

  test("第5-Wを第5-Lより優先しwhole WHEREを一度だけfetchへ束縛する", () => {
    const expr = where(
      "SELECT * FROM APP100 a "
      + "WHERE a.date = THIS_MONTH() AND a.text KLIKE 'urgent'"
    );
    const staticPlan = buildJoinPushdownPlan(expr, [core]);
    expect(isJoinServerFunctionFetchPlan(staticPlan)).toBe(false);

    const bound = bindJoinServerFunctionFetches(staticPlan, [core]);
    expect(isJoinServerFunctionFetchPlan(bound)).toBe(true);
    expect(bound.serverFunctionCandidate?.variant).toBe("WHOLE_WHERE_EXACT");
    expect(bound.serverFunctionCandidate?.fetchContract).toBe("CONFIRMED");
    expect(bound.fetchQueriesByAlias.get("a")).toBe(
      'date = THIS_MONTH() and text like "urgent"'
    );
    expect(bound.serverFunctionConsumptions[0].fetchBinding).toEqual({
      status: "BOUND_TO_TARGET_FETCH",
      targetAlias: "a",
      appId: 100,
      query: 'date = THIS_MONTH() and text like "urgent"',
    });
  });

  test("第5-W不成立時は第5-Lへfallbackし通常residualを維持する", () => {
    const expr = where(
      "SELECT * FROM APP100 a "
      + "WHERE a.date = THIS_MONTH() AND LENGTH(a.text) > 1"
    );
    const plan = buildJoinPushdownPlan(expr, [core]);
    expect(plan.serverFunctionCandidate?.variant).toBe("EXACT_LEAF");
    expect(plan.serverFunctionConsumptions[0].consumption).toBe("leaf");
    expect(plan.residualWhere).toBe(
      expr.type === "LOGICAL" ? expr.right : undefined
    );
  });

  test("LOGINUSERと複数target aliasをそれぞれのfetchへ束縛する", () => {
    const login = buildJoinPushdownPlan(
      binary("SELECT * FROM APP100 a WHERE a.creator IN (LOGINUSER())"),
      [core]
    );
    expect(isJoinServerFunctionFetchPlan(
      bindJoinServerFunctionFetches(login, [core])
    )).toBe(true);

    const left = source("a", 100, [{ code: "date", fieldType: "DATE" }]);
    const right = source("b", 200, [{ code: "updated", fieldType: "UPDATED_TIME" }]);
    const multiple = buildJoinPushdownPlan(
      where(
        "SELECT * FROM APP100 a INNER JOIN APP200 b ON a.date = b.updated "
        + "WHERE a.date = TODAY() AND b.updated >= NOW()"
      ),
      [left, right]
    );
    const bound = bindJoinServerFunctionFetches(multiple, [left, right]);
    expect(isJoinServerFunctionFetchPlan(bound)).toBe(true);
    expect(bound.serverFunctionCandidate?.variant).toBe("EXACT_LEAF");
    expect(bound.fetchQueriesByAlias).toEqual(new Map([
      ["a", "date = TODAY()"],
      ["b", "updated >= NOW()"],
    ]));
  });
});

describe("B76 Phase A Step 2 runtime boundary / serializer guard", () => {
  const left = source("a", 100, [
    { code: "same", fieldType: "SINGLE_LINE_TEXT" },
    { code: "date", fieldType: "DATE" },
    { code: "number", fieldType: "NUMBER" },
  ]);
  const right = source("b", 200, [
    { code: "same", fieldType: "SINGLE_LINE_TEXT" },
    { code: "time", fieldType: "TIME" },
  ]);

  test("AND leaf の指定型 = だけを alias 別 exact item にする", () => {
    const plan = buildJoinPushdownStep2Plan(
      where(
        "SELECT * FROM APP100 a WHERE "
        + "a.same = 'A' AND a.date = '2026-07-27' AND b.time = '09:30' AND a.number = 1"
      ),
      [left, right]
    );
    expect(plan.items.map((item) => [
      item.targetAlias,
      item.relation,
      serializeJoinPushdownItem(item, [left, right]),
    ])).toEqual([
      ["a", "exact", 'same = "A" and date = "2026-07-27"'],
      ["b", "exact", 'time = "09:30"'],
    ]);
  });

  test("Step 3 対象の OR / GROUP と既存 NUMBER は runtime plan に入れない", () => {
    expect(buildJoinPushdownStep2Plan(
      where("SELECT * FROM APP100 a WHERE a.same = 'A' OR a.date = '2026-07-27'"),
      [left, right]
    ).items).toEqual([]);
    expect(buildJoinPushdownStep2Plan(
      where("SELECT * FROM APP100 a WHERE (a.same = 'A')"),
      [left, right]
    ).items).toEqual([]);
    expect(buildJoinPushdownStep2Plan(
      where("SELECT * FROM APP100 a WHERE a.number = 1"),
      [left, right]
    ).items).toEqual([]);
  });

  test("同名 field は修飾正例だけ serialize し、非修飾は採用しない", () => {
    const qualified = buildJoinPushdownStep2Plan(
      where("SELECT * FROM APP100 a WHERE a.same = 'A'"),
      [left, right]
    );
    expect(serializeJoinPushdownItem(qualified.items[0], [left, right])).toBe('same = "A"');
    expect(buildJoinPushdownStep2Plan(
      where("SELECT * FROM APP100 a WHERE same = 'A'"),
      [left, right]
    ).items).toEqual([]);
  });

  test("item と異なる alias/appId は serializer 前に fail-loud にする", () => {
    const predicate = where("SELECT * FROM APP100 a WHERE b.same = 'B'");
    const corrupted: JoinPushdownItem = {
      targetAlias: "a",
      appId: 100,
      predicate,
      relation: "superset",
    };
    expect(() => serializeJoinPushdownItem(corrupted, [left, right]))
      .toThrow("InternalError: JOIN pushdown ownership guard failed for a/APP100");
  });
});

test.each([
  ["型不明", source("a", 100, [{ code: "x", fieldType: "FUTURE_FIELD" }])],
  ["CTE synthetic type", source("a", 0, [{ code: "x", fieldType: "KSQL_STRING" }], {
    sourceKind: "CTE",
  })],
  ["temp synthetic type", source("a", 0, [{ code: "x", fieldType: "KSQL_NUMBER" }], {
    sourceKind: "TEMP",
  })],
] as const)("%s は unsafe", (_label, target) => {
  expect(relation("SELECT * FROM APP100 AS a WHERE a.x = 'A'", [target])).toBe("unsafe");
});
