import { parseSqlStatements } from "../../core";
import { resolvePluginApplyOptions } from "../applySurface";

const APPLY = "UPDATE APP4221 SET 親='x' WHERE $id=8 APPLY テーブル (PATCH SET 子='y' ALL ROWS)";

test("B44 Phase 6: plugin は APPLY mutation だけ capability と固定 100/100 を渡す", () => {
  expect(resolvePluginApplyOptions(parseSqlStatements(APPLY))).toEqual({
    allowApplyMutation: true,
    dmlMaxRows: 100,
    dmlMaxSubtableRows: 100,
  });
  expect(resolvePluginApplyOptions(parseSqlStatements(`${APPLY} VALIDATE ONLY`))).toEqual({
    dmlMaxRows: 100,
    dmlMaxSubtableRows: 100,
  });
  expect(resolvePluginApplyOptions(parseSqlStatements("UPDATE APP4221 SET 親='x' WHERE $id=8"))).toEqual({});
});
