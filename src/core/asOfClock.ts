export const AS_OF_FUNCTION_NAMES = [
  "NOW",
  "TODAY",
  "MONTH_START",
  "NEXT_MONTH_START",
] as const;

export type AsOfFunctionName = typeof AS_OF_FUNCTION_NAMES[number];

const AS_OF_VARIABLE_PREFIX = "\u0000as-of:";

export interface AsOfClock {
  readonly asOf: Date;
  readonly timezone?: string;
  readonly values: Readonly<Record<AsOfFunctionName, string>>;
}

export function asOfVariableName(name: AsOfFunctionName): string {
  return `${AS_OF_VARIABLE_PREFIX}${name}`;
}

export function asOfFunctionNameFromVariable(name: string): AsOfFunctionName | null {
  if (!name.startsWith(AS_OF_VARIABLE_PREFIX)) return null;
  const candidate = name.slice(AS_OF_VARIABLE_PREFIX.length);
  return isAsOfFunctionName(candidate) ? candidate : null;
}

export function isAsOfFunctionName(name: string): name is AsOfFunctionName {
  return (AS_OF_FUNCTION_NAMES as readonly string[]).includes(name);
}

/**
 * Captures and validates the script-wide as-of clock.
 * An omitted timezone intentionally delegates to the host/browser timezone.
 */
export function createAsOfClock(asOf: Date = new Date(), timezone?: string): AsOfClock {
  if (!(asOf instanceof Date) || !Number.isFinite(asOf.getTime())) {
    throw new Error("ArgumentError: asOf must be a valid Date.");
  }

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      ...(timezone === undefined ? {} : { timeZone: timezone }),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    // Some implementations do not validate the time zone until formatting.
    formatter.format(asOf);
  } catch {
    throw new Error(`ArgumentError: invalid IANA timezone: ${timezone ?? ""}.`);
  }

  const parts = formatter.formatToParts(asOf);
  const year = partNumber(parts, "year");
  const month = partNumber(parts, "month");
  const day = partNumber(parts, "day");
  const today = `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
  const monthStart = `${pad4(year)}-${pad2(month)}-01`;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;

  return {
    asOf: new Date(asOf.getTime()),
    ...(timezone === undefined ? {} : { timezone }),
    values: {
      NOW: asOf.toISOString(),
      TODAY: today,
      MONTH_START: monthStart,
      NEXT_MONTH_START: `${pad4(nextYear)}-${pad2(nextMonth)}-01`,
    },
  };
}

function partNumber(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  const value = parts.find((part) => part.type === type)?.value;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`InternalError: Intl.DateTimeFormat did not return ${type}.`);
  }
  return parsed;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function pad4(value: number): string {
  return String(value).padStart(4, "0");
}
