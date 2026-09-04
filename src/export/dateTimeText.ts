import { ExportSinkInvalidTimezoneError, ExportSinkInvalidValueError } from "./types";

const UTC_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/;

interface DateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  fraction: string;
}

function utcMilliseconds(parts: Omit<DateTimeParts, "fraction">): number {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  return date.getTime();
}

function parseUtcDateTime(text: string): { parts: DateTimeParts; instant: Date } {
  const match = UTC_DATETIME.exec(text);
  if (!match) throw new ExportSinkInvalidValueError("DATETIME value is not a valid UTC ISO 8601 string.");
  const parts: DateTimeParts = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6]),
    fraction: match[7] ?? "",
  };
  const wholeSecond = utcMilliseconds(parts);
  const check = new Date(wholeSecond);
  if (
    check.getUTCFullYear() !== parts.year || check.getUTCMonth() + 1 !== parts.month
    || check.getUTCDate() !== parts.day || check.getUTCHours() !== parts.hour
    || check.getUTCMinutes() !== parts.minute || check.getUTCSeconds() !== parts.second
  ) {
    throw new ExportSinkInvalidValueError("DATETIME value is not a valid UTC ISO 8601 instant.");
  }
  const milliseconds = Number((parts.fraction.slice(1) + "000").slice(0, 3));
  return { parts, instant: new Date(wholeSecond + milliseconds) };
}

export function createDateTimeFormatter(timezone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-CA-u-nu-latn", {
      timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23",
    });
  } catch (error) {
    throw new ExportSinkInvalidTimezoneError(
      `timezone ${JSON.stringify(timezone)} is not a supported IANA timezone.`,
      error
    );
  }
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  const value = parts.find((candidate) => candidate.type === type)?.value;
  if (value === undefined) {
    throw new ExportSinkInvalidTimezoneError("timezone formatter did not return the required date parts.");
  }
  return Number(value);
}

function pad(value: number): string { return String(value).padStart(2, "0"); }

/** Converts a UTC ISO instant to an offset ISO string while retaining its fraction verbatim. */
export function formatDateTimeInTimezone(text: string, formatter: Intl.DateTimeFormat): string {
  const { parts: utc, instant } = parseUtcDateTime(text);
  const formatted = formatter.formatToParts(instant);
  const local = {
    year: part(formatted, "year"), month: part(formatted, "month"), day: part(formatted, "day"),
    hour: part(formatted, "hour"), minute: part(formatted, "minute"), second: part(formatted, "second"),
  };
  const offsetSeconds = (utcMilliseconds(local) - utcMilliseconds(utc)) / 1000;
  if (!Number.isInteger(offsetSeconds)) {
    throw new ExportSinkInvalidTimezoneError("timezone produced a non-integral offset.");
  }
  const offsetSign = offsetSeconds < 0 ? "-" : "+";
  const offset = Math.abs(offsetSeconds);
  const offsetHours = Math.floor(offset / 3600);
  const offsetMinutes = Math.floor((offset % 3600) / 60);
  return `${String(local.year).padStart(4, "0")}-${pad(local.month)}-${pad(local.day)}`
    + `T${pad(local.hour)}:${pad(local.minute)}:${pad(local.second)}${utc.fraction}`
    + `${offsetSign}${pad(offsetHours)}:${pad(offsetMinutes)}`;
}

export function assertValidUtcDateTime(text: string): void {
  parseUtcDateTime(text);
}
