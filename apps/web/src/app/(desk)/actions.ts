"use server";

import { asLimit } from "@/lib/quote-nearest";
import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { beginOAuth, disconnectOAuth, type BeginResult } from "@/server/partners/oauth";
import { originOf } from "@/server/partners/origin";
import { journalFile, saveAccounts, type SaveAccountsResult } from "@/server/partners/accounting";
import type { AccountsForm } from "@/lib/accounting-map";
import { syncAccounting, type AccountingSyncResult } from "@/server/partners/qbo-sync";
import { SLEEP_COOKIE, THEME_COOKIE, UI_COOKIE, asSleepMinutes, asTheme, asUi } from "@/lib/appearance";
import { redirect, RedirectType } from "next/navigation";
import { prisma } from "@/lib/db";
import { checkAccess, requireCan } from "@/server/tl/access";
import { removeLoadDocument, type DocResult } from "@/server/tl/documents";
import { addMember, setMemberGrants, removeMember, setMemberRole, type MemberResult } from "@/server/tl/members";
import { assignDriver, dispatchLoad, DispatchError, recordDriverResponse, unassignLoad } from "@/server/tl/dispatch";
import { isRecallCode } from "@/lib/recall-reasons";
import { RelayError, acknowledgeDiscrepancy, flagDiscrepancy, receiveHandoff, recordDrop } from "@/server/tl/relay";
import type { MilesSource } from "@/lib/relay";
import { retryBridgeDelivery } from "@/server/bridge/retry";
import { setWorkspaceTimezone } from "@/server/tl/zone-setting";
import { ZONE_COOKIE } from "@/lib/tz";
import { cancelLoad, recordTonu, reopenCancelled, rescheduleLoad } from "@/server/tl/disruptions";
import { invoiceLoad, markLoadPaid } from "@/server/tl/invoicing";
import { parseCentralLocal } from "@/lib/zoned";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { pickupClock, stopClocksOf } from "@/server/tl/stop-clock";
import { workspaceTimezone } from "@/server/tl/zone";
import { saveThresholds } from "@/server/tl/thresholds";
import { saveLeakIntake, type IntakeSave } from "@/server/tl/leak-intake";
import { acknowledgeSignal, saveSignalSettings } from "@/server/tl/signals";
import type { SignalSettings } from "@/lib/signal-settings";
import { saveCompany } from "@/server/tl/company";
import { saveCustomer, type SaveCustomerResult } from "@/server/tl/customers";
import type { CustomerValues } from "@/lib/customer";
import type { CompanyValues } from "@/lib/company";
import { saveKpiNote, setLaneTarget, type InputResult } from "@/server/tl/kpi-inputs";
import { applySchedule, clearSchedule, removeTimeOff, saveSchedule, saveTimeOff, type ShiftResult, type TimeOffInput } from "@/server/tl/shifts";
import { addTerminal, archiveTerminal, renameTerminal, setDriverCode, setDriversHome, type TerminalResult } from "@/server/tl/terminal-list";
import { recordAdvance, saveDeduction, setAdvanceActive, setDeductionActive, type AdvanceSave, type DeductionSave } from "@/server/tl/deductions";
import { saveCostProfile, saveDriver, saveDriverTax, saveTruck, setDriverActive, setTruckArchived, type ActResult, type SaveResult } from "@/server/tl/fleet";
import type { DriverTaxValues, DriverValues, ProfileKey, TruckValues } from "@/lib/fleet-forms";
import type { Thresholds } from "@/lib/thresholds";
import type { PayKind } from "@/server/tl/projector";
import { quoteWarnings, readQuote, type QuoteValues } from "@/lib/quote";
import { bookQuote, discardQuote, fitQuote, listQuotes, passQuote, quoteContext, saveQuote, type BookResult, type FitResult, type Override, type QuoteContext, type QuoteListRow, type QuoteSave } from "@/server/tl/quote";
import type { LoadEditValues } from "@/lib/load-edit";
import type { InvoiceForm } from "@/lib/invoicing";
import type { CompleteValues, CorrectValues, ExpenseValues, StartValues } from "@/lib/trip";
import { saveLoadDetails, type EditResult } from "@/server/tl/edit";
import { assignFromQueue, assignOptions, type AssignOptions, type AssignOutcome } from "@/server/tl/suggest";
import { currentTerminal } from "@/server/tl/terminal";
import { assignTrailerToLoad, hookTrailer, saveTrailer, setTrailerArchived, type AssignTrailerResult, type SaveResult as TrailerSaveResult } from "@/server/tl/trailers";
import { connectPartner, disconnectPartner, retryConnection, type ConnectResult } from "@/server/partners/connections";
import { deleteCredential } from "@/server/partners/credentials";
import { capabilityOf, saveKeysAndConnect, type SaveAndConnect } from "@/server/partners/setup";
import { importEldFleet, type ImportEldResult } from "@/server/partners/eld-import";
import { adjustTrailerDwell, clearTrailerDwell, waiveTrailerDwell, type DwellInput, type DwellResult } from "@/server/tl/dwell";
import { logCheckCall, removeCheckCall, type CheckCallInput, type CheckCallResult } from "@/server/tl/check-calls";
import { addRegion, archiveRegion, renameRegion, setMemberScope, setTerminalRegion, type MemberScopeInput, type RegionResult } from "@/server/tl/regions";
import { sendTestEvent, type TestEventResult } from "@/server/partners/test-event";
import { shareLoadLocation, type ShareResult } from "@/server/partners/tracking";
import { syncFuelCards, type FuelSync } from "@/server/partners/fuel-store";
import { clearFuelFlag, reopenFuelFlag, type FlagReviewResult } from "@/server/partners/fuel-flags";
import { commitFuelImport, previewFuelImport, removeFuelImport, type FuelImportMap, type FuelImportPreview, type FuelImportResult, type RemoveFuelImportResult } from "@/server/partners/fuel-import";
import { calculateIfta, type IftaResult } from "@/server/partners/ifta";
import { applyFactoringUpdate, factorInvoice, type FactorResult } from "@/server/partners/factoring";
import { syncEld, type SyncResult } from "@/server/partners/eld";
import { importFuelForLoad, saveFuelCard, type FuelCardResult, type SaveFuelCard } from "@/server/partners/fuel-card";
import { vetDriverCarrier, type VetResult } from "@/server/partners/vetting";
import { sendToPayroll, type SendResult } from "@/server/partners/payroll";
import { markThreadRead, sendMessage, type SendResult as SendMessageResult } from "@/server/tl/messages";
import { commitImport, locateHomeBases, previewImport, type ImportPreview, type ImportResult, type LocateResult } from "@/server/tl/import";
import { commitHistoryImport, previewHistoryImport, removeHistoryImport, type HistoryImportMap, type HistoryImportPreview, type HistoryImportResult, type RemoveHistoryResult } from "@/server/tl/tracker-import";
import { commitLoadImport, previewLoadImport, removeLoadImport, type LoadImportMap, type LoadImportPreview, type LoadImportResult, type RemoveImportResult } from "@/server/tl/load-import";
import type { ImportKind } from "@/lib/import-csv";
import { deleteLoad, restoreLoad, type RemoveResult } from "@/server/tl/remove";
import { saveBillingDetails, type BillingResult } from "@/server/tl/billing-details";
import type { BillingDetailsValues } from "@/lib/billing-details";
import { completeTrip, correctTrip, reopenDelivered, saveExpenses, startTrip, undoStartTrip, type TripResult } from "@/server/tl/execution";
import { undoPaid, recordChase, voidInvoice, invoiceLoads, issueCreditMemo, voidCreditMemo, type CreditOut, type InvoiceOut, type MultiInvoiceOut, type PaidOut } from "@/server/tl/invoicing";
import { waiveDetention } from "@/server/tl/detention";
import { saveFactoringTerms, type SaveTermsResult } from "@/server/partners/factoring-terms";
import { recordChargeback, type ChargebackResult } from "@/server/partners/factoring";
import { cancelFactoringBatch, retryFactoringBatch, sendFactoringBatch, type BatchResult, type RetryResult } from "@/server/partners/factoring-batch";
import { importFactorStatus, type ImportResult as FactorStatusResult } from "@/server/partners/factor-status-import";
import type { TermsForm } from "@/lib/factoring-terms";
import { confirmStopEvidence, dismissStopEvidence, type ConfirmValues, type DecisionResult } from "@/server/tl/detention-evidence";
import { discardSettlement, finalizeSettlement, markSettlementPaid, saveDraft, startSettlement, voidSettlement, type Draft, type SettleResult } from "@/server/tl/settlement";
import { checkAttachment } from "@/lib/attachments";
import { readRateCon } from "@/server/ratecon/reader";
import { claimRead, noteRead, readMeter } from "@/server/ratecon/meter";
import { releaseUsage } from "@/server/tl/usage";
import { MAX_RATE_CON_PAGES, pdfPageCount } from "@/lib/pdf-pages";
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
    if (e instanceof DispatchError || e instanceof RelayError) return back(loadId, "error", e.message);
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
  await requireCan("dispatch");
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
  await requireCan("read");
  return assignOptions(loadId);
}

