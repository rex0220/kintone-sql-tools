import type { KintoneFieldInfo } from "../execute";
import type { MultiValueApplyBlock } from "../types/ast";

export type ApplyMultiValueFieldType =
  | "CHECK_BOX"
  | "MULTI_SELECT"
  | "USER_SELECT"
  | "ORGANIZATION_SELECT"
  | "GROUP_SELECT";

export interface ApplyCodeValue {
  readonly code: string;
}

export interface ApplyMultiValueOperationPlan {
  readonly kind: "ADD" | "REMOVE_VALUE";
  readonly value: string;
  readonly changed: boolean;
}

export interface ApplyMultiValueFieldPlan {
  readonly field: string;
  readonly fieldType: ApplyMultiValueFieldType;
  readonly operations: readonly ApplyMultiValueOperationPlan[];
  readonly postImageValue: readonly string[] | readonly ApplyCodeValue[];
  readonly addedValues: number;
  readonly removedValues: number;
  readonly changedValues: number;
}

const STRING_ARRAY_TYPES = new Set<ApplyMultiValueFieldType>(["CHECK_BOX", "MULTI_SELECT"]);
const CODE_ARRAY_TYPES = new Set<ApplyMultiValueFieldType>([
  "USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT",
]);

function argument(message: string): never {
  throw new Error(`ArgumentError: ${message}`);
}

/**
 * Pure snapshot -> post-image collection planner.
 *
 * Every operation is resolved against the original snapshot. The post-image is
 * therefore independent of operation order except that genuinely new ADD values
 * retain their first ADD order at the end of the existing collection.
 */
export function buildApplyMultiValueFieldPlan(
  block: MultiValueApplyBlock,
  snapshotValue: unknown,
  field: KintoneFieldInfo
): ApplyMultiValueFieldPlan {
  const fieldType = requireMultiValueFieldType(field.fieldType, block.field);
  const snapshotCodes = readSnapshotCodes(snapshotValue, fieldType, block.field);
  const snapshotSet = new Set(snapshotCodes);
  const addOrder: string[] = [];
  const addSet = new Set<string>();
  const removeSet = new Set<string>();

  for (const operation of block.operations) {
    const value = operation.value;
    // B46 parity: the empty string represents an unselected value, not an
    // option/code element. It is consequently a no-op for both verbs.
    if (value === "") continue;
    if (operation.kind === "ADD") {
      if (!addSet.has(value)) addOrder.push(value);
      addSet.add(value);
    } else {
      removeSet.add(value);
    }
  }
  for (const value of addSet) {
    if (removeSet.has(value)) {
      argument(`APPLY multi-value field ${block.field} has conflicting ADD and REMOVE for ${JSON.stringify(value)}.`);
    }
  }

  const survivorCodes = snapshotCodes.filter((value) => !removeSet.has(value));
  const appendedCodes = addOrder.filter((value) => !snapshotSet.has(value));
  const postImageCodes = [...survivorCodes, ...appendedCodes];
  const actuallyRemoved = new Set(snapshotCodes.filter((value) => removeSet.has(value))).size;
  const reportedAdds = new Set<string>();
  const reportedRemoves = new Set<string>();
  const operations = block.operations.map((operation): ApplyMultiValueOperationPlan => {
    const reported = operation.kind === "ADD" ? reportedAdds : reportedRemoves;
    const first = !reported.has(operation.value);
    reported.add(operation.value);
    return {
      kind: operation.kind,
      value: operation.value,
      changed: operation.value !== "" && first && (operation.kind === "ADD"
        ? !snapshotSet.has(operation.value)
        : snapshotSet.has(operation.value)),
    };
  });
  const postImageValue = STRING_ARRAY_TYPES.has(fieldType)
    ? postImageCodes
    : postImageCodes.map((code) => ({ code }));
  return {
    field: block.field,
    fieldType,
    operations,
    postImageValue,
    addedValues: appendedCodes.length,
    removedValues: actuallyRemoved,
    changedValues: appendedCodes.length + actuallyRemoved,
  };
}

function requireMultiValueFieldType(fieldType: string, field: string): ApplyMultiValueFieldType {
  if (STRING_ARRAY_TYPES.has(fieldType as ApplyMultiValueFieldType)
    || CODE_ARRAY_TYPES.has(fieldType as ApplyMultiValueFieldType)) {
    return fieldType as ApplyMultiValueFieldType;
  }
  return argument(`APPLY multi-value target ${field} has unsupported type ${fieldType}.`);
}

function readSnapshotCodes(
  raw: unknown,
  fieldType: ApplyMultiValueFieldType,
  field: string
): string[] {
  if (!Array.isArray(raw)) return argument(`APPLY snapshot for ${field} must be an array.`);
  const codes = raw.map((item, index) => {
    if (STRING_ARRAY_TYPES.has(fieldType)) {
      if (typeof item !== "string") {
        return argument(`APPLY snapshot for ${field} must contain string values (item ${index + 1}).`);
      }
      return item;
    }
    if (typeof item !== "object" || item === null
      || typeof (item as { code?: unknown }).code !== "string") {
      return argument(`APPLY snapshot for ${field} must contain {code: string} values (item ${index + 1}).`);
    }
    return (item as { code: string }).code;
  });
  // Treat the snapshot as an ordered set even if malformed/legacy data contains
  // duplicate elements: preserve the first occurrence deterministically.
  return [...new Set(codes.filter((code) => code !== ""))];
}
