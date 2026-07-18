import { Lexer } from "../../../lexer/lexer";
import { Parser } from "../../../parser/parser";
import type { SelectStatement } from "../../../types/ast";
import {
  extractNumericPushdownCandidates,
  extractSafePushdownLeaves,
  extractTypedPushdownCandidates,
} from "../wherePredicatePushdown";

function where(sql: string) {
  return (new Parser(new Lexer(sql).tokenize()).parse() as SelectStatement).where!;
}

test.each(["=", ">", "<", ">=", "<="])(
  "$id %s NUMBER を安全なリーフとして抽出する",
  (op) => {
    const expr = where(`SELECT * FROM APP100 WHERE $id ${op} 1000`);
    expect(extractSafePushdownLeaves(expr)).toEqual(expr);
  }
);

test("AND を分解し GROUP 内の安全な $id リーフだけを抽出する", () => {
  const expr = where(
    "SELECT * FROM APP100 WHERE ($id >= 1000 AND 会社名 LIKE '%A%') AND 状態 = '完了'"
  );
  const extracted = extractSafePushdownLeaves(expr) as any;
  expect(extracted.type).toBe("BINARY");
  expect(extracted.left.field).toBe("$id");
  expect(extracted.op).toBe(">=");
});

test("JOIN は対象エイリアスの明示的な $id だけを抽出する", () => {
  const target = where("SELECT * FROM APP100 AS a WHERE a.$id >= 1000");
  const other = where("SELECT * FROM APP100 AS a WHERE b.$id >= 1000");
  const unqualified = where("SELECT * FROM APP100 AS a WHERE $id >= 1000");

  expect(extractSafePushdownLeaves(target, { tableAlias: "a" })).toEqual(target);
  expect(extractSafePushdownLeaves(other, { tableAlias: "a" })).toBeNull();
  expect(extractSafePushdownLeaves(unqualified, { tableAlias: "a" })).toBeNull();
});

test("単一テーブルは修飾なしまたは正しい別名の $id を許可する", () => {
  const unqualified = where("SELECT * FROM APP100 AS a WHERE $id >= 1000");
  const qualified = where("SELECT * FROM APP100 AS a WHERE a.$id >= 1000");
  const wrong = where("SELECT * FROM APP100 AS a WHERE b.$id >= 1000");
  const options = { tableAlias: "a", allowUnqualifiedFields: true };

  expect(extractSafePushdownLeaves(unqualified, options)).toEqual(unqualified);
  expect(extractSafePushdownLeaves(qualified, options)).toEqual(qualified);
  expect(extractSafePushdownLeaves(wrong, options)).toBeNull();
});

test.each([
  "SELECT * FROM APP100 WHERE $id != 1000",
  "SELECT * FROM APP100 WHERE $id <> 1000",
  "SELECT * FROM APP100 WHERE $id IN (1000, 1001)",
  "SELECT * FROM APP100 WHERE $id NOT IN (1000, 1001)",
  "SELECT * FROM APP100 WHERE $id = '1000'",
  "SELECT * FROM APP100 WHERE $id >= TODAY()",
  "SELECT * FROM APP100 WHERE 会社名 = 'A社'",
  "SELECT * FROM APP100 WHERE LENGTH($id) >= 1",
  "SELECT * FROM APP100 WHERE $id + 1 >= 1000",
  "SELECT * FROM APP100 WHERE CASE WHEN $id >= 1 THEN $id ELSE 0 END >= 1000",
  "SELECT * FROM APP100 WHERE $id IS NULL",
  "SELECT * FROM APP100 WHERE $id LIKE '10%'",
  "SELECT * FROM APP100 WHERE $id NOT LIKE '10%'",
  "SELECT * FROM APP100 WHERE NOT ($id >= 1000)",
  "SELECT * FROM APP100 WHERE ($id >= 1000 OR 会社名 = 'A社')",
  "SELECT * FROM APP100 WHERE EXISTS (SELECT * FROM APP101)",
])("危険または第0段対象外の述語を押し下げない: %s", (sql) => {
  expect(extractSafePushdownLeaves(where(sql))).toBeNull();
});

test.each(["=", ">", "<"])(
  "NUMBER フィールドの安全な %s 比較を抽出する",
  (op) => {
    const expr = where(`SELECT * FROM APP100 WHERE 金額 ${op} 1000`);
    const fieldTypes = new Map([["金額", "NUMBER"]]);
    expect(extractSafePushdownLeaves(expr, { fieldTypes })).toEqual(expr);
  }
);

test.each([
  "SELECT * FROM APP100 WHERE 金額 >= 1000",
  "SELECT * FROM APP100 WHERE 金額 <= 1000",
  "SELECT * FROM APP100 WHERE 金額 != 1000",
  "SELECT * FROM APP100 WHERE 金額 > 1.5",
  "SELECT * FROM APP100 WHERE 金額 > 9007199254740992",
])("NUMBER 型でも対象外の一般数値比較を押し下げない: %s", (sql) => {
  const expr = where(sql);
  const fieldTypes = new Map([["金額", "NUMBER"]]);
  expect(extractSafePushdownLeaves(expr, { fieldTypes })).toBeNull();
});

