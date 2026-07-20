import { parseSqlStatements } from "../../core";
import { isPluginApplyStatement, resolvePluginApplyOptions } from "../applySurface";

const APPLY = "UPDATE APP4221 SET 親='x' WHERE $id=8 APPLY テーブル (PATCH SET 子='y' ALL ROWS)";

test("B44 Phase 16c: plugin は APPLY mutation だけ capability と固定 100/500 を渡す", () => {
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

test("Phase 16c: pluginはINSERT APPLY mutationを開き、VALIDATE ONLYはcapability不要", () => {
  const sql = "INSERT INTO APP4221 (親) VALUES ('x') APPLY テーブル (APPEND (子) VALUES ('c'))";
  expect(isPluginApplyStatement(parseSqlStatements(sql)[0])).toBe(true);
  expect(isPluginApplyStatement(parseSqlStatements("INSERT INTO APP4221 (親) VALUES ('x')")[0])).toBe(false);
  expect(resolvePluginApplyOptions(parseSqlStatements(sql))).toEqual({
    allowApplyMutation: true, dmlMaxRows: 100, dmlMaxSubtableRows: 500,
  });
  expect(resolvePluginApplyOptions(parseSqlStatements(`${sql} VALIDATE ONLY`))).toEqual({
    dmlMaxRows: 100, dmlMaxSubtableRows: 500,
  });
});

test("Phase 16c: pluginはUPSERT APPLY mutationを開く", () => {
  expect(resolvePluginApplyOptions(parseSqlStatements(
    "UPSERT INTO APP4221 (親) VALUES ('x') ON DUPLICATE (親) "
      + "ON INSERT APPLY テーブル (APPEND (子) VALUES ('c'))"
  ))).toEqual({ allowApplyMutation: true, dmlMaxRows: 100, dmlMaxSubtableRows: 500 });
});

test("Phase 16c: pluginは多値・SUBTABLE混在mutation capabilityを開く", () => {
  const multi = "UPDATE APP4221 SET 親='x' WHERE $id=8 APPLY タグ (ADD 'A')";
  expect(resolvePluginApplyOptions(parseSqlStatements(multi))).toEqual({
    allowApplyMutation: true, dmlMaxRows: 100, dmlMaxSubtableRows: 500,
  });
  expect(resolvePluginApplyOptions(parseSqlStatements(
    `${multi} APPLY テーブル (PATCH SET 子='y' ALL ROWS)`
  ))).toEqual({ allowApplyMutation: true, dmlMaxRows: 100, dmlMaxSubtableRows: 500 });
});

test("Phase 16c: 複数親UPDATEはSQL形に依存せずAPPLY capabilityを開く", () => {
  expect(resolvePluginApplyOptions(parseSqlStatements(
    "UPDATE APP4221 SET 親='x' WHERE status='open' APPLY テーブル (PATCH SET 子='y' ALL ROWS)"
  ))).toEqual({ allowApplyMutation: true, dmlMaxRows: 100, dmlMaxSubtableRows: 500 });
});
