import type { AppBinding } from "./logicalApps";

export interface SqlDiagnosticDisplayOptions {
  readonly logicalAppDisplay?: "profile" | "physical";
}

/**
 * EXPLAIN等の利用者向け値に含まれる内部mapped APP表記を元の参照へ戻す。
 * structured validation payloadのmappedAppIdは、この関数を通さず保持する。
 */
export function restoreSqlDiagnosticValue(
  value: unknown,
  bindings: ReadonlyMap<number, AppBinding>,
  options: SqlDiagnosticDisplayOptions = {}
): unknown {
  const displayMode = options.logicalAppDisplay ?? "profile";
  if (typeof value === "string") {
    // DML プランの書き込み先ヘッダ（target: APP<mapped> (<mapped>)）は、仕様 §9.2 に従い
    // 論理名と物理ID・profile を併記する（LAPP_ORDERS -> APP1234@prod）。
    // 物理参照は APP<id>@profile。汎用置換より前に処理し、内部 mapped ID を露出しない。
    const dmlTarget = value.match(/^(\s*target:\s*)APP(\d+) \((\d+)\)\s*$/);
    if (dmlTarget && dmlTarget[2] === dmlTarget[3]) {
      const binding = bindings.get(Number(dmlTarget[2]));
      if (binding) {
        const target = binding.source === "logical"
          ? displayMode === "physical"
            ? `LAPP_${binding.logicalName} -> APP${binding.appId}`
            : `LAPP_${binding.logicalName} -> APP${binding.appId}@${binding.profile}`
          : displayMode === "physical"
            ? `APP${binding.appId}`
            : `APP${binding.appId}@${binding.profile}`;
        return `${dmlTarget[1]}${target}`;
      }
    }
    let restored = value;
    for (const binding of bindings.values()) {
      const internal = `APP${binding.mappedAppId}`;
      const display = binding.source === "logical"
        ? displayMode === "physical"
          ? `LAPP_${binding.logicalName} -> APP${binding.appId}`
          : `LAPP_${binding.logicalName}@${binding.profile}`
        : displayMode === "physical"
          ? `APP${binding.appId}`
          : `APP${binding.appId}@${binding.profile}`;
      restored = restored
        .split(`${internal} (${binding.mappedAppId})`).join(display)
        .split(internal).join(display);
    }
    return restored;
  }
  if (Array.isArray(value)) {
    return value.map((item) => restoreSqlDiagnosticValue(item, bindings, options));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        restoreSqlDiagnosticValue(item, bindings, options),
      ])
    );
  }
  return value;
}