test.each([
  "SELECT * FROM APP100 WHERE 金額 > 1e3",
  "SELECT * FROM APP100 WHERE 金額 > 1.0e3",
])("整数値の指数リテラルは平文整数（safe integer）として直書き整数と同様に押し下げる: %s", (sql) => {
  const expr = where(sql);
  const fieldTypes = new Map([["金額", "NUMBER"]]);
  // 1e3 = 1000 は safe integer。直書き `> 1000` と同じ安全leafとして押し下げる。
  expect(extractSafePushdownLeaves(expr, { fieldTypes })).toEqual(expr);
});

test("一般フィールドは NUMBER 型が確定した場合だけ押し下げる", () => {
  const expr = where("SELECT * FROM APP100 WHERE 金額 > 1000");
  expect(extractSafePushdownLeaves(expr)).toBeNull();
  expect(extractSafePushdownLeaves(expr, { fieldTypes: new Map() })).toBeNull();
  expect(extractSafePushdownLeaves(expr, {
    fieldTypes: new Map([["金額", "SINGLE_LINE_TEXT"]]),
  })).toBeNull();
});

test("NUMBER equalityだけは高精度raw literalを安全leafとして保持する", () => {
  const expr = where("SELECT * FROM APP100 WHERE 金額 = 9007199254740993");
  expect(extractSafePushdownLeaves(expr, {
    fieldTypes: new Map([["金額", "NUMBER"]]),
  })).toEqual(expr);
  if (expr.type !== "BINARY" || expr.right.type !== "NUMBER") throw new Error("unexpected AST");
  expect(expr.right.raw).toBe("9007199254740993");
});

test("一般数値候補は型メタなしで抽出し、$id と対象外演算子を除外する", () => {
  const expr = where(
    "SELECT * FROM APP100 WHERE $id >= 1 AND 金額 > 1000 AND 数量 >= 2 AND 状態 = '完了'"
  );
  const candidate = extractNumericPushdownCandidates(expr) as any;
  expect(candidate.type).toBe("BINARY");
  expect(candidate.left.field).toBe("金額");
  expect(candidate.op).toBe(">");
});

test("一般数値候補も JOIN では対象エイリアスの明示参照だけを抽出する", () => {
  const expr = where("SELECT * FROM APP100 AS a WHERE a.金額 > 1 AND b.金額 > 2 AND 数量 > 3");
  const candidate = extractNumericPushdownCandidates(expr, { tableAlias: "a" }) as any;
  expect(candidate.left.field).toBe("金額");
  expect(candidate.left.tableAlias).toBe("a");
});

test("選択系フィールドは型メタだけでは押し下げない", () => {
  const expr = where("SELECT * FROM APP100 WHERE 状態 IN ('完了')");
  const fieldTypes = new Map([["状態", "DROP_DOWN"]]);
  expect(extractSafePushdownLeaves(expr, { fieldTypes })).toBeNull();
});

test.each(["DROP_DOWN", "RADIO_BUTTON", "CHECK_BOX", "MULTI_SELECT", "STATUS"])(
  "%s の IN / NOT IN は全値が実在するときだけ押し下げる",
  (fieldType) => {
    const fieldTypes = new Map([["選択", fieldType]]);
    const fieldOptions = new Map([["選択", new Set(["A", "B"])]]);
    for (const op of ["IN", "NOT IN"]) {
      const expr = where(`SELECT * FROM APP100 WHERE 選択 ${op} ('A', 'B')`);
      expect(extractSafePushdownLeaves(expr, { fieldTypes, fieldOptions })).toEqual(expr);
    }
  }
);

test.each([
  "SELECT * FROM APP100 WHERE 選択 IN ('A', 'X')",
  "SELECT * FROM APP100 WHERE 選択 IN ('')",
  "SELECT * FROM APP100 WHERE 選択 IN (1)",
])("選択系 IN の非実在値・空値・非文字列は押し下げない: %s", (sql) => {
  const expr = where(sql);
  expect(extractSafePushdownLeaves(expr, {
    fieldTypes: new Map([["選択", "CHECK_BOX"]]),
    fieldOptions: new Map([["選択", new Set(["A"])]]),
  })).toBeNull();
});

test.each(["USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT", "STATUS_ASSIGNEE"])(
  "%s は選択肢集合があっても押し下げない",
  (fieldType) => {
    const expr = where("SELECT * FROM APP100 WHERE 選択 IN ('A')");
    expect(extractSafePushdownLeaves(expr, {
      fieldTypes: new Map([["選択", fieldType]]),
      fieldOptions: new Map([["選択", new Set(["A"])]]),
    })).toBeNull();
  }
);

test("選択系 IN は型メタなしの候補抽出に含め、対象外リーフは除く", () => {
  const expr = where(
    "SELECT * FROM APP100 WHERE 選択 IN ('A') AND 他 NOT IN ('B') AND 数量 IN (1)"
  );
  const candidate = extractTypedPushdownCandidates(expr) as any;
  expect(candidate.left.left.field).toBe("選択");
  expect(candidate.right.left.field).toBe("他");
});
