"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { DENSITY_COOKIE, THEME_COOKIE, asDensity, asTheme } from "@/lib/appearance";
import { redirect, RedirectType } from "next/navigation";
import { prisma } from "@/lib/db";
import { assignDriver, dispatchLoad, DispatchError, recordDriverResponse, unassignLoad } from "@/server/tl/dispatch";
import { cancelLoad, recordTonu, rescheduleLoad } from "@/server/tl/disruptions";
import { invoiceLoad, markLoadPaid } from "@/server/tl/invoicing";
import { parseCentralLocal } from "@/lib/zoned";
import { saveThresholds } from "@/server/tl/thresholds";
import { saveCompany } from "@/server/tl/company";
import { saveCustomer, type SaveCustomerResult } from "@/server/tl/customers";
import type { CustomerValues } from "@/lib/customer";
import type { CompanyValues } from "@/lib/company";
import { saveCostProfile, saveDriver, saveTruck, setDriverActive, setTruckArchived, type ActResult, type SaveResult } from "@/server/tl/fleet";
import type { DriverValues, ProfileKey, TruckValues } from "@/lib/fleet-forms";
import type { Thresholds } from "@/lib/thresholds";
import type { PayKind } from "@/server/tl/projector";
import { quoteWarnings, readQuote, type QuoteValues } from "@/lib/quote";
import { bookQuote, discardQuote, fitQuote, passQuote, quoteContext, saveQuote, type BookResult, type FitResult, type Override, type QuoteContext, type QuoteSave } from "@/server/tl/quote";
import type { LoadEditValues } from "@/lib/load-edit";
import type { InvoiceForm } from "@/lib/invoicing";
import type { CompleteValues, ExpenseValues, StartValues } from "@/lib/trip";
import { saveLoadDetails, type EditResult } from "@/server/tl/edit";
import { assignFromQueue, assignOptions, type AssignOptions, type AssignOutcome } from "@/server/tl/suggest";
import { deleteLoad, restoreLoad, type RemoveResult } from "@/server/tl/remove";
import { completeTrip, saveExpenses, startTrip, type TripResult } from "@/server/tl/execution";
import { undoPaid, type InvoiceOut, type PaidOut } from "@/server/tl/invoicing";
import { discardSettlement, finalizeSettlement, saveDraft, startSettlement, voidSettlement, type Draft, type SettleResult } from "@/server/tl/settlement";
import { readRateCon } from "@/server/ratecon/reader";
import { DuplicateLoadError, saveReviewedDraft, type ReviewedDraft } from "@/server/ratecon/save";
import { loadSendGaps } from "@/server/tl/readiness";
import { gapsPhrase } from "@/lib/send-readiness";
import type { RateConLoadDraft } from "@/server/ratecon/map";

/**
 * Server actions for the desk. Each one runs the same functions the tests run, then sends the page back with a
 * short note (?note=...) or an error (?error=...) so the result is visible without client state.
 */
function back(loadId: string, key: "note" | "error", text: string): never {
  // Replace, not push: the load may be open in the drawer, and closing it must land on the page beneath, not on the same load again.
  redirect(`/loads/${loadId}?${key}=${encodeURIComponent(text)}`, RedirectType.replace);
}

async function attempt(loadId: string, fn: () => Promise<string>): Promise<never> {
  let note: string;
  try {
    note = await fn();
  } catch (e) {
    if (e instanceof DispatchError) return back(loadId, "error", e.message);
    throw e;
  }
  revalidatePath("/loads");
  revalidatePath("/dispatch");
  revalidatePath("/alerts");
  revalidatePath("/audit");
  revalidatePath("/planner");
  revalidatePath("/kpi");
  return back(loadId, "note", note);
}

export async function assignAction(formData: FormData) {
  const loadId = String(formData.get("loadId"));
  await attempt(loadId, async () => {
    const rate = Number(formData.get("rate"));
    await assignDriver({
      loadId,
      driverId: String(formData.get("driverId")),
      pay: { kind: String(formData.get("payKind")) as PayKind, rate },
      overrideReason: String(formData.get("overrideReason") ?? "")
    });
    return "Driver assigned. Send it when you are ready.";
  });
}