/** Assign from the queue or the planner. Answers in place (no redirect), and everything that shows a load looks again. */
export async function assignFromQueueAction(input: { loadId: string; driverId: string; payKind: string; rate: string; overrideReason?: string }): Promise<AssignOutcome> {
  await requireCan("dispatch");
  const out = await assignFromQueue(input);
  if (out.ok) refreshLoads();
  return out;
}

export async function unassignAction(formData: FormData) {
  await requireCan("dispatch");
  const loadId = String(formData.get("loadId"));
  // A recall (the driver was already sent the load) carries a reason code and an optional note; a driver who was never sent it comes off with neither.
  const code = String(formData.get("reasonCode") ?? "");
  const note = String(formData.get("reasonNote") ?? formData.get("reason") ?? "");
  await attempt(loadId, async () => {
    // A driver who was already rolling empty to the pickup keeps the miles they drove, with where the figure came from (a closed positioning leg, paid at their own cents a mile).
    const rolling = formData.get("rolling") === "1";
    const miles = String(formData.get("milesDriven") ?? "").trim();
    const positioning = rolling ? { milesDriven: miles === "" ? null : Number(miles), milesSource: (String(formData.get("milesSource") ?? "") || null) as MilesSource | null } : undefined;
    await unassignLoad(loadId, note, undefined, undefined, undefined, isRecallCode(code) ? code : null, positioning);
    return code ? "Driver recalled. The load is back in Needs a driver." : "Driver removed. The load is back on the board.";
  });
}

const field = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const numField = (f: FormData, k: string): number | null => {
  const v = field(f, k);
  return v === "" ? null : Number(v);
};
const yesNo = (f: FormData, k: string): boolean | null => (field(f, k) === "yes" ? true : field(f, k) === "no" ? false : null);

/** The driver left the load at a place (docs/RELAY_DESIGN.md): recorded by the dispatcher for the driver until the phone can do it. The load waits in the yard for the next driver. */
export async function dropAction(formData: FormData) {
  await requireCan("dispatch");
  const loadId = String(formData.get("loadId"));
  await attempt(loadId, async () => {
    await recordDrop(loadId, {
      type: field(formData, "type"),
      reason: field(formData, "reason"),
      locationName: field(formData, "locationName") || null,
      lat: numField(formData, "lat"),
      lng: numField(formData, "lng"),
      slot: field(formData, "slot") || null,
      locationSetBy: field(formData, "lat") !== "" ? "emergency_pin" : "dispatcher_typed",
      outgoingNext: field(formData, "outgoingNext"),
      sealNumber: field(formData, "sealNumber") || null,
      reeferSetTemp: numField(formData, "reeferSetTemp"),
      reeferActualTemp: numField(formData, "reeferActualTemp"),
      reeferFuelPct: numField(formData, "reeferFuelPct"),
      conditionOk: yesNo(formData, "conditionOk"),
      conditionNotes: field(formData, "conditionNotes") || null,
      milesDriven: numField(formData, "milesDriven"),
      milesSource: field(formData, "milesSource") || null
    });
    return "Handoff recorded. The load is waiting in the yard for its next driver.";
  });
}

/** The next driver took the load (their tap, entered by the dispatcher for them until the phone can). */
export async function receiveAction(formData: FormData) {
  await requireCan("dispatch");
  const loadId = String(formData.get("loadId"));
  await attempt(loadId, async () => {
    await receiveHandoff(field(formData, "handoffId"), {
      driverId: field(formData, "driverId"),
      vehicleId: field(formData, "vehicleId") || null,
      pay: { kind: field(formData, "payKind") as PayKind, rate: Number(field(formData, "rate")) },
      sealMatches: yesNo(formData, "sealMatches"),
      conditionOk: yesNo(formData, "conditionOk"),
      conditionNotes: field(formData, "conditionNotes") || null,
      overrideReason: field(formData, "overrideReason") || null
    });
    return "Handoff received. The next driver has the load.";
  });
}

/** Something is wrong at the handoff: the baton is frozen as found and custody waits for dispatch. */
export async function discrepancyAction(formData: FormData) {
  await requireCan("dispatch");
  const loadId = String(formData.get("loadId"));
  await attempt(loadId, async () => {
    await flagDiscrepancy(field(formData, "handoffId"), { notes: field(formData, "notes"), raisedBy: field(formData, "raisedBy") === "incoming_driver" ? "incoming_driver" : "dispatcher" });
    return "Discrepancy recorded. The handoff is frozen as found until it is acknowledged.";
  });
}

export async function acknowledgeDiscrepancyAction(formData: FormData) {
  await requireCan("dispatch");
  const loadId = String(formData.get("loadId"));
  await attempt(loadId, async () => {
    await acknowledgeDiscrepancy(field(formData, "handoffId"));
    return "Discrepancy acknowledged. The next driver can take the load.";
  });
}

