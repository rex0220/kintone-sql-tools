import { createKsqlMcpTools } from "../tools";

test("E-6 MCP multi-statement ksql_explain reaches shared default as-of injection", async () => {
  const result = await createKsqlMcpTools({ profile: "test" }).explain({
    sql: "-- @ksql dialect: 1\nSELECT @NOW() AS n; SELECT @MONTH_START() AS m;",
  });
  expect(result).toMatchObject({ ok: true, batch: true, statementCount: 2 });
});
