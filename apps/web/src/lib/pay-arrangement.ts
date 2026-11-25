import type { PayKind } from "./pay";

/**
 * Desk-owned pay arrangement and per-mile basis (2026-11-24 Pay Arrangement Addendum P.1–P.4).
 * One desktop supports mixed fleets: each driver's arrangement determines whether contractor/settlement
 * controls vs company-payroll estimates are shown, never guessing from phone state alone.
 */
export const PAY_ARRANGEMENTS = ["company", "contractor"] as const;
export type PayArrangement = (typeof PAY_ARRANGEMENTS)[number];
export const PAY_ARRANGEMENT_LABEL: Record<PayArrangement, string> = {
  company: "Company driver",
  contractor: "Independent contractor"
};

export const PAY_MILES_BASES = ["logged", "billable"] as const;
export type PayMilesBasis = (typeof PAY_MILES_BASES)[number];
export const PAY_MILES_BASIS_LABEL: Record<PayMilesBasis, string> = {
  logged: "Logged / ELD miles (falls back to billable)",
  billable: "Billable / quoted loaded miles"
};

export const isPayArrangement = (v: unknown): v is PayArrangement => v === "company" || v === "contractor";
export const isPayMilesBasis = (v: unknown): v is PayMilesBasis => v === "logged" || v === "billable";

/**
 * Precedence (P.1):
 * 1. Explicit desk `driverArrangement` (`company` | `contractor`) wins over phone link & workspace default.
 * 2. Claimed, unrevoked phone invite `owner_op_leased` -> `contractor`.
 * 3. Workspace `defaultPayArrangement` -> `contractor` if set to `contractor`, else `company`.
 */
export function resolvePayArrangement(input: { driverArrangement?: string | null; inviteRole?: string | null; workspaceDefault?: string | null }): PayArrangement {
  if (isPayArrangement(input.driverArrangement)) return input.driverArrangement;
  if (input.inviteRole === "owner_op_leased") return "contractor";
  if (input.workspaceDefault === "contractor") return "contractor";
  return "company";
}

export const resolveIsContractor = (input: { driverArrangement?: string | null; inviteRole?: string | null; workspaceDefault?: string | null }): boolean =>
  resolvePayArrangement(input) === "contractor";

/**
 * Pay kinds offered for an arrangement (P.1):
 * - Company drivers are typically paid per mile (OTR/PTP) or hourly (regional).
 * - Independent contractors may also use percent of rate confirmation or set flat amount per load.
 */
export function payKindsForArrangement(arrangement: PayArrangement): readonly PayKind[] {
  return arrangement === "contractor" ? ["percent", "flat", "cpm", "hourly"] : ["cpm", "hourly"];
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const round1 = (n: number) => Math.round(n * 10) / 10;
const fmtMi = (n: number) => Number(round1(n)).toLocaleString("en-US", { maximumFractionDigits: 1 });

export type MilesGapSummary = {
  paidMiles: number;
  loggedMiles: number | null;
  billableMiles: number;
  delta: number | null;
  basis: PayMilesBasis;
  label: string | null;
};

/**
 * Shows logged vs billable miles side-by-side when they differ (P.2), without ever capping logged miles
 * down to billable miles: dispatcher-caused reroutes remain visible and payable when the workspace uses logged miles.
 */
export function milesGapSummary(loggedMiles: number | null | undefined, billableMiles: number, basis: PayMilesBasis = "logged"): MilesGapSummary {
  const billable = finite(billableMiles) && billableMiles >= 0 ? round1(billableMiles) : 0;
  const logged = finite(loggedMiles) && loggedMiles >= 0 ? round1(loggedMiles) : null;
  const paidMiles = basis === "logged" && logged != null ? logged : billable;
  if (logged == null) return { paidMiles, loggedMiles: null, billableMiles: billable, delta: null, basis, label: null };
  const delta = round1(logged - billable);
  if (Math.abs(delta) < 0.5) return { paidMiles, loggedMiles: logged, billableMiles: billable, delta: 0, basis, label: null };
  const sign = delta > 0 ? `+${fmtMi(delta)} reroute` : `-${fmtMi(Math.abs(delta))} under`;
  return {
    paidMiles,
    loggedMiles: logged,
    billableMiles: billable,
    delta,
    basis,
    label: `logged ${fmtMi(logged)} mi · billable ${fmtMi(billable)} mi · ${sign}`
  };
}