/** Who could take a load, with the best fits first: the data behind the Assign window on the dispatch queue and the planner. Reads only. */
export async function assignOptionsAction(loadId: string): Promise<AssignOptions | null> {
  return assignOptions(loadId);
}

/** Assign from the queue or the planner. Answers in place (no redirect), and everything that shows a load looks again. */
export async function assignFromQueueAction(input: { loadId: string; driverId: string; payKind: string; rate: string; overrideReason?: string }): Promise<AssignOutcome> {
  const out = await assignFromQueue(input);
  if (out.ok) refreshLoads();
  return out;
}

export async function unassignAction(formData: FormData) {
  const loadId = String(formData.get("loadId"));
  await attempt(loadId, async () => {
    await unassignLoad(loadId, String(formData.get("reason") ?? ""));
    return "Driver removed. The load is back on the board.";
  });
}

export async function sendAction(formData: FormData) {
  const loadId = String(formData.get("loadId"));
  const sendAnyway = formData.get("sendAnyway") === "1";
  await attempt(loadId, async () => {
    // The server decides what is missing, whatever the page showed. A load that lacks something goes only when the dispatcher says to send anyway.
    const gaps = await loadSendGaps(loadId);
    const missing = gapsPhrase(gaps);
    if (gaps.length > 0 && !sendAnyway) throw new DispatchError("not_ready", `Not ready: still missing ${missing}. Send anyway if the driver has it another way.`);
    await dispatchLoad(loadId, new Date(), gaps.length > 0 ? { sentWithout: missing } : {});
    return gaps.length > 0 ? `Sent without ${missing}.` : "Sent to the driver.";
  });
}

export async function respondAction(formData: FormData) {
  const loadId = String(formData.get("loadId"));
  const response = formData.get("response") === "declined" ? "declined" : "accepted";
  await attempt(loadId, async () => {
    await recordDriverResponse(loadId, response);
    return response === "accepted" ? "Driver accepted." : "Driver declined. Pick another driver.";
  });
}

// ── When a load falls through or moves ────────────────────────────────────────────────────────

const text = (formData: FormData, key: string) => String(formData.get(key) ?? "");

export async function cancelAction(formData: FormData) {
  const loadId = text(formData, "loadId");
  await attempt(loadId, async () => {
    await cancelLoad({ loadId, reason: text(formData, "reason"), note: text(formData, "note") });
    return "Load cancelled. The reason is in the audit log.";
  });
}

export async function tonuAction(formData: FormData) {
  const loadId = text(formData, "loadId");
  await attempt(loadId, async () => {
    await recordTonu({ loadId, reason: text(formData, "reason"), note: text(formData, "note"), fee: Number(text(formData, "fee")) });
    return "TONU recorded. The fee counts as revenue on the load.";
  });
}

export async function rescheduleAction(formData: FormData) {
  const loadId = text(formData, "loadId");
  await attempt(loadId, async () => {
    const at = parseCentralLocal(text(formData, "pickup"));
    if (at == null) throw new DispatchError("bad_time", "Pick a date and time for the new pickup.");
    await rescheduleLoad({ loadId, newPickup: new Date(at), reason: text(formData, "reason"), note: text(formData, "note") });
    return "Pickup rescheduled. Every stop moved with it.";
  });
}

// ── Rate confirmations ─────────────────────────────────────────────────────────────────────────

/** A draft with its dates as ISO strings, so it can cross the server-action boundary. */
export type DraftDto = Omit<RateConLoadDraft, "stops"> & {
  stops: Array<Omit<RateConLoadDraft["stops"][number], "timeWindowEarliest" | "timeWindowLatest"> & { timeWindowEarliest: string | null; timeWindowLatest: string | null }>;
};

