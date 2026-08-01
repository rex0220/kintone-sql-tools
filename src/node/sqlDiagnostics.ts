import type { AppBinding, SqlRewriteSegment } from "./appProfiles";
export { restoreSqlDiagnosticValue } from "../core/sqlDiagnostics";

export interface SqlDiagnosticContext {
  bindings: ReadonlyMap<number, AppBinding>;
  rewriteSegments: ReadonlyArray<Readonly<SqlRewriteSegment>>;
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
