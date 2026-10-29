/**
 * Projects a dispatcher's load into the driver-safe `load_summary` of TrueLane's bridge contract (v2.2).
 * Pure: no database, no network. The driver sees where to go, when, the numbers the dock will ask for, and
 * how they are paid. They never see the broker's rate, the gross, the margin, any cost figure or the rate
 * confirmation. `assertDriverSafe` is the merge gate that fails if any of that leaks.
 *
 * Contract: TRUELANE/docs/parked/EXTERNAL_DISPATCH_CONTRACT.md section 5; plan: docs/CONVERGENCE_BUILD_PLAN.md.
 */
export type PayKind = "flat" | "cpm" | "hourly";
export type AssignmentPay = { kind: PayKind; rate: number };

export type ProjectableStop = {
  stopSequence: number;
  stopType: string;
  stopRole?: string | null;
  addressString: string;
  lat?: number | null;
  lng?: number | null;
  timeWindowEarliest?: Date | null;
  timeWindowLatest?: Date | null;
  referenceNumbers?: unknown;
  facilityName?: string | null;
  stopNotes?: string | null;
};

export type ProjectableLoad = {
  loadNumber?: string | null;
  poNumber?: string | null;
  brokerName?: string | null;
  trailerType?: string | null;
  originAddress?: string | null;
  destinationAddress?: string | null;
  loadedMiles: number;
  estimatedHours?: number | null;
  stops: ProjectableStop[];
};

export type LoadSummary = {
  schema: 3;
  origin: { address: string; lat?: number; lng?: number; window_earliest?: string; window_latest?: string } | null;
  destination: { address: string; lat?: number; lng?: number; window_earliest?: string; window_latest?: string } | null;
  stops: Array<{
    seq: number;
    type: "pickup" | "delivery";
    address: string;
    lat?: number;
    lng?: number;
    window_earliest?: string;
    window_latest?: string;
    po_number?: string;
    dock_notes?: string;
  }>;
  equipment: { trailer_type: string | null };
  driver_pay: { kind: PayKind; rate: number; estimate: number };
  reference: { broker_name?: string; load_number?: string };
  miles?: { loaded: number };
};

/** Display-only estimate, as the contract defines it: flat = rate, cpm = rate x loaded miles, hourly = rate x est. hours. */
export function payEstimate(pay: AssignmentPay, loadedMiles: number, estimatedHours: number | null | undefined): number {
  const raw = pay.kind === "flat" ? pay.rate : pay.kind === "cpm" ? pay.rate * loadedMiles : pay.rate * (estimatedHours ?? 0);
  return Math.round(raw * 100) / 100;
}

const iso = (d?: Date | null) => (d ? d.toISOString() : undefined);
const role = (s: ProjectableStop): "pickup" | "delivery" =>
  (s.stopRole ?? s.stopType) === "pickup" || s.stopType === "origin" ? "pickup" : "delivery";

function firstRef(refs: unknown): string | undefined {
  if (Array.isArray(refs) && refs.length > 0 && typeof refs[0] === "string") return refs[0];
  return undefined;
}

export function projectLoadToSummary(load: ProjectableLoad, pay: AssignmentPay): LoadSummary {
  const ordered = [...load.stops].sort((a, b) => a.stopSequence - b.stopSequence);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const point = (s: ProjectableStop | undefined, fallback: string | null | undefined) =>
    s
      ? {
          address: s.addressString,
          lat: s.lat ?? undefined,
          lng: s.lng ?? undefined,
          window_earliest: iso(s.timeWindowEarliest),
          window_latest: iso(s.timeWindowLatest)
        }
      : fallback
        ? { address: fallback }
        : null;
  const middle = ordered.length > 2 ? ordered.slice(1, -1) : [];

  return {
    schema: 3,
    origin: point(first, load.originAddress),
    destination: point(last, load.destinationAddress),
    stops: middle.map((s) => ({
      seq: s.stopSequence,
      type: role(s),
      address: s.addressString,
      lat: s.lat ?? undefined,
      lng: s.lng ?? undefined,
      window_earliest: iso(s.timeWindowEarliest),
      window_latest: iso(s.timeWindowLatest),
      po_number: firstRef(s.referenceNumbers),
      dock_notes: s.stopNotes ?? undefined
    })),
    equipment: { trailer_type: load.trailerType ?? null },
    driver_pay: { kind: pay.kind, rate: pay.rate, estimate: payEstimate(pay, load.loadedMiles, load.estimatedHours) },
    reference: {
      broker_name: load.brokerName ?? undefined,
      load_number: load.loadNumber ?? undefined
    },
    miles: { loaded: load.loadedMiles }
  };
}

/** Keys that must never appear anywhere in a driver-facing payload (contract section 5). */
export const FORBIDDEN_KEY = /quoted_revenue|gross|margin|all_?in|line_?haul|market_rate|fsc|rate_?con|cost|rpm|empty_mile|revenue/i;

function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(k);
      keysOf(v, out);
    }
  }
  return out;
}

/**
 * Throws if the summary leaks. Checks (1) no forbidden key anywhere, (2) driver_pay has only kind/rate/estimate, and
 * (3) none of the load's secret numbers appear as values under an innocent key.
 */
export function assertDriverSafe(summary: LoadSummary, secrets: { numbers?: number[] } = {}): void {
  const bad = keysOf(summary).filter((k) => FORBIDDEN_KEY.test(k));
  if (bad.length > 0) throw new Error(`driver payload leaks keys: ${bad.join(", ")}`);
  const payKeys = Object.keys(summary.driver_pay).sort().join(",");
  if (payKeys !== "estimate,kind,rate") throw new Error(`driver_pay has unexpected keys: ${payKeys}`);
  const text = JSON.stringify(summary);
  for (const n of secrets.numbers ?? []) {
    if (!Number.isFinite(n) || n === 0) continue;
    const pattern = new RegExp(`(^|[^0-9.])${String(n).replace(".", "\\.")}([^0-9]|$)`);
    if (pattern.test(text)) throw new Error(`driver payload contains a secret value: ${n}`);
  }
}
