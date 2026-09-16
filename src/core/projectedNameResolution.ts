/**
 * Resolve a reference against projected/materialized column names.
 *
 * Projected aliases are stored in their lowercase canonical form. Preserve an
 * exact match first, then allow the spelling used in SQL to reach that
 * canonical name. Physical APP field codes must not be passed to this helper.
 */
export function resolveProjectedName(
  requested: string,
  available: Iterable<string>
): string | undefined {
  const names = [...available];
  if (names.includes(requested)) return requested;
  const canonical = requested.toLowerCase();
  return names.find((name) => name === canonical);
}
