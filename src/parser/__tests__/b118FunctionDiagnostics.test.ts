import { parseSqlStatement } from "../../core/sql";

function getErrorMessage(sql: string): string {
  let caught: unknown;
  try {
    parseSqlStatement(sql);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  return (caught as Error).message;
}

test("B118: 未知の関数名を名指しし、DATE_SUB には DATE_ADD の負数を案内する", () => {
  expect(() => parseSqlStatement("SELECT DATE_SUB(受注予定日, 1, 'MONTH') FROM APP1"))
    .toThrow("「DATE_SUB」という関数はありません。日付を減算するには DATE_ADD の加算値へ負数を指定してください");
});

test("B118: DATE_ADD の MySQL INTERVAL 構文へ正しい kSQL 構文を案内する", () => {
  expect(() => parseSqlStatement("SELECT DATE_ADD(受注予定日, INTERVAL 1 MONTH) FROM APP1"))
    .toThrow("DATE_ADD の構文は DATE_ADD(列, n, '単位') です");
});

test("B118: 既知関数の構文案内は位置情報を一度だけ表示し、空白を重ねない", () => {
  expect(getErrorMessage("SELECT DATE_ADD(受注予定日, INTERVAL 1 MONTH) AS x FROM APP4149"))
    .toBe("DATE_ADD の構文は DATE_ADD(列, n, '単位') です。「)」が必要です（位置 32、トークン: 「1」）");
});

test("B118: 未知関数の構文案内は従来どおり位置情報を一度だけ表示する", () => {
  expect(getErrorMessage("SELECT DATE_SUB(受注予定日, 1, 'MONTH') FROM APP1"))
    .toBe("「DATE_SUB」という関数はありません。日付を減算するには DATE_ADD の加算値へ負数を指定してください（位置 7、トークン: 「DATE_SUB」）");
});

test.each([
  ["DATE_ADD(受注予定日, 1)", "ArgumentError: DATE_ADD expects 3 argument(s)."],
  ["ROUND(売上, 1, 2)", "ArgumentError: ROUND expects 1 to 2 argument(s)."],
  ["FORMAT(売上)", "ArgumentError: FORMAT expects 2 argument(s)."],
])("B118: %s は静的に引数数を拒否する", (call, message) => {
  expect(() => parseSqlStatement(`SELECT ${call} FROM APP1`)).toThrow(message);
});
