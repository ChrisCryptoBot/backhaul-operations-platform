import { computeOnTime } from "@/truelane/lib/domain/onTime";

/**
 * How a driver has done on the loads they delivered: arriving inside the window (the phone's own rule: up to an hour early and half an hour
 * late still count as on time), how much of their driving was empty, what they are owed, and how often the customer paid less than the invoice.
 * Pure: it is given the driver's delivered loads and returns numbers. A stop with no arrival entered is not scored, except the last, whose
 * arrival is taken from the time the load was delivered.
 */
export type ScoreStop = { earliest: Date | null; latest: Date | null; arrivedAt: Date | null };

export type ScoreLoad = {
  id: string;
  loadNumber: string | null;
  lane: string;
  completedAt: Date | null;
  /** In order, first stop first. */
  stops: ScoreStop[];
  loadedMiles: number;
  pickupDeadheadMiles: number;
  returnDeadheadMiles: number;
  /** A load covers the way home, so the return counts as no empty miles. */
  isBackhaul: boolean;
  payEstimate: number | null;
  invoicedAmount: number | null;
  paidAmount: number | null;
  paymentStatus: string | null;
};

export type LoadScore = {
  id: string;
  loadNumber: string | null;
  lane: string;
  completedAt: Date | null;
  stopsScored: number;
  stopsOnTime: number;
  /** The most minutes late any stop arrived (after the window closed), or null when none was late. */
  worstLateMinutes: number | null;
  emptyMiles: number;
  totalMiles: number;
  pay: number;
  /** Dollars the customer paid below the invoice, 0 when it paid in full or has not paid. */
  shortBy: number;
};

export type DriverScorecard = {
  loads: number;
  onTime: { scored: number; onTime: number; rate: number | null };
  worstLateMinutes: number | null;
  empty: { miles: number; total: number; share: number | null };
  pay: number;
  shortPaid: { loads: number; dollars: number };
  perLoad: LoadScore[];
};

const cents = (n: number) => Math.round(n * 100) / 100;

export function scoreLoad(l: ScoreLoad): LoadScore {
  let scored = 0;
  let onTime = 0;
  let worst: number | null = null;
  l.stops.forEach((s, i) => {
    const arrival = s.arrivedAt ?? (i === l.stops.length - 1 ? l.completedAt : null);
    const r = computeOnTime({ arrivedAtMs: arrival?.getTime() ?? null, windowEarliestMs: s.earliest?.getTime() ?? null, windowLatestMs: s.latest?.getTime() ?? null });
    if (!r.scored) return;
    scored += 1;
    if (r.onTime) onTime += 1;
    if (r.deltaMinutes != null && r.deltaMinutes > 0 && !r.onTime) worst = Math.max(worst ?? 0, Math.round(r.deltaMinutes));
  });
  const empty = l.pickupDeadheadMiles + (l.isBackhaul ? 0 : l.returnDeadheadMiles);
  const short = l.paymentStatus === "paid" && l.paidAmount != null && l.invoicedAmount != null && l.paidAmount < l.invoicedAmount - 0.005 ? cents(l.invoicedAmount - l.paidAmount) : 0;
  return { id: l.id, loadNumber: l.loadNumber, lane: l.lane, completedAt: l.completedAt, stopsScored: scored, stopsOnTime: onTime, worstLateMinutes: worst, emptyMiles: empty, totalMiles: empty + l.loadedMiles, pay: l.payEstimate ?? 0, shortBy: short };
}

export function driverScorecard(loads: ScoreLoad[]): DriverScorecard {
  const perLoad = loads.map(scoreLoad);
  const scored = perLoad.reduce((s, l) => s + l.stopsScored, 0);
  const onTime = perLoad.reduce((s, l) => s + l.stopsOnTime, 0);
  const emptyMiles = perLoad.reduce((s, l) => s + l.emptyMiles, 0);
  const total = perLoad.reduce((s, l) => s + l.totalMiles, 0);
  const lates = perLoad.map((l) => l.worstLateMinutes).filter((m): m is number => m != null);
  const short = perLoad.filter((l) => l.shortBy > 0);
  return {
    loads: loads.length,
    onTime: { scored, onTime, rate: scored > 0 ? onTime / scored : null },
    worstLateMinutes: lates.length > 0 ? Math.max(...lates) : null,
    empty: { miles: emptyMiles, total, share: total > 0 ? emptyMiles / total : null },
    pay: cents(perLoad.reduce((s, l) => s + l.pay, 0)),
    shortPaid: { loads: short.length, dollars: cents(short.reduce((s, l) => s + l.shortBy, 0)) },
    perLoad
  };
}
