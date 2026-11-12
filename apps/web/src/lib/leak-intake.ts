/**
 * The Leak Read intake: the few numbers a carrier tells us that imported history cannot carry. A load imported from a TMS export has no floor frozen when it was booked and no detention terms frozen
 * on it, and today's cost profile is not what the truck cost on the day. So the carrier says, once:
 *   - what a mile costs them before fuel (the fleet's figure, and optionally a truck's own), the same meaning as a truck's break-even floor on the Cost profile;
 *   - the detention terms they bill at: the rate an hour and the free time (the fleet's, and optionally a customer's own).
 * The Leak ledger prices imported loads from these and labels every such line "intake, not frozen at booking"; it never mixes them with the floors and terms frozen on loads booked on the desk.
 * Nothing here is a market rate or a guess: a figure that was not given leaves the load counted and unpriced. Pure: the server stores one document on the workspace (server/tl/leak-intake.ts).
 */
export type IntakeTruck = { name: string; costPerMile: number };
export type IntakeCustomer = { name: string; detentionRate: number | null; freeMinutes: number | null };
export type LeakIntake = {
  /** Dollars a mile costs before fuel: the fleet default. */
  costPerMile: number | null;
  /** Dollars an hour the carrier bills for detention, and the minutes at a stop that are free: the fleet default. */
  detentionRate: number | null;
  freeMinutes: number | null;
  trucks: IntakeTruck[];
  customers: IntakeCustomer[];
};

export const EMPTY_INTAKE: LeakIntake = { costPerMile: null, detentionRate: null, freeMinutes: null, trucks: [], customers: [] };

/** The outer bounds a figure may take: a cell past these is a typo, not a cost. */
export const INTAKE_LIMITS = {
  costPerMile: { min: 0.01, max: 20 },
  detentionRate: { min: 1, max: 500 },
  freeMinutes: { min: 0, max: 1440 },
  trucks: 500,
  customers: 1000,
  name: 120
} as const;

const key = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();
const clean = (name: string) => name.trim().replace(/\s+/g, " ");
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const usd2 = (n: number) => `$${n.toFixed(2)}`;

/** What the form holds: everything as typed. */
export type IntakeForm = {
  costPerMile: string;
  detentionRate: string;
  freeMinutes: string;
  trucks: Array<{ name: string; costPerMile: string }>;
  customers: Array<{ name: string; detentionRate: string; freeMinutes: string }>;
};

export const emptyForm = (): IntakeForm => ({ costPerMile: "", detentionRate: "", freeMinutes: "", trucks: [], customers: [] });

const show = (n: number | null) => (n == null ? "" : String(n));
export function formOf(i: LeakIntake): IntakeForm {
  return {
    costPerMile: show(i.costPerMile),
    detentionRate: show(i.detentionRate),
    freeMinutes: show(i.freeMinutes),
    trucks: i.trucks.map((t) => ({ name: t.name, costPerMile: show(t.costPerMile) })),
    customers: i.customers.map((c) => ({ name: c.name, detentionRate: show(c.detentionRate), freeMinutes: show(c.freeMinutes) }))
  };
}

export type IntakeCheck = { ok: true; intake: LeakIntake } | { ok: false; errors: Record<string, string> };

