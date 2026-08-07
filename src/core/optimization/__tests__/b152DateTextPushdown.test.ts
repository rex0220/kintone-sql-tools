import { Lexer } from "../../../lexer/lexer";
import { Parser } from "../../../parser/parser";
import type { BinaryExpr, SelectStatement } from "../../../types/ast";
import {
  isCanonicalJoinDate,
  isCanonicalJoinDateTime,
  isCanonicalJoinTime,
} from "../joinDateTimeLiteralPolicy";
import {
  classifyJoinPushdownLeaf,
  serializeJoinPushdownItem,
  type JoinPushdownSource,
} from "../joinPredicatePushdown";

const source: JoinPushdownSource = {
  alias: "t",
  appId: 4228,
  sourceKind: "APP",
  fieldTypes: new Map([
    ["日付", "DATE"],
    ["時刻", "TIME"],
    ["日時", "DATETIME"],
    ["作成日時", "CREATED_TIME"],
    ["更新日時", "UPDATED_TIME"],
    ["件名", "SINGLE_LINE_TEXT"],
    ["リンク", "LINK"],
    ["主担当", "USER_SELECT"],
  ]),
};

function predicate(sqlPredicate: string): BinaryExpr {
  const statement = new Parser(new Lexer(
    `SELECT * FROM APP4228 AS t WHERE ${sqlPredicate}`
  ).tokenize()).parse() as SelectStatement;
  if (statement.where?.type !== "BINARY") throw new Error("expected binary predicate");
  return statement.where;
}

function relation(sqlPredicate: string): string {
  return classifyJoinPushdownLeaf(predicate(sqlPredicate), [source]).relation;
}

function serialized(sqlPredicate: string): string {
  const leaf = predicate(sqlPredicate);
  const classification = classifyJoinPushdownLeaf(leaf, [source]);
  expect(classification.relation).toBe("exact");
  if (classification.relation !== "exact" || classification.owner === undefined) return "";
  return serializeJoinPushdownItem({
    targetAlias: classification.owner.alias,
    appId: classification.owner.appId,
    predicate: leaf,
    relation: "exact",
  }, [source]);
}

describe("B152 canonical date/time literal policy", () => {
  test.each([
    ["2024-02-29", true],
    ["2026-02-29", false],
    ["2026-2-07", false],
    [" 2026-08-07", false],
    ["", false],
  ])("DATE %s -> %s", (value, expected) => {
    expect(isCanonicalJoinDate(value)).toBe(expected);
  });

  test.each(["0001", "0099", "0100", "0999", "1000", "9999"])(
    "DATE accepts the supported four-digit year boundary %s",
    (year) => {
      expect(isCanonicalJoinDate(`${year}-01-01`)).toBe(true);
    }
  );

  test("DATE rejects year 0000", () => {
    expect(isCanonicalJoinDate("0000-01-01")).toBe(false);
  });

  test.each([
    ["00:00", true],
    ["23:59", true],
    ["24:00", false],
    ["09:30:00", false],
    ["", false],
  ])("TIME %s -> %s", (value, expected) => {
    expect(isCanonicalJoinTime(value)).toBe(expected);
  });

  test.each([
    ["2026-08-07T00:00:00Z", true],
    ["2026-08-07T09:00:00+09:00", false],
    ["2026-08-07T00:00Z", false],
    ["2026-08-07T00:00:00.000Z", false],
    [" 2026-08-07T00:00:00Z", false],
    ["", false],
  ])("DATETIME %s -> %s", (value, expected) => {
    expect(isCanonicalJoinDateTime(value)).toBe(expected);
  });

  test.each(["0001", "0099", "0100", "0999", "1000", "9999"])(
    "DATETIME accepts the supported four-digit year boundary %s",
    (year) => {
      expect(isCanonicalJoinDateTime(`${year}-01-01T00:00:00Z`)).toBe(true);
    }
  );

  test("DATETIME rejects year 0000", () => {
    expect(isCanonicalJoinDateTime("0000-01-01T00:00:00Z")).toBe(false);
  });
});

describe("B152 Phase 2+3 JOIN leaf classifier", () => {
  test.each(["=", "!=", "<>", "<", ">", "<=", ">="])(
    "DATE/TIME/DATETIME 系 %s は canonical literal で exact",
    (op) => {
      for (const [field, literal] of [
        ["日付", "2026-08-07"],
        ["時刻", "09:30"],
        ["日時", "2026-08-07T00:00:00Z"],
        ["作成日時", "2026-08-07T00:00:00Z"],
        ["更新日時", "2026-08-07T00:00:00Z"],
      ]) {
        expect(relation(`t.${field} ${op} '${literal}'`)).toBe("exact");
      }
    }
  );

  test.each(["=", "!=", "<>", "IN", "NOT IN"])(
    "TEXT/LINK %s は非空 string literal で exact",
    (op) => {
      const rhs = op.includes("IN") ? "('A', 'B')" : "'A'";
      expect(relation(`t.件名 ${op} ${rhs}`)).toBe("exact");
      expect(relation(`t.リンク ${op} ${rhs}`)).toBe("exact");
    }
  );

  test("実 serializer 形をそのまま使う", () => {
    expect(serialized("t.件名 = 'A\"\\B'")).toBe('件名 = "A\\"\\\\B"');
    expect(serialized("t.件名 IN ('A', 'B')")).toBe('件名 in ("A","B")');
    expect(serialized("t.件名 <> 'A'")).toBe('件名 != "A"');
  });

  test.each([
    "t.日付 = '2026-02-29'",
    "t.時刻 >= '24:00'",
    "t.日時 = '2026-08-07T09:00:00+09:00'",
    "t.日時 = '2026-08-07T00:00Z'",
    "t.日時 = '2026-08-07T00:00:00.000Z'",
    "t.件名 = ''",
    "t.件名 IN ('A', '')",
    "t.リンク < 'A'",
    "t.主担当 IN ('known')",
  ])("対象外は fail-closed: %s", (sqlPredicate) => {
    expect(relation(sqlPredicate)).toBe("unsafe");
  });
});
