import type { AppBinding, SqlRewriteSegment } from "./appProfiles";

export interface SqlDiagnosticContext {
  bindings: ReadonlyMap<number, AppBinding>;
  rewriteSegments: ReadonlyArray<Readonly<SqlRewriteSegment>>;
}

/**
 * EXPLAIN等の利用者向け値に含まれる内部mapped APP表記を元の参照へ戻す。
 * structured validation payloadのmappedAppIdは、この関数を通さず保持する。
 */
export function restoreSqlDiagnosticValue(
  value: unknown,
  bindings: ReadonlyMap<number, AppBinding>
): unknown {
  if (typeof value === "string") {
    // DML プランの書き込み先ヘッダ（target: APP<mapped> (<mapped>)）は、仕様 §9.2 に従い
    // 論理名と物理ID・profile を併記する（LAPP_ORDERS -> APP1234@prod）。
    // 物理参照は APP<id>@profile。汎用置換より前に処理し、内部 mapped ID を露出しない。
    const dmlTarget = value.match(/^(\s*target:\s*)APP(\d+) \((\d+)\)\s*$/);
    if (dmlTarget && dmlTarget[2] === dmlTarget[3]) {
      const binding = bindings.get(Number(dmlTarget[2]));
      if (binding) {
        const target = binding.source === "logical"
          ? `LAPP_${binding.logicalName} -> APP${binding.appId}@${binding.profile}`
          : `APP${binding.appId}@${binding.profile}`;
        return `${dmlTarget[1]}${target}`;
      }
    }
    let restored = value;
    for (const binding of bindings.values()) {
      const internal = `APP${binding.mappedAppId}`;
      const display = binding.source === "logical"
        ? `LAPP_${binding.logicalName}@${binding.profile}`
        : `APP${binding.appId}@${binding.profile}`;
      restored = restored
        .split(`${internal} (${binding.mappedAppId})`).join(display)
        .split(internal).join(display);
    }
    return restored;
  }
  if (Array.isArray(value)) {
    return value.map((item) => restoreSqlDiagnosticValue(item, bindings));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, restoreSqlDiagnosticValue(item, bindings)])
    );
  }
  return value;
}

/**
 * 正規化SQLに対するエラーを元SQLの表記・位置へ復元する。
 * 元Errorをそのまま返して、name/token/cause/独自プロパティとsurface側のexit判定を維持する。
 */
export function restoreSqlContextError(
  err: unknown,
  sourceSql: string,
  context: SqlDiagnosticContext
): unknown {
  if (!(err instanceof Error)) return err;

  let message = err.message;
  for (const binding of context.bindings.values()) {
    if (binding.source === "logical") {
      message = message
        .split(`APP${binding.mappedAppId}`)
        .join(`LAPP_${binding.logicalName}@${binding.profile}`);
    }
  }

  const token = (err as Error & { token?: { pos?: number } }).token;
  if (typeof token?.pos === "number") {
    const segment = context.rewriteSegments.find(
      (candidate) => token.pos! >= candidate.normalizedStart && token.pos! < candidate.normalizedEnd
    );
    if (segment) {
      const sourcePos = segment.sourceStart + Math.min(
        token.pos - segment.normalizedStart,
        Math.max(0, segment.sourceEnd - segment.sourceStart - 1)
      );
      message = message.replace(/（位置 \d+、トークン:/, `（位置 ${sourcePos}、トークン:`);
      const originalRef = sourceSql.slice(segment.sourceStart, segment.sourceEnd);
      if (segment.bindingMappedAppId !== undefined && originalRef) {
        message = message.replace(/(トークン: 「)[^」]*(」)/, `$1${originalRef}$2`);
      }
    }
  }

  err.message = message;
  return err;
}
