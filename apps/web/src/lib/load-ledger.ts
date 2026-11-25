import { grossOf } from "./load-gross";

export type LedgerLoadInput = {
  status: string;
  quotedRevenue: number;
  actualRevenue: number | null;
  fuelSurcharge: number | null;
  layoverPay: number | null;
  tonuRevenue: number | null;
  expenseFuelActual?: number | null;
  expenseTolls?: number | null;
  expenseMisc?: number | null;
  insuranceRiderFlat?: number | null;
  assignmentPayEstimate?: number | null;
  forecastFuel?: number | null;
  totalMiles?: number | null;
};

export type LedgerLegInput = {
  status: string;
  kind?: string | null;
  payEstimate: number | null;
};

export type LedgerSettledInput = {
  id: string;
  number: string;
  amount: number;
} | null;

export type LedgerDetentionInput = {
  billedExtra: number;
  billable: number;
  waived?: boolean;
};

export type LoadLedger = {
  /** Header gross revenue (grossOf: excludes detention). */
  earned: number;
  /** Original rate shown only as muted reference on cancelled / TONU loads; never summed. */
  referenceRate: number | null;
  /** Linehaul on non-cancelled, non-TONU loads: paid (actual) when > 0, else agreed. */
  revLinehaul: number;
  /** Agreed quoted rate on non-cancelled, non-TONU loads. */
  revAgreed: number;
  /** Difference (actual - agreed) when actual > 0 differs from agreed; 0 otherwise. */
  revVariance: number;
  revFsc: number;
  revDetention: number;
  revLayover: number;
  revTonu: number;
  totalRev: number;
  /** Operational driver cost: settled amount when settled, else editable/estimated leg + active assignment costs. */
  expDriver: number;
  driverCostSource: "settled" | "estimate" | "none";
  driverCostNote: string | undefined;
  expFuel: number;
  fuelCostSource: "actual" | "forecast";
  expTolls: number;
  expRider: number;
  expMisc: number;
  totalExp: number;
  netProfit: number;
  netMarginPct: number;
  netProfitPerMile: number;
};

const fin = (n: number | null | undefined): number => (typeof n === "number" && Number.isFinite(n) ? n : 0);
const pos = (n: number | null | undefined): number => Math.max(0, fin(n));
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Pure Money-tab ledger for one load, built on `grossOf`.
 * Cancelled -> $0 revenue; TONU -> TONU fee only (original rate is reference-only and never summed);
 * completed/active -> paid linehaul if entered else agreed (with variance surfaced as its own figure), waived detention excluded.
 * Driver cost reflects settled statement amount when settled, else closed leg estimates plus active assignment estimate — never zeroed just because revenue is $0/TONU/short.
 */
export function loadLedger(
  load: LedgerLoadInput,
  legs: ReadonlyArray<LedgerLegInput>,
  settled: LedgerSettledInput,
  detention: LedgerDetentionInput
): LoadLedger {
  const earned = grossOf({
    status: load.status,
    quotedRevenue: fin(load.quotedRevenue),
    actualRevenue: load.actualRevenue,
    fuelSurcharge: load.fuelSurcharge,
    layoverPay: load.layoverPay,
    tonuRevenue: load.tonuRevenue
  });

  const cancelled = load.status === "cancelled" || load.status === "quote";
  const tonu = load.status === "tonu";
  const agreed = round2(pos(load.quotedRevenue));
  const fsc = round2(pos(load.fuelSurcharge));
  const refRaw = round2(agreed + fsc);

  let revLinehaul = 0;
  let revAgreed = 0;
  let revVariance = 0;
  let revFsc = 0;
  let revLayover = 0;
  let revDetention = 0;
  let revTonu = 0;
  let referenceRate: number | null = null;

  if (cancelled) {
    referenceRate = refRaw > 0 ? refRaw : null;
  } else if (tonu) {
    revTonu = round2(pos(load.tonuRevenue));
    referenceRate = refRaw > 0 ? refRaw : null;
  } else {
    const actual = pos(load.actualRevenue);
    revAgreed = agreed;
    revLinehaul = round2(actual > 0 ? actual : agreed);
    revVariance = actual > 0 ? round2(actual - agreed) : 0;
    revFsc = fsc;
    revLayover = round2(pos(load.layoverPay));
    if (!detention.waived) {
      revDetention = round2(detention.billedExtra > 0 ? detention.billedExtra : load.status === "completed" ? detention.billable : 0);
    }
  }

  const totalRev = round2(earned + revDetention);

  let expDriver = 0;
  let driverCostSource: LoadLedger["driverCostSource"] = "none";
  let driverCostNote: string | undefined;

  if (settled != null) {
    expDriver = round2(pos(settled.amount));
    driverCostSource = "settled";
    driverCostNote = `settled on ${settled.number}`;
  } else {
    const closedLegsPay = legs.filter((l) => l.status === "closed").reduce((s, l) => s + pos(l.payEstimate), 0);
    const hasHaulLegs = legs.some((l) => (l.kind ?? "haul") === "haul");
    const hasActiveLeg = legs.some((l) => l.status === "active");
    const anyLegHasEstimate = legs.some((l) => l.payEstimate != null);
    const activeAssignPay = !hasHaulLegs || hasActiveLeg || !anyLegHasEstimate ? pos(load.assignmentPayEstimate) : 0;
    expDriver = round2(closedLegsPay + activeAssignPay);
    if (expDriver > 0) {
      driverCostSource = "estimate";
      driverCostNote = "estimate";
    }
  }

  const fuelActual = pos(load.expenseFuelActual);
  const fuelCostSource: LoadLedger["fuelCostSource"] = fuelActual > 0 ? "actual" : "forecast";
  const expFuel = round2(fuelActual > 0 ? fuelActual : pos(load.forecastFuel));
  const expTolls = round2(pos(load.expenseTolls));
  const expRider = round2(pos(load.insuranceRiderFlat));
  const expMisc = round2(pos(load.expenseMisc));
  const totalExp = round2(expDriver + expFuel + expTolls + expRider + expMisc);

  const netProfit = round2(totalRev - totalExp);
  const netMarginPct = totalRev > 0 ? (netProfit / totalRev) * 100 : 0;
  const totalMiles = pos(load.totalMiles);
  const netProfitPerMile = totalMiles > 0 ? netProfit / totalMiles : 0;

  return {
    earned,
    referenceRate,
    revLinehaul,
    revAgreed,
    revVariance,
    revFsc,
    revDetention,
    revLayover,
    revTonu,
    totalRev,
    expDriver,
    driverCostSource,
    driverCostNote,
    expFuel,
    fuelCostSource,
    expTolls,
    expRider,
    expMisc,
    totalExp,
    netProfit,
    netMarginPct,
    netProfitPerMile
  };
}
