/**
 * Data health: how complete the desk's own records are, and where two sources that should agree do not. Pure: it takes plain rows and returns counts, scores and the items behind each gap.
 *
 * Nothing here estimates. A check is either answered by what is stored or it is not checked, and a figure that cannot be told is counted as "not checked", never as a pass. Every cross-source check says what it
 * compares and on what basis, and the one that cannot be done from stored data says so.
 */

// ── Completeness ─────────────────────────────────────────────────────────────────────────────────

export type HealthLoad = {
  id: string;
  loadNumber: string | null;
  /** "completed" or "tonu": the loads that finished and earned. */
  status: string;
  completedAt: number | null;
  broker: string | null;
  origin: string | null;
  destination: string | null;
  loadedMiles: number;
  quotedRevenue: number;
  actualRevenue: number | null;
  vehicleId: string | null;
  truck: string | null;
  /** A driver is on it, and the pay on that assignment is a figure. */
  hasDriver: boolean;
  driverPay: boolean;
  marketBenchmark: number | null;
  /** The truck's break-even floor frozen when the load was accepted. */
  floor: number | null;
  stops: number;
  stopsWithArrival: number;
  /** A proof of delivery file, or a typed note saying what it is. */
  hasPod: boolean;
  /** Closed without a proof of delivery on purpose (the reason is on the load). */
  podWaived: boolean;
  hasRateCon: boolean;
  expenseFuel: number;
  /** What the fuel card says was bought for this load (null when no purchase is tied to it) and the gallons. */
  cardFuel: number | null;
  cardGallons: number | null;
  paymentStatus: string | null;
  invoicedAmount: number | null;
  /** What the rate confirmation promised: the rate plus the fuel surcharge. */
  rateTotal: number;
  /** The invoice's own lines, when it kept them. */
  invoiceLines: Array<{ label: string; amount: number }> | null;
};

export type HealthTruck = { id: string; name: string; hasProfile: boolean; hasBase: boolean; hasMpg: boolean };
export type HealthDriver = { id: string; name: string; hasCdlDate: boolean; hasMedicalDate: boolean; hasPhone: boolean };
export type HealthTrailer = { id: string; number: string; hasRegistration: boolean; hasInspection: boolean };

export type ModuleKey = "loads" | "stops" | "trucks" | "drivers" | "trailers";
export type CheckDef<T> = { key: string; module: ModuleKey; label: string; /** What a gap costs, in a sentence. */ why: string; applies: (x: T) => boolean; pass: (x: T) => boolean };

const done = (l: HealthLoad) => l.status === "completed";

