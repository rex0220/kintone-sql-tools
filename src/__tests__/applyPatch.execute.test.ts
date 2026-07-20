import { execute, executeBatch, type KintoneClient, type KintoneFieldInfo, type SelectResult } from "../execute";
import type { KintonePutParams, KintoneRecord } from "../converter/dmlToKintone";

const fieldInfos: KintoneFieldInfo[] = [
  { code: "親", label: "親", fieldType: "SINGLE_LINE_TEXT", writable: true },
  { code: "親数値", label: "親数値", fieldType: "NUMBER", writable: true },
  { code: "添付", label: "添付", fieldType: "FILE", writable: true },
  { code: "作成者", label: "作成者", fieldType: "CREATOR", writable: false },
  { code: "テーブル", label: "テーブル", fieldType: "SUBTABLE", writable: false },
  { code: "子", label: "子", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "テーブル" },
  { code: "子添付", label: "子添付", fieldType: "FILE", writable: true, inSubtable: true, subtableCode: "テーブル" },
  { code: "別表", label: "別表", fieldType: "SUBTABLE", writable: false },
  { code: "別子", label: "別子", fieldType: "SINGLE_LINE_TEXT", writable: true, inSubtable: true, subtableCode: "別表" },
];

function parent(id = "8", childCount = 1): KintoneRecord {
  return {
    "$id": { value: id },
    "$revision": { value: "3" },
    親: { value: "before" },
    親数値: { value: "1" },
    テーブル: { value: Array.from({ length: childCount }, (_, index) => ({
      id: String(101 + index),
      value: { 子: { value: "old" }, 子添付: { value: [{ fileKey: "opaque" }] } },
    })) },
    別表: { value: [] },
  } as unknown as KintoneRecord;
}

function makeClient(records: KintoneRecord[], infos = fieldInfos) {
  const getRecords = jest.fn(async () => ({ records }));
  const putRecords = jest.fn(async () => undefined);
  const getFields = jest.fn(async () => infos);
  const getNumberPrecision = jest.fn(async () => ({ digits: 30, decimalPlaces: 10, roundingMode: "HALF_EVEN" as const }));
  const client: KintoneClient = {
    getRecords,
    openCursor: async () => { throw new Error("unexpected cursor"); },
    postRecords: async () => { throw new Error("unexpected post"); },
    putRecords,
    deleteRecords: async () => { throw new Error("unexpected delete"); },
    getApps: async () => [],
    getFields,
    getNumberPrecision,
    getProcessStatuses: async () => ({ enable: false, states: [] }),
  };
  return { client, getRecords, putRecords, getFields, getNumberPrecision };
}

const sql = "UPDATE APP4221 SET 親 = 'after' WHERE $id = 8 " +
  "APPLY テーブル (PATCH SET 子 = 'patched' WHERE _rid = '101')";

