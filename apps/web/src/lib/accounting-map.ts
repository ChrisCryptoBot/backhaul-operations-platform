/**
 * Which account each kind of money is booked to (docs/MONEY_PLAN.md, rules D and E). Pure: the Settings screen, the journal export and the QuickBooks sync read the same table.
 *
 * Rule D: every invoice line goes to an income account. The defaults are linehaul to Freight Income, fuel surcharge to Fuel Surcharge Income, and detention, lumper, layover, stop-off and
 * truck-ordered-not-used to Accessorial Income. "Other" and "Credit" lines have no default on purpose: what they are differs by fleet, so the fleet names their account before a sync or a
 * journal that carries one can run. A kind that is unmapped stops the sync before anything is sent.
 * Rule E: a 1099 owner-operator's statement is a bill to the driver as a vendor (Driver Pay expense, Accounts Payable). A W-2 company driver's pay is never booked here: it goes only through
 * payroll, so taxes and withholding are not counted twice.
 * Wave 4 step 7: a 1099 statement's deductions (lease, insurance, ELD charged back) are Deduction Income; escrow held for a driver is the driver's money, a liability (Driver Escrow), never
 * income, and a release takes it back down; an advance is an asset (Driver Advances) the fleet holds until the driver repays it on statements.
 */
export type AccountGroup = "income" | "expense" | "balance";
export type AccountKey = {
  key: string;
  group: AccountGroup;
  /** What it is, to a person. */
  label: string;
  /** The default account name, or null when the fleet has to choose one. */
  fallback: string | null;
};

export const ACCOUNT_KEYS: readonly AccountKey[] = [
  { key: "linehaul", group: "income", label: "Linehaul", fallback: "Freight Income" },
  { key: "fuel_surcharge", group: "income", label: "Fuel surcharge", fallback: "Fuel Surcharge Income" },
  { key: "detention", group: "income", label: "Detention", fallback: "Accessorial Income" },
  { key: "lumper", group: "income", label: "Lumper", fallback: "Accessorial Income" },
  { key: "layover", group: "income", label: "Layover", fallback: "Accessorial Income" },
  { key: "stop_off", group: "income", label: "Stop-off", fallback: "Accessorial Income" },
  { key: "tonu", group: "income", label: "Truck ordered, not used", fallback: "Accessorial Income" },
  { key: "other", group: "income", label: "Other charges", fallback: null },
  { key: "credit", group: "income", label: "Credits and allowances", fallback: null },
  { key: "deduction_income", group: "income", label: "Driver deductions charged back (lease, insurance, ELD)", fallback: "Driver Deduction Income" },
  { key: "driver_pay_1099", group: "expense", label: "Driver pay (1099 owner-operators)", fallback: "Driver Pay" },
  { key: "fuel", group: "expense", label: "Fuel", fallback: "Fuel" },
  { key: "factoring_fee", group: "expense", label: "Factoring fees", fallback: "Factoring Fees" },
  { key: "write_off", group: "expense", label: "Short pays written off", fallback: "Bad Debt" },
  { key: "accounts_receivable", group: "balance", label: "What customers owe", fallback: "Accounts Receivable" },
  { key: "cash", group: "balance", label: "Money received", fallback: "Undeposited Funds" },
  { key: "factor_reserve", group: "balance", label: "Reserve the factor holds", fallback: "Factoring Reserve" },
  { key: "accounts_payable", group: "balance", label: "What the fleet owes drivers", fallback: "Accounts Payable" },
  { key: "fuel_card_payable", group: "balance", label: "What the fuel card is owed", fallback: "Fuel Card Payable" },
  { key: "escrow_liability", group: "balance", label: "Escrow held for drivers (their money)", fallback: "Driver Escrow" },
  { key: "driver_advances", group: "balance", label: "Advances drivers still owe", fallback: "Driver Advances" }
];

export const ACCOUNT_KEY_SET: ReadonlySet<string> = new Set(ACCOUNT_KEYS.map((k) => k.key));
export const GROUP_LABEL: Record<AccountGroup, string> = { income: "Income, by invoice line and driver deductions", expense: "Expenses", balance: "Balance accounts" };

export type MappedAccount = { account: string; number: string | null; fallback: boolean };
export type AccountMap = Record<string, MappedAccount | null>;

/** The fleet's rows over the defaults: each key to its account, or null when it has neither. */
export function resolveAccounts(rows: ReadonlyArray<{ key: string; account: string; number: string | null }>): AccountMap {
  const mine = new Map(rows.filter((r) => ACCOUNT_KEY_SET.has(r.key) && r.account.trim() !== "").map((r) => [r.key, r]));
  return Object.fromEntries(
    ACCOUNT_KEYS.map((k) => {
      const r = mine.get(k.key);
      if (r) return [k.key, { account: r.account.trim(), number: r.number?.trim() || null, fallback: false }];
      return [k.key, k.fallback ? { account: k.fallback, number: null, fallback: true } : null];
    })
  );
}

/** The keys a piece of work needs that have no account, in the table's order. An unknown key (a line kind added later) is unmapped too. */
export function unmappedOf(needed: Iterable<string>, map: AccountMap): string[] {
  const want = new Set(needed);
  const known = ACCOUNT_KEYS.filter((k) => want.has(k.key) && !map[k.key]).map((k) => k.key);
  const unknown = [...want].filter((k) => !ACCOUNT_KEY_SET.has(k)).sort();
  return [...known, ...unknown];
}

export const labelOfKey = (key: string): string => ACCOUNT_KEYS.find((k) => k.key === key)?.label ?? key;

/** A plain sentence naming what has to be mapped first. */
export const unmappedSentence = (keys: string[]): string => `Choose an account for ${keys.map(labelOfKey).join(", ")} first (Settings, Integrations, Accounting accounts).`;

export type AccountsForm = Record<string, { account: string; number: string }>;

/**
 * The form, checked. A blank account goes back to the default (or to unmapped, for a key with no default). Account names are at most 100 characters (QuickBooks' limit) on one line, with
 * no colon (QuickBooks uses it for sub-accounts); a number is up to 20 letters, digits, dots and dashes.
 */
export function checkAccountsForm(form: AccountsForm): { ok: true; rows: Array<{ key: string; account: string | null; number: string | null }> } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const rows: Array<{ key: string; account: string | null; number: string | null }> = [];
  for (const k of ACCOUNT_KEYS) {
    const f = form[k.key];
    if (!f) continue;
    const account = (f.account ?? "").trim();
    const number = (f.number ?? "").trim();
    if (account.length > 100 || /[\r\n\t:]/.test(account)) errors[`${k.key}.account`] = "An account name, up to 100 characters, with no colon.";
    if (number !== "" && !/^[A-Za-z0-9.-]{1,20}$/.test(number)) errors[`${k.key}.number`] = "Up to 20 letters, digits, dots or dashes.";
    if (number !== "" && account === "") errors[`${k.key}.account`] = "Name the account the number belongs to.";
    rows.push({ key: k.key, account: account || null, number: number || null });
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, rows };
}