export const LOAD_CHECKS: Array<CheckDef<HealthLoad>> = [
  { key: "customer", module: "loads", label: "Customer named", why: "Customer scorecards, slow-pay and SLA cannot count a load with no customer.", applies: () => true, pass: (l) => !!l.broker?.trim() },
  { key: "lane", module: "loads", label: "Pickup and delivery places", why: "A load with no lane is on no lane scorecard and cannot be compared with its market.", applies: () => true, pass: (l) => !!l.origin?.trim() && !!l.destination?.trim() },
  { key: "finished", module: "loads", label: "Finish time", why: "A load with no finish time falls into the wrong week of every figure.", applies: () => true, pass: (l) => l.completedAt != null },
  { key: "miles", module: "loads", label: "Loaded miles", why: "Per-mile figures, empty-mile share and the floor check all divide by miles.", applies: done, pass: (l) => l.loadedMiles > 0 },
  { key: "revenue", module: "loads", label: "Revenue", why: "No revenue, no gross, no per-mile and no invoice.", applies: () => true, pass: (l) => (l.actualRevenue ?? l.quotedRevenue) > 0 },
  { key: "truck", module: "loads", label: "Truck on it", why: "Truck and trailer figures, the floor and empty miles by truck need a truck.", applies: done, pass: (l) => l.vehicleId != null },
  { key: "driver", module: "loads", label: "Driver on it", why: "Driver scorecards and pay need the driver.", applies: done, pass: (l) => l.hasDriver },
  { key: "pay", module: "loads", label: "Driver pay figure", why: "Without the pay the load cannot be settled or its profit worked out.", applies: (l) => done(l) && l.hasDriver, pass: (l) => l.driverPay },
  { key: "market", module: "loads", label: "Market rate", why: "Without a market rate the load cannot be judged above or below the market.", applies: done, pass: (l) => l.marketBenchmark != null },
  { key: "floor", module: "loads", label: "Floor frozen at accept", why: "The leak ledger prices empty miles and paid-under-floor at this floor; without it they are counted and left unpriced.", applies: done, pass: (l) => l.floor != null },
  { key: "pod", module: "loads", label: "Proof of delivery", why: "A delivery with no proof is hard to bill and hard to defend.", applies: done, pass: (l) => l.hasPod || l.podWaived },
  { key: "fuel", module: "loads", label: "Fuel recorded", why: "A load with miles and no fuel overstates its profit.", applies: (l) => done(l) && l.loadedMiles > 0, pass: (l) => l.expenseFuel > 0 || (l.cardFuel ?? 0) > 0 },
  { key: "ratecon", module: "loads", label: "Rate confirmation on file", why: "The invoice cannot be checked against what was promised.", applies: done, pass: (l) => l.hasRateCon }
];

/** Stops: every stop of a finished load carries its arrival, which the on-time and wait figures need. */
export const STOP_CHECK: CheckDef<HealthLoad> = { key: "arrivals", module: "stops", label: "Arrival time on every stop", why: "On-time pickup and delivery, waits and detention are read from stop arrivals.", applies: (l) => done(l) && l.stops > 0, pass: (l) => l.stopsWithArrival >= l.stops };

export const TRUCK_CHECKS: Array<CheckDef<HealthTruck>> = [
  { key: "profile", module: "trucks", label: "Cost profile", why: "A truck with no cost profile has no floor, so no verdict.", applies: () => true, pass: (t) => t.hasProfile },
  { key: "base", module: "trucks", label: "Home base", why: "Without a base the truck cannot be ranked by distance on Quote.", applies: () => true, pass: (t) => t.hasBase },
  { key: "mpg", module: "trucks", label: "Miles per gallon", why: "Fuel cost per mile and the fuel check use it.", applies: () => true, pass: (t) => t.hasMpg }
];
export const DRIVER_CHECKS: Array<CheckDef<HealthDriver>> = [
  { key: "cdl", module: "drivers", label: "CDL expiry", why: "The desk cannot stop a lapsed licence it does not know about.", applies: () => true, pass: (d) => d.hasCdlDate },
  { key: "medical", module: "drivers", label: "Medical card expiry", why: "The desk cannot stop a lapsed medical card it does not know about.", applies: () => true, pass: (d) => d.hasMedicalDate },
  { key: "phone", module: "drivers", label: "Phone", why: "Messages and the driver link need a phone.", applies: () => true, pass: (d) => d.hasPhone }
];
export const TRAILER_CHECKS: Array<CheckDef<HealthTrailer>> = [
  { key: "registration", module: "trailers", label: "Registration expiry", why: "A trailer with no registration date is never flagged when it lapses.", applies: () => true, pass: (t) => t.hasRegistration },
  { key: "inspection", module: "trailers", label: "Inspection expiry", why: "A trailer with no inspection date is never flagged when it lapses.", applies: () => true, pass: (t) => t.hasInspection }
];

export const MODULES: Array<{ key: ModuleKey; label: string; /** How much of the headline score the module carries. */ weight: number }> = [
  { key: "loads", label: "Loads", weight: 0.4 },
  { key: "stops", label: "Stops", weight: 0.15 },
  { key: "trucks", label: "Trucks", weight: 0.15 },
  { key: "drivers", label: "Drivers", weight: 0.15 },
  { key: "trailers", label: "Trailers", weight: 0.15 }
];