test("allowApplyMutation なしの mutation は API 前に fail-closed", async () => {
  const mock = makeClient([parent()]);
  await expect(execute(sql, mock.client, { cacheContext: "apply-no-capability" }))
    .rejects.toThrow("UnsupportedError: APPLY mutation requires allowApplyMutation=true");
  expect(mock.getFields).not.toHaveBeenCalled();
  expect(mock.getRecords).not.toHaveBeenCalled();
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test(
  "VALIDATE ONLY は共通plan/validation/guardの全件数を返し confirm/PUT しない",
  async () => {
    const mock = makeClient([parent()]);
    const confirm = jest.fn(async () => true);
    await expect(execute(`${sql} VALIDATE ONLY`, mock.client, {
      cacheContext: "apply-validate", confirm, dmlMaxRows: 2, dmlMaxSubtableRows: 3,
    })).resolves.toMatchObject({
      type: "VALIDATION", operation: "UPDATE",
      validatedRows: 1, validRows: 1, invalidRows: 0, errorCount: 0,
      apply: [{
        field: "テーブル",
        operations: [{ kind: "PATCH", matchedRows: 1, changedRows: 1 }],
        changedSubtableRows: 1,
        deletedRows: 0,
      }],
      guards: {
        revisionRequired: true, parentRows: 1, dmlMaxRows: 2,
        subtableRows: 1, dmlMaxSubtableRows: 3, wouldExceed: false,
      },
    });
    expect(mock.getFields).toHaveBeenCalledWith(4221);
    expect(mock.getRecords).toHaveBeenCalledTimes(1);
    expect(mock.getRecords).toHaveBeenCalledWith({
      app: 4221,
      query: "$id = 8 limit 2",
      fields: ["$id", "$revision", "親", "親数値", "作成者", "テーブル", "別表"],
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(mock.putRecords).not.toHaveBeenCalled();
  }
);

test("VALIDATE ONLY はガード超過を wouldExceed=true の成功診断にして mutation 0", async () => {
  const mock = makeClient([parent("8", 2)]);
  const result = await execute(
    "UPDATE APP4221 SET 親='after' WHERE $id=8 APPLY テーブル (PATCH SET 子='x' ALL ROWS) VALIDATE ONLY",
    mock.client,
    { cacheContext: "apply-validate-guard", dmlMaxRows: 1, dmlMaxSubtableRows: 1 }
  );
  expect(result).toMatchObject({
    type: "VALIDATION",
    apply: [{ operations: [{ matchedRows: 2, changedRows: 2 }], changedSubtableRows: 2 }],
    guards: { parentRows: 1, subtableRows: 2, wouldExceed: true },
  });
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("VALIDATE ONLY apply[]はtable別PATCH/APPENDとtable横断追加合計を返す", async () => {
  const mock = makeClient([parent()]);
  const result = await execute(
    "UPDATE APP4221 SET 親='after' WHERE $id=8 "
      + "APPLY テーブル (PATCH SET 子='x' ALL ROWS; APPEND (子) VALUES ('a'), ('b')) "
      + "APPLY 別表 (APPEND (別子) VALUES ('c')) VALIDATE ONLY",
    mock.client,
    { cacheContext: "apply-v11-validate-detail", dmlMaxRows: 1, dmlMaxSubtableRows: 4 }
  );
  expect(result).toMatchObject({
    type: "VALIDATION",
    apply: [
      {
        field: "テーブル",
        operations: [
          { kind: "PATCH", matchedRows: 1, changedRows: 1 },
          { kind: "APPEND", addedRows: 2 },
        ],
        changedSubtableRows: 3,
      },
      {
        field: "別表",
        operations: [{ kind: "APPEND", addedRows: 1 }],
        changedSubtableRows: 1,
      },
    ],
    guards: { subtableRows: 4, dmlMaxSubtableRows: 4, wouldExceed: false },
  });
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("VALIDATE ONLY の post-image error は親単位/セル単位件数と固定列順を返す", async () => {
  const constrained = fieldInfos.map((field) => field.code === "別子" ? { ...field, required: true } : field);
  const invalid = parent();
  invalid.別表 = { value: [{ id: "201", value: { 別子: { value: "" } } }] } as never;
  const mock = makeClient([invalid], constrained);
  const result = await execute(`${sql} VALIDATE ONLY`, mock.client, { cacheContext: "apply-validate-errors" });
  expect(result).toMatchObject({
    type: "VALIDATION", validatedRows: 1, validRows: 0, invalidRows: 1, errorCount: 1,
  });
  if (result.type !== "VALIDATION") throw new Error("expected validation result");
  expect(result.columns).toEqual([
    "$id", "親",
    "$err_statement", "$err_operation", "$err_row", "$err_field", "$err_code", "$err_message",
    "$err_value", "$err_subtable", "$err_subrow", "$err_subrow_id",
  ]);
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("APPLY VALIDATE ONLY INTO #err は batch で固定列/型を実体化し後続SELECTへ列順を保つ", async () => {
  const constrained = fieldInfos.map((field) => field.code === "別子" ? { ...field, required: true } : field);
  const invalid = parent();
  invalid.別表 = { value: Array.from({ length: 10 }, (_, index) => ({
    id: String(201 + index), value: { 別子: { value: "" } },
  })) } as never;
  const mock = makeClient([invalid], constrained);
  const batch = await executeBatch(
    `${sql} VALIDATE ONLY INTO #err; SELECT * FROM #err ORDER BY $err_subrow`,
    mock.client,
    { cacheContext: "apply-validate-into" }
  );
  expect(batch.ok).toBe(true);
  const selected = batch.statements[1].result as SelectResult;
  expect(selected.columns).toEqual([
    "$id", "親",
    "$err_statement", "$err_operation", "$err_row", "$err_field", "$err_code", "$err_message",
    "$err_value", "$err_subtable", "$err_subrow", "$err_subrow_id",
  ]);
  expect(selected.rows[0]).toMatchObject({ $id: "8", $err_subrow: "1", $err_subrow_id: "201" });
  // B42 locator と同じ string metadata。number 扱いなら "2" が先になる。
  expect(selected.rows.slice(0, 3).map((row) => row.$err_subrow)).toEqual(["1", "10", "2"]);
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("APPLY VALIDATE ONLY INTO #err は単文では拒否する", async () => {
  const mock = makeClient([parent()]);
  await expect(execute(`${sql} VALIDATE ONLY INTO #err`, mock.client, { cacheContext: "apply-into-single" }))
    .rejects.toThrow("ArgumentError: VALIDATE ONLY INTO requires a batch");
  expect(mock.getRecords).not.toHaveBeenCalled();
});

test("二重ガード以内は revision 付き1-record PUTを1回だけ行う", async () => {
  const mock = makeClient([parent()]);
  await expect(execute(sql, mock.client, {
    cacheContext: "apply-success", allowApplyMutation: true, dmlMaxRows: 1, dmlMaxSubtableRows: 1,
  })).resolves.toMatchObject({ type: "UPDATE", updatedCount: 1 });
  expect(mock.putRecords).toHaveBeenCalledTimes(1);
  expect(mock.putRecords).toHaveBeenCalledWith({
    app: 4221,
    records: [{
      id: 8,
      revision: 3,
      record: {
        親: { value: "after" },
        テーブル: { value: [{ id: "101", value: { 子: { value: "patched" } } }] },
      },
    }],
  });
});

test("複数tableのPATCH/APPENDを1 recordへ合成し、defaultを明示payload化してFILEを送らない", async () => {
  const infos: KintoneFieldInfo[] = [
    ...fieldInfos.map((field) => field.code === "子" ? { ...field, defaultValue: "DEFAULT" } : field),
    { code: "必須", label: "必須", fieldType: "SINGLE_LINE_TEXT", writable: true, required: true, inSubtable: true, subtableCode: "テーブル" },
  ];
  const record = parent();
  (record.テーブル.value as any[])[0].value.必須 = { value: "existing" };
  const mock = makeClient([record], infos);
  const statement = "UPDATE APP4221 SET 親='after' WHERE $id=8 "
    + "APPLY テーブル (APPEND (必須) VALUES ('first'), ('second'); PATCH SET 子='patched' ALL ROWS) "
    + "APPLY 別表 (APPEND (別子) VALUES ('other'))";
  const confirm = jest.fn(async (_count, _operation, context) => {
    expect(context?.applyDetail).toEqual({
      kind: "APPLY_PATCH", parentRows: 1, changedSubtableRows: 4, addedSubtableRows: 3,
      tables: [
        { table: "テーブル", patchRows: 1, appendRows: 2 },
        { table: "別表", patchRows: 0, appendRows: 1 },
      ],
      deletedRows: 0, revisionRequired: true,
    });
    return true;
  });
  await expect(execute(statement, mock.client, {
    cacheContext: "apply-v11-multi", allowApplyMutation: true, confirm,
  })).resolves.toMatchObject({ updatedCount: 1 });
  expect(mock.putRecords).toHaveBeenCalledTimes(1);
  const payload = (mock.putRecords.mock.calls as unknown as [[KintonePutParams]])[0][0];
  expect(payload.records).toHaveLength(1);
  expect(payload.records[0].record).toEqual({
    親: { value: "after" },
    テーブル: { value: [
      { id: "101", value: { 子: { value: "patched" } } },
      { value: { 子: { value: "DEFAULT" }, 必須: { value: "first" } } },
      { value: { 子: { value: "DEFAULT" }, 必須: { value: "second" } } },
    ] },
    別表: { value: [{ value: { 別子: { value: "other" } } }] },
  });
});

test("APPEND未指定required既定値なしとnumber precision違反をPUT前に拒否する", async () => {
  const requiredInfos: KintoneFieldInfo[] = [
    ...fieldInfos,
    { code: "必須", label: "必須", fieldType: "SINGLE_LINE_TEXT", writable: true, required: true, inSubtable: true, subtableCode: "テーブル" },
  ];
  const requiredRecord = parent();
  (requiredRecord.テーブル.value as any[])[0].value.必須 = { value: "existing" };
  const requiredMock = makeClient([requiredRecord], requiredInfos);
  await expect(execute(
    "UPDATE APP4221 SET 親='after' WHERE $id=8 APPLY テーブル (APPEND (子) VALUES ('x'))",
    requiredMock.client,
    { cacheContext: "apply-v11-required", allowApplyMutation: true }
  )).rejects.toThrow(/APPLY post-image validation failed.*ERR_REQUIRED/);
  expect(requiredMock.putRecords).not.toHaveBeenCalled();

  const numberInfos: KintoneFieldInfo[] = [
    ...fieldInfos,
    { code: "子数値", label: "子数値", fieldType: "NUMBER", writable: true, inSubtable: true, subtableCode: "テーブル" },
  ];
  const numberRecord = parent();
  (numberRecord.テーブル.value as any[])[0].value.子数値 = { value: "1" };
  const numberMock = makeClient([numberRecord], numberInfos);
  numberMock.getNumberPrecision.mockResolvedValueOnce({ digits: 3, decimalPlaces: 1, roundingMode: "HALF_EVEN" });
  await expect(execute(
    "UPDATE APP4221 SET 親='after' WHERE $id=8 APPLY テーブル (APPEND (子数値) VALUES (100))",
    numberMock.client,
    { cacheContext: "apply-v11-precision", allowApplyMutation: true }
  )).rejects.toThrow(/APPLY post-image validation failed.*ERR_NUMBER_INTEGER_DIGITS/);
  expect(numberMock.putRecords).not.toHaveBeenCalled();
});

test("APPENDのmetadata既定値も通常値と同じchoice primitiveで検証する", async () => {
  const infos: KintoneFieldInfo[] = [
    ...fieldInfos,
    {
      code: "選択", label: "選択", fieldType: "DROP_DOWN", writable: true,
      optionOrder: { A: 0 }, defaultValue: "UNKNOWN", inSubtable: true, subtableCode: "テーブル",
    },
  ];
  const record = parent();
  (record.テーブル.value as any[])[0].value.選択 = { value: "A" };
  const mock = makeClient([record], infos);
  await expect(execute(
    "UPDATE APP4221 SET 親='after' WHERE $id=8 APPLY テーブル (APPEND (子) VALUES ('x'))",
    mock.client,
    { cacheContext: "apply-v11-default-choice", allowApplyMutation: true }
  )).rejects.toThrow(/APPLY post-image validation failed.*ERR_CHOICE_INVALID/);
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("親1・子501は既定子ガード500で PUT 0", async () => {
  const mock = makeClient([parent("8", 501)]);
  const allRowsSql = "UPDATE APP4221 SET 親 = 'after' WHERE $id = 8 " +
    "APPLY テーブル (PATCH SET 子 = 'patched' ALL ROWS)";
  await expect(execute(allRowsSql, mock.client, { cacheContext: "apply-default-child-guard", allowApplyMutation: true }))
    .rejects.toThrow("ArgumentError: APPLY changed subtable rows (501) exceed dmlMaxSubtableRows (500)");
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("親ガードと両ガードの正整数契約を core で強制する", async () => {
  const parentGuard = makeClient([parent()]);
  await expect(execute(sql, parentGuard.client, {
    cacheContext: "apply-parent-guard", allowApplyMutation: true, dmlMaxRows: 0,
  })).rejects.toThrow("ArgumentError: dmlMaxRows must be a positive safe integer");
  expect(parentGuard.putRecords).not.toHaveBeenCalled();

  const childGuard = makeClient([parent()]);
  await expect(execute(sql, childGuard.client, {
    cacheContext: "apply-child-guard-invalid", allowApplyMutation: true, dmlMaxSubtableRows: 1.5,
  })).rejects.toThrow("ArgumentError: dmlMaxSubtableRows must be a positive safe integer");
  expect(childGuard.putRecords).not.toHaveBeenCalled();
});

test.each([
  [
    "unknown rid",
    "UPDATE APP4221 SET 親='after' WHERE $id=8 APPLY テーブル (PATCH SET 子='x' WHERE _rid='999')",
    /ArgumentError: APPLY _rid 999 does not exist/,
  ],
  [
    "duplicate cell",
    "UPDATE APP4221 SET 親='after' WHERE $id=8 APPLY テーブル (" +
      "PATCH SET 子='x' ALL ROWS; PATCH SET 子='y' WHERE _rid='101')",
    /ArgumentError: APPLY patches cell 101\.子 more than once/,
  ],
] as const)("%s は plan 完了前に拒否し PUT 0", async (_label, statement, error) => {
  const mock = makeClient([parent()]);
  await expect(execute(statement, mock.client, {
    cacheContext: `apply-plan-${_label}`, allowApplyMutation: true,
  })).rejects.toThrow(error);
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("全 preflight とガード完了後に applyDetail 付き confirm を1回呼び、拒否なら PUT 0", async () => {
  const mock = makeClient([parent()]);
  const confirm = jest.fn(async (count, operation, context) => {
    expect(mock.getFields).toHaveBeenCalledTimes(1);
    expect(mock.getRecords).toHaveBeenCalledTimes(1);
    expect(mock.getNumberPrecision).toHaveBeenCalledTimes(1);
    expect(mock.putRecords).not.toHaveBeenCalled();
    expect(count).toBe(1);
    expect(operation).toBe("UPDATE");
    expect(context?.importDetail).toBeUndefined();
    expect(context?.applyDetail).toEqual({
      kind: "APPLY_PATCH",
      parentRows: 1,
      changedSubtableRows: 1,
      addedSubtableRows: 0,
      tables: [{ table: "テーブル", patchRows: 1, appendRows: 0 }],
      deletedRows: 0,
      revisionRequired: true,
    });
    return false;
  });
  await expect(execute(sql, mock.client, {
    cacheContext: "apply-confirm-order", allowApplyMutation: true, confirm,
  })).rejects.toThrow("UPDATE をキャンセルしました（対象: 1 件）");
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("revision conflict を再GET・retryせずそのまま失敗させる", async () => {
  const mock = makeClient([parent()]);
  mock.putRecords.mockRejectedValueOnce(new Error("GAIA_CO02: revision conflict"));
  await expect(execute(sql, mock.client, {
    cacheContext: "apply-revision-conflict", allowApplyMutation: true,
  })).rejects.toThrow("GAIA_CO02: revision conflict");
  expect(mock.getRecords).toHaveBeenCalledTimes(1);
  expect(mock.putRecords).toHaveBeenCalledTimes(1);
});

test.each([
  ["0件", [], /ArgumentError: APPLY parent \$id 8 does not exist/],
  ["2件", [parent(), parent()], /ArgumentError: APPLY parent \$id 8 returned multiple records/],
  ["$id不一致", [parent("9")], /ArgumentError: APPLY snapshot \$id 9 does not match requested \$id 8/],
] as const)("親GETの%sを fail-closed にし PUT 0", async (_label, records, error) => {
  const mock = makeClient([...records]);
  await expect(execute(sql, mock.client, { cacheContext: `apply-parent-${_label}`, allowApplyMutation: true })).rejects.toThrow(error);
  expect(mock.getRecords).toHaveBeenCalledTimes(1);
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("target/child/writable metadata error は records API 前に拒否する", async () => {
  const wrongChild = makeClient([parent()]);
  const wrongChildSql = "UPDATE APP4221 SET 親 = 'after' WHERE $id = 8 " +
    "APPLY テーブル (PATCH SET 別子 = 'x' ALL ROWS)";
  await expect(execute(wrongChildSql, wrongChild.client, { cacheContext: "apply-wrong-child", allowApplyMutation: true }))
    .rejects.toThrow("ArgumentError: APPLY child 別子 does not belong to subtable テーブル");
  expect(wrongChild.getRecords).not.toHaveBeenCalled();
  expect(wrongChild.putRecords).not.toHaveBeenCalled();

  const missingTable = makeClient([parent()], fieldInfos.filter((field) => field.code !== "テーブル"));
  await expect(execute(sql, missingTable.client, { cacheContext: "apply-missing-table", allowApplyMutation: true }))
    .rejects.toThrow("ArgumentError: APPLY target テーブル is not a SUBTABLE");
  expect(missingTable.getRecords).not.toHaveBeenCalled();
});

test("post-image error は固定列順の診断を含む ArgumentError で停止し PUT 0", async () => {
  const constrained = fieldInfos.map((field) => field.code === "別子"
    ? { ...field, required: true }
    : field.code === "子"
      ? { ...field, minLength: "2" }
      : field);
  const invalid = parent();
  invalid.別表 = { value: [{ id: "201", value: { 別子: { value: "" } } }] } as never;
  const mock = makeClient([invalid], constrained);

  let error: Error | undefined;
  try {
    await execute(sql, mock.client, { cacheContext: "apply-post-image-errors", allowApplyMutation: true });
  } catch (caught) {
    error = caught as Error;
  }
  expect(error?.message).toContain("ArgumentError: APPLY post-image validation failed");
  const diagnostic = JSON.parse(error!.message.slice(error!.message.indexOf("{") )) as {
    columns: string[]; errors: Array<Record<string, string>>;
  };
  expect(diagnostic.columns).toEqual([
    "$id", "親",
    "$err_statement", "$err_operation", "$err_row", "$err_field", "$err_code", "$err_message",
    "$err_value", "$err_subtable", "$err_subrow", "$err_subrow_id",
  ]);
  expect(diagnostic.errors).toEqual([
    expect.objectContaining({
      $id: "8", 親: "after", $err_field: "別子", $err_subtable: "別表", $err_subrow: "1", $err_subrow_id: "201",
    }),
  ]);
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("トップレベル post-image error の locator 3列は空で $id は重複しない", async () => {
  const constrained = fieldInfos.map((field) => field.code === "親数値"
    ? { ...field, maxValue: "0" }
    : field);
  const mock = makeClient([parent()], constrained);
  await expect(execute(sql, mock.client, { cacheContext: "apply-post-image-top-error", allowApplyMutation: true }))
    .rejects.toThrow(/\"\$err_subtable\":\"\",\"\$err_subrow\":\"\",\"\$err_subrow_id\":\"\"/);
  expect(mock.putRecords).not.toHaveBeenCalled();
});

test("post-image に NUMBER セルがない場合は precision cache を読まない", async () => {
  const withoutNumbers = fieldInfos.filter((field) => field.code !== "親数値");
  const record = parent();
  delete record.親数値;
  const mock = makeClient([record], withoutNumbers);
  await expect(execute(sql, mock.client, { cacheContext: "apply-no-number-precision", allowApplyMutation: true }))
    .resolves.toMatchObject({ updatedCount: 1 });
  expect(mock.getNumberPrecision).not.toHaveBeenCalled();
  expect(mock.putRecords).toHaveBeenCalledTimes(1);
});
