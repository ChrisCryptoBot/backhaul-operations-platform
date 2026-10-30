import { parseCentralLocal } from "./zoned";

/**
 * What a dispatcher enters for a driver who is not entering it on the phone: the pickup (when they arrived, how long they waited, the seal),
 * the delivery (arrival and wait at each stop, when it was delivered, whether there is proof of delivery, what it cost) and the expenses on
 * their own. Checked here and again on the server. Pure.
 */
export type StartValues = { arrivedAt: string; waitMinutes: string; seal: string };
/** `seal` is the seal number put on or read at that stop (optional; blank keeps what is already recorded). */
export type CompleteStopValues = { id: string; arrivedAt: string; waitMinutes: string; seal?: string };
export type ExpenseValues = { fuel: string; tolls: string; misc: string };
/** `actualRevenue` is the linehaul the broker actually paid, when it is not the rate on the load (a short pay, an adjusted rate): blank keeps the load's own rate. */
export type CompleteValues = ExpenseValues & { stops: CompleteStopValues[]; deliveredAt: string; pod: "received" | "none"; podNote: string; actualRevenue?: string };

export type TripErrors = Record<string, string>;
export type StartInput = { arrivedAt: Date; waitMinutes: number | null; seal: string | null };
export type CompleteInput = { actualRevenue: number | null; stops: Array<{ id: string; arrivedAt: Date | null; waitMinutes: number | null; seal: string | null }>; deliveredAt: Date; pod: "received" | "none"; podNote: string | null; expenses: ExpenseInput };
export type ExpenseInput = { fuel: number; tolls: number; misc: number };

const t = (v: unknown) => (typeof v === "string" ? v.trim() : "");
/** A clock a little ahead is allowed: the dispatcher's clock and the driver's are not the same. */
const FUTURE_SLACK_MS = 10 * 60_000;

function time(errors: TripErrors, key: string, raw: string, now: number, required: boolean): Date | null {
  const s = t(raw);
  if (s === "") {
    if (required) errors[key] = "When? Pick a date and time.";
    return null;
  }
  const ms = parseCentralLocal(s);
  if (ms == null) {
    errors[key] = "A real date and time.";
    return null;
  }
  if (ms > now + FUTURE_SLACK_MS) {
    errors[key] = "That is in the future. Enter what has happened.";
    return null;
  }
  return new Date(ms);
}

function minutes(errors: TripErrors, key: string, raw: string): number | null {
  const s = t(raw);
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 1440) {
    errors[key] = "Whole minutes, 0 to 1,440.";
    return null;
  }
  return n;
}

function money(errors: TripErrors, key: string, raw: string): number {
  const s = t(raw).replace(/,/g, "");
  if (s === "") return 0;
  // Plain digits with at most one point: "1e3" and "0x10" are numbers to JavaScript but not dollar amounts.
  const n = /^(\d+(\.\d*)?|\.\d+)$/.test(s) ? Number(s) : Number.NaN;
  if (!Number.isFinite(n) || n < 0 || n > 100000 || Math.abs(n * 100 - Math.trunc(n * 100)) > 1e-6) {
    errors[key] = "Dollars and cents, 0 to 100,000.";
    return 0;
  }
  return n;
}

export function validateExpenses(v: ExpenseValues): { ok: true; value: ExpenseInput } | { ok: false; errors: TripErrors } {
  const errors: TripErrors = {};
  const value = { fuel: money(errors, "fuel", v.fuel), tolls: money(errors, "tolls", v.tolls), misc: money(errors, "misc", v.misc) };
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value };
}

export function validateStart(v: StartValues, now = Date.now()): { ok: true; value: StartInput } | { ok: false; errors: TripErrors } {
  const errors: TripErrors = {};
  const arrivedAt = time(errors, "arrivedAt", v.arrivedAt, now, true);
  const waitMinutes = minutes(errors, "waitMinutes", v.waitMinutes);
  const seal = t(v.seal);
  if (seal.length > 30) errors.seal = "A seal number is 30 characters at most.";
  if (Object.keys(errors).length > 0 || !arrivedAt) return { ok: false, errors };
  return { ok: true, value: { arrivedAt, waitMinutes, seal: seal === "" ? null : seal } };
}

export function validateComplete(v: CompleteValues, now = Date.now()): { ok: true; value: CompleteInput } | { ok: false; errors: TripErrors } {
  const errors: TripErrors = {};
  const stops = v.stops.map((s, i) => {
    const seal = t(s.seal ?? "");
    if (seal.length > 30) errors[`stop${i}.seal`] = "A seal number is 30 characters at most.";
    return { id: s.id, arrivedAt: time(errors, `stop${i}.arrivedAt`, s.arrivedAt, now, false), waitMinutes: minutes(errors, `stop${i}.waitMinutes`, s.waitMinutes), seal: seal === "" ? null : seal };
  });
  const deliveredAt = time(errors, "deliveredAt", v.deliveredAt, now, true);
  const note = t(v.podNote);
  if (v.pod !== "received" && v.pod !== "none") errors.pod = "Say whether there is proof of delivery.";
  if (v.pod === "none" && note.length < 3) errors.podNote = "Say why there is no proof of delivery.";
  if (note.length > 300) errors.podNote = "300 characters at most.";
  const expenses = validateExpenses(v);
  if (!expenses.ok) Object.assign(errors, expenses.errors);
  // The linehaul actually paid: blank keeps the load's own rate; anything typed has to be real money.
  let actualRevenue: number | null = null;
  const actualRaw = t(v.actualRevenue ?? "");
  if (actualRaw !== "") {
    const typed = money(errors, "actualRevenue", actualRaw);
    if (errors.actualRevenue === undefined) {
      if (typed <= 0) errors.actualRevenue = "More than $0, or leave it blank to keep the rate on the load.";
      else actualRevenue = typed;
    }
  }
  if (Object.keys(errors).length > 0 || !deliveredAt || !expenses.ok) return { ok: false, errors };
  return { ok: true, value: { stops, deliveredAt, pod: v.pod, podNote: note === "" ? null : note, expenses: expenses.value, actualRevenue } };
}