export async function sendAction(formData: FormData) {
  await requireCan("dispatch");
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

/** Try again to put a load on the driver's phone after it could not be delivered. The same delivery the schedule makes, asked for now. */
export async function retryBridgeAction(formData: FormData) {
  await requireCan("dispatch");
  const loadId = String(formData.get("loadId"));
  await attempt(loadId, async () => {
    const r = await retryBridgeDelivery(loadId);
    if (r === "nothing") throw new DispatchError("not_sent", "There is nothing waiting to be delivered for this load.");
    return r === "delivered" ? "Delivered to the driver's phone." : "Still could not reach the driver's phone. It will keep trying.";
  });
}

export async function respondAction(formData: FormData) {
  await requireCan("dispatch");
  const loadId = String(formData.get("loadId"));
  const answer = formData.get("response");
  const response = answer === "declined" ? "declined" : "accepted";
  const note = String(formData.get("note") ?? "").trim();
  await attempt(loadId, async () => {
    // The answer is what was pressed, never a default: a form sent some other way (Enter in the note) answers nothing.
    if (answer !== "accepted" && answer !== "declined") throw new DispatchError("bad_reason", "Press Driver accepts or Driver declines.");
    // A no is kept with its reason: the next dispatcher to look at the load needs to know why.
    if (response === "declined" && note.length < 3) throw new DispatchError("reason_required", "Say why the driver declined. It is kept with the answer.");
    await recordDriverResponse(loadId, response, new Date(), note || undefined);
    return response === "accepted" ? "Driver accepted." : "Driver declined. Pick another driver.";
  });
}

// ── When a load falls through or moves ────────────────────────────────────────────────────────

const text = (formData: FormData, key: string) => String(formData.get(key) ?? "");

export async function cancelAction(formData: FormData) {
  await requireCan("dispatch");
  const loadId = text(formData, "loadId");
  await attempt(loadId, async () => {
    await cancelLoad({ loadId, reason: text(formData, "reason"), note: text(formData, "note") });
    return "Load cancelled. The reason is in the audit log.";
  });
}

export async function tonuAction(formData: FormData) {
  await requireCan("dispatch");
  const loadId = text(formData, "loadId");
  await attempt(loadId, async () => {
    await recordTonu({ loadId, reason: text(formData, "reason"), note: text(formData, "note"), fee: Number(text(formData, "fee")) });
    return "TONU recorded. The fee counts as revenue on the load.";
  });
}

export async function rescheduleAction(formData: FormData) {
  await requireCan("dispatch");
  const loadId = text(formData, "loadId");
  await attempt(loadId, async () => {
    // The new pickup is typed on the clock at the pickup (the dock's time), as the dialog says.
    const ws = currentWorkspaceId();
    const at = parseCentralLocal(text(formData, "pickup"), pickupClock(await stopClocksOf(loadId, ws), await workspaceTimezone(ws)));
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
  await requireCan("read");
  const out = await readRateCon({ fileName });
  return out.ok ? { ok: true, source: out.source, fileName, draft: toDto(out.draft) } : { ok: false, reason: out.reason };
}

/** The most a rate confirmation file can be: a phone photo of two pages is a few megabytes. Matches `serverActions.bodySizeLimit`. */
const MAX_RATE_CON_BYTES = 10 * 1024 * 1024;

/** A file chosen or dropped on the page. A sample's name still reads without a key; anything else needs one. */
export async function readUploadedRateConAction(formData: FormData): Promise<ReadResult> {
  await requireCan("dispatch");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, reason: "unreadable" };
  if (file.size > MAX_RATE_CON_BYTES) return { ok: false, reason: "too_big" };
  // An uploaded file is a paid read (the samples have their own buttons, readSampleRateConAction), so it is held to the daily meter and its type is taken from the file's own bytes,
  // not from what the browser said it was.
  const checked = checkAttachment(file.name, file.type, new Uint8Array(await file.arrayBuffer()));
  if (!checked.ok) return { ok: false, reason: checked.code === "too_big" ? "too_big" : "unsupported_file" };
  // A PDF with more pages than a rate confirmation has is refused before anything is spent on it.
  if (checked.type.mime === "application/pdf" && pdfPageCount(checked.data) > MAX_RATE_CON_PAGES) return { ok: false, reason: "too_many_pages" };
  const meter = await readMeter();
  if (!meter.ok) return { ok: false, reason: meter.reason };
  // The claim on paid spend comes before the call and is checked in one step, so a burst of reads cannot all pass; a read that never reaches the service gives it back.
  const claim = await claimRead();
  if (!claim.ok) return { ok: false, reason: claim.reason };
  const out = await readRateCon({ fileName: file.name, mime: checked.type.mime, bytes: checked.data });
  // A file that never reached the service (no key here, a type it cannot read) cost nothing and is not counted.
  if (out.ok || out.reason === "unreadable" || out.reason === "refused" || out.reason === "upstream_error") await noteRead(out.ok, file.name);
  else await releaseUsage(claim.claim);
  return out.ok ? { ok: true, source: out.source, fileName: file.name, draft: toDto(out.draft) } : { ok: false, reason: out.reason };
}

export async function saveRateConAction(dto: DraftDto, confirmed: boolean, vehicleId: string | null = null, fileName: string | null = null, allowDuplicate = false): Promise<{ ok: true; loadId: string } | { ok: false; error: string; duplicateOf?: string }> {
  await requireCan("dispatch");
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
  await requireCan("dispatch");
  const out = await saveDriver(values, id);
  if (out.ok) refreshFleet();
  return out;
}

/** A driver's 1099 tax profile: the billing office's, as sending pay is (payout). Never the full SSN or EIN: the save refuses more than four digits. */
export async function saveDriverTaxAction(values: Record<string, string>, id: string): Promise<SaveResult<keyof DriverTaxValues>> {
  await requireCan("payout");
  const out = await saveDriverTax(values, id);
  if (out.ok && out.changed) refreshFleet();
  return out;
}

// ── What a person types on the KPI screens: a lane's target rate and the note for the weekly call (dispatch or billing) ──

export async function setLaneTargetAction(lane: string, rate: string): Promise<InputResult> {
  await requireCan("dispatch", "bill");
  const out = await setLaneTarget(lane, rate);
  if (out.ok && out.changed) revalidatePath("/", "layout");
  return out;
}

export async function saveKpiNoteAction(weekKey: string, body: string): Promise<InputResult> {
  await requireCan("dispatch", "bill");
  const out = await saveKpiNote(weekKey, body);
  if (out.ok && out.changed) revalidatePath("/kpi/report");
  return out;
}

// ── Shifts, time off, driver codes and terminals (docs/DRIVER_SHIFTS.md). Shifts and homes are the roster's (a driver manager or an admin); the terminal list itself is an admin's. ──

export async function saveScheduleAction(driverId: string, week: unknown, force = false): Promise<ShiftResult> {
  await requireCan("roster");
  const out = await saveSchedule(driverId, week, { force });
  if (out.ok) refreshFleet();
  return out;
}

export async function applyScheduleAction(driverIds: string[], week: unknown, force = false): Promise<ShiftResult> {
  await requireCan("roster");
  const out = await applySchedule(driverIds, week, { force });
  if (out.ok) refreshFleet();
  return out;
}

export async function clearScheduleAction(driverId: string): Promise<ShiftResult> {
  await requireCan("roster");
  const out = await clearSchedule(driverId);
  if (out.ok) refreshFleet();
  return out;
}

export async function saveTimeOffAction(driverId: string, input: TimeOffInput, force = false): Promise<ShiftResult> {
  await requireCan("roster");
  const out = await saveTimeOff(driverId, input, { force });
  if (out.ok) refreshFleet();
  return out;
}

export async function removeTimeOffAction(driverId: string, dateKey: string, force = false): Promise<ShiftResult> {
  await requireCan("roster");
  const out = await removeTimeOff(driverId, dateKey, { force });
  if (out.ok) refreshFleet();
  return out;
}

export async function setDriversHomeAction(driverIds: string[], terminal: string | null): Promise<TerminalResult> {
  await requireCan("roster");
  const out = await setDriversHome(driverIds, terminal);
  if (out.ok) refreshFleet();
  return out;
}

export async function setDriverCodeAction(id: string, code: string): Promise<TerminalResult> {
  await requireCan("roster");
  const out = await setDriverCode(id, code);
  if (out.ok) refreshFleet();
  return out;
}

export async function addTerminalAction(input: { name: string; city?: string | null; note?: string | null }): Promise<TerminalResult> {
  await requireCan("admin");
  const out = await addTerminal(input);
  if (out.ok) refreshFleet();
  return out;
}

export async function renameTerminalAction(id: string, name: string): Promise<TerminalResult> {
  await requireCan("admin");
  const out = await renameTerminal(id, name);
  if (out.ok) refreshFleet();
  return out;
}

export async function archiveTerminalAction(id: string): Promise<TerminalResult> {
  await requireCan("admin");
  const out = await archiveTerminal(id);
  if (out.ok) refreshFleet();
  return out;
}

// ── A dropped trailer's dwell figure: the company's terms are the start, and a dispatcher or a billing person has the last word (docs/TELEMATICS_RADAR.md). ──

export async function adjustTrailerDwellAction(trailerId: string, input: DwellInput): Promise<DwellResult> {
  await requireCan("dispatch", "bill");
  const out = await adjustTrailerDwell(String(trailerId), input && typeof input === "object" ? input : {});
  if (out.ok) revalidatePath("/trailers");
  return out;
}

export async function waiveTrailerDwellAction(trailerId: string, note: string | null): Promise<DwellResult> {
  await requireCan("dispatch", "bill");
  const out = await waiveTrailerDwell(String(trailerId), typeof note === "string" ? note : null);
  if (out.ok) revalidatePath("/trailers");
  return out;
}

export async function clearTrailerDwellAction(trailerId: string): Promise<DwellResult> {
  await requireCan("dispatch", "bill");
  const out = await clearTrailerDwell(String(trailerId));
  if (out.ok) revalidatePath("/trailers");
  return out;
}

// ── Regions and what a person may see (an admin's): docs/SCOPE.md ──

export async function addRegionAction(input: { name: string; note?: string | null }): Promise<RegionResult> {
  await requireCan("admin");
  const out = await addRegion({ name: String(input?.name ?? ""), note: typeof input?.note === "string" ? input.note : null });
  if (out.ok) refreshFleet();
  return out;
}

export async function renameRegionAction(id: string, name: string): Promise<RegionResult> {
  await requireCan("admin");
  const out = await renameRegion(String(id), String(name ?? ""));
  if (out.ok) refreshFleet();
  return out;
}

export async function archiveRegionAction(id: string): Promise<RegionResult> {
  await requireCan("admin");
  const out = await archiveRegion(String(id));
  if (out.ok) refreshFleet();
  return out;
}

export async function setTerminalRegionAction(terminalId: string, regionId: string | null): Promise<RegionResult> {
  await requireCan("admin");
  const out = await setTerminalRegion(String(terminalId), regionId ? String(regionId) : null);
  if (out.ok) refreshFleet();
  return out;
}

export async function setMemberScopeAction(memberId: string, input: MemberScopeInput): Promise<RegionResult> {
  await requireCan("admin");
  const out = await setMemberScope(String(memberId), { regionIds: Array.isArray(input?.regionIds) ? input.regionIds.map(String) : [], terminals: Array.isArray(input?.terminals) ? input.terminals.map(String) : [] });
  if (out.ok) refreshFleet();
  return out;
}

// ── Check calls on a truck or a trailer: what the driver said, and when, kept with the asset (docs/ASSET_HISTORY.md). ──

export async function logCheckCallAction(input: CheckCallInput): Promise<CheckCallResult> {
  await requireCan("dispatch");
  const out = await logCheckCall(input && typeof input === "object" ? input : ({} as CheckCallInput));
  if (out.ok) {
    revalidatePath("/fleet");
    revalidatePath("/trailers");
  }
  return out;
}

export async function removeCheckCallAction(id: string): Promise<ActResult> {
  await requireCan("dispatch");
  const out = await removeCheckCall(String(id));
  if (out.ok) {
    revalidatePath("/fleet");
    revalidatePath("/trailers");
  }
  return out;
}

export async function setDriverActiveAction(id: string, active: boolean): Promise<ActResult> {
  await requireCan("dispatch");
  const out = await setDriverActive(id, active);
  if (out.ok) refreshFleet();
  return out;
}

export async function saveTruckAction(values: Record<string, string>, id: string | null): Promise<SaveResult<keyof TruckValues>> {
  await requireCan("dispatch");
  const out = await saveTruck(values, id);
  if (out.ok) refreshFleet();
  return out;
}

export async function setTruckArchivedAction(id: string, archived: boolean): Promise<ActResult> {
  await requireCan("dispatch");
  const out = await setTruckArchived(id, archived);
  if (out.ok) refreshFleet();
  return out;
}

export async function saveTrailerAction(values: Record<string, string>, id: string | null): Promise<TrailerSaveResult> {
  await requireCan("dispatch");
  const out = await saveTrailer(values, id);
  if (out.ok) refreshFleet();
  return out;
}

export async function setTrailerArchivedAction(id: string, archived: boolean): Promise<ActResult> {
  await requireCan("dispatch");
  const out = await setTrailerArchived(id, archived);
  if (out.ok) refreshFleet();
  return out;
}

/** Hook a trailer to a tractor (by the tractor's id), or unhook it with an empty id. */
export async function hookTrailerAction(id: string, vehicleId: string): Promise<ActResult> {
  await requireCan("dispatch");
  const out = await hookTrailer(id, vehicleId || null);
  if (out.ok) refreshFleet();
  return out;
}

/** Put a trailer on a load, or take it off with an empty id. */
export async function assignTrailerAction(loadId: string, trailerId: string): Promise<AssignTrailerResult> {
  await requireCan("dispatch");
  const out = await assignTrailerToLoad(loadId, trailerId || null);
  if (out.ok) {
    revalidatePath("/loads", "layout");
    revalidatePath("/trailers", "layout");
  }
  return out;
}

export async function saveCostProfileAction(vehicleId: string, values: Record<string, string>): Promise<SaveResult<ProfileKey> & { floors?: { breakEven: number; survival: number } }> {
  await requireCan("dispatch");
  const out = await saveCostProfile(vehicleId, values);
  if (out.ok) refreshFleet();
  return out;
}

// ── Thresholds (Settings) ──────────────────────────────────────────────────────────────────────

/** Checks and saves the thresholds the form sent. Everything that reads them (alerts, the KPI lines, invoice terms) refreshes. */
export async function saveThresholdsAction(values: Record<string, string>): Promise<{ ok: true; changed: boolean } | { ok: false; errors: Partial<Record<keyof Thresholds, string>> }> {
  await requireCan("admin");
  const out = await saveThresholds(values);
  if (!out.ok) return { ok: false, errors: out.errors };
  revalidatePath("/", "layout");
  return { ok: true, changed: out.changed ?? false };
}

/**
 * Saves the Leak Read intake (docs/LEAK_LEDGER.md): what a mile costs and the detention terms that price imported history in the Leak ledger. For the billing office, the same people who read the ledger,
 * because it decides the dollars on it. Saving what is already stored writes nothing.
 */
export async function saveLeakIntakeAction(values: unknown): Promise<IntakeSave> {
  await requireCan("bill");
  const out = await saveLeakIntake(values);
  if (out.ok) revalidatePath("/", "layout");
  return out;
}

/** Says someone is on a signal (docs/SIGNALS.md): it leaves the open list until it clears or gets worse. Held to the person's own scope on the server. */
export async function acknowledgeSignalAction(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireCan("dispatch");
  const out = await acknowledgeSignal(id);
  if (out.ok) {
    revalidatePath("/signals");
    revalidatePath("/audit");
  }
  return out;
}

/** What the desk tells people about and when the weekly report goes (Settings, Rules). */
export async function saveSignalSettingsAction(values: Record<string, string>): Promise<{ ok: true; changed: boolean } | { ok: false; errors: Partial<Record<keyof SignalSettings, string>> }> {
  await requireCan("admin");
  const out = await saveSignalSettings(values);
  if (!out.ok) return { ok: false, errors: out.errors };
  revalidatePath("/settings/rules");
  revalidatePath("/signals");
  return { ok: true, changed: out.changed ?? false };
}

/** The company on invoices and statements. Both sheets read it, so they refresh with the layout. */
export async function saveCompanyAction(values: CompanyValues): Promise<{ ok: true; changed: boolean } | { ok: false; errors: Partial<Record<keyof CompanyValues, string>> }> {
  await requireCan("admin");
  const out = await saveCompany(values);
  if (!out.ok) return { ok: false, errors: out.errors };
  revalidatePath("/", "layout");
  return { ok: true, changed: out.changed ?? false };
}

/** A customer's record. Its name is on loads, so everything that shows a load or a customer looks again. */
export async function saveCustomerAction(values: CustomerValues, id: string | null): Promise<SaveCustomerResult> {
  await requireCan("dispatch", "billing_details");
  const out = await saveCustomer(values, id);
  if (out.ok && out.changed) refreshLoads();
  return out;
}

// ── Appearance (Settings) ──────────────────────────────────────────────────────────────────────

/** The carrier's own clock. Admin only: it moves where days, weeks and months are counted for everyone on the desk. */
export async function saveTimezoneAction(formData: FormData) {
  await requireCan("admin");
  const out = await setWorkspaceTimezone(formData.get("timezone"));
  if (!out.ok) redirect("/settings?error=" + encodeURIComponent(out.error));
  // The page reads its clock from this cookie, so the person who changed it sees it at once; everyone else is brought to it on their next page (the shell checks it against the desk).
  cookies().set(ZONE_COOKIE, out.zone, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  revalidatePath("/", "layout");
  redirect("/settings?note=" + encodeURIComponent(out.changed ? "Time zone saved." : "That is already the time zone."));
}

export async function setAppearanceAction(formData: FormData) {
  await requireCan("read");
  const jar = cookies();
  const theme = formData.get("theme");
  const ui = formData.get("ui");
  const year = 60 * 60 * 24 * 365;
  if (typeof ui === "string") jar.set(UI_COOKIE, asUi(ui), { path: "/", maxAge: year, sameSite: "lax" });
  if (typeof theme === "string") jar.set(THEME_COOKIE, asTheme(theme), { path: "/", maxAge: year, sameSite: "lax" });
  const sleep = formData.get("sleep");
  if (typeof sleep === "string") jar.set(SLEEP_COOKIE, String(asSleepMinutes(sleep)), { path: "/", maxAge: year, sameSite: "lax" });
  revalidatePath("/", "layout");
  redirect("/settings?note=" + encodeURIComponent("Appearance saved."));
}

// ── Quote ──────────────────────────────────────────────────────────────────────────────────────

export type PricedQuote = { ok: true; fit: FitResult; context: QuoteContext; warnings: string[] } | { ok: false };

/** The offer priced as you type: the nearest trucks in the terminals in view (`limit` of them, 25 to start, 25 more at a time), each with the driver who runs it, plus what the desk already knows about the lane and the broker. Writes nothing. */
export async function priceQuoteAction(values: QuoteValues, limit?: number, keepTruckId?: string | null): Promise<PricedQuote> {
  await requireCan("read");
  const input = readQuote(values);
  if (!input) return { ok: false };
  const [fit, context] = await Promise.all([fitQuote(input, undefined, undefined, await currentTerminal(), asLimit(limit), keepTruckId ? [String(keepTruckId)] : []), quoteContext(input)]);
  return { ok: true, fit, context, warnings: quoteWarnings(input) };
}

/** Saved quotes, a page at a time, for the list's search and filter. */
export async function listQuotesAction(q: string, status: "open" | "passed" | "all", offset: number): Promise<{ rows: QuoteListRow[]; total: number }> {
  await requireCan("read");
  return listQuotes(undefined, { q, status, offset }, await currentTerminal());
}

export async function saveQuoteAction(values: QuoteValues, quoteId: string | null, vehicleId: string | null): Promise<QuoteSave> {
  await requireCan("quote");
  const out = await saveQuote(values, quoteId, vehicleId);
  if (out.ok) revalidatePath("/quote");
  return out;
}

export async function bookQuoteAction(values: QuoteValues, pick: { vehicleId: string; driverId: string | null }, override: Override | null, quoteId: string | null): Promise<BookResult> {
  await requireCan("quote");
  const out = await bookQuote(values, pick, override, quoteId);
  if (out.ok) {
    for (const path of ["/quote", "/loads", "/dispatch", "/planner", "/alerts", "/audit", "/kpi"]) revalidatePath(path);
    revalidatePath("/", "layout");
  }
  return out;
}

export async function passQuoteAction(id: string, reason: string, notes: string): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireCan("quote");
  const out = await passQuote(id, reason, notes);
  if (out.ok) {
    revalidatePath("/quote");
    revalidatePath("/audit");
  }
  return out;
}

export async function discardQuoteAction(id: string): Promise<{ ok: boolean }> {
  await requireCan("quote");
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
  await requireCan("dispatch");
  const out = await saveLoadDetails(loadId, values);
  if (out.ok && out.changed) refreshLoads();
  return out;
}

export async function saveBillingDetailsAction(loadId: string, values: BillingDetailsValues): Promise<BillingResult> {
  await requireCan("billing_details");
  const out = await saveBillingDetails(loadId, values);
  if (out.ok && out.changed) refreshLoads();
  return out;
}

export async function deleteLoadAction(loadId: string, reason: string, note: string): Promise<RemoveResult> {
  await requireCan("dispatch");
  const out = await deleteLoad({ loadId, reason, note });
  if (out.ok) refreshLoads();
  return out;
}

export async function restoreLoadAction(loadId: string): Promise<RemoveResult> {
  await requireCan("dispatch");
  const out = await restoreLoad(loadId);
  if (out.ok) refreshLoads();
  return out;
}

export async function startTripAction(loadId: string, values: StartValues): Promise<TripResult> {
  await requireCan("dispatch");
  const out = await startTrip(loadId, values);
  if (out.ok) refreshLoads();
  return out;
}

export async function undoStartAction(formData: FormData) {
  await requireCan("dispatch");
  const loadId = String(formData.get("loadId"));
  await attempt(loadId, async () => {
    const out = await undoStartTrip(loadId, String(formData.get("reason") ?? ""));
    if (!out.ok) throw new DispatchError("not_allowed", out.error ?? "That pickup cannot be taken back.");
    return "Pickup taken back. The driver has the load again.";
  });
}

export async function reopenDeliveredAction(formData: FormData) {
  await requireCan("dispatch");
  const loadId = String(formData.get("loadId"));
  await attempt(loadId, async () => {
    const out = await reopenDelivered(loadId, String(formData.get("reason") ?? ""));
    if (!out.ok) throw new DispatchError("not_allowed", out.error ?? "That delivery cannot be taken back.");
    return "Delivery taken back. The load is on the road again.";
  });
}

export async function reopenCancelledAction(formData: FormData) {
  await requireCan("dispatch");
  const loadId = String(formData.get("loadId"));
  await attempt(loadId, async () => {
    await reopenCancelled({ loadId, reason: String(formData.get("reason") ?? "") });
    return "Reopened. It is back on the board, needing a driver.";
  });
}

export async function completeTripAction(loadId: string, values: CompleteValues): Promise<TripResult> {
  await requireCan("dispatch");
  const out = await completeTrip(loadId, values);
  if (out.ok) refreshLoads();
  return out;
}

export async function correctTripAction(loadId: string, values: CorrectValues): Promise<TripResult & { changed?: boolean }> {
  await requireCan("figures");
  const out = await correctTrip(loadId, values);
  if (out.ok && out.changed) refreshLoads();
  return out;
}

export async function saveExpensesAction(loadId: string, values: ExpenseValues): Promise<TripResult & { changed?: boolean }> {
  await requireCan("figures");
  const out = await saveExpenses(loadId, values);
  if (out.ok && out.changed) refreshLoads();
  return out;
}

export async function invoiceLoadAction(loadId: string, form: InvoiceForm): Promise<InvoiceOut> {
  await requireCan("bill");
  const out = await invoiceLoad(loadId, { form });
  if (out.ok) refreshLoads();
  return out;
}

/** One invoice for several delivered loads of the same customer (docs/MONEY_PLAN.md, rule G). The server checks the same-customer rule again; the screen only explains it first. */
export async function invoiceLoadsAction(loadIds: string[], form: { number: string; terms: string }): Promise<MultiInvoiceOut> {
  await requireCan("bill");
  const out = await invoiceLoads(loadIds.slice(0, 60), { number: form.number.slice(0, 40), terms: form.terms.slice(0, 4) });
  if (out.ok) refreshLoads();
  return out;
}

/** Credit part or all of what is owed on an open invoice with a credit memo of its own (rule F). The amount is typed as dollars and cents and checked on the server. */
export async function creditMemoAction(loadId: string, amount: string, reason: string, label: string): Promise<CreditOut> {
  await requireCan("bill");
  const text = amount.trim().replace(/,/g, "");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) return { ok: false, error: "Type the amount to credit as dollars and cents, like 125.50." };
  const out = await issueCreditMemo(loadId, { amount: Number.parseFloat(text), reason: reason.slice(0, 200), label: label.slice(0, 80) });
  if (out.ok) refreshLoads();
  return out;
}

/** Take a credit memo back. A credit is money the customer was told it did not owe, so taking it back is an admin's (the same as a write-off). */
export async function voidCreditMemoAction(memoId: string, reason: string): Promise<CreditOut> {
  await requireCan("writeoff");
  const out = await voidCreditMemo(memoId, reason.slice(0, 200));
  if (out.ok) refreshLoads();
  return out;
}

/** The fleet's factoring terms (remit-to, notice wording, advance and fee). An admin's: they decide where customers are told to pay. */
export async function saveFactoringTermsAction(form: TermsForm): Promise<SaveTermsResult> {
  await requireCan("admin");
  const access = await checkAccess("admin");
  const out = await saveFactoringTerms(form, access.ok ? (access.identity.name ?? access.identity.email ?? "Admin") : "Admin");
  if (out.ok && out.changed) {
    revalidatePath("/settings");
    revalidatePath("/invoices");
    revalidatePath("/audit");
  }
  return out;
}

/** Send the invoices that are ready to the factor as one batch of files (schedule of accounts and packets), by the SFTP or email the factoring terms name. */
export async function sendFactoringBatchAction(invoiceIds?: string[]): Promise<BatchResult> {
  await requireCan("bill");
  const access = await checkAccess("bill");
  const out = await sendFactoringBatch({ invoiceIds: invoiceIds?.slice(0, 500), who: access.ok ? (access.identity.name ?? access.identity.email ?? undefined) : undefined, terminal: await currentTerminal() });
  if (out.ok) refreshLoads();
  return out;
}

/** Try a batch that did not reach the factor again. */
export async function retryFactoringBatchAction(batchId: string): Promise<RetryResult> {
  await requireCan("bill");
  const out = await retryFactoringBatch(batchId);
  if (out.ok) refreshLoads();
  return out;
}

/** Give a failed batch's invoices back, so they can go another way. */
export async function cancelFactoringBatchAction(batchId: string, reason: string): Promise<{ ok: boolean; error?: string }> {
  await requireCan("bill");
  const out = await cancelFactoringBatch(batchId, reason.slice(0, 200));
  if (out.ok) refreshLoads();
  return out;
}

/** Read a factor's status file and say what each line would do, writing nothing. */
export async function checkFactorStatusAction(text: string): Promise<FactorStatusResult> {
  await requireCan("bill");
  return importFactorStatus(text, { apply: false });
}

/** Apply a factor's status file: each line through the same steps a webhook takes; lines already true do nothing, so the same file twice changes nothing. */
export async function applyFactorStatusAction(text: string): Promise<FactorStatusResult> {
  await requireCan("bill");
  const out = await importFactorStatus(text, { apply: true });
  if (out.ok && out.counts.apply > 0) {
    refreshLoads();
    revalidatePath("/invoices/factoring");
  }
  return out;
}

/** The factor charged a funded invoice back (the customer did not pay it). */
export async function factoringChargebackAction(loadId: string, reason: string): Promise<ChargebackResult> {
  await requireCan("bill");
  const out = await recordChargeback(loadId, reason.slice(0, 200));
  if (out.ok) refreshLoads();
  return out;
}

/** Mark an invoice paid with the amount that came in; blank means the invoice total. */
export async function paidAction(
  loadId: string,
  amount: string,
  paidOn = "",
  method = "",
  shortAction: "balance" | "writeoff" = "balance",
  shortReason = "",
  extra: { reference?: string; payer?: string; shortCode?: string } = {}
): Promise<PaidOut> {
  await requireCan("bill");
  // Money that will never come in is written off by an admin; a person who only bills records what was received and leaves the rest owing.
  if (shortAction === "writeoff") await requireCan("writeoff");
  const text = amount.trim().replace(/,/g, "");
  const typed = text === "" ? undefined : Number(text);
  const out = await markLoadPaid(loadId, new Date(), { amount: typed, paidOn, method, shortAction: shortAction === "writeoff" ? "writeoff" : "balance", shortReason, reference: (extra.reference ?? "").slice(0, 80), payer: (extra.payer ?? "").slice(0, 120), shortCode: extra.shortCode });
  if (out.ok) refreshLoads();
  return out;
}

export async function voidInvoiceAction(formData: FormData) {
  await requireCan("bill");
  const loadId = String(formData.get("loadId"));
  await attempt(loadId, async () => {
    const out = await voidInvoice(loadId, String(formData.get("reason") ?? ""));
    if (!out.ok) throw new DispatchError("not_allowed", out.error ?? "That invoice cannot be taken back.");
    return "Invoice taken back. The load is ready to invoice again.";
  });
}

export async function chasedAction(loadId: string, how: "email" | "phone"): Promise<{ ok: boolean; error?: string }> {
  await requireCan("bill");
  const out = await recordChase(loadId, how === "phone" ? "phone" : "email");
  if (out.ok) revalidatePath("/invoices");
  return out;
}

/** A person accepts (or corrects, with why) what the truck's track showed at a stop: the stop's arrival and wait are written through the same correction every other one uses (docs/DETENTION_EVIDENCE.md). */
export async function confirmStopEvidenceAction(evidenceId: string, values: ConfirmValues): Promise<DecisionResult> {
  await requireCan("figures");
  const out = await confirmStopEvidence(evidenceId, values);
  if (out.ok) {
    refreshLoads();
    revalidatePath("/invoices");
    revalidatePath("/detention", "layout");
    revalidatePath("/audit");
  }
  return out;
}

/** A person says the track does not show a wait worth claiming, with why. Writes nothing to the stop. */
export async function dismissStopEvidenceAction(evidenceId: string, reason: string): Promise<DecisionResult> {
  await requireCan("figures");
  const out = await dismissStopEvidence(evidenceId, reason);
  if (out.ok) {
    revalidatePath("/invoices");
    revalidatePath("/detention", "layout");
    revalidatePath("/audit");
  }
  return out;
}

export async function waiveDetentionAction(loadId: string, reason: string): Promise<{ ok: boolean; error?: string }> {
  await requireCan("bill");
  const out = await waiveDetention(loadId, reason);
  if (out.ok) {
    refreshLoads();
    revalidatePath("/invoices");
  }
  return out;
}

export async function undoPaidAction(formData: FormData) {
  await requireCan("bill");
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
  await requireCan("bill");
  const out = await startSettlement(input);
  if (out.ok) refreshSettlements();
  return out;
}

export async function saveSettlementAction(id: string, draft: Draft): Promise<SettleResult> {
  await requireCan("bill");
  const out = await saveDraft(id, draft);
  if (out.ok) refreshSettlements(id);
  return out;
}

export async function finalizeSettlementAction(id: string, draft: Draft, confirmedTotal: number | null = null, confirmNegative = false): Promise<SettleResult> {
  await requireCan("bill");
  const out = await finalizeSettlement(id, draft, new Date(), undefined, confirmedTotal, confirmNegative === true);
  if (out.ok) refreshSettlements(id);
  return out;
}

/** A driver's recurring deductions and escrow: part of making their statements (bill). */
export async function saveDeductionAction(values: Record<string, string>, driverId: string, id: string | null): Promise<DeductionSave> {
  await requireCan("bill");
  const out = await saveDeduction(values, driverId, id);
  if (out.ok && out.changed) revalidatePath("/", "layout");
  return out;
}

export async function setDeductionActiveAction(id: string, active: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireCan("bill");
  const out = await setDeductionActive(id, active);
  if (out.ok) revalidatePath("/", "layout");
  return out;
}

/** Money given to a driver ahead of their pay: money out, so payout's act, like marking a statement paid. */
export async function recordAdvanceAction(values: Record<string, string>, driverId: string): Promise<AdvanceSave> {
  await requireCan("payout");
  const out = await recordAdvance(values, driverId);
  if (out.ok) revalidatePath("/", "layout");
  return out;
}

/** Pause or resume an advance's repayment: part of making statements (bill). */
export async function setAdvanceActiveAction(id: string, active: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireCan("bill");
  const out = await setAdvanceActive(id, active);
  if (out.ok) revalidatePath("/", "layout");
  return out;
}

export async function markSettlementPaidAction(id: string, paidOn: string, method: string): Promise<SettleResult> {
  await requireCan("payout");
  const out = await markSettlementPaid(id, { paidOn, method });
  if (out.ok) refreshSettlements(id);
  return out;
}

export async function voidSettlementAction(id: string, reason: string): Promise<SettleResult> {
  await requireCan("writeoff");
  const out = await voidSettlement(id, reason);
  if (out.ok) refreshSettlements(id);
  return out;
}

export async function discardSettlementAction(id: string): Promise<SettleResult> {
  await requireCan("bill");
  const out = await discardSettlement(id);
  if (out.ok) refreshSettlements();
  return out;
}

// ── Bulk import of trucks and drivers ──────────────────────────────────────────────────────────

const asKind = (k: unknown): ImportKind | null => (k === "trucks" || k === "drivers" || k === "trailers" ? k : null);

/** Reads a CSV and says what would be imported and what would not. Writes nothing. */
export async function previewImportAction(kind: ImportKind, text: string): Promise<ImportPreview> {
  await requireCan("read");
  const k = asKind(kind);
  if (!k || typeof text !== "string") return { ok: false, error: "That is not a file the desk can read." };
  return previewImport(k, text);
}

/** Imports the rows that pass, 500 at a time, with one entry in the audit log. */
export async function commitImportAction(kind: ImportKind, text: string, fileName: string): Promise<ImportResult> {
  await requireCan("dispatch");
  const k = asKind(kind);
  if (!k || typeof text !== "string") return { ok: false, error: "That is not a file the desk can read." };
  const out = await commitImport(k, text, typeof fileName === "string" ? fileName : "");
  if (out.ok) revalidatePath("/", "layout");
  return out;
}

/** Reads a CSV of finished loads against the column match and says what would be imported, what is already on the desk and what is wrong. Writes nothing. */
export async function previewLoadImportAction(text: string, mapping: LoadImportMap | null): Promise<LoadImportPreview> {
  await requireCan("dispatch");
  if (typeof text !== "string") return { ok: false, error: "That is not a file the desk can read." };
  return previewLoadImport(text, mapping && typeof mapping === "object" ? mapping : null);
}

/** Imports the loads that pass as finished loads marked with their batch, with one entry in the audit log. */
export async function commitLoadImportAction(text: string, mapping: LoadImportMap | null, fileName: string): Promise<LoadImportResult> {
  await requireCan("dispatch");
  if (typeof text !== "string") return { ok: false, error: "That is not a file the desk can read." };
  const out = await commitLoadImport(text, mapping && typeof mapping === "object" ? mapping : null, typeof fileName === "string" ? fileName : "");
  if (out.ok) revalidatePath("/", "layout");
  return out;
}

/** Takes a whole import away again (its loads are deleted, and can be restored one by one from the Deleted loads list). */
export async function removeLoadImportAction(batchId: string): Promise<RemoveImportResult> {
  await requireCan("dispatch");
  const out = await removeLoadImport(typeof batchId === "string" ? batchId : "");
  if (out.ok) revalidatePath("/", "layout");
  return out;
}

/** Reads a weekly-tracker CSV against the column match and says what would be imported as history, what is already there and what is wrong. Writes nothing. */
export async function previewHistoryImportAction(text: string, mapping: HistoryImportMap | null): Promise<HistoryImportPreview> {
  await requireCan("dispatch");
  if (typeof text !== "string") return { ok: false, error: "That is not a file the desk can read." };
  return previewHistoryImport(text, mapping && typeof mapping === "object" ? mapping : null);
}

/** Imports the lane-weeks that pass as imported history (never as loads), with one entry in the audit log. */
export async function commitHistoryImportAction(text: string, mapping: HistoryImportMap | null, fileName: string): Promise<HistoryImportResult> {
  await requireCan("dispatch");
  if (typeof text !== "string") return { ok: false, error: "That is not a file the desk can read." };
  const out = await commitHistoryImport(text, mapping && typeof mapping === "object" ? mapping : null, typeof fileName === "string" ? fileName : "");
  if (out.ok) revalidatePath("/", "layout");
  return out;
}

/** Takes a whole weekly-history import away again. */
export async function removeHistoryImportAction(batchId: string): Promise<RemoveHistoryResult> {
  await requireCan("dispatch");
  const out = await removeHistoryImport(typeof batchId === "string" ? batchId : "");
  if (out.ok) revalidatePath("/", "layout");
  return out;
}

/** Finds the next few trucks' home bases on the map; the screen calls it again with `next` until there is none. */
export async function locateHomeBasesAction(after: string | null): Promise<LocateResult> {
  await requireCan("dispatch");
  const out = await locateHomeBases(typeof after === "string" ? after : null);
  if (out.located > 0) revalidatePath("/fleet");
  return out;
}

// ── Partner companies (factoring, ELD, fuel cards, carrier vetting, payroll) ───────────────────

/** The factor's answer, entered by hand until a webhook is connected (the status only moves one allowed step; see FACTORING_NEXT). */
export async function factoringUpdateAction(loadId: string, status: string): Promise<{ ok: boolean; error?: string }> {
  await requireCan("bill");
  const moved = await applyFactoringUpdate(loadId, status, null);
  if (moved) refreshLoads();
  return moved ? { ok: true } : { ok: false, error: "That is not a step this invoice can take from where it is. Reload to see its status." };
}

export async function factorInvoiceAction(loadId: string, sendAnyway: boolean): Promise<FactorResult> {
  await requireCan("bill");
  const out = await factorInvoice(loadId, { sendAnyway: sendAnyway === true });
  if (out.ok) {
    revalidatePath("/invoices", "layout");
    revalidatePath("/audit");
  }
  return out;
}

export async function syncEldAction(): Promise<SyncResult> {
  await requireCan("dispatch");
  const out = await syncEld();
  if (out.ok) revalidatePath("/", "layout");
  return out;
}

/** Reads a trip's fuel from the truck's card. Writes nothing to the load: the screen decides whether to put the total in the box. */
export async function importFuelAction(loadId: string): Promise<FuelCardResult> {
  await requireCan("figures");
  return importFuelForLoad(loadId);
}

export async function saveFuelCardAction(vehicleId: string, provider: string, accountId: string): Promise<SaveFuelCard> {
  await requireCan("dispatch");
  const out = await saveFuelCard(vehicleId, String(provider ?? ""), String(accountId ?? ""));
  if (out.ok) refreshFleet();
  return out;
}

export async function vetCarrierAction(driverId: string): Promise<VetResult> {
  await requireCan("dispatch");
  const out = await vetDriverCarrier(driverId);
  if (out.ok) refreshFleet();
  return out;
}

export async function sendToPayrollAction(statementIds: string[]): Promise<SendResult> {
  await requireCan("payout");
  const out = await sendToPayroll(Array.isArray(statementIds) ? statementIds.filter((i) => typeof i === "string") : []);
  if (out.ok) revalidatePath("/payroll", "layout");
  return out;
}

export async function connectPartnerAction(capability: string, provider: string, accountLabel: string | null): Promise<ConnectResult> {
  await requireCan("admin");
  const out = await connectPartner(String(capability), String(provider), accountLabel);
  if (out.ok) revalidatePath("/", "layout");
  return out;
}

/** Save this fleet's own keys for a company (sealed on the server; nothing comes back but whether it worked). Admin only. */
export async function savePartnerKeysAction(provider: string, values: Record<string, string>): Promise<SaveAndConnect & { imported?: ImportEldResult }> {
  await requireCan("admin");
  const clean: Record<string, string> = {};
  if (values && typeof values === "object") for (const [k, v] of Object.entries(values)) if (typeof v === "string") clean[String(k)] = v;
  const out = await saveKeysAndConnect(String(provider), clean);
  if (!out.ok) return out;
  // A test key on an ELD is the whole setup: the fleet it lists is added as trucks and drivers and read for where they are, so the radar lights up at once (docs/TELEMATICS_RADAR.md).
  const imported = out.sandbox && out.connected && capabilityOf(String(provider)) === "eld" ? await importEldFleet() : undefined;
  revalidatePath("/settings");
  if (imported?.ok) revalidatePath("/", "layout");
  return imported ? { ...out, imported } : out;
}

/** Read the connected ELD's whole fleet again and add any truck or driver the desk does not have yet. Nothing the desk has is changed. Admin only. */
export async function importEldFleetAction(): Promise<ImportEldResult> {
  await requireCan("admin");
  const out = await importEldFleet();
  if (out.ok) revalidatePath("/", "layout");
  return out;
}

export async function removePartnerKeysAction(provider: string): Promise<{ ok: true; removed: boolean }> {
  await requireCan("admin");
  const removed = await deleteCredential(String(provider));
  revalidatePath("/settings");
  return { ok: true, removed };
}

/** After a run of failed calls: clear the failures and ask again at once. */
export async function retryPartnerAction(capability: string, provider: string): Promise<ConnectResult> {
  await requireCan("admin");
  const out = await retryConnection(String(capability), String(provider));
  if (out.ok) revalidatePath("/settings");
  return out;
}

/** The demo's one-click proof: a signed simulator event through the real receiver (or a simulated ELD read). Admin only; refuses unless the keys run the simulator. */
export async function sendTestEventAction(capability: string, provider: string): Promise<TestEventResult> {
  await requireCan("admin");
  const out = await sendTestEvent(String(capability), String(provider));
  if (out.ok) revalidatePath("/", "layout");
  return out;
}

/** Share a load's location with the connected tracking company, or stop. Starting needs the carrier's yes for this load in the same call. */
export async function shareLocationAction(loadId: string, share: boolean, optIn: boolean): Promise<ShareResult> {
  await requireCan("dispatch");
  const out = await shareLoadLocation(String(loadId), Boolean(share), Boolean(optIn));
  if (out.ok) revalidatePath(`/loads/${String(loadId)}`);
  return out;
}

/** Read the last days of card purchases for every truck with a card. Dispatch or billing. */
export async function syncFuelCardsAction(days: number): Promise<FuelSync> {
  await requireCan("dispatch", "bill");
  const out = await syncFuelCards(Number.isFinite(days) ? days : 30);
  if (out.ok) revalidatePath("/fuel");
  return out;
}

/** Reads a fuel CSV and says what an import would do: the column match, every row checked, nothing written. Dispatch or billing, as reading the cards is. */
export async function previewFuelImportAction(text: string, mapping: FuelImportMap | null): Promise<FuelImportPreview> {
  await requireCan("dispatch", "bill");
  if (typeof text !== "string") return { ok: false, error: "That is not a file the desk can read." };
  return previewFuelImport(text, mapping && typeof mapping === "object" ? mapping : null);
}

/** Imports the fuel purchases in a CSV that pass, as one batch with one entry in the audit log. */
export async function commitFuelImportAction(text: string, mapping: FuelImportMap | null, fileName: string): Promise<FuelImportResult> {
  await requireCan("dispatch", "bill");
  if (typeof text !== "string") return { ok: false, error: "That is not a file the desk can read." };
  const out = await commitFuelImport(text, mapping && typeof mapping === "object" ? mapping : null, typeof fileName === "string" ? fileName : "");
  if (out.ok) revalidatePath("/fuel", "layout");
  return out;
}

/** Takes a whole fuel file import away again; refused while a purchase from it is on a driver statement. */
export async function removeFuelImportAction(batchId: string): Promise<RemoveFuelImportResult> {
  await requireCan("dispatch", "bill");
  const out = await removeFuelImport(typeof batchId === "string" ? batchId : "");
  if (out.ok) revalidatePath("/fuel", "layout");
  return out;
}

/** Clears one exception flag on one fuel purchase, with why (any other flag on it stays open). Dispatch or billing. */
export async function clearFuelFlagAction(id: string, code: string, note: string): Promise<FlagReviewResult> {
  await requireCan("dispatch", "bill");
  const out = await clearFuelFlag(String(id), String(code), typeof note === "string" ? note : "");
  if (out.ok) revalidatePath("/fuel");
  return out;
}

/** Reopens a fuel flag someone cleared. */
export async function reopenFuelFlagAction(id: string, code: string): Promise<FlagReviewResult> {
  await requireCan("dispatch", "bill");
  const out = await reopenFuelFlag(String(id), String(code));
  if (out.ok) revalidatePath("/fuel");
  return out;
}

/** Work out a quarter's fuel-tax miles by state and keep them. The billing office's work. */
export async function calculateIftaAction(quarter: string): Promise<IftaResult> {
  await requireCan("bill");
  const out = await calculateIfta(String(quarter));
  if (out.ok) revalidatePath("/ifta");
  return out;
}

export async function disconnectPartnerAction(capability: string, provider: string): Promise<ConnectResult> {
  await requireCan("admin");
  const out = await disconnectPartner(String(capability), String(provider));
  if (out.ok) revalidatePath("/", "layout");
  return out;
}


/** Save a message to a driver (the desk's record only: nothing carries it to a phone yet). `clientId` makes a double send save once. */
export async function sendMessageAction(input: { driverId: string; body: string; loadId?: string | null; clientId?: string | null }): Promise<SendMessageResult> {
  await requireCan("dispatch", "bill");
  const out = await sendMessage({ driverId: String(input.driverId), body: String(input.body ?? ""), loadId: input.loadId ? String(input.loadId) : null, clientId: input.clientId ? String(input.clientId) : null });
  if (out.ok) revalidatePath("/messages");
  return out;
}

/** The dispatcher opened a conversation: the driver's messages in it count as read, and the sidebar number drops. */
export async function markThreadReadAction(driverId: string): Promise<number> {
  await requireCan("dispatch", "bill");
  const n = await markThreadRead(String(driverId));
  if (n > 0) revalidatePath("/", "layout");
  return n;
}

export async function removeDocumentAction(id: string): Promise<DocResult> {
  await requireCan("documents");
  const out = await removeLoadDocument(id);
  if (out.ok) refreshLoads();
  return out;
}

// ── The team (admins only) ─────────────────────────────────────────────────────────────────────

export async function addMemberAction(input: { email: string; name: string; role: string; grants?: string[] }): Promise<MemberResult> {
  await requireCan("admin");
  const out = await addMember(input);
  if (out.ok) revalidatePath("/settings");
  return out;
}

export async function setMemberRoleAction(id: string, role: string): Promise<MemberResult> {
  await requireCan("admin");
  const out = await setMemberRole(id, role);
  if (out.ok) revalidatePath("/settings");
  return out;
}

export async function setMemberGrantsAction(id: string, grants: string[]): Promise<MemberResult> {
  await requireCan("admin");
  const out = await setMemberGrants(id, grants);
  if (out.ok) revalidatePath("/settings");
  return out;
}

export async function removeMemberAction(id: string): Promise<MemberResult> {
  await requireCan("admin");
  const out = await removeMember(id);
  if (out.ok) revalidatePath("/settings");
  return out;
}

/** Start signing in to a partner company that connects by OAuth (QuickBooks Online): answers the address to send the person to. Admin only. */
export async function beginPartnerSignInAction(provider: string): Promise<BeginResult> {
  await requireCan("admin");
  const access = await checkAccess("admin");
  const origin = originOf(headers());
  if (!origin) return { ok: false, error: "The desk could not tell its own address. Open it from its usual address and try again." };
  return beginOAuth(String(provider), { origin, who: access.ok ? (access.identity.name ?? access.identity.email) : null });
}

/** Sign out of a partner company: its tokens are forgotten and the connection is marked not connected. Admin only. */
export async function signOutPartnerAction(provider: string): Promise<{ ok: true; changed: boolean }> {
  await requireCan("admin");
  const out = await disconnectOAuth(String(provider));
  revalidatePath("/settings");
  return out;
}

/** Save the fleet's accounting accounts (rules D and E). A blank account goes back to its default. Admin only. */
export async function saveAccountingAccountsAction(form: AccountsForm): Promise<SaveAccountsResult> {
  await requireCan("admin");
  const access = await checkAccess("admin");
  const clean: AccountsForm = {};
  if (form && typeof form === "object") for (const [k, v] of Object.entries(form)) if (v && typeof v === "object") clean[String(k)] = { account: String((v as { account?: unknown }).account ?? ""), number: String((v as { number?: unknown }).number ?? "") };
  const out = await saveAccounts(clean, access.ok ? (access.identity.name ?? access.identity.email) : null);
  if (out.ok) revalidatePath("/settings");
  return out;
}

export type JournalCheck = { ok: true; entries: number; rows: number; notes: string[] } | { ok: false; error: string; problems: string[]; unmapped: string[] };

/** What the journal for these days would hold, or why it cannot be given out yet: checked before the file is downloaded. The billing office's. */
export async function checkJournalAction(from: string | null, to: string | null): Promise<JournalCheck> {
  await requireCan("bill");
  const out = await journalFile({ from: from ? String(from) : null, to: to ? String(to) : null });
  return out.ok ? { ok: true, entries: out.entries, rows: out.rows, notes: out.notes } : out;
}

/** Sync with QuickBooks now: push what changed, pull payments entered there. The billing office's. */
export async function syncAccountingAction(): Promise<AccountingSyncResult> {
  await requireCan("bill");
  const access = await checkAccess("bill");
  const out = await syncAccounting({ who: access.ok ? (access.identity.name ?? access.identity.email) : null });
  revalidatePath("/settings");
  if (out.ok && out.pulled > 0) revalidatePath("/invoices");
  return out;
}