export type GapItem = { id: string; label: string };
export type CheckResult = { key: string; module: ModuleKey; label: string; why: string; /** Items the check applied to, and how many passed. */ checked: number; passed: number; gaps: number; /** A few of the items that failed, for the list. */ examples: GapItem[] };
export type ModuleResult = { key: ModuleKey; label: string; checked: number; passed: number; /** 0 to 1, or null when nothing was checked. */ score: number | null };
export type Completeness = { modules: ModuleResult[]; checks: CheckResult[]; /** The headline: the modules' scores weighted, over the modules that have anything to check. Null when nothing was checked. */ score: number | null };

/** How many failing items are named under each check. */
export const EXAMPLES = 8;

function run<T>(defs: Array<CheckDef<T>>, items: readonly T[], name: (x: T) => GapItem): CheckResult[] {
  return defs.map((d) => {
    const applicable = items.filter(d.applies);
    const failed = applicable.filter((x) => !d.pass(x));
    return { key: d.key, module: d.module, label: d.label, why: d.why, checked: applicable.length, passed: applicable.length - failed.length, gaps: failed.length, examples: failed.slice(0, EXAMPLES).map(name) };
  });
}

export function completeness(i: { loads: readonly HealthLoad[]; trucks: readonly HealthTruck[]; drivers: readonly HealthDriver[]; trailers: readonly HealthTrailer[] }): Completeness {
  const checks = [
    ...run(LOAD_CHECKS, i.loads, (l) => ({ id: l.id, label: l.loadNumber ?? "Load" })),
    ...run([STOP_CHECK], i.loads, (l) => ({ id: l.id, label: l.loadNumber ?? "Load" })),
    ...run(TRUCK_CHECKS, i.trucks, (t) => ({ id: t.id, label: t.name })),
    ...run(DRIVER_CHECKS, i.drivers, (d) => ({ id: d.id, label: d.name })),
    ...run(TRAILER_CHECKS, i.trailers, (t) => ({ id: t.id, label: t.number }))
  ];
  const modules: ModuleResult[] = MODULES.map((m) => {
    const mine = checks.filter((c) => c.module === m.key);
    const checked = mine.reduce((s, c) => s + c.checked, 0);
    const passed = mine.reduce((s, c) => s + c.passed, 0);
    return { key: m.key, label: m.label, checked, passed, score: checked > 0 ? passed / checked : null };
  });
  const counted = MODULES.filter((m) => modules.find((x) => x.key === m.key)!.score != null);
  const weight = counted.reduce((s, m) => s + m.weight, 0);
  const score = weight > 0 ? counted.reduce((s, m) => s + modules.find((x) => x.key === m.key)!.score! * m.weight, 0) / weight : null;
  return { modules, checks, score };
}

/** The headline as a word, for the page and the report: the score is the share of checked fields that are filled in. */
export function gradeOf(score: number | null): { word: string; tone: "ok" | "warn" | "bad" | "muted" } {
  if (score == null) return { word: "Nothing checked yet", tone: "muted" };
  if (score >= 0.9) return { word: "Ready for a read", tone: "ok" };
  if (score >= 0.7) return { word: "Mostly there", tone: "warn" };
  return { word: "Needs work first", tone: "bad" };
}

// ── Cross-source checks ──────────────────────────────────────────────────────────────────────────

const cents = (n: number) => Math.round(n * 100) / 100;

export type FuelCheck = {
  /** Loads with a card purchase tied to them. */
  withCard: number;
  /** Both a card total and a fuel figure on the load, and the two within the tolerance. */
  matched: number;
  /** Both present and apart by more than the tolerance. */
  off: number;
  /** Dollars the off loads are apart by (the card minus the load's own figure, absolute, summed). */
  offDollars: number;
  /** A card purchase, and nothing recorded as fuel on the load. */
  cardOnly: number;
  cardOnlyDollars: number;
  /** Fuel recorded on the load, no card purchase tied to it, while the desk does have card data. */
  loadOnly: number;
  hasCardData: boolean;
  worst: Array<{ id: string; label: string; card: number; load: number; diff: number }>;
};

