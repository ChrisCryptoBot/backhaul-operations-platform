/**
 * The partner shelf on a load: one card per vertical, saying only what is true. A card never says "connected", "synced" or "verified" unless the fleet really connected that company
 * and the desk really holds the figure; with nothing connected (today, for every fleet) each card says so and says what the dispatcher does by hand instead. A vertical the desk does not
 * build yet (fuel tax by state, insurance records) says "not built yet". Pure, so the words can be tested.
 */
export type ShelfCapability = "factoring" | "eld" | "fuel_card" | "tracking" | "payroll" | "vetting" | "ifta";
export const SHELF_CAPABILITIES: readonly ShelfCapability[] = ["factoring", "eld", "fuel_card", "tracking", "payroll", "vetting", "ifta"];

export type ShelfTone = "ok" | "warn" | "bad" | "muted";
export type ShelfCard = { key: ShelfCapability | "insurance"; title: string; tagline: string; chip: string; tone: ShelfTone; line: string; /** What the dispatcher does by hand until it is connected. */ byHand: string | null };

export type ShelfInput = {
  /** Which capabilities the fleet has connected (a company chosen, its keys on the server, and the connection made). */
  connected: Partial<Record<ShelfCapability, boolean>>;
  factoringStatus: string;
  docKinds: string[];
  driverName: string | null;
  /** Hours left as the ELD last said, and when (already formatted), or null when never synced. */
  hosHours: number | null;
  hosSyncedAt: string | null;
  vetStatus: string | null;
  coiExpiresAt: string | null;
  onStatement: boolean;
  totalMiles: number;
};

const FACTORING_TONE: Record<string, ShelfTone> = { requested: "warn", submitted: "warn", funded: "ok", paid: "ok", rejected: "bad" };
const VET_TONE: Record<string, ShelfTone> = { clear: "ok", review: "warn", failed: "bad" };
const upper = (s: string) => s.replace(/_/g, " ").toUpperCase();

export function shelfFor(i: ShelfInput): ShelfCard[] {
  const on = (c: ShelfCapability) => i.connected[c] === true;
  const hasRateCon = i.docKinds.includes("rate_con");
  const hasPod = i.docKinds.includes("pod");
  const missing = [hasRateCon ? null : "rate confirmation", hasPod ? null : "proof of delivery"].filter((x): x is string => x != null);
  const who = i.driverName;

  return [
    {
      key: "factoring",
      title: "Factoring",
      tagline: "At the invoice, when cash matters most.",
      chip: i.factoringStatus === "none" ? "NOT SENT" : upper(i.factoringStatus),
      tone: FACTORING_TONE[i.factoringStatus] ?? "muted",
      line: missing.length === 0 ? "Rate confirmation and proof of delivery are on file." : `Missing: ${missing.join(" and ")}.`,
      byHand: on("factoring") ? null : "Not connected: each step is marked by hand."
    },
    {
      key: "eld",
      title: "ELD and telematics",
      tagline: "On the quote, where the hours decide the load.",
      chip: !on("eld") ? "NOT CONNECTED" : i.hosHours != null ? "HOURS KNOWN" : "NO HOURS YET",
      tone: !on("eld") ? "muted" : i.hosHours != null ? "ok" : "muted",
      line: on("eld") && i.hosHours != null ? `${who ?? "The driver"}: ${i.hosHours} h left${i.hosSyncedAt ? `, as of ${i.hosSyncedAt}` : ""}.` : "Hours left are not known.",
      byHand: on("eld") ? null : "Not connected: the hours caution on a quote does not appear."
    },
    {
      key: "fuel_card",
      title: "Fuel cards",
      tagline: "On the trip, where the spend happens.",
      chip: on("fuel_card") ? "CONNECTED" : "NOT CONNECTED",
      tone: on("fuel_card") ? "ok" : "muted",
      line: on("fuel_card") ? "Fuel purchases can be imported on the trip." : "Fuel for this trip is typed in.",
      byHand: on("fuel_card") ? null : "Not connected: type the fuel cost on the trip."
    },
    {
      key: "tracking",
      title: "Load tracking",
      tagline: "On the shipment, in front of the customer.",
      chip: on("tracking") ? "CONNECTED" : "NOT CONNECTED",
      tone: on("tracking") ? "ok" : "muted",
      line: "No position is shared on this load.",
      byHand: on("tracking") ? null : "Not connected: give the customer an ETA by phone or message."
    },
    {
      key: "payroll",
      title: "Payroll",
      tagline: "At the statement, every week.",
      chip: i.onStatement ? "ON A STATEMENT" : who ? "NOT ON A STATEMENT" : "NO DRIVER",
      tone: i.onStatement ? "ok" : "muted",
      line: i.onStatement ? "Counted in a driver statement." : who ? `Pay for ${who} is worked out when the load is settled.` : "Driver pay is worked out once a driver is assigned.",
      byHand: on("payroll") ? null : "Not connected: statements are paid by hand."
    },
    {
      key: "vetting",
      title: "Carrier vetting",
      tagline: "Before the load goes out.",
      chip: who == null ? "NO DRIVER" : i.vetStatus ? upper(i.vetStatus) : "NOT CHECKED",
      tone: who == null || !i.vetStatus ? "muted" : (VET_TONE[i.vetStatus] ?? "muted"),
      line: who == null ? "No driver on this load." : i.vetStatus ? `Insurance and authority: ${i.vetStatus}${i.coiExpiresAt ? `, certificate runs to ${i.coiExpiresAt}` : ""}.` : `${who} has not been checked.`,
      byHand: on("vetting") ? null : "Not connected: use the FMCSA lookup on the driver's page."
    },
    {
      key: "ifta",
      title: "Fuel tax (IFTA)",
      tagline: "At the quarter, from the same miles.",
      chip: "NOT BUILT YET",
      tone: "muted",
      line: `${Math.round(i.totalMiles).toLocaleString("en-US")} mi on this load. The split by state is not kept yet.`,
      byHand: null
    },
    {
      key: "insurance",
      title: "Insurance",
      tagline: "The moment a truck or a load needs cover.",
      chip: "NOT BUILT YET",
      tone: "muted",
      line: "Policies and certificates are not kept yet.",
      byHand: null
    }
  ];
}

/** "0 of 7 partner connections made", counted over the seven capabilities that can be connected. */
export function shelfHeader(connected: Partial<Record<ShelfCapability, boolean>>): string {
  const n = SHELF_CAPABILITIES.filter((c) => connected[c] === true).length;
  return `${n} of ${SHELF_CAPABILITIES.length} partner connections made`;
}
