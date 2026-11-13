/**
 * A company's name as it is compared, not as it is shown (docs/MONEY_PLAN.md, rule D: "customers are matched by normalized DisplayName / CompanyName before one is created"). Case, punctuation,
 * "&" against "and", spacing, and the legal ending (LLC, Inc, Co, Corp, Ltd, LP, LLP, Company) do not make two companies different: "ACME LOGISTICS, LLC" and "Acme Logistics" are one.
 * Anything else does: "Acme Logistics West" is another company.
 */
const ENDINGS = /\b(llc|l l c|inc|incorporated|co|corp|corporation|ltd|limited|lp|llp|company)\b/g;

export function normName(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(ENDINGS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The candidates that are the same company as `name`, by their display or company name. */
export function sameCompany<T extends { name: string | null; companyName: string | null }>(name: string, candidates: T[]): T[] {
  const want = normName(name);
  if (!want) return [];
  return candidates.filter((c) => normName(c.name) === want || (c.companyName != null && normName(c.companyName) === want));
}
