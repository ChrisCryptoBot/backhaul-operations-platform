// VENDORED from TrueLane lib/appointmentWindow.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Appointment window parse/format for load-detail stop rows.
 * Timed = point appointment; Open 24h = local calendar day 00:00 → 23:59:00.
 */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function startOfLocalDayFromParts(y: number, m: number, d: number): number {
  return new Date(y, m, d, 0, 0, 0, 0).getTime();
}

function endOfLocalDayFromParts(y: number, m: number, d: number): number {
  // DST-safe: construct 23:59 local rather than adding 24h.
  return new Date(y, m, d, 23, 59, 0, 0).getTime();
}

export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  return startOfLocalDayFromParts(d.getFullYear(), d.getMonth(), d.getDate());
}

export function localEndOfDay(ms: number): number {
  const d = new Date(ms);
  return endOfLocalDayFromParts(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 'YYYY-MM-DD HH:MM' → local ms. Requires both date and time. */
export function parseTimed(input: string): number | null {
  const trimmed = input.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const year = parseInt(match[1]!, 10);
  const month = parseInt(match[2]!, 10) - 1;
  const day = parseInt(match[3]!, 10);
  const hour = parseInt(match[4]!, 10);
  const minute = parseInt(match[5]!, 10);
  if (month < 0 || month > 11 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const ms = new Date(year, month, day, hour, minute, 0, 0).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** 'YYYY-MM-DD' → local 00:00 / 23:59 same day. */
export function parseOpen24h(input: string): { earliest: number; latest: number } | null {
  const trimmed = input.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const year = parseInt(match[1]!, 10);
  const month = parseInt(match[2]!, 10) - 1;
  const day = parseInt(match[3]!, 10);
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const earliest = startOfLocalDayFromParts(year, month, day);
  const latest = endOfLocalDayFromParts(year, month, day);
  if (!Number.isFinite(earliest) || !Number.isFinite(latest)) return null;
  // Reject impossible calendar dates (e.g. Feb 31 → rolled forward)
  const check = new Date(earliest);
  if (check.getFullYear() !== year || check.getMonth() !== month || check.getDate() !== day) {
    return null;
  }
  return { earliest, latest };
}

/** local ms → 'YYYY-MM-DD HH:MM' */
export function formatTimed(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Exact Open 24h: earliest === startOfLocalDay(earliest)
 * AND latest === localEndOfDay(earliest). No tolerances.
 */
export function isOpen24h(earliest: number | null, latest: number | null): boolean {
  if (earliest == null || latest == null) return false;
  if (!Number.isFinite(earliest) || !Number.isFinite(latest)) return false;
  return earliest === startOfLocalDay(earliest) && latest === localEndOfDay(earliest);
}

/** If isOpen24h → 'YYYY-MM-DD', else null. */
export function formatOpen24h(earliest: number, latest: number): string | null {
  if (!isOpen24h(earliest, latest)) return null;
  const d = new Date(earliest);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
