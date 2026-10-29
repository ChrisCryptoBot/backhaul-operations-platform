// VENDORED from TrueLane lib/insuranceFields.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Cost Profile insurance: one total, or five categories (math audit C2).
 *
 * The truck cost reads the categories whenever any is set (getEffectiveTotalInsuranceMonthly). After
 * the one-time legacy move (total → liability) the categories were always set, so editing "Insurance
 * total" changed nothing: not the live preview, not the saved truck cost. Now:
 * - categories hidden: the total IS the insurance bill — saved as liability, the others cleared;
 * - categories shown: the total is their sum (read-only);
 * - a profile whose saved total and categories disagree shows the amount the truck cost uses, and
 *   asks which one is right (insuranceMismatch) — nothing changes silently.
 */

export type InsuranceCategories = {
  liability: number;
  physicalDamage: number;
  cargo: number;
  generalLiability: number;
  other: number;
};

const nonNeg = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

export function sumInsuranceCategories(c: InsuranceCategories): number {
  return nonNeg(c.liability) + nonNeg(c.physicalDamage) + nonNeg(c.cargo) + nonNeg(c.generalLiability) + nonNeg(c.other);
}

/**
 * Liability and cargo the carrier covers. The other categories stay.
 * Not for a lump total: that total is stored as liability, and clearing it would drop coverage
 * that was never split out (math audit rows 2–7).
 */
export function clearCarrierCoveredPremiums(c: InsuranceCategories): InsuranceCategories {
  return { ...c, liability: 0, cargo: 0 };
}

/** The insurance the wizard saves and previews. */
export function resolveWizardInsurance(
  total: number,
  categories: InsuranceCategories,
  categoriesShown: boolean
): { monthlyInsurance: number; categories: InsuranceCategories } {
  if (categoriesShown) {
    return { monthlyInsurance: sumInsuranceCategories(categories), categories };
  }
  const t = nonNeg(total);
  return {
    monthlyInsurance: t,
    categories: { liability: t, physicalDamage: 0, cargo: 0, generalLiability: 0, other: 0 },
  };
}

/** True when the categories hold more than liability — the wizard opens them so the split isn't lost. */
export function categoriesCarrySplit(c: InsuranceCategories): boolean {
  return nonNeg(c.physicalDamage) + nonNeg(c.cargo) + nonNeg(c.generalLiability) + nonNeg(c.other) > 0;
}

/**
 * The saved total and the categories the truck cost actually uses disagree (the total was edited
 * after the categories were filled, and ignored). Null when they agree or no total was saved.
 */
export function insuranceMismatch(
  savedTotal: number,
  categories: InsuranceCategories
): { typedTotal: number; usedTotal: number } | null {
  const typed = nonNeg(savedTotal);
  if (typed === 0) return null;
  const used = sumInsuranceCategories(categories);
  return Math.abs(typed - used) >= 0.005 ? { typedTotal: typed, usedTotal: used } : null;
}