function toDto(d: RateConLoadDraft): DraftDto {
  return { ...d, stops: d.stops.map((s) => ({ ...s, timeWindowEarliest: s.timeWindowEarliest?.toISOString() ?? null, timeWindowLatest: s.timeWindowLatest?.toISOString() ?? null })) };
}

export type ReadResult = { ok: true; source: "demo" | "live"; fileName: string; draft: DraftDto } | { ok: false; reason: string };

export async function readSampleRateConAction(fileName: string): Promise<ReadResult> {
  const out = await readRateCon({ fileName });
  return out.ok ? { ok: true, source: out.source, fileName, draft: toDto(out.draft) } : { ok: false, reason: out.reason };
}

/** The most a rate confirmation file can be: a phone photo of two pages is a few megabytes. Matches `serverActions.bodySizeLimit`. */
const MAX_RATE_CON_BYTES = 10 * 1024 * 1024;

/** A file chosen or dropped on the page. A sample's name still reads without a key; anything else needs one. */
export async function readUploadedRateConAction(formData: FormData): Promise<ReadResult> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, reason: "unreadable" };
  if (file.size > MAX_RATE_CON_BYTES) return { ok: false, reason: "too_big" };
  const out = await readRateCon({ fileName: file.name, mime: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
  return out.ok ? { ok: true, source: out.source, fileName: file.name, draft: toDto(out.draft) } : { ok: false, reason: out.reason };
}

export async function saveRateConAction(dto: DraftDto, confirmed: boolean, vehicleId: string | null = null, fileName: string | null = null, allowDuplicate = false): Promise<{ ok: true; loadId: string } | { ok: false; error: string; duplicateOf?: string }> {
  try {
    const draft: ReviewedDraft = {
      ...dto,
      confirmed,
      vehicleId,
      fileName,
      allowDuplicate,
      stops: dto.stops.map((s) => ({ ...s, timeWindowEarliest: s.timeWindowEarliest ? new Date(s.timeWindowEarliest) : null, timeWindowLatest: s.timeWindowLatest ? new Date(s.timeWindowLatest) : null }))
    };
    const load = await saveReviewedDraft(draft);
    revalidatePath("/loads");
    revalidatePath("/dispatch");
    revalidatePath("/rate-cons");
    revalidatePath("/audit");
    revalidatePath("/planner");
    return { ok: true, loadId: load.id };
  } catch (e) {
    if (e instanceof DuplicateLoadError) return { ok: false, error: e.message, duplicateOf: e.loadId };
    return { ok: false, error: e instanceof Error ? e.message : "Could not save." };
  }
}

// ── Drivers and trucks ─────────────────────────────────────────────────────────────────────────

// Called from the forms and buttons on Drivers and Trucks. Every one returns what happened (field errors, or a plain message) rather
// than redirecting, so the form can stay open and say what is wrong.
const refreshFleet = () => revalidatePath("/", "layout");

export async function saveDriverAction(values: Record<string, string>, id: string | null): Promise<SaveResult<keyof DriverValues>> {
  const out = await saveDriver(values, id);
  if (out.ok) refreshFleet();
  return out;
}

export async function setDriverActiveAction(id: string, active: boolean): Promise<ActResult> {
  const out = await setDriverActive(id, active);
  if (out.ok) refreshFleet();
  return out;
}

export async function saveTruckAction(values: Record<string, string>, id: string | null): Promise<SaveResult<keyof TruckValues>> {
  const out = await saveTruck(values, id);
  if (out.ok) refreshFleet();
  return out;
}

export async function setTruckArchivedAction(id: string, archived: boolean): Promise<ActResult> {
  const out = await setTruckArchived(id, archived);
  if (out.ok) refreshFleet();
  return out;
}

export async function saveCostProfileAction(vehicleId: string, values: Record<string, string>): Promise<SaveResult<ProfileKey> & { floors?: { breakEven: number; survival: number } }> {
  const out = await saveCostProfile(vehicleId, values);
  if (out.ok) refreshFleet();
  return out;
}

// ── Thresholds (Settings) ──────────────────────────────────────────────────────────────────────

/** Checks and saves the thresholds the form sent. Everything that reads them (alerts, the KPI lines, invoice terms) refreshes. */
export async function saveThresholdsAction(values: Record<string, string>): Promise<{ ok: true; changed: boolean } | { ok: false; errors: Partial<Record<keyof Thresholds, string>> }> {
  const out = await saveThresholds(values);
  if (!out.ok) return { ok: false, errors: out.errors };
  revalidatePath("/", "layout");
  return { ok: true, changed: out.changed ?? false };
}

/** The company on invoices and statements. Both sheets read it, so they refresh with the layout. */
export async function saveCompanyAction(values: CompanyValues): Promise<{ ok: true; changed: boolean } | { ok: false; errors: Partial<Record<keyof CompanyValues, string>> }> {
  const out = await saveCompany(values);
  if (!out.ok) return { ok: false, errors: out.errors };
  revalidatePath("/", "layout");
  return { ok: true, changed: out.changed ?? false };
}

/** A customer's record. Its name is on loads, so everything that shows a load or a customer looks again. */
export async function saveCustomerAction(values: CustomerValues, id: string | null): Promise<SaveCustomerResult> {
  const out = await saveCustomer(values, id);
  if (out.ok && out.changed) refreshLoads();
  return out;
}

// ── Appearance (Settings) ──────────────────────────────────────────────────────────────────────

/** Saves the theme and/or density in cookies (read by the root layout) and returns to Settings with a note. */
export async function setAppearanceAction(formData: FormData) {
  const jar = cookies();
  const theme = formData.get("theme");
  const density = formData.get("density");
  const year = 60 * 60 * 24 * 365;
  if (typeof theme === "string") jar.set(THEME_COOKIE, asTheme(theme), { path: "/", maxAge: year, sameSite: "lax" });
  if (typeof density === "string") jar.set(DENSITY_COOKIE, asDensity(density), { path: "/", maxAge: year, sameSite: "lax" });
  revalidatePath("/", "layout");
  redirect("/settings?note=" + encodeURIComponent("Appearance saved."));
}

// ── Quote ──────────────────────────────────────────────────────────────────────────────────────

export type PricedQuote = { ok: true; fit: FitResult; context: QuoteContext; warnings: string[] } | { ok: false };

/** The offer priced as you type: every truck and driver, plus what the desk already knows about the lane and the broker. Writes nothing. */
export async function priceQuoteAction(values: QuoteValues): Promise<PricedQuote> {
  const input = readQuote(values);
  if (!input) return { ok: false };
  const [fit, context] = await Promise.all([fitQuote(input), quoteContext(input)]);
  return { ok: true, fit, context, warnings: quoteWarnings(input) };
}

export async function saveQuoteAction(values: QuoteValues, quoteId: string | null, vehicleId: string | null): Promise<QuoteSave> {
  const out = await saveQuote(values, quoteId, vehicleId);
  if (out.ok) revalidatePath("/quote");
  return out;
}

export async function bookQuoteAction(values: QuoteValues, pick: { vehicleId: string; driverId: string | null }, override: Override | null, quoteId: string | null): Promise<BookResult> {
  const out = await bookQuote(values, pick, override, quoteId);
  if (out.ok) {
    for (const path of ["/quote", "/loads", "/dispatch", "/planner", "/alerts", "/audit", "/kpi"]) revalidatePath(path);
    revalidatePath("/", "layout");
  }
  return out;
}

export async function passQuoteAction(id: string, reason: string, notes: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const out = await passQuote(id, reason, notes);
  if (out.ok) {
    revalidatePath("/quote");
    revalidatePath("/audit");
  }
  return out;
}

export async function discardQuoteAction(id: string): Promise<{ ok: boolean }> {
  const ok = await discardQuote(id);
  if (ok) revalidatePath("/quote");
  return { ok };
}

// ── Editing a load, entering a trip, billing ───────────────────────────────────────────────────

/** Everything that shows a load or its money has to look again after one of these. */
function refreshLoads() {
  for (const path of ["/loads", "/dispatch", "/planner", "/alerts", "/audit", "/kpi", "/invoices", "/customers", "/lanes"]) revalidatePath(path);
  revalidatePath("/", "layout");
}

export async function saveLoadDetailsAction(loadId: string, values: LoadEditValues): Promise<EditResult> {
  const out = await saveLoadDetails(loadId, values);
  if (out.ok && out.changed) refreshLoads();
  return out;
}

export async function deleteLoadAction(loadId: string, reason: string, note: string): Promise<RemoveResult> {
  const out = await deleteLoad({ loadId, reason, note });
  if (out.ok) refreshLoads();
  return out;
}

export async function restoreLoadAction(loadId: string): Promise<RemoveResult> {
  const out = await restoreLoad(loadId);
  if (out.ok) refreshLoads();
  return out;
}

export async function startTripAction(loadId: string, values: StartValues): Promise<TripResult> {
  const out = await startTrip(loadId, values);
  if (out.ok) refreshLoads();
  return out;
}

export async function completeTripAction(loadId: string, values: CompleteValues): Promise<TripResult> {
  const out = await completeTrip(loadId, values);
  if (out.ok) refreshLoads();
  return out;
}

export async function saveExpensesAction(loadId: string, values: ExpenseValues): Promise<TripResult & { changed?: boolean }> {
  const out = await saveExpenses(loadId, values);
  if (out.ok && out.changed) refreshLoads();
  return out;
}

export async function invoiceLoadAction(loadId: string, form: InvoiceForm): Promise<InvoiceOut> {
  const out = await invoiceLoad(loadId, { form });
  if (out.ok) refreshLoads();
  return out;
}

/** Mark an invoice paid with the amount that came in; blank means the invoice total. */
export async function paidAction(loadId: string, amount: string, paidOn = "", method = ""): Promise<PaidOut> {
  const text = amount.trim().replace(/,/g, "");
  const typed = text === "" ? undefined : Number(text);
  const out = await markLoadPaid(loadId, new Date(), { amount: typed, paidOn, method });
  if (out.ok) refreshLoads();
  return out;
}

export async function undoPaidAction(formData: FormData) {
  const loadId = String(formData.get("loadId"));
  await attempt(loadId, async () => {
    const out = await undoPaid(loadId, String(formData.get("reason") ?? ""));
    if (!out.ok) throw new DispatchError("not_allowed", out.error ?? "That payment cannot be taken back.");
    return "Payment taken back. The invoice is out again.";
  });
}

// ── Driver statements ──────────────────────────────────────────────────────────────────────────

function refreshSettlements(id?: string) {
  for (const path of ["/settlements", "/audit", "/loads", "/drivers"]) revalidatePath(path);
  if (id) revalidatePath(`/settlements/${id}`);
  revalidatePath("/", "layout");
}

export async function startSettlementAction(input: { driverId: string; start: string; end: string }): Promise<SettleResult> {
  const out = await startSettlement(input);
  if (out.ok) refreshSettlements();
  return out;
}

export async function saveSettlementAction(id: string, draft: Draft): Promise<SettleResult> {
  const out = await saveDraft(id, draft);
  if (out.ok) refreshSettlements(id);
  return out;
}

export async function finalizeSettlementAction(id: string, draft: Draft): Promise<SettleResult> {
  const out = await finalizeSettlement(id, draft);
  if (out.ok) refreshSettlements(id);
  return out;
}

export async function voidSettlementAction(id: string, reason: string): Promise<SettleResult> {
  const out = await voidSettlement(id, reason);
  if (out.ok) refreshSettlements(id);
  return out;
}

export async function discardSettlementAction(id: string): Promise<SettleResult> {
  const out = await discardSettlement(id);
  if (out.ok) refreshSettlements();
  return out;
}
