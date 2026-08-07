import { Lexer } from "../../../lexer/lexer";
import { Parser } from "../../../parser/parser";
import type { BinaryExpr, SelectStatement } from "../../../types/ast";
import {
  classifyJoinPushdownLeaf,
  serializeJoinPushdownItem,
  type JoinPushdownSource,
} from "../joinPredicatePushdown";
import { isJoinNumberLiteralSupported } from "../joinNumberLiteralPolicy";

const source: JoinPushdownSource = {
  alias: "t",
  appId: 4228,
  sourceKind: "APP",
  fieldTypes: new Map([
    ["個数", "NUMBER"],
    ["計算値", "CALC"],
    ["$id", "__ID__"],
  ]),
};

function predicate(sqlPredicate: string): BinaryExpr {
  const sql = `SELECT * FROM APP4228 AS t WHERE ${sqlPredicate}`;
  const statement = new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement;
  if (statement.where?.type !== "BINARY") throw new Error("expected binary predicate");
  return statement.where;
}

function classify(sqlPredicate: string, fieldSource = source) {
  return classifyJoinPushdownLeaf(predicate(sqlPredicate), [fieldSource]);
}

describe("B151 NUMBER JOIN prefilter classifier", () => {
  test.each([
    ["999999999999.99985", true],
    ["9007199254740993", true],
    ["-5", true],
    ["1e3", true],
    ["-0", true],
    ["+0", true],
    ["1e-10", true],
    ["1e-11", false],
    ["1000000000000000000000000000000", false],
    ["1e9007199254740991", false],
  ])("pure literal policy: %s -> %s", (raw, expected) => {
    expect(isJoinNumberLiteralSupported({ type: "NUMBER", value: Number(raw), raw }))
      .toBe(expected);
  });

  test.each([
    ["t.個数 = 10", "個数 = 10"],
    ["t.個数 != 10", "個数 != 10"],
    ["t.個数 <> 10", "個数 != 10"],
    ["t.個数 < 999999999999.99985", "個数 < 999999999999.99985"],
    ["t.個数 > 9007199254740993", "個数 > 9007199254740993"],
    ["t.個数 <= -5", "個数 <= -5"],
    ["t.個数 >= 1e3", "個数 >= 1000"],
    ["t.個数 IN (-6, 10, 1e3)", "個数 in (-6,10,1000)"],
    ["t.個数 NOT IN (-6, 10, 1e3)", "個数 not in (-6,10,1000)"],
    ["t.個数 = -0", "個数 = 0"],
  ])("%s を exact のまま serialize する", (sqlPredicate, query) => {
    const leaf = predicate(sqlPredicate);
    const classification = classifyJoinPushdownLeaf(leaf, [source]);
    expect(classification.relation).toBe("exact");
    if (classification.relation !== "exact" || classification.owner === undefined) return;
    expect(serializeJoinPushdownItem({
      targetAlias: classification.owner.alias,
      appId: classification.owner.appId,
      predicate: leaf,
      relation: classification.relation,
    }, [source])).toBe(query);
  });

  test("raw +0 も 0 として exact にする", () => {
    const leaf = predicate("t.個数 = 0");
    const plusZero = {
      ...leaf,
      right: { type: "NUMBER" as const, value: 0, raw: "+0" },
    };
    const classification = classifyJoinPushdownLeaf(plusZero, [source]);
    expect(classification.relation).toBe("exact");
    expect(serializeJoinPushdownItem({
      targetAlias: "t",
      appId: 4228,
      predicate: plusZero,
      relation: "exact",
    }, [source])).toBe("個数 = 0");
  });

  test.each([
    "t.個数 >= '100'",
    "t.個数 IN (10, '20')",
    "t.個数 >= 1e-11",
    "t.個数 >= 1000000000000000000000000000000",
  ])("対象外 literal は unsafe: %s", (sqlPredicate) => {
    expect(classify(sqlPredicate).relation).toBe("unsafe");
  });

  test("CALC と $id の既存 gate を変更しない", () => {
    expect(classify("t.計算値 <= 100").relation).toBe("unsafe");
    expect(classify("t.$id = 9007199254740993").relation).toBe("unsafe");
    expect(classify("t.$id = 1").relation).toBe("exact");
  });

  test("巨大指数を展開せず unsafe にする", () => {
    const huge = predicate("t.個数 >= 1e9007199254740991");
    expect(classifyJoinPushdownLeaf(huge, [source]).relation).toBe("unsafe");
  });
});
