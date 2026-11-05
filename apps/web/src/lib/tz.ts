/**
 * Two clocks, never confused.
 *
 *   CARRIER BASE TIME is the carrier's own zone (`Workspace.timezone`): where a billing day ends, how an invoice ages, which week a driver's statement and weekly limits fall in, what
 *   "this month" means, and the stamp on an audit event. It is one zone for the whole company.
 *
 *   STOP LOCAL TIME is the clock at the physical facility: an appointment window at a dock in Atlanta is Eastern whatever zone the carrier is in. The desk stores instants, so a stop's
 *   zone only decides how its window is read and shown, and it is worked out from the stop's address (its state), never from the carrier.
 *
 * A stop's zone is worked out on the server (src/server/geo/stop-zone.ts: its coordinates, else its state), because the boundary data is too big for the browser. Pure otherwise, so both
 * clocks can be tested; the one piece of state is the reader below, which a server entry registers so a sync formatter can ask "whose clock is this page on".
 */
export const DEFAULT_TZ = "America/Chicago";
export const ZONE_COOKIE = "desk-tz";

/** The zones a carrier can choose. The label is what the Settings control and the clock suffix say. */
export const CARRIER_ZONES = [
  { id: "America/New_York", name: "Eastern", abbr: "ET" },
  { id: "America/Chicago", name: "Central", abbr: "CT" },
  { id: "America/Denver", name: "Mountain", abbr: "MT" },
  { id: "America/Phoenix", name: "Mountain, Arizona (no daylight time)", abbr: "MST" },
  { id: "America/Los_Angeles", name: "Pacific", abbr: "PT" },
  { id: "America/Anchorage", name: "Alaska", abbr: "AKT" },
  { id: "Pacific/Honolulu", name: "Hawaii", abbr: "HST" }
] as const;

export const isCarrierZone = (v: unknown): v is string => typeof v === "string" && CARRIER_ZONES.some((z) => z.id === v);
/** A valid carrier zone, or the default: a stored or cookie value is never trusted to be one. */
export const asZone = (v: unknown): string => (isCarrierZone(v) ? v : DEFAULT_TZ);

/** "ET", "CT", "MT", "PT": the suffix on a time. Any other IANA zone (a stop in Canada) gets its own city's name rather than a guess. */
export function zoneAbbr(zone: string | null | undefined): string {
  const z = CARRIER_ZONES.find((c) => c.id === zone);
  if (z) return z.abbr;
  const extra: Record<string, string> = { "America/Detroit": "ET", "America/Indiana/Indianapolis": "ET", "America/Kentucky/Louisville": "ET", "America/Toronto": "ET", "America/Indiana/Knox": "CT", "America/Menominee": "CT", "America/Winnipeg": "CT", "America/Boise": "MT", "America/Edmonton": "MT", "America/Vancouver": "PT" };
  if (zone && extra[zone]) return extra[zone]!;
  return zone ? zone.split("/").pop()!.replace(/_/g, " ") : "";
}

// ── whose clock a page is on ─────────────────────────────────────────────────────────────────────────────────────

let reader: (() => string | null | undefined) | null = null;

/** The server registers how to read the request's zone (a cookie set from the workspace at sign-in and when Settings changes it). The browser needs nothing: it reads its own cookie. */
export function registerZoneReader(fn: () => string | null | undefined): void {
  reader = fn;
}

/**
 * The carrier's zone as this request or page sees it, for showing a time. It is a display setting: anything that counts money or days on the server (aging, a month's totals, a statement
 * week) asks the workspace row for its zone instead of trusting a cookie. A missing or invalid value is the default.
 */
export function activeTz(): string {
  try {
    if (reader) {
      const v = reader();
      if (v) return asZone(v);
    }
  } catch {
    /* outside a request (a script, a test): the default */
  }
  if (typeof document !== "undefined") {
    const m = new RegExp(`(?:^|; )${ZONE_COOKIE}=([^;]*)`).exec(document.cookie);
    if (m) return asZone(decodeURIComponent(m[1]!));
  }
  return DEFAULT_TZ;
}

/** "Eastern time", "Central time": what a form says its times are, so nobody types a Boston appointment thinking it is Dallas. */
export function clockName(tz: string = activeTz()): string {
  const names: Record<string, string> = { "America/New_York": "Eastern", "America/Chicago": "Central", "America/Denver": "Mountain", "America/Phoenix": "Arizona", "America/Los_Angeles": "Pacific", "America/Anchorage": "Alaska", "Pacific/Honolulu": "Hawaii" };
  return `${names[tz] ?? zoneAbbr(tz)} time`;
}
