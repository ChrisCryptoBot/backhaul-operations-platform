// VENDORED from TrueLane lib/rateCon/stopTime.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Appointment times in the STOP's timezone. Pure (Intl only, no native code).
 *
 * A rate con prints a wall-clock time at the stop ("8:00" at a dock in Bowman, ND). The app stores instants and compares them with
 * "now", so the printed time must be turned into the instant it means THERE. Reading it in the phone's zone puts a Mountain
 * appointment on a Central phone an hour off: a wrong value, not a missing one (12 of 31 rate cons in the corpus cross a zone).
 *
 * Where the zone comes from, best first:
 *   1. the stop's coordinates (tz-lookup, boundary data: right for Bowman ND, El Paso TX, Kentucky's split);
 *   2. the stop's state, when the whole state is one zone;
 *   3. nothing: the phone's zone, as before, and the sheet says so for that stop.
 *
 * Only a timed appointment (or window start/end) is zone-converted. A bare date means "open all day" and stays the phone's calendar
 * day, so "Open 24 hours" keeps reading as that wherever the stop is.
 */
import tzlookup from 'tz-lookup';
import { parseOpen24h, parseTimed } from '@/truelane/lib/appointmentWindow';

/** States that sit wholly in one zone. Split states (TX, FL, KS, NE, SD, ND, KY, TN, IN, MI, OR, ID, AZ's Navajo) are left out on purpose. */
const STATE_ZONE: Record<string, string> = {
  CT: 'America/New_York', DE: 'America/New_York', GA: 'America/New_York', MA: 'America/New_York', MD: 'America/New_York',
  ME: 'America/New_York', NH: 'America/New_York', NJ: 'America/New_York', NY: 'America/New_York', NC: 'America/New_York',
  OH: 'America/New_York', PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York', VT: 'America/New_York',
  VA: 'America/New_York', WV: 'America/New_York', DC: 'America/New_York',
  AL: 'America/Chicago', AR: 'America/Chicago', IL: 'America/Chicago', IA: 'America/Chicago', LA: 'America/Chicago',
  MN: 'America/Chicago', MS: 'America/Chicago', MO: 'America/Chicago', OK: 'America/Chicago', WI: 'America/Chicago',
  CO: 'America/Denver', MT: 'America/Denver', NM: 'America/Denver', UT: 'America/Denver', WY: 'America/Denver',
  AZ: 'America/Phoenix',
  CA: 'America/Los_Angeles', NV: 'America/Los_Angeles', WA: 'America/Los_Angeles',
  AK: 'America/Anchorage', HI: 'Pacific/Honolulu',
};

/** "TX" -> its zone, or null when the state is split or unknown. */
export function zoneForState(state: string | null | undefined): string | null {
  return STATE_ZONE[(state ?? '').trim().toUpperCase()] ?? null;
}

/** The two-letter state at the end of "Street, City, ST 12345" (or "City, ST"), upper-cased; null when there is none. */
export function stateOfAddress(address: string | null | undefined): string | null {
  const s = (address ?? '').replace(/\s+/g, ' ').trim();
  const m = /(?:,|\s)\s*([A-Za-z]{2})\.?\s*(?:\d{5}(?:-\d{4})?)?\s*$/.exec(s);
  return m ? m[1]!.toUpperCase() : null;
}

/** The IANA zone of a point, or null for an invalid one. */
export function zoneAt(lat: number, lng: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  try {
    const z = tzlookup(lat, lng);
    return typeof z === 'string' && z.length > 0 ? z : null;
  } catch {
    return null;
  }
}

/** Minutes the zone is ahead of UTC at this instant, or null when this runtime has no Intl zone support. */
function offsetMinutes(ms: number, zone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(ms));
    const v = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour') % 24, v('minute'), v('second'));
    if (!Number.isFinite(asUtc)) return null;
    return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
  } catch {
    return null;
  }
}