/** The card and the load may differ by this much before it is called off: the larger of $25 and a tenth of the load's own figure. */
export const FUEL_TOLERANCE = { dollars: 25, share: 0.1 };

export function fuelCheck(loads: readonly HealthLoad[], hasCardData: boolean): FuelCheck {
  let matched = 0;
  let off = 0;
  let offDollars = 0;
  let cardOnly = 0;
  let cardOnlyDollars = 0;
  let loadOnly = 0;
  let withCard = 0;
  const worst: FuelCheck["worst"] = [];
  for (const l of loads) {
    const card = l.cardFuel;
    if (card != null && card > 0) {
      withCard += 1;
      if (l.expenseFuel > 0) {
        const diff = cents(card - l.expenseFuel);
        const tol = Math.max(FUEL_TOLERANCE.dollars, l.expenseFuel * FUEL_TOLERANCE.share);
        if (Math.abs(diff) <= tol) matched += 1;
        else {
          off += 1;
          offDollars += Math.abs(diff);
          worst.push({ id: l.id, label: l.loadNumber ?? "Load", card, load: l.expenseFuel, diff });
        }
      } else {
        cardOnly += 1;
        cardOnlyDollars += card;
      }
    } else if (hasCardData && l.expenseFuel > 0) loadOnly += 1;
  }
  worst.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  return { withCard, matched, off, offDollars: cents(offDollars), cardOnly, cardOnlyDollars: cents(cardOnlyDollars), loadOnly, hasCardData, worst: worst.slice(0, EXAMPLES) };
}

export type RateConCheck = {
  /** Invoiced or paid loads. */
  invoiced: number;
  /** Of those, with a rate confirmation on file (the ones that can be checked). */
  checkable: number;
  /** Billed the rate and surcharge it promised, to the dollar. */
  matched: number;
  /** Billed less than the rate confirmation promised. */
  under: number;
  underDollars: number;
  /** Billed more than the rate and surcharge (an extra the invoice does not name, or a wrong rate). */
  over: number;
  overDollars: number;
  /** Invoiced, but no rate confirmation on file, so there is nothing to check against. */
  unchecked: number;
  worst: Array<{ id: string; label: string; promised: number; billed: number; diff: number }>;
};

/** What the invoice billed for the rate and the surcharge: its Line haul, TONU and Fuel surcharge lines when it kept lines (a detention, lumper or layover line is an extra), else the whole amount. */
export function billedBase(l: Pick<HealthLoad, "invoicedAmount" | "invoiceLines">): number | null {
  if (l.invoicedAmount == null) return null;
  if (!l.invoiceLines || l.invoiceLines.length === 0) return l.invoicedAmount;
  const base = l.invoiceLines.filter((x) => x.label === "Line haul" || x.label === "TONU fee" || x.label === "Fuel surcharge");
  return base.length > 0 ? cents(base.reduce((s, x) => s + x.amount, 0)) : l.invoicedAmount;
}

export function rateConCheck(loads: readonly HealthLoad[]): RateConCheck {
  const out: RateConCheck = { invoiced: 0, checkable: 0, matched: 0, under: 0, underDollars: 0, over: 0, overDollars: 0, unchecked: 0, worst: [] };
  for (const l of loads) {
    if (l.paymentStatus !== "invoiced" && l.paymentStatus !== "paid") continue;
    out.invoiced += 1;
    if (!l.hasRateCon || l.status !== "completed") {
      out.unchecked += 1;
      continue;
    }
    const billed = billedBase(l);
    if (billed == null) {
      out.unchecked += 1;
      continue;
    }
    out.checkable += 1;
    const diff = cents(billed - l.rateTotal);
    if (Math.abs(diff) <= 1) out.matched += 1;
    else {
      if (diff < 0) {
        out.under += 1;
        out.underDollars += -diff;
      } else {
        out.over += 1;
        out.overDollars += diff;
      }
      out.worst.push({ id: l.id, label: l.loadNumber ?? "Load", promised: l.rateTotal, billed, diff });
    }
  }
  out.underDollars = cents(out.underDollars);
  out.overDollars = cents(out.overDollars);
  out.worst.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  out.worst = out.worst.slice(0, EXAMPLES);
  return out;
}

