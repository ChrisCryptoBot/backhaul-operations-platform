// VENDORED from TrueLane lib/domain/contractorLoads.ts @ 06678c59. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * A contractor's loads from a company's desk (finalization plan F2, sync plan Step 5c; Chris 2026-11-23). The desk sends `contractor: { gross, fee_pct }` only on a contractor's link
 * (an employee's load never carries it); the bridge pull stores it on the load (v62, local-only) with whether the link runs under the company's authority.
 *
 * - Own authority, using the company as a dispatch service: the full gross is the driver's revenue, the company's fee is a dispatcher fee (a cost, lib/domain/dispatchFees.ts),
 *   and the load is owed to the driver until they invoice it.
 * - Leased on (under the company's authority): the gross and the company's cut are shown, but only the driver's share is income for taxes (the frozen carrier cut,
 *   lib/taxYearRead.ts), and the load is never listed as not invoiced (the Wallet's leased-on rule, lib/domain/leaks.ts).
 *
 * `asContractorMoney` gives the existing math a view of the load with the desk's figures in the money fields it already reads, so no formula changes: the gross as the agreed rate
 * (no fuel surcharge or layover on top: the gross already includes them), and the fee as the frozen dispatcher fee or the frozen carrier cut. The load itself is never written.
 * Math audit Round 7, R7-27..R7-30.
 */
/** The same mark as lib/domain/bridgedLoads.ts (that module's personalLoads uses this one, so this one cannot import it back). */
type BridgeMark = { externalDispatchId?: string | null };
const isBridgedLoad = (l: BridgeMark): boolean => typeof l.externalDispatchId === 'string' && l.externalDispatchId.length > 0;

export type ContractorMark = BridgeMark & {
  contractorGross?: number | null;
  contractorFeePct?: number | null;
  contractorLeasedOn?: boolean | null;
  externalOrgId?: string | null;
};

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** A bridged load the desk priced for a contractor. An employee's bridged load (no gross) is not one, and stays out of the driver's own money. */
export const isContractorLoad = (l: ContractorMark): boolean => isBridgedLoad(l) && finite(l.contractorGross) && l.contractorGross >= 0;

/** The dispatcher a contractor's own-authority load is booked through, for the Wallet's fee rows: the company, by its bridge org. */
export const contractorSourceId = (orgId: string | null | undefined): string => `bridge:${orgId ?? 'company'}`;

/** The fee as a fraction (25 -> 0.25), within 0..1; a missing or broken percent is no fee. */
export function contractorFeeFraction(pct: number | null | undefined): number {
  return finite(pct) && pct > 0 ? Math.min(pct, 100) / 100 : 0;
}

/**
 * The load as the Wallet's math should read it. Built on the load as its prototype, so every other field (id, miles, dates, invoice state) reads through unchanged, and a
 * WatermelonDB record stays usable. A load that is not a contractor's is returned as it is.
 */
export function asContractorMoney<T extends ContractorMark>(l: T): T {
  if (!isContractorLoad(l)) return l;
  const fee = contractorFeeFraction(l.contractorFeePct);
  const leasedOn = l.contractorLeasedOn === true;
  const over: Record<string, unknown> = {
    quotedRevenue: l.contractorGross,
    actualRevenue: 0,
    fuelSurcharge: 0,
    layoverPay: 0,
    tonuRevenue: 0,
    dispatchSourceId: leasedOn ? null : contractorSourceId(l.externalOrgId),
    snapshotDispatchFeePct: leasedOn ? null : fee,
    snapshotCarrierCutPct: leasedOn ? fee : null,
  };
  const props: PropertyDescriptorMap = {};
  for (const [k, value] of Object.entries(over)) props[k] = { value, enumerable: true };
  return Object.create(l as object, props) as T;
}

/** What the driver keeps from a contractor's load: the gross less the company's fee or cut, to the cent. */
export function contractorShare(l: ContractorMark): number | null {
  if (!isContractorLoad(l)) return null;
  return Math.round((l.contractorGross as number) * (1 - contractorFeeFraction(l.contractorFeePct)) * 100) / 100;
}
