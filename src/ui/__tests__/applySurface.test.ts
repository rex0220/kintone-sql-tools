import { parseSqlStatements } from "../../core";
import { resolvePluginApplyOptions } from "../applySurface";

const APPLY = "UPDATE APP4221 SET 親='x' WHERE $id=8 APPLY テーブル (PATCH SET 子='y' ALL ROWS)";

test("B44 Phase 6: plugin は APPLY mutation だけ capability と固定 100/100 を渡す", () => {
  expect(resolvePluginApplyOptions(parseSqlStatements(APPLY))).toEqual({
    allowApplyMutation: true,
    dmlMaxRows: 100,
    dmlMaxSubtableRows: 500,
  });
  expect(resolvePluginApplyOptions(parseSqlStatements(`${APPLY} VALIDATE ONLY`))).toEqual({
    dmlMaxRows: 100,
    dmlMaxSubtableRows: 500,
  });
  expect(resolvePluginApplyOptions(parseSqlStatements("UPDATE APP4221 SET 親='x' WHERE $id=8"))).toEqual({});
});

test("Phase 13c: pluginはINSERT APPLY capabilityをPhase 16cまで開かない", () => {
  expect(resolvePluginApplyOptions(parseSqlStatements(
    "INSERT INTO APP4221 (親) VALUES ('x') APPLY テーブル (APPEND (子) VALUES ('c'))"
  ))).toEqual({});
});

test("Phase 14c: pluginはUPSERT APPLY capabilityをPhase 16cまで開かない", () => {
  expect(resolvePluginApplyOptions(parseSqlStatements(
    "UPSERT INTO APP4221 (親) VALUES ('x') ON DUPLICATE (親) "
      + "ON INSERT APPLY テーブル (APPEND (子) VALUES ('c'))"
  ))).toEqual({});
});

test("Phase 15b: pluginは多値・SUBTABLE混在mutation capabilityをPhase 16cまで開かない", () => {
  const multi = "UPDATE APP4221 SET 親='x' WHERE $id=8 APPLY タグ (ADD 'A')";
  expect(resolvePluginApplyOptions(parseSqlStatements(multi))).toEqual({
    dmlMaxRows: 100,
    dmlMaxSubtableRows: 500,
  });
  expect(resolvePluginApplyOptions(parseSqlStatements(
    `${multi} APPLY テーブル (PATCH SET 子='y' ALL ROWS)`
  ))).toEqual({
    dmlMaxRows: 100,
    dmlMaxSubtableRows: 500,
  });
});