// ── Position pings against billed miles (the last week only) ─────────────────────────────────────

export type PingPoint = { lat: number; lng: number; at: number };
export type PingTrip = { id: string; label: string; loadedMiles: number; points: PingPoint[] };

const R_MILES = 3958.8;
const rad = (d: number) => (d * Math.PI) / 180;
/** Straight-line miles between two points. */
export function haversine(a: Pick<PingPoint, "lat" | "lng">, b: Pick<PingPoint, "lat" | "lng">): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The miles along a run of pings, point to point in time order. A straight line between fixes: it can only fall short of the road, never exceed it by much. */
export function pingMiles(points: readonly PingPoint[]): number {
  const sorted = [...points].sort((a, b) => a.at - b.at);
  let total = 0;
  for (let i = 1; i < sorted.length; i++) total += haversine(sorted[i - 1]!, sorted[i]!);
  return total;
}

export type PingCheck = {
  /** Finished loads of the last week with a truck, and how many of those had enough pings to measure. */
  trips: number;
  measured: number;
  /** Within the band of the billed loaded miles. */
  agreed: number;
  /** Outside it: the pings say the truck drove well less or well more than was billed. */
  apart: number;
  worst: Array<{ id: string; label: string; billed: number; pings: number; share: number }>;
};

/** Pings are a straight line between fixes, so the road is a little longer: a trip is called apart only when the pings fall under 70% or over 130% of the billed loaded miles. Fewer than 6 pings is not enough to say. */
export const PING_BAND = { low: 0.7, high: 1.3, minPoints: 6 };

export function pingCheck(trips: readonly PingTrip[]): PingCheck {
  let measured = 0;
  let agreed = 0;
  const apart: PingCheck["worst"] = [];
  for (const t of trips) {
    if (t.points.length < PING_BAND.minPoints || !(t.loadedMiles > 0)) continue;
    measured += 1;
    const miles = pingMiles(t.points);
    const share = miles / t.loadedMiles;
    if (share >= PING_BAND.low && share <= PING_BAND.high) agreed += 1;
    else apart.push({ id: t.id, label: t.label, billed: t.loadedMiles, pings: cents(miles), share });
  }
  apart.sort((a, b) => Math.abs(1 - b.share) - Math.abs(1 - a.share));
  return { trips: trips.length, measured, agreed, apart: apart.length, worst: apart.slice(0, EXAMPLES) };
}

export type DataHealth = {
  completeness: Completeness;
  fuel: FuelCheck;
  rateCon: RateConCheck;
  pings: PingCheck;
  /** What the checks read: the finished loads of the window, the units in the terminals in view. */
  counts: { loads: number; trucks: number; drivers: number; trailers: number };
};

export function buildDataHealth(i: { loads: readonly HealthLoad[]; trucks: readonly HealthTruck[]; drivers: readonly HealthDriver[]; trailers: readonly HealthTrailer[]; hasCardData: boolean; trips: readonly PingTrip[] }): DataHealth {
  return {
    completeness: completeness(i),
    fuel: fuelCheck(i.loads, i.hasCardData),
    rateCon: rateConCheck(i.loads),
    pings: pingCheck(i.trips),
    counts: { loads: i.loads.length, trucks: i.trucks.length, drivers: i.drivers.length, trailers: i.trailers.length }
  };
}