/** A decimal with at most `places` digits after the point; blank is null, anything else is "bad". */
function decimal(raw: unknown, places: number): number | null | "bad" {
  const t = String(raw ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (t === "") return null;
  if (!new RegExp(`^\\d+(\\.\\d{1,${places}})?$`).test(t)) return "bad";
  const n = Number(t);
  return Number.isFinite(n) ? n : "bad";
}

function wholeNumber(raw: unknown): number | null | "bad" {
  const t = String(raw ?? "").trim().replace(/,/g, "");
  if (t === "") return null;
  if (!/^\d+$/.test(t)) return "bad";
  const n = Number(t);
  return Number.isFinite(n) ? n : "bad";
}

/**
 * Check what the form sent. A row with a name and no figure is dropped, like a blank one: it says "use the fleet's figure", which is what no row says (the form offers a row for each of the busiest trucks and
 * customers, and most are left as they are). A figure with no name is refused, as is a name used twice. Errors are keyed by field
 * ("costPerMile", "trucks.2.name", "customers.0.detentionRate") so the form can show each next to its field.
 */
export function validateIntake(input: unknown): IntakeCheck {
  const form = (input && typeof input === "object" ? input : {}) as Partial<IntakeForm>;
  const errors: Record<string, string> = {};
  const L = INTAKE_LIMITS;

  const cpm = (raw: unknown, at: string): number | null => {
    const v = decimal(raw, 4);
    if (v === "bad") errors[at] = "Dollars a mile, like 1.85.";
    else if (v != null && (v < L.costPerMile.min || v > L.costPerMile.max)) errors[at] = `Between $${L.costPerMile.min.toFixed(2)} and $${L.costPerMile.max} a mile.`;
    return typeof v === "number" ? v : null;
  };
  const rate = (raw: unknown, at: string): number | null => {
    const v = decimal(raw, 2);
    if (v === "bad") errors[at] = "Dollars an hour, like 60.";
    else if (v != null && (v < L.detentionRate.min || v > L.detentionRate.max)) errors[at] = `Between $${L.detentionRate.min} and $${L.detentionRate.max} an hour.`;
    return typeof v === "number" ? v : null;
  };
  const free = (raw: unknown, at: string): number | null => {
    const v = wholeNumber(raw);
    if (v === "bad") errors[at] = "Whole minutes, like 120.";
    else if (v != null && v > L.freeMinutes.max) errors[at] = `No more than ${L.freeMinutes.max} minutes.`;
    return typeof v === "number" ? v : null;
  };

  const costPerMile = cpm(form.costPerMile, "costPerMile");
  const detentionRate = rate(form.detentionRate, "detentionRate");
  const freeMinutes = free(form.freeMinutes, "freeMinutes");

  const trucks: IntakeTruck[] = [];
  const seenTrucks = new Set<string>();
  const truckRows = Array.isArray(form.trucks) ? form.trucks : [];
  if (truckRows.length > L.trucks) errors.trucks = `At most ${L.trucks} trucks.`;
  truckRows.slice(0, L.trucks).forEach((r, i) => {
    const name = clean(String(r?.name ?? ""));
    const raw = String(r?.costPerMile ?? "").trim();
    if (raw === "") return; // no figure: the fleet's applies, whatever the name
    if (name === "") errors[`trucks.${i}.name`] = "Name the truck.";
    else if (name.length > L.name) errors[`trucks.${i}.name`] = `Under ${L.name} characters.`;
    else if (seenTrucks.has(key(name))) errors[`trucks.${i}.name`] = "This truck is already in the list.";
    const v = cpm(raw, `trucks.${i}.costPerMile`);
    if (name !== "" && v != null && !errors[`trucks.${i}.name`]) {
      seenTrucks.add(key(name));
      trucks.push({ name, costPerMile: v });
    }
  });

  const customers: IntakeCustomer[] = [];
  const seenCustomers = new Set<string>();
  const customerRows = Array.isArray(form.customers) ? form.customers : [];
  if (customerRows.length > L.customers) errors.customers = `At most ${L.customers} customers.`;
  customerRows.slice(0, L.customers).forEach((r, i) => {
    const name = clean(String(r?.name ?? ""));
    const rawRate = String(r?.detentionRate ?? "").trim();
    const rawFree = String(r?.freeMinutes ?? "").trim();
    if (rawRate === "" && rawFree === "") return; // no figure: the fleet's applies, whatever the name
    if (name === "") errors[`customers.${i}.name`] = "Name the customer.";
    else if (name.length > L.name) errors[`customers.${i}.name`] = `Under ${L.name} characters.`;
    else if (seenCustomers.has(key(name))) errors[`customers.${i}.name`] = "This customer is already in the list.";
    const r2 = rate(rawRate, `customers.${i}.detentionRate`);
    const f2 = free(rawFree, `customers.${i}.freeMinutes`);
    if (name !== "" && (r2 != null || f2 != null) && !errors[`customers.${i}.name`]) {
      seenCustomers.add(key(name));
      customers.push({ name, detentionRate: r2, freeMinutes: f2 });
    }
  });

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, intake: { costPerMile, detentionRate, freeMinutes, trucks, customers } };
}

