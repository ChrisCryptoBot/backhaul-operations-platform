import { computeLoadDetention, loadDetentionTerms, type StopDetention } from "@/truelane/lib/domain/detention";
import { invoiceRateTotal } from "@/truelane/lib/invoice";

/**
 * Detention to recover on a finished load, using TrueLane's own rule (each stop gets its own free time; only the wait beyond it
 * is billable at the truck's rate). Also works out how much of it the invoice already carried, so "unbilled" is what is still owed.
 * Pure.
 */
export type DetentionInput = {
  stops: Array<{ stopSequence: number; stopType: string; waitMinutes: number | null }>;
  /** loads.dock_wait_minutes: only used when no stop has its own wait. */
  dockWaitMinutes: number | null;
  /** The truck's cost profile, and the workspace's free time for a profile that has none. */
  rate: number | null;
  graceMinutes: number | null;
  workspaceGraceMinutes: number;
  /** What the invoice (if one exists) was for, against the agreed rate plus fuel surcharge. */
  invoice: { invoiced: boolean; invoicedAmount: number | null; quotedRevenue: number; fuelSurcharge: number | null };
};

export type DetentionSummary = {
  rate: number;
  graceMinutes: number;
  basis: "per_stop" | "total_only";
  totalWaitMinutes: number;
  billableMinutes: number;
  billable: number;
  stops: StopDetention[];
  /** The part of an issued invoice that was detention (invoice total above the rate and fuel surcharge). */
  billedExtra: number;
  /** Still owed and not on any invoice. */
  unbilled: number;
  /** There was waiting beyond the free time, but the truck has no detention rate, so nothing can be billed. */
  noRate: boolean;
};

const cents = (n: number) => Math.round(n * 100) / 100;

export function summarizeDetention(i: DetentionInput): DetentionSummary {
  const terms = loadDetentionTerms({}, { detentionHourlyRate: i.rate, freeGraceMinutes: i.graceMinutes ?? i.workspaceGraceMinutes });
  const d = computeLoadDetention({ stops: i.stops, totalWaitMinutes: i.dockWaitMinutes, detentionHourlyRate: terms.detentionHourlyRate, freeGraceMinutes: terms.freeGraceMinutes });
  const base = invoiceRateTotal({ quotedRevenue: i.invoice.quotedRevenue, fuelSurcharge: i.invoice.fuelSurcharge });
  const billedExtra = i.invoice.invoiced && i.invoice.invoicedAmount != null ? Math.max(0, cents(i.invoice.invoicedAmount - base)) : 0;
  // With no rate there is nothing to bill, but the minutes past the free time are still the load's own fact.
  const noRate = terms.detentionHourlyRate <= 0 && waitedPastGrace(i, terms.freeGraceMinutes);
  return {
    rate: terms.detentionHourlyRate,
    graceMinutes: terms.freeGraceMinutes,
    basis: d.basis,
    totalWaitMinutes: d.totalWaitMinutes,
    billableMinutes: d.billableMinutes,
    billable: d.billableAmount,
    stops: d.stops,
    billedExtra,
    unbilled: Math.max(0, cents(d.billableAmount - billedExtra)),
    noRate
  };
}

function waitedPastGrace(i: DetentionInput, grace: number): boolean {
  const waits = i.stops.map((s) => s.waitMinutes).filter((w): w is number => w != null);
  return waits.length > 0 ? waits.some((w) => w > grace) : (i.dockWaitMinutes ?? 0) > grace * 2;
}
