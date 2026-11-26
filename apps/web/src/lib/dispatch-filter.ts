/**
 * The Dispatch queue's filters, read from the address (so they survive a refresh and a trip to another page and back): a search, the pickup day on the carrier's clock, a state inside
 * Needs a driver, and the equipment. Pure.
 */
export type QueueDay = "overdue" | "today" | "tomorrow";
export type QueueState = "no_driver" | "ready_to_send" | "declined" | "recalled";
export type QueueFilter = { q: string; day: QueueDay | null; state: QueueState | null; eq: string | null };

const DAYS: readonly QueueDay[] = ["overdue", "today", "tomorrow"];
const STATES: readonly QueueState[] = ["no_driver", "ready_to_send", "declined", "recalled"];

export function readQueueFilter(p: { q?: string; day?: string; state?: string; eq?: string } | undefined): QueueFilter {
  return {
    q: (p?.q ?? "").trim().slice(0, 60),
    day: DAYS.includes(p?.day as QueueDay) ? (p!.day as QueueDay) : null,
    state: STATES.includes(p?.state as QueueState) ? (p!.state as QueueState) : null,
    eq: p?.eq?.trim() ? p.eq.trim().slice(0, 40) : null
  };
}

export const isFiltered = (f: QueueFilter) => f.q !== "" || f.day != null || f.state != null || f.eq != null;

/** The filters as address fields, blank ones left out, for links that must keep them (Show more). */
export function filterParams(f: QueueFilter): Record<string, string> {
  return { ...(f.q ? { q: f.q } : {}), ...(f.day ? { day: f.day } : {}), ...(f.state ? { state: f.state } : {}), ...(f.eq ? { eq: f.eq } : {}) };
}

type Row = {
  loadNumber: string | null;
  poNumber: string | null;
  bolNumber: string | null;
  rateConNumber: string | null;
  proNumber: string | null;
  brokerName: string | null;
  origin: string | null;
  destination: string | null;
  driverName: string | null;
  equipment: string | null;
  pickupAt: Date | null;
  scheduledDate: Date | null;
  status: string;
};

/**
 * Whether a row passes the search, the day and the equipment (the Needs state is applied to that column alone). `keyOf` turns a time into the carrier's date key; `today` and `tomorrow`
 * are those keys for now. Overdue is a pickup whose time has passed on a load not yet on the road.
 */
export function passes(r: Row, f: QueueFilter, now: number, keyOf: (ms: number) => string, today: string, tomorrow: string): boolean {
  if (f.q) {
    const needle = f.q.toLowerCase();
    const hay = [r.loadNumber, r.poNumber, r.bolNumber, r.rateConNumber, r.proNumber, r.brokerName, r.origin, r.destination, r.driverName];
    if (!hay.some((v) => v != null && v.toLowerCase().includes(needle))) return false;
  }
  if (f.eq && r.equipment !== f.eq) return false;
  if (f.day) {
    const at = (r.pickupAt ?? r.scheduledDate)?.getTime() ?? null;
    if (at == null) return false;
    if (f.day === "overdue") return at < now && r.status !== "in_progress";
    return keyOf(at) === (f.day === "today" ? today : tomorrow);
  }
  return true;
}