/** The stored document back as an intake: anything that is not a sound figure is dropped, so a hand-edited row can never price a load. */
export function parseIntake(raw: unknown): LeakIntake {
  if (!raw || typeof raw !== "object") return EMPTY_INTAKE;
  const o = raw as Record<string, unknown>;
  const L = INTAKE_LIMITS;
  const inRange = (n: unknown, lo: number, hi: number): number | null => (finite(n) && n >= lo && n <= hi ? n : null);
  const wholeIn = (n: unknown): number | null => (finite(n) && Number.isInteger(n) && n >= L.freeMinutes.min && n <= L.freeMinutes.max ? n : null);
  const trucks: IntakeTruck[] = [];
  for (const t of Array.isArray(o.trucks) ? o.trucks.slice(0, L.trucks) : []) {
    const name = clean(String((t as Record<string, unknown> | null)?.name ?? ""));
    const v = inRange((t as Record<string, unknown> | null)?.costPerMile, L.costPerMile.min, L.costPerMile.max);
    if (name !== "" && v != null) trucks.push({ name, costPerMile: v });
  }
  const customers: IntakeCustomer[] = [];
  for (const c of Array.isArray(o.customers) ? o.customers.slice(0, L.customers) : []) {
    const rec = c as Record<string, unknown> | null;
    const name = clean(String(rec?.name ?? ""));
    const r = inRange(rec?.detentionRate, L.detentionRate.min, L.detentionRate.max);
    const f = wholeIn(rec?.freeMinutes);
    if (name !== "" && (r != null || f != null)) customers.push({ name, detentionRate: r, freeMinutes: f });
  }
  return {
    costPerMile: inRange(o.costPerMile, L.costPerMile.min, L.costPerMile.max),
    detentionRate: inRange(o.detentionRate, L.detentionRate.min, L.detentionRate.max),
    freeMinutes: wholeIn(o.freeMinutes),
    trucks,
    customers
  };
}

/** Nothing has been given: every imported load is counted and none is priced. */
export const intakeIsEmpty = (i: LeakIntake): boolean => i.costPerMile == null && i.detentionRate == null && i.freeMinutes == null && i.trucks.length === 0 && i.customers.length === 0;

// ── Which figure prices a load ────────────────────────────────────────────────────────────────

export type FloorChoice = { rpm: number; from: "truck" | "fleet"; note: string };

/**
 * The cost a mile that prices an imported load's empty miles: the truck's own figure when the carrier gave one (matched on the truck's name as the load carries it), else the fleet default, else none.
 * The cost profile on the desk today is never used: it is not what the truck cost on the day.
 */
export function floorFor(intake: LeakIntake | null | undefined, truckName: string | null | undefined): FloorChoice | null {
  if (!intake) return null;
  if (truckName) {
    const own = intake.trucks.find((t) => key(t.name) === key(truckName));
    if (own) return { rpm: own.costPerMile, from: "truck", note: `${usd2(own.costPerMile)} a mile, ${own.name}'s intake figure` };
  }
  if (intake.costPerMile != null) return { rpm: intake.costPerMile, from: "fleet", note: `${usd2(intake.costPerMile)} a mile, the fleet's intake figure` };
  return null;
}

export type TermsChoice = {
  /** Dollars an hour, or null when neither the customer nor the fleet has one (the wait is counted and not priced). */
  rate: number | null;
  freeMinutes: number;
  rateFrom: "customer" | "fleet" | null;
  freeFrom: "customer" | "fleet" | "desk";
  note: string;
};

/**
 * The detention terms that price an imported load: the customer's own rate and free time where the carrier gave them, else the fleet default for each, else (free time only) the desk's own free-time
 * setting. There is no rate to fall back on: no rate leaves the wait counted and unpriced.
 */
export function termsFor(intake: LeakIntake | null | undefined, customer: string | null | undefined, deskFreeMinutes: number): TermsChoice {
  const own = intake && customer ? intake.customers.find((c) => key(c.name) === key(customer)) : undefined;
  const rate = own?.detentionRate ?? intake?.detentionRate ?? null;
  const rateFrom = own?.detentionRate != null ? "customer" : intake?.detentionRate != null ? "fleet" : null;
  const freeMinutes = own?.freeMinutes ?? intake?.freeMinutes ?? deskFreeMinutes;
  const freeFrom = own?.freeMinutes != null ? "customer" : intake?.freeMinutes != null ? "fleet" : "desk";
  const word = { customer: "customer's intake terms", fleet: "fleet's intake default", desk: "the desk's free-time setting" } as const;
  const note = `${rate == null ? "no rate given" : `${usd2(rate)} an hour (${word[rateFrom!]})`}, ${freeMinutes} minutes free (${word[freeFrom]})`;
  return { rate, freeMinutes, rateFrom, freeFrom, note };
}