/** 'YYYY-MM-DD' + 'HH:MM' on a wall clock in `zone` -> the instant (ms). A time that does not exist (DST gap) lands just after the gap. */
export function instantInZone(date: string, time: string, zone: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const t = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!d || !t) return null;
  const [y, mo, da, h, mi] = [Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2])];
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59) return null;
  const guess = Date.UTC(y, mo - 1, da, h, mi);
  const o1 = offsetMinutes(guess, zone);
  if (o1 == null) return null;
  const c1 = guess - o1 * 60000;
  const o2 = offsetMinutes(c1, zone);
  if (o2 == null || o2 === o1) return Number.isFinite(c1) ? c1 : null;
  // The offset changed between the guess and the answer: a DST edge. Take the answer whose own offset agrees; when the wall time
  // does not exist (spring forward) neither agrees and the later reading is used, which is the time just after the gap.
  const c2 = guess - o2 * 60000;
  const at = offsetMinutes(c2, zone) === o2 ? c2 : Math.max(c1, c2);
  return Number.isFinite(at) ? at : null;
}

export type Wall = { date: string | null; time: string | null; endTime: string | null; kind: 'appointment' | 'window' | null };
export type Window = { timeWindowEarliest: number | null; timeWindowLatest: number | null; isTimeSensitive: boolean | null };

const isHm = (s: string | null): s is string => s != null && /^\d{1,2}:\d{2}$/.test(s);
const isYmd = (s: string | null): s is string => s != null && /^\d{4}-\d{2}-\d{2}$/.test(s);
const hm = (s: string): string => {
  const [h, m] = s.split(':');
  return `${h!.padStart(2, '0')}:${m}`;
};

/**
 * The appointment as instants. With a zone the printed times are read there; without one, in the phone's zone (the earlier rule).
 *  - timed appointment: earliest = latest = the instant, time-sensitive;
 *  - window with an end: both ends; a window with only a start runs to the end of that day;
 *  - a bare date: the phone's calendar day, open all day.
 */
export function windowFromWall(w: Wall, zone: string | null): Window {
  const none: Window = { timeWindowEarliest: null, timeWindowLatest: null, isTimeSensitive: null };
  // A runtime without Intl zone support falls back to the phone's zone, the earlier behaviour, rather than dropping the time.
  const at = (date: string, time: string): number | null =>
    (zone ? instantInZone(date, hm(time), zone) : null) ?? parseTimed(`${date} ${hm(time)}`);
  if (isYmd(w.date) && isHm(w.time)) {
    const start = at(w.date, w.time);
    if (start == null) return none;
    if (w.kind === 'window') {
      const end = isHm(w.endTime) ? at(w.date, w.endTime) : null;
      if (end != null && end > start) return { timeWindowEarliest: start, timeWindowLatest: end, isTimeSensitive: false };
      const dayEnd = (zone ? instantInZone(w.date, '23:59', zone) : null) ?? parseOpen24h(w.date)?.latest ?? null;
      return { timeWindowEarliest: start, timeWindowLatest: dayEnd != null && dayEnd >= start ? dayEnd : start, isTimeSensitive: false };
    }
    return { timeWindowEarliest: start, timeWindowLatest: start, isTimeSensitive: true };
  }
  if (isYmd(w.date)) {
    const day = parseOpen24h(w.date);
    if (day) return { timeWindowEarliest: day.earliest, timeWindowLatest: day.latest, isTimeSensitive: false };
  }
  return none;
}

const ABBR: Record<string, string> = {
  'America/New_York': 'ET', 'America/Detroit': 'ET', 'America/Indiana/Indianapolis': 'ET', 'America/Kentucky/Louisville': 'ET', 'America/Toronto': 'ET',
  'America/Chicago': 'CT', 'America/Indiana/Knox': 'CT', 'America/Menominee': 'CT', 'America/Winnipeg': 'CT',
  'America/Denver': 'MT', 'America/Boise': 'MT', 'America/Edmonton': 'MT',
  'America/Phoenix': 'MST',
  'America/Los_Angeles': 'PT', 'America/Vancouver': 'PT',
  'America/Anchorage': 'AKT', 'Pacific/Honolulu': 'HST',
};

/** "MT", "CT", "PT", "ET", "MST" (Arizona, no daylight time), or the city of an unlisted zone. */
export function zoneLabel(zone: string | null | undefined): string {
  if (!zone) return '';
  return ABBR[zone] ?? zone.split('/').pop()!.replace(/_/g, ' ');
}

/** A time or date of an instant on the wall clock of `zone` (the phone's zone when null), in the phone's language. */
export function formatInZone(ms: number, zone: string | null, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(undefined, zone ? { ...opts, timeZone: zone } : opts).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat(undefined, opts).format(new Date(ms));
  }
}
