export const PHASE1_BOARD_TIMEZONE = "America/New_York";

export function isIsoDay(value: string | null | undefined): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

export function todayIsoInTimeZone(timeZone: string = PHASE1_BOARD_TIMEZONE): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return formatter.format(new Date());
}

export function getTimeZoneOffsetMs(atUtc: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = formatter.formatToParts(atUtc);
  const year = parseInt(parts.find((part) => part.type === "year")?.value ?? "0", 10);
  const month = parseInt(parts.find((part) => part.type === "month")?.value ?? "0", 10);
  const day = parseInt(parts.find((part) => part.type === "day")?.value ?? "0", 10);
  const hour = parseInt(parts.find((part) => part.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(parts.find((part) => part.type === "minute")?.value ?? "0", 10);
  const second = parseInt(parts.find((part) => part.type === "second")?.value ?? "0", 10);
  const asUtcTimestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUtcTimestamp - atUtc.getTime();
}

export function zonedMidnightToUtc(isoDay: string, timeZone: string): Date {
  const [year, month, day] = isoDay.split("-").map(Number);
  const utcGuess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const guessDate = new Date(utcGuess);
  const offset = getTimeZoneOffsetMs(guessDate, timeZone);
  return new Date(utcGuess - offset);
}

export function boardDayRange(isoDay: string, timeZone: string): { dayStart: Date; dayEnd: Date } {
  const dayStart = zonedMidnightToUtc(isoDay, timeZone);
  const nextDayUtc = new Date(`${isoDay}T00:00:00.000Z`);
  nextDayUtc.setUTCDate(nextDayUtc.getUTCDate() + 1);
  const nextIsoDay = nextDayUtc.toISOString().slice(0, 10);
  const dayEnd = zonedMidnightToUtc(nextIsoDay, timeZone);
  return { dayStart, dayEnd };
}
