import { deckHero } from "@/lib/deck-hero";
import Link from "next/link";
import { grossOf } from "@/lib/load-gross";
import { dueAt as dueAtOf } from "@/lib/overdue";
import React from "react";
import { getLoadDetail } from "@/server/tl/queries";
import { getAlerts } from "@/server/tl/alerts";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { checkAccess } from "@/server/tl/access";
import { canAny, type Capability } from "@/lib/roles";
import { listLoadAudit } from "@/server/tl/audit";
import { num, numOrNull } from "@/server/tl/convert";
import { detentionOfLoad, waivedDetentionLoads } from "@/server/tl/detention";
import { evidenceSummary } from "@/server/tl/detention-evidence";
import { ReadOnlyGate } from "./kit/read-only";
import { UnwaiveDetentionButton, WaiveDetentionButton } from "./waive-detention";
import { getThresholds } from "@/server/tl/thresholds";
import { settlementOfLoad } from "@/server/tl/settlement";
import { AssignFields } from "./assign-fields";
import { DeclineNote } from "./load-view-fields";
import { AssignTrailer } from "./trailer-forms";
import { trailerBlocker } from "@/lib/trailer-clearance";
import { acknowledgeDiscrepancyAction, assignAction, discrepancyRelayAction, dropRelayAction, recallAction, receiveRelayAction, reopenCancelledAction, reopenDeliveredAction, respondAction, retryBridgeAction, sendAction, unassignAction, undoPaidAction, undoStartAction, voidInvoiceAction } from "@/app/(desk)/actions";
import { InvoiceDialog, LoadEditDialog, PaidDialog, TripEntry } from "./load-actions";
import { loadLedger } from "@/lib/load-ledger";
import { roleOfStop } from "@/lib/stop-role";
import { RecallForm } from "./recall-form";
import { DiscrepancyForm, DropForm, ReceiveForm } from "./relay-forms";
import { handoffsOfLoad, legsOfLoad, receiveOptions } from "@/server/tl/relay";
import { HANDOFF_REASON_LABEL, HANDOFF_STATE_LABEL, HANDOFF_TYPE_LABEL, OUTGOING_NEXT_LABEL, handoffLevel, waitMinutes, waitWords, type HandoffReason, type HandoffState, type HandoffType, type OutgoingNext } from "@/lib/relay";
import { holderTrail } from "@/server/tl/assignment-events";
import { RECALL_LABELS } from "@/lib/recall-reasons";
import { billedOf } from "@/lib/billed";
import { moneyState } from "@/lib/money-state";
import { daysPastDue } from "@/lib/overdue";
import { canInvoiceStatus, invoiceBasis, invoiceReadiness, owedOf, termsLabel } from "@/lib/invoicing";
import { toEditValues } from "@/lib/load-edit";
import { customerTermsMap } from "@/server/tl/customers";
import { suggestedInvoiceNumber } from "@/server/tl/invoicing";
import { DeleteLoadButton } from "./delete-load";
import { deriveTimeline } from "@/lib/desk-timeline";
import { CAN_CANCEL, CAN_RESCHEDULE, CAN_TONU, reasonLabel } from "@/lib/disruptions";
import { toCentralLocal } from "@/lib/zoned";
import { workspaceTimezone } from "@/server/tl/zone";
import { TrackingPanel } from "./tracking-panel";
import { providerName } from "@/server/partners/call";
import { ACTION_LABEL } from "@/lib/audit-diff";
import { gapsPhrase, refList, sendReadiness } from "@/lib/send-readiness";
import { SHELF_CAPABILITIES, shelfFor, shelfHeader, type ShelfCapability } from "@/lib/partner-shelf";
import { partnerStatus } from "@/server/partners/connections";
import { linkStateFor } from "@/server/bridge/outbox";
import { stopZoneOf } from "@/server/geo/stop-zone";
import { activeTz } from "@/lib/tz";
import { FAILURE_TEXT, type FailureWord } from "@/server/bridge/core";
import { AssignmentChip, StatusChip, VerdictChip } from "./ui";
import { AlertList } from "./alert-bits";
import { SubmitButton } from "./kit/submit-button";
import { BillingDetailsDialog } from "./billing-details-dialog";
import { listLoadDocuments, podStopsMissing } from "@/server/tl/documents";
import { ConfirmForm } from "./kit/confirm-form";
import { DisruptionButtons } from "./disruption-dialogs";
import { Fold } from "./kit/fold";
import { Icon } from "./kit/icons";
import { Tip, type TipData } from "./kit/tooltip";
import { ASSIGNMENT_STATUS, LOAD_STATUS, dateTime, miles, PAY_KIND_LABEL, payLabel, perMile, stopTime, usd } from "@/lib/desk-format";
import { rateConTotal } from "@/lib/pay";
import { telHref } from "@/lib/contact";
import { LoadCockpit, SplitDocViewer, DriverCabSheet } from "./load-cockpit";
import { LoadTracker } from "./load-tracker";
import { LoadDocuments } from "./load-documents";
import { getLoadTracking } from "@/server/tl/load-tracking";
import { fixAge } from "@/lib/whereabouts";
import { lateText } from "@/lib/planner";
import "./cockpit.css";

const TONE: Record<string, "ok" | "warn" | "bad"> = { accept: "ok", caution: "warn", reject: "bad" };

/**
 * A load, in the drawer. The drawer is the only view of a load (Chris 2026-11-23: the full page is gone): it opens over whatever page you were on, and an address like /loads/abc opens it over the Loads board.
 * A short summary and the next step on top; then Trip, Money, Paperwork and More. What this stage asks for is in view; what is rarer is one line that opens (kit/fold.tsx). Nothing about a load lives anywhere else.
 */
export async function LoadView({ id }: { id: string }) {
  const detail = await getLoadDetail(id);
  // The page under it says "not found" (app/(desk)/loads/[id]); the drawer just does not open.
  if (!detail) return null;

  const access = await checkAccess("read");
  const me = access.ok ? access.identity : null;
  const may = (...caps: Capability[]) => !!me && canAny(me.role, me.grants, caps);
  const gate = (body: React.ReactNode, ...caps: Capability[]) => <ReadOnlyGate allowed={may(...caps)}>{body}</ReadOnlyGate>;
  const readOnlyNote = may("dispatch", "figures", "documents", "billing_details", "bill") ? null : (
    <p className="tl-note" role="note">You can read this load but not change it. A dispatcher or the accounting office can.</p>
  );

  const [{ byLoad }, feed, settled, waivedMap, tracking, evidence, holders, legs, batons] = await Promise.all([
    getAlerts(new Date(), currentWorkspaceId(), "open", id),
    listLoadAudit(id),
    settlementOfLoad(id),
    waivedDetentionLoads([id]),
    getLoadTracking(id),
    // Whether the truck's track was frozen for this load's stops (docs/DETENTION_EVIDENCE.md): one line and a link.
    evidenceSummary(id),
    // Who held this load, in order, and why it changed hands (docs/RELAY_DESIGN.md).
    holderTrail(id),
    // The legs and batons of a relay (docs/RELAY_DESIGN.md): none for a load that never changed hands.
    legsOfLoad(id),
    handoffsOfLoad(id)
  ]);
  const waivedReason = waivedMap.get(id) ?? null;
  const openBaton = batons.find((b) => b.state === "dropped" || b.state === "disputed") ?? null;
  const { load, evaluation, flipped, driverView, drivers } = detail;
  const a = load.assignment;
  const alerts = byLoad.get(id) ?? [];

  const canAssign = (load.status === "draft" || load.status === "accepted") && (!a || a.status === "draft" || a.status === "declined");
  const canUnassign = !!a && ["draft", "accepted"].includes(load.status) && ["draft", "dispatched", "accepted", "declined"].includes(a.status);
  const wayHome = load.isBackhaul ? "A load covers the way home" : "Way home counted empty";
  const otherWayHome = load.isBackhaul ? "Way home counted empty" : "A load covers the way home";

  const totalMiles = evaluation?.totalMiles ?? 0;
  const delivered = load.status === "completed";
  const earned = grossOf({ status: load.status, quotedRevenue: num(load.quotedRevenue), actualRevenue: numOrNull(load.actualRevenue), fuelSurcharge: numOrNull(load.fuelSurcharge), layoverPay: numOrNull(load.layoverPay), tonuRevenue: numOrNull(load.tonuRevenue) });
  const heroGross = delivered || load.status === "cancelled" || load.status === "tonu" ? earned : evaluation?.effectiveGross ?? num(load.quotedRevenue);
  const allIn = evaluation && totalMiles > 0 ? heroGross / totalMiles : null;
  const loadedMiles = num(load.loadedMiles);
  const perLoaded = evaluation && loadedMiles > 0 ? heroGross / loadedMiles : null;
  const frozenFloor = numOrNull((load as { snapshotBaseFloorRpm?: unknown }).snapshotBaseFloorRpm as never);
  const paidLine = numOrNull(load.actualRevenue);
  const paidDiffers = delivered && paidLine != null && paidLine > 0 && Math.abs(paidLine - num(load.quotedRevenue)) > 1;
  const tone = evaluation ? TONE[evaluation.finalDecision] ?? "" : "";
  const arrived = load.stops.map((s) => s.arrivedAt).filter((d): d is Date => d != null).sort((x, y) => x.getTime() - y.getTime())[0] ?? null;

  const thresholds = await getThresholds();
  const dt = detentionOfLoad(load, thresholds.detentionGraceMinutes);
  const fellThrough = load.status === "cancelled" || load.status === "tonu";
  const firstPickup = load.stops.map((s) => s.timeWindowEarliest).find((d): d is Date => d != null) ?? null;

  const deleteBlocked = load.status === "in_progress" ? "A load on the road cannot be deleted." : load.paymentStatus ? "An invoiced load cannot be deleted." : settled ? "A load on a driver statement cannot be deleted." : null;
  const can = { cancel: CAN_CANCEL.includes(load.status), tonu: CAN_TONU.includes(load.status), reschedule: CAN_RESCHEDULE.includes(load.status) && firstPickup != null };

  const scheduleLocked = !["draft", "accepted"].includes(load.status);
  const stored = (v: Parameters<typeof num>[0]) => {
    const n = num(v);
    return n > 0 ? String(n) : "";
  };
  // A time typed for a stop is the dock's time (src/lib/tz.ts): each stop's own clock, from where it is, falling back to the workspace's.
  const workspaceZone = await workspaceTimezone(currentWorkspaceId());
  const stopZones = Object.fromEntries(load.stops.map((s) => [s.id, stopZoneOf(s, workspaceZone)]));
  const lastStopZone = load.stops.length > 0 ? stopZones[load.stops[load.stops.length - 1]!.id] : undefined;
  const pickupStop = load.stops.find((s) => s.timeWindowEarliest != null);
  const tripStops = load.stops.map((s) => ({
    id: s.id,
    sequence: s.stopSequence,
    role: s.stopRole ?? s.stopType,
    place: s.facilityName ?? s.addressString,
    zone: stopZones[s.id],
    arrivedLocal: s.arrivedAt ? toCentralLocal(s.arrivedAt.getTime(), stopZones[s.id]) : "",
    waitMinutes: s.waitMinutes != null ? String(s.waitMinutes) : "",
    opensLocal: s.timeWindowEarliest ? toCentralLocal(s.timeWindowEarliest.getTime(), stopZones[s.id]) : "",
    seal: s.sealNumber ?? ""
  }));
  const tripVisible = !!a && ["accepted", "in_progress", "completed", "tonu"].includes(load.status);
  const basis = invoiceBasis({ status: load.status, quotedRevenue: num(load.quotedRevenue), fuelSurcharge: num(load.fuelSurcharge), tonuRevenue: load.tonuRevenue != null ? num(load.tonuRevenue) : null });
  const storedItems = Object.fromEntries(Object.entries((load.expenseItems && typeof load.expenseItems === "object" && !Array.isArray(load.expenseItems) ? load.expenseItems : {}) as Record<string, unknown>).map(([k, n]) => [k, String(Number(n) || "")]));
  const itemisedSum = Object.values(storedItems).reduce((s, n) => s + (Number(n) || 0), 0);
  const quotedTotal = num(load.quotedPickupDhMiles) + num(load.quotedLoadedMiles) + (load.isBackhaul ? 0 : num(load.quotedReturnDhMiles));
  const actualTotal = num(load.pickupDeadheadMiles) + num(load.loadedMiles) + (load.isBackhaul ? 0 : num(load.returnDeadheadMiles));
  const milesVariance = load.quotedLoadedMiles != null && quotedTotal > 0 && actualTotal > 0 && Math.round(quotedTotal) !== Math.round(actualTotal) ? { quoted: Math.round(quotedTotal), actual: Math.round(actualTotal), pct: (actualTotal - quotedTotal) / quotedTotal, over: Math.abs(actualTotal - quotedTotal) / quotedTotal > 0.08 } : null;
  const suggestedNumber = load.paymentStatus ? "" : await suggestedInvoiceNumber(load);
  const readiness = invoiceReadiness({ ...load, quotedRevenue: basis.rate, paidLinehaul: numOrNull(load.actualRevenue), podStopsMissing: (await podStopsMissing([load.id])).get(load.id) ?? null });
  const invoiceContext = { rate: basis.rate, surcharge: basis.surcharge, detention: basis.tonu ? 0 : dt.billable, rateLabel: basis.label, defaultTerms: load.payTermsDays ?? (await customerTermsMap()).get((load.brokerName ?? "").trim().toLowerCase()) ?? thresholds.defaultPayTermsDays };
  const billed = billedOf({ invoicedAmount: numOrNull(load.invoicedAmount), status: load.status, quotedRevenue: num(load.quotedRevenue), fuelSurcharge: numOrNull(load.fuelSurcharge), tonuRevenue: numOrNull(load.tonuRevenue) });
  const invoiceLines = Array.isArray(load.invoiceLines) ? (load.invoiceLines as Array<{ label: string; amount: number }>) : null;
  const dueAt = dueAtOf(load.invoicedAt, load.payTermsDays);
  const paidAmount = load.paidAmount != null ? num(load.paidAmount) : null;
  const owing = load.paymentStatus === "invoiced" ? (owedOf(billed, paidAmount) ?? billed) : 0;
  const needs = [load.requiresLiftgate ? "liftgate" : null, load.requiresRamp ? "ramp" : null, load.requiresPalletJack ? "pallet jack" : null].filter((x): x is string => x != null);
  const size = [load.lengthFt, load.widthFt].every((x) => x == null) && load.loadHeightIn == null ? null : [load.lengthFt != null ? `${num(load.lengthFt)} ft long` : null, load.widthFt != null ? `${num(load.widthFt)} ft wide` : null, load.loadHeightIn != null ? `${num(load.loadHeightIn)} in high` : null].filter(Boolean).join(", ");

  const gaps = sendReadiness({
    weightLbs: load.weightLbs,
    loadNumber: load.loadNumber,
    pickupRefs: [...refList(load.pickupNumbers), ...load.stops.filter((s) => roleOfStop(s) === "pickup").flatMap((s) => refList(s.referenceNumbers))],
    trailerType: load.trailerType,
    vehicleType: load.vehicle?.type ?? null,
    pickupTime: load.stops[0]?.timeWindowEarliest ?? null,
    deliveryTime: load.stops[load.stops.length - 1]?.timeWindowEarliest ?? null
  });
  const decision = load.decisions[0] ?? null;

  const steps = deriveTimeline({
    status: load.status,
    createdAt: load.createdAt,
    completedAt: load.completedAt,
    invoicedAt: load.invoicedAt,
    paidAt: load.paidAt,
    paymentStatus: load.paymentStatus,
    firstArrivedAt: arrived,
    assignment: a ? { status: a.status, createdAt: a.createdAt, dispatchedAt: a.dispatchedAt, respondedAt: a.respondedAt } : null,
    // Each stop as it is reached (the driver's phone reports arrivals, sync plan Step 2). Not before the trip is on the road: an unsent load's stops are a plan, not progress.
    stops: ["in_progress", "completed"].includes(load.status) ? load.stops.map((s) => ({ sequence: s.stopSequence, role: roleOfStop(s), arrivedAt: s.arrivedAt, waitMinutes: s.waitMinutes, fromPhone: s.arrivedSource === "phone" })) : undefined
  });

  const bar = (value: number | null, floor: number | null, max: number, verdict: string | undefined) => (
    <div className="mb-track">
      {value != null ? <div className={`mb-fill ${TONE[verdict ?? ""] ?? ""}`} style={{ width: `${Math.min(100, (value / max) * 100)}%` }} /> : null}
      {floor != null ? <div className="mb-floor" style={{ left: `${Math.min(100, (floor / max) * 100)}%` }} /> : null}
    </div>
  );
  const flippedAllIn = flipped && flipped.totalMiles > 0 ? flipped.effectiveGross / flipped.totalMiles : null;

  const pickupMi = num(load.pickupDeadheadMiles);
  const homeMi = num(load.returnDeadheadMiles);
  const VERDICT_WORDS: Record<string, string> = { accept: "Covers your cost", caution: "Barely covers your cost", reject: "Below your cost" };
  const gapText = (perMi: number | null, floor: number) => {
    if (perMi == null) return "—";
    const gap = perMi - floor;
    return `${usd(Math.abs(gap), 2)} a mile ${gap >= 0 ? "over" : "short of"} your floor`;
  };
  const milesTip = (ev: NonNullable<typeof evaluation>, homeCounted: boolean, perMi: number | null, title: string, sub: string, note: string): TipData => ({
    title,
    sub,
    rows: [
      ["What the load pays", usd(ev.effectiveGross, 0)],
      ["Empty to the pickup", miles(pickupMi)],
      ["Loaded miles", miles(loadedMiles)],
      ["Empty way home", homeCounted ? miles(homeMi) : `${miles(homeMi)}, not counted`],
      ["Miles it has to cover", miles(ev.totalMiles)],
      ["Pay per mile", perMi == null ? "—" : `${usd(ev.effectiveGross, 0)} ÷ ${miles(ev.totalMiles)} = ${perMile(perMi)}`],
      ["Your floor", perMile(ev.verdictFloorRpm)],
      ["Against your floor", gapText(perMi, ev.verdictFloorRpm)],
      ["Verdict", VERDICT_WORDS[ev.finalDecision] ?? "—"]
    ],
    note
  });
  const barMax = Math.max(allIn ?? 0, flippedAllIn ?? 0, evaluation?.verdictFloorRpm ?? 0, flipped?.verdictFloorRpm ?? 0, 0.01) * 1.15;

  const docs = await listLoadDocuments(load.id);
  // The shelf says only what is true: which companies this fleet has really connected (none, until a company is chosen and its keys are set).
  const connectionRows = await partnerStatus();
  // The driver link: how this load's driver is reached, and where a delivery to their phone stands.
  const link = a ? await linkStateFor(load.id, a.driverId) : null;
  const linked = link?.mode.mode === "bridged";
  const shelfConnected: Partial<Record<ShelfCapability, boolean>> = {};
  for (const c of SHELF_CAPABILITIES) shelfConnected[c] = connectionRows.some((r) => r.capability === c && r.connected && r.configured);
  const shelf = shelfFor({
    connected: shelfConnected,
    factoringStatus: load.factoringStatus,
    docKinds: docs.map((d) => d.kind),
    driverName: load.assignment?.driver.name ?? null,
    hosHours: load.vehicle?.hosAvailableHours == null ? null : Number(load.vehicle.hosAvailableHours),
    hosSyncedAt: load.vehicle?.hosSyncedAt ? dateTime(load.vehicle.hosSyncedAt) : null,
    vetStatus: load.assignment?.driver.vetStatus && load.assignment.driver.vetStatus !== "unchecked" ? load.assignment.driver.vetStatus : null,
    coiExpiresAt: load.assignment?.driver.coiExpiresAt ? dateTime(load.assignment.driver.coiExpiresAt) : null,
    onStatement: Boolean(settled),
    totalMiles
  });
  const deliveryStopOptions = load.stops.filter((s) => roleOfStop(s) === "delivery").map((s) => ({ id: s.id, label: `Stop ${s.stopSequence}, ${s.facilityName ?? s.addressString}` }));
  const stopLabelOf = (id: string | null) => (id ? (deliveryStopOptions.find((s) => s.id === id)?.label ?? null) : null);
  const docsLocked = load.factoringStatus !== "none" && load.factoringStatus !== "rejected" ? "This load's invoice has gone to a factoring company, so its documents stay as they were sent." : null;

  // Stops & Cities for Ribbon
  const firstStop = load.stops[0];
  const lastStop = load.stops[load.stops.length - 1];
  // Two clocks (src/lib/tz.ts): money and days are the carrier's; an appointment is read where the dock is, with the carrier's time beside it when they differ.
  const carrierZone = activeTz();
  const zoneOfStop = (s: (typeof load.stops)[number]) => stopZoneOf(s, carrierZone);
  const originCity = firstStop?.facilityName ?? load.originAddress?.split(",")[0] ?? "Origin";
  const destCity = lastStop?.facilityName ?? load.destinationAddress?.split(",")[0] ?? "Destination";

  // Compliance Gates Status
  const weightVal = numOrNull(load.weightLbs);
  const maxWeightLbs = load.vehicle?.payloadLbs ?? 45000;
  const weightOk = weightVal == null || weightVal <= maxWeightLbs;
  const trailerOk = !!load.trailer || !!load.trailerType;
  const driverOk = !!a && (a.status === "accepted" || a.status === "dispatched" || a.status === "in_progress");
  const refsOk = gaps.length === 0;
  const floorThreshold = delivered && frozenFloor != null ? frozenFloor : (evaluation?.verdictFloorRpm ?? 0);

  // Margin Ledger Math
  const ledger = loadLedger(
    {
      status: load.status,
      quotedRevenue: num(load.quotedRevenue),
      actualRevenue: numOrNull(load.actualRevenue),
      fuelSurcharge: numOrNull(load.fuelSurcharge),
      layoverPay: numOrNull(load.layoverPay),
      tonuRevenue: numOrNull(load.tonuRevenue),
      expenseFuelActual: numOrNull(load.expenseFuelActual),
      expenseTolls: numOrNull(load.expenseTolls),
      expenseMisc: numOrNull(load.expenseMisc),
      insuranceRiderFlat: numOrNull(load.insuranceRiderFlat),
      assignmentPayEstimate: a?.payEstimate != null ? num(a.payEstimate) : null,
      forecastFuel: evaluation?.fuelCost?.totalFuelCost ?? 0,
      totalMiles
    },
    legs.map((l) => ({ status: l.status, kind: l.kind, payEstimate: l.payEstimate != null ? num(l.payEstimate) : null })),
    settled,
    { billedExtra: dt.billedExtra, billable: dt.billable, waived: waivedReason != null }
  );
  const { netMarginPct, netProfitPerMile, netProfit } = ledger;

  // Deck figures. One hero: the margin against the floor when the load has a floor, else what it pays (a load not judged yet must never leave the header blank).
  const deckTonu = load.status === "tonu";
  const deckLead = deckHero({ tonu: deckTonu, allIn, floor: floorThreshold, verdictTone: tone });
  const deckMargin = deckLead.margin;
  const deckGross = usd(heroGross, Number.isInteger(heroGross) ? 0 : 2);
  const deckHeroText = deckTonu ? usd(earned, 2) : deckMargin != null ? `${deckMargin >= 0 ? "+" : "−"}${usd(Math.abs(deckMargin), 2)}/mi` : deckGross;
  const deckHeroLabel = deckTonu ? "TONU fee" : deckMargin != null ? (deckMargin >= 0 ? "over your floor" : "under your floor") : allIn != null ? `gross pay, ${perMile(allIn)} every mile` : "gross pay";
  // ── Tab 1: Route & Stops Workbench ─────────────────────────────────────────────────────────
  const trailerOpen = load.status === "draft" || load.status === "accepted" || load.status === "in_progress";
  const relayWho = !!me && may("dispatch");
  const relayOptions = openBaton && relayWho ? await receiveOptions(id) : null;
  const canHandOff = relayWho && load.status === "in_progress" && !!a && a.status === "in_progress" && !openBaton;
  const relaySec = legs.length === 0 && batons.length === 0 && !canHandOff ? null : (
    <section className="sec">
      <h3>Relay{legs.length > 0 ? ` · ${legs.length} leg${legs.length === 1 ? "" : "s"}` : ""}</h3>
      <div className="sec-box">
        {legs.length > 0 ? (
          <ul className="feed">
            {legs.map((l) => (
              <li key={l.id}>
                <div>
                  <b>Leg {l.seq}</b> · {l.driverName ?? "No driver"}{l.vehicleName ? ` · ${l.vehicleName}` : ""}{l.trailerNumber ? ` · ${l.trailerNumber}` : ""}{l.kind === "positioning" ? " · positioning only (no freight)" : ""}
                  {" · "}{l.status === "active" ? "rolling" : "closed"}
                </div>
                <div className="t">
                  {l.fromName ? `From ${l.fromName}` : ""}{l.toName ? ` to ${l.toName}` : ""}
                  {l.milesDriven != null ? ` · ${num(l.milesDriven).toLocaleString("en-US")} mi (${l.milesSource === "eld" ? "ELD" : l.milesSource === "driver" ? "from the driver" : "worked out by dispatch"})` : l.status === "closed" ? " · miles not recorded" : ""}
                  {may("billing_details") && l.payEstimate != null ? ` · pay estimate ${usd(num(l.payEstimate), 2)}` : ""}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {batons.map((b) => {
          const waiting = b.state === "dropped" || b.state === "disputed";
          const lvl = handoffLevel(b, new Date());
          return (
            <div key={b.id} className="tl-note" style={{ marginTop: 12 }}>
              <b>{HANDOFF_TYPE_LABEL[b.type as HandoffType] ?? b.type}</b> · {HANDOFF_STATE_LABEL[b.state as HandoffState] ?? b.state} · {HANDOFF_REASON_LABEL[b.reason as HandoffReason] ?? b.reason}
              <div>
                {b.outDriverName ?? "The driver"} left it at {b.locationName ?? "a pin"}{b.locationSlot ? `, spot ${b.locationSlot}` : ""} {dateTime(b.droppedAt)}
                {b.droppedSource === "dispatcher" ? " (entered by dispatch for the driver)" : ""}
                {b.trailerNumber ? ` · trailer ${b.trailerNumber}` : ""}{b.sealNumber ? ` · seal ${b.sealNumber}` : ""}
                {b.outgoingNext ? ` · they ${OUTGOING_NEXT_LABEL[b.outgoingNext as OutgoingNext]?.toLowerCase() ?? b.outgoingNext}` : ""}
              </div>
              {b.state === "received" ? (
                <div>
                  {b.inDriverName} took it {b.receivedAt ? dateTime(b.receivedAt) : ""}{b.tractorInName ? ` in ${b.tractorInName}` : ""}
                  {b.sealMatches === true ? " · seal matched" : b.sealMatches === false ? " · seal did NOT match" : ""}
                  {b.frozenSha256 ? ` · frozen ${b.frozenSha256.slice(0, 10)}` : ""}
                </div>
              ) : null}
              {b.discrepancyFlagged ? (
                <div className={b.ackAt ? "" : "tl-note warn"}>
                  Reported by {b.discrepancyBy ?? "someone"}: “{b.discrepancyNotes}”{b.ackAt ? ` · acknowledged by ${b.ackBy ?? "dispatch"} ${dateTime(b.ackAt)}` : " · not acknowledged yet"}
                </div>
              ) : null}
              {waiting ? <div>Waiting {waitWords(waitMinutes(b.droppedAt, new Date()))}{lvl ? ` · ${lvl === "block" ? "needs attention" : "getting long"}` : ""}</div> : null}
              {waiting && relayWho && relayOptions ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                  {b.state === "disputed" ? (
                    <ConfirmForm action={acknowledgeDiscrepancyAction} fields={{ loadId: load.id, handoffId: b.id }} label="Acknowledge the problem" title="Acknowledge the reported problem?" eyebrow="Handoff" confirmLabel="Acknowledge">
                      <p className="tl-note">This says dispatch has seen it. The next driver can then take the load, and the report stays on it.</p>
                    </ConfirmForm>
                  ) : null}
                  <ReceiveForm action={receiveRelayAction} loadId={load.id} handoff={{ id: b.id, type: b.type, locationName: b.locationName, tractorOutId: b.tractorOutId, tractorOutName: b.tractorOutName, sealNumber: b.sealNumber }} drivers={relayOptions.drivers} trucks={relayOptions.trucks} rateConTotal={rateConTotal(num(load.quotedRevenue), num(load.fuelSurcharge))} blockedByDiscrepancy={b.state === "disputed"} />
                  {b.state === "dropped" ? <DiscrepancyForm action={discrepancyRelayAction} loadId={load.id} handoffId={b.id} location={b.locationName ?? "the handoff"} /> : null}
                </div>
              ) : null}
            </div>
          );
        })}
        {canHandOff && a ? (
          <div style={{ marginTop: 12 }}>
            <DropForm action={dropRelayAction} loadId={load.id} loadNumber={load.loadNumber ?? "this load"} driverName={a.driver.name} />
            <p className="tl-note" style={{ marginTop: 6 }}>For a planned relay, a driver who ran out of hours, or a breakdown. If the driver was recalled while rolling, this is how the load moves on.</p>
          </div>
        ) : null}
        {legs.length > 0 || batons.length > 0 ? <p className="tl-note" style={{ marginTop: 10 }}>What each leg is paid is not split yet: a closed leg keeps its driver&rsquo;s pay as it stood, and the next driver&rsquo;s assignment carries no estimate. Pay the legs by hand for now.</p> : null}
      </div>
    </section>
  );

  const trailerSec = (
    <section className="sec">
      <h3>Trailer Clearance</h3>
      <div className="sec-box">
        {load.trailer ? (
          <p style={{ margin: "0 0 10px" }}>
            <Link href={`/trailers/${load.trailer.id}`}><b>{load.trailer.number}</b></Link>
            {trailerBlocker(load.trailer) ? <span className="tl-chip bad" style={{ marginLeft: 8 }}>{trailerBlocker(load.trailer)}</span> : null}
          </p>
        ) : (
          <p className="tl-note" style={{ marginBottom: 10 }}>No trailer unit is on this load{load.trailerType ? ` (it needs ${load.trailerType.replace(/_/g, " ")})` : ""}.</p>
        )}
        {trailerOpen ? gate(<AssignTrailer loadId={load.id} current={load.trailer ? { id: load.trailer.id, number: load.trailer.number } : null} />, "dispatch") : null}
      </div>
    </section>
  );

  const driverSec = (
    <section className="sec">
      <h3>Driver & HOS Assignment</h3>
      <div className="sec-box">
        {a ? (
          <dl className="tl-kv" style={{ marginBottom: 12 }}>
            <dt>Driver</dt>
            <dd>{a.driver.name}</dd>
            {a.driver.phone ? (
              <>
                <dt>Phone</dt>
                <dd><a href={telHref(a.driver.phone)}>{a.driver.phone}</a></dd>
              </>
            ) : null}
            {may("billing_details") ? (
              <>
                <dt>Pay (estimate)</dt>
                <dd>{PAY_KIND_LABEL[a.payKind] ?? a.payKind} · {payLabel(a.payKind, num(a.payRate))}</dd>
                <dt>Estimate (display only)</dt>
                <dd>{usd(a.payEstimate == null ? null : num(a.payEstimate), 2)}</dd>
              </>
            ) : null}
            <dt>Status</dt>
            <dd><AssignmentChip status={a.status} /></dd>
            {settled && may("billing_details") ? (
              <>
                <dt>Paid to the driver</dt>
                <dd>
                  On statement <Link href={`/settlements/${settled.id}`}>{settled.number}</Link>
                </dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="tl-note" style={{ marginBottom: 12 }}>No driver yet.</p>
        )}

        {canAssign ? (
          <form action={assignAction} className="tl-form-row" style={{ marginBottom: canUnassign ? 10 : 0 }}>
            <input type="hidden" name="loadId" value={load.id} />
            <AssignFields loadId={load.id} drivers={drivers} initial={{ driverId: a?.driverId ?? null, payKind: a?.payKind ?? null, rate: a ? num(a.payRate) : null }} rateConTotal={rateConTotal(num(load.quotedRevenue), num(load.fuelSurcharge))} askOverride={drivers.some((d) => d.busy)} />
            <SubmitButton className="tl-btn sm" pending="Saving…">{a ? "Change driver or pay" : "Assign driver"}</SubmitButton>
          </form>
        ) : null}

        {a && load.status === "in_progress" && may("dispatch") ? (
          <p className="tl-note" style={{ marginTop: 8 }}>This load is on the road, so the driver cannot be recalled. To move it to another driver, use Hand off under Relay.</p>
        ) : null}

        {canUnassign && a && (a.status === "dispatched" || a.status === "accepted") ? (
          <RecallForm action={recallAction} loadId={load.id} driverName={a.driver.name} loadNumber={load.loadNumber ?? "this load"} accepted={a.status === "accepted"} />
        ) : null}

        {canUnassign && a && !(a.status === "dispatched" || a.status === "accepted") ? (
          <ConfirmForm
            action={unassignAction}
            fields={{ loadId: load.id }}
            label="Remove driver"
            title={`Take ${a.driver.name} off ${load.loadNumber ?? "this load"}?`}
            eyebrow="Unassign"
            confirmLabel="Remove driver"
            destructive
            askReason={a.status === "dispatched" || a.status === "accepted"}>
            <p className="tl-note">
              {a.status === "dispatched" || a.status === "accepted"
                ? "The load was already sent. The driver will not have it any more, and the reason is kept in the audit trail."
                : "The load goes back to the board without a driver."}
            </p>
          </ConfirmForm>
        ) : null}
      </div>
    </section>
  );

  const tripSec = tripVisible ? (
    <section className="sec">
      <h3>Trip Actuals & Stop Telemetry</h3>
      <div className="sec-box">
        <TripEntry
          loadId={load.id}
          status={load.status}
          assignmentStatus={a?.status ?? null}
          driverName={a?.driver.name ?? null}
          stops={tripStops}
          expenses={{ fuel: stored(load.expenseFuelActual), tolls: stored(load.expenseTolls), misc: stored(Math.max(0, num(load.expenseMisc) - itemisedSum)), layover: stored(load.layoverPay), items: storedItems, rider: stored(load.insuranceRiderFlat), revenueNote: load.revenueNote ?? "", miles: { pickup: stored(load.pickupDeadheadMiles), loaded: stored(load.loadedMiles), home: stored(load.returnDeadheadMiles) }, backhaul: load.isBackhaul, tonuMiles: stored(load.tonuMiles) }}
          delivered={load.completedAt ? toCentralLocal(load.completedAt.getTime(), lastStopZone) : ""}
          pod={{ note: load.podNote ?? "", without: load.closedWithoutPod === true }}
          quoted={stored(load.quotedRevenue)}
          canDispatch={may("dispatch")}
          terms={{ rate: stored(load.snapshotDetentionRate ?? load.vehicle?.costProfile?.detentionHourlyRate ?? null), grace: String(load.snapshotFreeGraceMinutes ?? load.vehicle?.costProfile?.freeGraceMinutes ?? thresholds.detentionGraceMinutes) }}
        />
      </div>
    </section>
  ) : null;

  const docksSec = (
    <section className="sec">
      <h3>Dock Waiting & Detention</h3>
      {evidence.total > 0 && may("dispatch", "bill", "figures") ? (
        <p className="tl-note" style={{ margin: "0 0 8px" }}>
          The truck&apos;s track was kept for {evidence.total} {evidence.total === 1 ? "stop" : "stops"}
          {evidence.proposed > 0 ? `, ${evidence.proposed} still to confirm` : ", all decided"}. <Link href={`/detention/${load.id}`}>Open the evidence</Link>
        </p>
      ) : null}
      <div className={`cp-detention-box ${dt.billable > 0 ? "billable-wait" : dt.totalWaitMinutes > 0 ? "active-wait" : ""}`}>
        <div>
          <div className="cp-clock">
            {dt.totalWaitMinutes} MIN TOTAL WAITED {dt.billable > 0 ? `· ${dt.billableMinutes} MIN BILLABLE` : ""}
          </div>
          <div style={{ fontSize: 12, color: "var(--db-fg-dim)", marginTop: 4 }}>
            Grace period: {dt.graceMinutes} min per stop · Detention rate: {usd(dt.rate)}/hr past free time
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 11, color: "var(--db-fg-dim)", textTransform: "uppercase" }}>Billable Detention</div>
          <div style={{ fontFamily: "var(--db-font-head)", fontSize: 20, fontWeight: 700, color: dt.billable > 0 ? "var(--db-neg)" : "var(--db-fg)" }}>
            {usd(dt.billable, 2)}
          </div>
        </div>
      </div>

      {dt.stops.length > 0 ? (
        <div className="sec-box" style={{ marginTop: 8 }}>
          <table className="tl-table" aria-label="Waiting at the docks">
            <thead>
              <tr>
                <th>Stop</th>
                <th className="num">Waited</th>
                <th className="num">Free Grace</th>
                <th className="num">Billable</th>
              </tr>
            </thead>
            <tbody>
              {dt.stops.map((st) => (
                <tr key={st.stopSequence}>
                  <td style={{ textTransform: "capitalize" }}>{st.stopType}</td>
                  <td className="num">{st.waitMinutes} min</td>
                  <td className="num">{dt.graceMinutes} min</td>
                  <td className="num">{st.billableAmount > 0 ? usd(st.billableAmount, 2) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {waivedReason != null ? (
            <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <p className="tl-note" style={{ margin: 0 }}>
                Detention waived: &ldquo;{waivedReason}&rdquo;.
              </p>
              {may("bill") ? <UnwaiveDetentionButton loadId={load.id} loadNumber={load.loadNumber} /> : null}
            </div>
          ) : load.status === "completed" && dt.unbilled > 0 && may("bill") ? (
            <div style={{ marginTop: 8 }}>
              <WaiveDetentionButton loadId={load.id} loadNumber={load.loadNumber} amount={dt.unbilled} />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );

  // ── Tab 2: Economics & Margin Workbench ───────────────────────────────────────────────────
  const countSec =
    evaluation && flipped ? (
      <section className="sec">
        <h3>Count Every Mile Analysis</h3>
        <div className="sec-box">
          <p className="tl-note" style={{ margin: "0 0 12px" }}>
            <b>The pay is the same either way. The miles it has to cover are not.</b> The same money spread over more miles pays less for each one.
          </p>
          <div className="mb">
            <Tip
              as="div"
              focusable
              className="mb-row"
              tip={milesTip(
                evaluation,
                !load.isBackhaul,
                allIn,
                wayHome,
                load.isBackhaul ? "Another load is lined up for the trip back, so those miles are paid by that load." : "Nothing is lined up for the trip back, so you drive home with no load.",
                `This is how the load is set now. ${load.isBackhaul ? "The empty miles home are left out, so the same pay goes further per mile." : "The empty miles home are charged to this load, so it has more miles to cover."}`
              )}>
              <span>{wayHome}</span>
              {bar(allIn, evaluation.verdictFloorRpm, barMax, evaluation.finalDecision)}
              <b>{perMile(allIn)}</b>
            </Tip>
            <Tip
              as="div"
              focusable
              className="mb-row"
              tip={milesTip(
                flipped,
                load.isBackhaul,
                flippedAllIn,
                otherWayHome,
                load.isBackhaul ? "Nothing is lined up for the trip back, so you drive home with no load." : "Another load is lined up for the trip back, so you drive home with no load.",
                `What it would look like if the way home were set the other way. ${load.isBackhaul ? "The empty miles home are charged to this load, so it has more miles to cover." : "The empty miles home are left out, so the same pay goes further per mile."}`
              )}>
              <span>{otherWayHome}</span>
              {bar(flippedAllIn, flipped.verdictFloorRpm, barMax, flipped.finalDecision)}
              <b>{perMile(flippedAllIn)}</b>
            </Tip>
            <div className="mb-key">
              <i /> Your floor: what a mile costs you to run. A bar that reaches the line covers it.
            </div>
          </div>
        </div>
      </section>
    ) : null;

  // ── Tab 3: Documents & Proof Workbench ─────────────────────────────────────────────────────
  // ── Tab 4: Partners & History Workbench ────────────────────────────────────────────────────
  const invoiceSec =
    load.paymentStatus && load.invoicedAt ? (
      <section className="sec">
        <h3>Invoice Details</h3>
        <div className="sec-box">
          <dl className="tl-kv" style={{ marginBottom: 10 }}>
            <dt>Number</dt>
            <dd>{load.invoiceNumber ?? "—"} · {termsLabel(load.payTermsDays)}</dd>
            <dt>Sent</dt>
            <dd>{dateTime(load.invoicedAt)}</dd>
            <dt>Due</dt>
            <dd>{dueAt ? dateTime(dueAt) : "—"}</dd>
            <dt>Status</dt>
            <dd>
              {(() => {
                const m = moneyState({ paymentStatus: load.paymentStatus, billed, received: paidAmount, writeOffAmount: numOrNull(load.writeOffAmount), writeOffReason: load.writeOffReason, overdueDays: daysPastDue(load.invoicedAt, load.payTermsDays) });
                return `${m.label}${load.paymentStatus === "paid" && load.paidAt ? ` ${dateTime(load.paidAt)}` : ""}${paidAmount != null && paidAmount > 0 && load.paymentStatus === "paid" ? ` · ${usd(paidAmount, 2)}` : ""}${m.detail ? ` · ${m.detail}` : ""}`;
              })()}
            </dd>
          </dl>
          <table className="tl-table" aria-label="Invoice lines">
            <tbody>
              {(invoiceLines ?? [{ label: "Line haul and fuel surcharge", amount: billed }]).map((l, idx) => (
                <tr key={`${idx}:${l.label}`}>
                  <td>{l.label}</td>
                  <td className="num">{usd(l.amount, 2)}</td>
                </tr>
              ))}
              <tr>
                <td><b>Total due</b></td>
                <td className="num"><b>{usd(billed, 2)}</b></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    ) : null;

  const decisionSec = decision ? (
    <section className="sec">
      <h3>Booking Decision</h3>
      <div className="sec-box">
        <span className={`tl-chip ${decision.decisionType === "overridden" ? "warn" : "ok"}`}>
          {decision.decisionType === "overridden" ? "Booked over a warning" : "Booked on its numbers"}
        </span>
        <span className="tl-sub"> · {dateTime(decision.decidedAt)}</span>
        {decision.overrideReason ? (
          <p className="tl-note" style={{ marginTop: 6 }}>
            {decision.overrideReason}
            {decision.overrideNotes ? `: ${decision.overrideNotes}` : ""}
          </p>
        ) : null}
      </div>
    </section>
  ) : null;

  const whereSec = fellThrough ? null : (
    <section className="sec">
      <h3>Load Progress</h3>
      <div className="sec-box">
        <ol className="tlv" aria-label="Progress">
          {steps.map((s) => (
            <li key={s.key} data-state={s.state} aria-current={s.state === "current" ? "step" : undefined}>
              <span className="dot">{s.state === "done" ? <Icon name="check" size={11} /> : null}</span>
              <div>
                <div className="lbl">{s.label}</div>
                {s.note ? <div className="note">{s.note}</div> : null}
              </div>
              <span className="at">{s.at ? dateTime(s.at) : s.state === "current" ? "Next" : ""}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );

  const HOLDER_VERB: Record<string, string> = {
    assigned: "Assigned to",
    reassigned: "Changed to",
    sent: "Sent to",
    accepted: "Accepted by",
    declined: "Declined by",
    recalled: "Recalled from",
    removed: "Taken off",
    dropped: "Dropped by",
    received: "Received by",
    reoffered: "Re-offered to",
    cancelled: "Load cancelled",
    tonu: "Closed as TONU",
    reopened: "Load reopened",
    deleted: "Load deleted",
    restored: "Load restored"
  };
  const HOLDER_NO_DRIVER = new Set(["cancelled", "tonu", "reopened", "deleted", "restored"]);
  const holderSec = holders.length === 0 ? null : (
    <section className="sec">
      <h3>Who Held It · {holders.length}</h3>
      <div className="sec-box">
        <ul className="feed">
          {holders.map((h) => (
            <li key={h.id}>
              <div>
                <b>{HOLDER_VERB[h.kind] ?? h.kind}</b>
                {h.driverName ? ` ${HOLDER_NO_DRIVER.has(h.kind) ? `(${h.driverName})` : h.driverName}` : HOLDER_NO_DRIVER.has(h.kind) ? "" : " a driver"}
                {h.reasonCode ? ` · ${RECALL_LABELS[h.reasonCode]}` : ""}
              </div>
              {h.reasonNote ? <div className="r">“{h.reasonNote}”</div> : null}
              <div className="t">{dateTime(h.at)} · {h.via === "phone" ? "on their phone" : h.actor}</div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );

  const activitySec = (
    <section className="sec">
      <h3>Activity Trail · {feed.length >= 25 ? "latest 25" : feed.length}</h3>
      <div className="sec-box">
        {feed.length === 0 ? (
          <p className="tl-note">Nothing recorded on this load yet.</p>
        ) : (
          <ul className="feed">
            {feed.map((e) => (
              <li key={e.id}>
                <div>
                  <b>{ACTION_LABEL[e.action] ?? e.action}</b> · {e.summary}
                </div>
                {e.reason ? <div className="r">“{e.reason}”</div> : null}
                <div className="t">{dateTime(e.createdAt)} · {e.actor}</div>
              </li>
            ))}
          </ul>
        )}
        {feed.length >= 25 && load.loadNumber ? (
          <p className="tl-note" style={{ marginTop: 8 }}>
            The latest 25 are shown. <Link href={`/audit?q=${encodeURIComponent(load.loadNumber)}`}>See all history in the audit log</Link>.
          </p>
        ) : null}
      </div>
    </section>
  );

  const moreSec = (
    <section className="sec">
      <h3>Disruptions & Emergency Actions</h3>
      <div className="sec-box lv-more">
        {can.cancel || can.tonu || can.reschedule ? (
          <DisruptionButtons
            loadId={load.id}
            loadNumber={load.loadNumber ?? "This load"}
            can={can}
            pickupLocal={firstPickup ? toCentralLocal(firstPickup.getTime(), pickupStop ? stopZones[pickupStop.id] : undefined) : null}
            pickupZone={pickupStop ? stopZones[pickupStop.id] : undefined}
            driverName={a?.driver.name ?? null}
            reconfirm={!!a && (a.status === "dispatched" || a.status === "accepted")}
          />
        ) : null}
        <DeleteLoadButton loadId={load.id} loadNumber={load.loadNumber ?? "This load"} driverName={a?.driver.name ?? null} blocked={deleteBlocked} />
        <Link className="tl-btn ghost sm" href={`/quote?like=${load.id}`}>
          Quote like this
        </Link>
      </div>
    </section>
  );

  // Tracking: the link a customer follows for this load, and the carrier's yes to share it. Stopping is always open; starting needs a connected tracking company and a load that is still open.
  const trackingRow = connectionRows.find((r) => r.capability === "tracking" && r.connected && r.configured);
  const trackingReason = !trackingRow ? "No tracking company is connected. An admin connects one under Settings, Integrations." : !["draft", "accepted", "in_progress"].includes(load.status) ? "Only a load that is still open can be tracked." : null;
  const trackingSec = (
    <section className="sec">
      <h3>Tracking</h3>
      <div className="sec-box">
        <TrackingPanel
          loadId={load.id}
          loadNumber={load.loadNumber ?? "this load"}
          shared={load.trackingShareUrl ? { url: load.trackingShareUrl, at: load.trackingSharedAt ? dateTime(load.trackingSharedAt) : "" } : null}
          providerName={load.trackingProvider ? providerName(load.trackingProvider) : trackingRow ? trackingRow.name : null}
          sandbox={trackingRow?.sandbox ?? false}
          reason={trackingReason}
          canStop
        />
      </div>
    </section>
  );

  const shelfSec = (
      <section className="sec">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>Partner integrations</h3>
          <span style={{ fontSize: 11, color: "var(--db-fg-dim)" }}>{shelfHeader(shelfConnected)}</span>
        </div>
        <div className="cp-shelf-grid">
          {shelf.map((card) => (
            <div key={card.key} className="cp-shelf-card">
              <span className="cp-shelf-corner tl">+</span>
              <span className="cp-shelf-corner tr">+</span>
              <span className="cp-shelf-corner bl">+</span>
              <span className="cp-shelf-corner br">+</span>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <span className="cp-shelf-title">{card.title}</span>
                <span className="t-st" data-tone={card.tone === "muted" ? undefined : card.tone}>{card.chip}</span>
              </div>
              <span className="cp-shelf-tagline">{card.tagline}</span>
              <div className="cp-shelf-status">
                <span>{card.line}</span>
                {card.byHand ? <span className="t-dim">{card.byHand}</span> : null}
              </div>
            </div>
          ))}
        </div>
      </section>
  );

  // ── Tier 3: Pinned Action Foot ──────────────────────────────────────────────────────────────
  const footer = (
    <>
      {gate(
        <>
          {a?.status === "draft" ? (
            <form action={sendAction} className="lv-send">
              <input type="hidden" name="loadId" value={load.id} />
              {gaps.length > 0 ? (
                <>
                  <input type="hidden" name="sendAnyway" value="1" />
                  <p className="tl-note warn">Not ready: still missing {gapsPhrase(gaps)}.</p>
                </>
              ) : null}
              <SubmitButton className={gaps.length > 0 ? "tl-btn" : "tl-btn primary"} pending="Sending…">
                {gaps.length > 0 ? "Send anyway" : "Send to driver"}
              </SubmitButton>
            </form>
          ) : null}
          {a?.status === "dispatched" && linked ? (
            <p className="tl-sub" role="status">
              {link!.item?.status === "failed"
                ? `Not delivered to ${a.driver.name}'s phone: ${FAILURE_TEXT[(link!.item.lastError ?? "unreachable") as FailureWord] ?? FAILURE_TEXT.unreachable} Retry, or call them and answer for them below.`
                : link!.item
                  ? link!.item.attempts > 0
                    ? `Could not reach ${a.driver.name}'s phone yet. Trying again.`
                    : `Sending to ${a.driver.name}'s phone…`
                  : `On ${a.driver.name}'s phone. Waiting for their answer.`}
            </p>
          ) : null}
          {a?.status === "dispatched" && link?.item?.status === "failed" ? (
            <form action={retryBridgeAction}>
              <input type="hidden" name="loadId" value={load.id} />
              <SubmitButton className="tl-btn sm" pending="Trying…">Retry delivery</SubmitButton>
            </form>
          ) : null}
          {a?.status === "dispatched" ? (
            <details className="demo-controls">
              <summary>{linked ? "Answer for the driver (their phone is connected)" : "Answer for the driver (phone not connected)"}</summary>
              <form action={respondAction}>
                <input type="hidden" name="loadId" value={load.id} />
                <button type="submit" disabled hidden tabIndex={-1} aria-hidden="true" />
                <span className="tl-sub">
                  Waiting on {a.driver.name}. {linked ? "Use this only when you have the answer by phone call or text, such as a driver out of coverage." : "Their phone is not connected, so the answer is entered here."} It is kept as answered by you:
                </span>
                <DeclineNote loadId={load.id} />
                <SubmitButton name="response" value="accepted" className="tl-btn primary sm">Driver accepts</SubmitButton>
                <SubmitButton name="response" value="declined" className="tl-btn sm">Driver declines</SubmitButton>
              </form>
            </details>
          ) : null}
        </>,
        "dispatch"
      )}
      {gate(
        <>
          {canInvoiceStatus(load.status, load.tonuRevenue != null ? num(load.tonuRevenue) : null) && !load.paymentStatus ? (
            <InvoiceDialog loadId={load.id} loadNumber={load.loadNumber ?? "This load"} defaults={{ number: suggestedNumber }} context={invoiceContext} blockers={readiness.blockers} cautions={readiness.cautions} />
          ) : null}
          {load.paymentStatus ? (
            <Link href={`/invoices/${load.id}`} className="tl-btn">
              View invoice
            </Link>
          ) : null}
        </>,
        "bill"
      )}
      {gate(
        <>
          {load.paymentStatus === "invoiced" ? <PaidDialog loadId={load.id} invoiceNumber={load.invoiceNumber} billed={billed} owing={owing} canWriteOff={may("writeoff")} tz={workspaceZone} /> : null}
        </>,
        "bill"
      )}
    </>
  );

  // Taking something back is rare and needs a reason: it is under More, so the foot holds only this stage's next action.
  const canUndoTrip = (load.status === "in_progress" && !!a) || ((load.status === "cancelled" || load.status === "tonu") && !load.paymentStatus) || (load.status === "completed" && !load.paymentStatus && !settled && !!a);
  const canUndoMoney = load.paymentStatus === "invoiced" || load.paymentStatus === "paid";
  const correctionsSec =
    canUndoTrip || canUndoMoney ? (
      <div className="lv-more">
        {gate(
          <>
          {load.status === "in_progress" && a ? (
            <ConfirmForm action={undoStartAction} fields={{ loadId: load.id }} label="Take the pickup back" title={`Take back the pickup on ${load.loadNumber ?? "this load"}?`} eyebrow="Trip" confirmLabel="Take it back" destructive askReason>
              <p className="tl-note">For a pickup entered against the wrong load, or before it happened.</p>
            </ConfirmForm>
          ) : null}
          {(load.status === "cancelled" || load.status === "tonu") && !load.paymentStatus ? (
            <ConfirmForm action={reopenCancelledAction} fields={{ loadId: load.id }} label={load.status === "tonu" ? "Take the TONU back" : "Reopen this load"} title={`Reopen ${load.loadNumber ?? "this load"}?`} eyebrow="Load" confirmLabel="Reopen it" askReason>
              <p className="tl-note">For a load cancelled or turned into a TONU by mistake.</p>
            </ConfirmForm>
          ) : null}
          {load.status === "completed" && !load.paymentStatus && !settled && a ? (
            <ConfirmForm action={reopenDeliveredAction} fields={{ loadId: load.id }} label="Take the delivery back" title={`Take back the delivery of ${load.loadNumber ?? "this load"}?`} eyebrow="Trip" confirmLabel="Take it back" destructive askReason>
              <p className="tl-note">For a delivery entered against the wrong load.</p>
            </ConfirmForm>
          ) : null}
        </>,
          "dispatch"
        )}
        {gate(
          <>
          {load.paymentStatus === "invoiced" && (load.factoringStatus === "none" || load.factoringStatus === "rejected") && !(paidAmount != null && paidAmount > 0) ? (
            <ConfirmForm action={voidInvoiceAction} fields={{ loadId: load.id }} label="Take the invoice back" title={`Take back ${load.invoiceNumber ?? "this invoice"}?`} eyebrow="Invoice" confirmLabel="Take it back" destructive askReason>
              <p className="tl-note">For an invoice made for the wrong amount or the wrong customer.</p>
            </ConfirmForm>
          ) : null}
          {(load.paymentStatus === "paid" || (load.paymentStatus === "invoiced" && paidAmount != null && paidAmount > 0)) ? (
            <ConfirmForm action={undoPaidAction} fields={{ loadId: load.id }} label="Undo payment" title={`Take back the latest payment on ${load.invoiceNumber ?? "this invoice"}?`} eyebrow="Payment" confirmLabel="Take it back" destructive askReason>
              <p className="tl-note">For a payment entered against the wrong invoice.</p>
            </ConfirmForm>
          ) : null}
          </>,
          "admin"
        )}
      </div>
    ) : null;

  const chips = (
    <>
      <StatusChip status={load.status} />
      {fellThrough ? null : <VerdictChip verdict={evaluation?.finalDecision ?? null} />}
      {a && ASSIGNMENT_STATUS[a.status]?.label !== LOAD_STATUS[load.status]?.label ? <AssignmentChip status={a.status} /> : null}
    </>
  );

  const sub = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <strong>{load.brokerName ?? "Direct Shipper"}</strong>
      {load.brokerMcNumber ? <span className="dim">MC {load.brokerMcNumber}</span> : null}
      {load.brokerPhone ? (
        <a href={telHref(load.brokerPhone)} style={{ color: "var(--db-accent-fg)", textDecoration: "none" }}>
          {load.brokerPhone}
        </a>
      ) : null}
    </span>
  );

  // ── The drawer's focused view (Chris 2026-11-23): what this load is waiting on, then Trip / Money / Paperwork / More.
  const pickupCity = originCity;
  const pickupWhen = firstStop?.timeWindowEarliest ? stopTime(firstStop.timeWindowEarliest, zoneOfStop(firstStop)) : null;
  const driverName = a?.driver.name ?? null;
  // An old position is not "now": the line says how old it is instead of reading last week's speed as this minute's.
  const fix = tracking.status === "tracking" ? fixAge(tracking.asOf, Date.now()) : null;
  const nextText: string | null = fellThrough
    ? null
    : load.paymentStatus === "paid"
      ? "Paid. Nothing left to do on this load."
      : load.paymentStatus === "invoiced"
        ? `Invoiced${load.invoiceNumber ? ` ${load.invoiceNumber}` : ""}. Waiting on ${usd(owing, 2)} from ${load.brokerName ?? "the customer"}.`
        : delivered
          ? readiness.blockers.length > 0
            ? `Delivered. Before it can be invoiced: ${readiness.blockers[0]}`
            : "Delivered. Next: invoice it."
          : load.status === "in_progress"
            ? tracking.status === "tracking"
              ? fix?.old
                ? `On the road${driverName ? ` with ${driverName}` : ""}. The last position is ${lateText(fix.minutes)} old.`
                : tracking.headline
              : `On the road${driverName ? ` with ${driverName}` : ""}.`
            : !a
              ? "Next: put a driver on it."
              : a.status === "draft"
                ? gaps.length > 0
                  ? `Next: send it to ${a.driver.name}. Still missing ${gapsPhrase(gaps)}.`
                  : `Next: send it to ${a.driver.name}.`
                : a.status === "dispatched"
                  ? `Waiting on ${a.driver.name} to accept.`
                  : `Next: pickup${pickupWhen ? ` ${pickupWhen}` : ""} at ${pickupCity}${driverName ? `, ${driverName}` : ""}.`;
  const nextLate = load.status === "in_progress" && tracking.status === "tracking" && tracking.late && !fix?.old;
  const nextLine = nextText ? (
    <p className={`lv-next${nextLate ? " late" : ""}`} role="status">
      <b>{load.status === "in_progress" ? "Now" : "Next"}</b>
      <span>{nextText.replace(/^Next: /, "")}</span>
    </p>
  ) : null;

  const open = ["draft", "accepted", "in_progress"].includes(load.status);
  const preTrip = !a || ["draft", "dispatched", "accepted"].includes(a.status);
  const moving = load.status === "in_progress";
  // Only what this stage needs, in the order a dispatcher reaches for it. A section with nothing to say is not drawn.
  // Trip: the stops as a short list (when, where, and what happened there), the few details a dispatcher quotes on the phone, and the wait in one line.
  const roleWord = (s: (typeof load.stops)[number]) => (roleOfStop(s) === "pickup" ? "Pickup" : "Delivery");
  const drawerStops = (
    <section className="lv-sec">
      <header className="lv-sec-h">
        <h3>Stops</h3>
      </header>
      <ol className="lv-stops">
        {load.stops.map((s) => {
          const ref = refList(s.referenceNumbers).join(", ") || null;
          const closes = s.timeWindowLatest && s.timeWindowEarliest && s.timeWindowLatest.getTime() !== s.timeWindowEarliest.getTime() ? s.timeWindowLatest : null;
          const contact = [s.contactName, s.contactPhone].filter(Boolean).join(" · ");
          const done = s.arrivedAt != null;
          return (
            <li key={s.id} data-done={done ? "true" : undefined}>
              <span className="lv-dot" aria-hidden="true" />
              <div className="lv-stop-main">
                <b>{`${roleWord(s)} · ${s.facilityName ?? s.addressString.split(",")[0]}`}</b>
                <span title={s.addressString}>{s.addressString}</span>
                {contact ? <span>{contact}</span> : null}
                {s.stopNotes ? <span className="t-warn" title={s.stopNotes}>{s.stopNotes}</span> : null}
              </div>
              <div className="lv-stop-when">
                <b>{s.timeWindowEarliest ? stopTime(s.timeWindowEarliest, zoneOfStop(s)) : "Window open"}</b>
                {closes ? <span>closes {stopTime(closes, zoneOfStop(s))}</span> : null}
                {done ? <span>{`Arrived ${stopTime(s.arrivedAt!, zoneOfStop(s))}${s.waitMinutes ? ` · waited ${s.waitMinutes} min` : ""}${s.arrivedSource === "phone" ? " · from the driver's phone" : ""}`}</span> : null}
                <span>{[ref ? `Ref ${ref}` : "No reference number", s.sealNumber ? `seal ${s.sealNumber}` : null].filter(Boolean).join(" · ")}</span>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
  const detailRow = (k: string, v: React.ReactNode) => (
    <div key={k}>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
  const drawerDetails = (
    <section className="lv-sec">
      <h3>Details</h3>
      <dl className="lv-kv">
        {load.poNumber ? detailRow("Customer PO", load.poNumber) : null}
        {detailRow("Equipment", [load.trailer ? `Trailer ${load.trailer.number}` : load.trailerType ? load.trailerType.replace(/_/g, " ") : "Not stated", size, needs.length > 0 ? `needs ${needs.join(", ")}` : null].filter(Boolean).join(" · "))}
        {detailRow("Weight", `${weightVal != null ? `${weightVal.toLocaleString("en-US")} lb` : "Not set"}${load.hazmatClass ? ` · hazmat ${load.hazmatClass}` : ""}`)}
        {detailRow(
          "Miles",
          <>
            {`${num(load.pickupDeadheadMiles)} empty to pickup · ${loadedMiles} loaded · ${load.isBackhaul ? 0 : num(load.returnDeadheadMiles)} empty home`}
            {milesVariance ? (
              <span className={`tl-sub${milesVariance.over ? " warn" : ""}`}>
                {" "}
                Quoted {milesVariance.quoted} mi, drove {milesVariance.actual} mi ({milesVariance.pct > 0 ? "+" : ""}
                {(milesVariance.pct * 100).toFixed(1)}%){milesVariance.over ? ": more than 8% off, quote per-mile was inaccurate" : ""}
              </span>
            ) : null}
          </>
        )}
        {detailRow("Terms", `${load.payTermsDays != null ? termsLabel(load.payTermsDays) : load.paymentTerms ?? "Not set"} · ${load.channel ?? "dispatch"}`)}
        {load.notes ? detailRow("Notes", load.notes) : null}
        {settled && may("billing_details") ? detailRow("Driver paid", <>On statement <Link href={`/settlements/${settled.id}`}>{settled.number}</Link></>) : null}
      </dl>
    </section>
  );
  const waitWordsLine = dt.totalWaitMinutes > 0 ? `${dt.totalWaitMinutes} min · ${dt.billable > 0 ? `${usd(dt.billable, 2)} billable` : "nothing billable"}` : "none yet";
  const drawerTrip = (
    <>
      {moving ? <LoadTracker t={tracking} quietHead /> : null}
      {drawerStops}
      {preTrip && open ? gate(driverSec, "dispatch") : null}
      {open && !trailerOk ? gate(trailerSec, "dispatch") : null}
      {/* Pickup, arrivals, waits, delivery and what the trip cost: in view while it is the work, one line once it is done. */}
      {tripSec ? open ? gate(tripSec, "dispatch", "figures") : <Fold title="Trip record" meta={load.completedAt ? `delivered ${dateTime(load.completedAt)}` : undefined}>{gate(tripSec, "dispatch", "figures")}</Fold> : null}
      {gate(relaySec, "dispatch")}
      {drawerDetails}
      {/* Booked and heading to the pickup: where the truck is now. */}
      {load.status === "accepted" && tracking.status === "tracking" ? <LoadTracker t={tracking} /> : null}
      {dt.stops.length > 0 || evidence.total > 0 ? <Fold title="Dock waiting and detention" meta={waitWordsLine}>{docksSec}</Fold> : null}
      {!(preTrip && open) ? <Fold title="Driver" meta={a ? a.driver.name : "no driver"}>{gate(driverSec, "dispatch")}</Fold> : null}
      {trailerOk || !open ? <Fold title="Trailer" meta={load.trailer ? load.trailer.number : load.trailerType ? load.trailerType.replace(/_/g, " ") : "none"}>{gate(trailerSec, "dispatch")}</Fold> : null}
      {open ? gate(moreSec, "dispatch") : null}
    </>
  );

  // Money: one ruled list, what came in, what went out, and what is left; the mile analysis under it.
  const moneyRow = (label: string, amount: number, opts: { cost?: boolean; strong?: boolean; note?: string } = {}) => (
    <div key={label} className={opts.strong ? "lv-total" : undefined}>
      <dt>
        {label}
        {opts.note ? <span>{opts.note}</span> : null}
      </dt>
      <dd>{opts.cost && amount > 0 ? `−${usd(amount, 2)}` : usd(amount, 2)}</dd>
    </div>
  );
  const drawerMoney = (
    <>
    <section className="lv-sec">
      <header className="lv-sec-h">
        <h3>Money</h3>
        {may("billing_details") ? <BillingDetailsDialog
              loadId={load.id}
              loadNumber={load.loadNumber ?? "This load"}
              invoiced={!!load.paymentStatus}
              initial={{ brokerName: load.brokerName ?? "", brokerMcNumber: load.brokerMcNumber ?? "", brokerPhone: load.brokerPhone ?? "", brokerEmail: load.brokerEmail ?? "", poNumber: load.poNumber ?? "", payTermsDays: load.payTermsDays != null ? String(load.payTermsDays) : "", revenueNote: load.revenueNote ?? "" }}
            /> : null}
      </header>
      <dl className="lv-ledger">
        {load.status === "cancelled" || load.status === "quote" ? (
          <>
            {moneyRow("Revenue", 0, { note: "cancelled" })}
            {ledger.referenceRate != null ? (
              <div key="Original rate">
                <dt>
                  Original rate
                  <span>reference only, not earned</span>
                </dt>
                <dd><s>{usd(ledger.referenceRate, 2)}</s></dd>
              </div>
            ) : null}
          </>
        ) : load.status === "tonu" ? (
          <>
            {moneyRow("TONU fee", ledger.revTonu)}
            {ledger.referenceRate != null ? (
              <div key="Original rate">
                <dt>
                  Original rate
                  <span>reference only, not earned</span>
                </dt>
                <dd><s>{usd(ledger.referenceRate, 2)}</s></dd>
              </div>
            ) : null}
          </>
        ) : (
          <>
            {moneyRow("Linehaul", ledger.revAgreed)}
            {ledger.revVariance !== 0 ? (
              <div key="Linehaul variance">
                <dt>
                  {ledger.revVariance < 0 ? "Short pay" : "Rate adjustment"}
                  <span>{`paid ${usd(ledger.revLinehaul, 2)}`}</span>
                </dt>
                <dd>{`${ledger.revVariance > 0 ? "+" : "−"}${usd(Math.abs(ledger.revVariance), 2)}`}</dd>
              </div>
            ) : null}
            {ledger.revFsc > 0 ? moneyRow("Fuel surcharge", ledger.revFsc) : null}
            {ledger.revDetention > 0 ? moneyRow("Detention", ledger.revDetention) : null}
            {ledger.revLayover > 0 ? moneyRow("Layover", ledger.revLayover) : null}
          </>
        )}
        {may("billing_details") ? moneyRow("Driver pay", ledger.expDriver, { cost: true, note: ledger.driverCostNote }) : null}
        {moneyRow("Fuel", ledger.expFuel, { cost: true, note: ledger.fuelCostSource })}
        {ledger.expTolls > 0 ? moneyRow("Tolls", ledger.expTolls, { cost: true }) : null}
        {ledger.expRider > 0 ? moneyRow("Insurance rider", ledger.expRider, { cost: true }) : null}
        {ledger.expMisc > 0 ? moneyRow("Lumpers and other", ledger.expMisc, { cost: true }) : null}
        {may("billing_details") ? (
          <div className="lv-total">
            <dt>
              Left over
              <span>{`${netMarginPct.toFixed(1)}% · ${perMile(netProfitPerMile)} over all miles`}</span>
            </dt>
            <dd className={netProfit >= 0 ? "ok" : "bad"}>{usd(netProfit, 2)}</dd>
          </div>
        ) : null}
      </dl>
    </section>
    {countSec ? <Fold title="Count every mile" meta={`${wayHome.toLowerCase()} ${perMile(allIn)}`}>{countSec}</Fold> : null}
    {decisionSec ? <Fold title="Booking decision" meta={decision!.decisionType === "overridden" ? "booked over a warning" : "booked on its numbers"}>{decisionSec}</Fold> : null}
    {correctionsSec ? <Fold title="Take something back">{correctionsSec}</Fold> : null}
    </>
  );

  // Paperwork: the documents as a list with the upload, the inspector when a paper has to be read closely, then the invoice.
  const drawerPaper = (
    <>
      <section className="lv-sec">
        <h3>Documents</h3>
        {gate(
          <LoadDocuments
            loadId={load.id}
            items={docs.map((d) => ({ id: d.id, kind: d.kind, name: d.name, bytes: d.bytes, when: dateTime(d.createdAt), by: d.addedBy, stop: stopLabelOf(d.stopId), toDriver: d.toDriver }))}
            locked={docsLocked}
            canRemove={may("documents_remove")}
            defaultKind={load.status === "completed" ? "pod" : "rate_con"}
            deliveryStops={deliveryStopOptions}
          />,
          "documents"
        )}
      </section>
      {docs.length > 0 ? (
        <Fold title="Read a document here" meta={`${docs.length} on file`}>
          {gate(
            <SplitDocViewer
              loadId={load.id}
              items={docs.map((d) => ({ id: d.id, kind: d.kind, name: d.name, bytes: d.bytes, when: dateTime(d.createdAt), by: d.addedBy, stop: stopLabelOf(d.stopId), toDriver: d.toDriver }))}
              deliveryStops={deliveryStopOptions}
              locked={docsLocked}
              canRemove={may("documents_remove")}
              defaultKind={load.status === "completed" ? "pod" : "rate_con"}
            />,
            "documents"
          )}
        </Fold>
      ) : null}
      {gate(invoiceSec, "bill")}
    </>
  );
  // More: the record of the load and what is reached for now and then.
  const cabSheet = (
    <DriverCabSheet
      driverView={driverView}
      driverName={a?.driver.name ?? null}
      equipmentType={load.trailer?.number ? `Trailer ${load.trailer.number}` : (load.trailerType ?? null)}
      showPay={may("billing_details")}
      stopZones={Object.fromEntries(load.stops.map((s) => [s.stopSequence, stopZones[s.id]]))}
      originZone={load.stops[0] ? stopZones[load.stops[0].id] : workspaceZone}
      destinationZone={lastStopZone ?? workspaceZone}
      fallbackZone={workspaceZone}
    />
  );
  const drawerMore = (
    <>
      {whereSec}
      {activitySec}
      {holderSec ? <Fold title="Who held it" meta={`${holders.length}`}>{holderSec}</Fold> : null}
      {driverView ? <Fold title="What the driver sees" meta={a ? a.driver.name : undefined}>{cabSheet}</Fold> : null}
      <Fold title="Customer tracking link" meta={load.trackingShareUrl ? "shared" : "not shared"}>{gate(trackingSec, "dispatch")}</Fold>
      <Fold title="Partners" meta={shelfHeader(shelfConnected)}>{shelfSec}</Fold>
      {open ? null : gate(moreSec, "dispatch")}
    </>
  );
  // The drawer's summary: the next step, the trip in two lines, three figures, and what still blocks this stage. No boxes; one figure row.
  const marginTone = deckMargin == null ? "" : deckMargin >= 0 ? "ok" : "bad";
  const stillNeeds: string[] = [];
  if (open) {
    if (!a) stillNeeds.push("a driver");
    else if (!driverOk && a.status !== "completed") stillNeeds.push("driver clearance");
    if (!trailerOk) stillNeeds.push("a trailer");
    if (!weightOk) stillNeeds.push(`a weight check (over ${maxWeightLbs.toLocaleString("en-US")} lb)`);
  }
  if ((open || (delivered && !load.paymentStatus)) && !refsOk) stillNeeds.push(gapsPhrase(gaps));
  const drawerDeck = (
    <div className="lv-sum">
      {nextLine}
      <div className="lv-route">
        <div className="lv-stop">
          <span className="lv-k">Pickup</span>
          <b title={load.originAddress ?? undefined}>{originCity}</b>
          <span>{firstStop?.timeWindowEarliest ? stopTime(firstStop.timeWindowEarliest, zoneOfStop(firstStop)) : "Window open"}</span>
        </div>
        <span className="lv-arrow" aria-hidden="true">→</span>
        <div className="lv-stop">
          <span className="lv-k">Delivery</span>
          <b title={load.destinationAddress ?? undefined}>{destCity}</b>
          <span>{lastStop?.timeWindowEarliest ? stopTime(lastStop.timeWindowEarliest, zoneOfStop(lastStop)) : "Window open"}</span>
        </div>
      </div>
      <p className="lv-meta">
        {`${miles(loadedMiles)} loaded · ${miles(totalMiles)} total · ${wayHome.toLowerCase()}`}
        {a ? ` · ${a.driver.name}` : ""}
      </p>
      <dl className="lv-stats">
        <div>
          <dt>{deckTonu ? "TONU fee" : deckMargin != null ? "Margin" : delivered ? "Paid" : "Gross"}</dt>
          <dd className={deckMargin != null ? marginTone : undefined}>{deckHeroText}</dd>
          {deckMargin != null ? <span>{`${deckHeroLabel} · floor ${perMile(floorThreshold)}`}</span> : null}
        </div>
        {deckMargin != null ? (
          <div>
            <dt>{delivered ? "Paid" : "Gross"}</dt>
            <dd>{deckGross}</dd>
            {paidDiffers ? <span>{`${usd(num(load.quotedRevenue), 2)} agreed`}</span> : null}
          </div>
        ) : null}
        {!deckTonu && allIn != null ? (
          <div>
            <dt>Per mile</dt>
            <dd>{perMile(allIn)}</dd>
            {perLoaded != null ? <span>{`${perMile(perLoaded)} loaded`}</span> : null}
          </div>
        ) : null}
      </dl>
      {readOnlyNote}
      {alerts.length > 0 ? <AlertList alerts={alerts} /> : null}
      {stillNeeds.length > 0 ? (
        <p className="lv-needs">
          <b>Missing</b>
          <span>{stillNeeds.join(" · ")}</span>
        </p>
      ) : null}
      {fellThrough ? (
        <p className="lv-fell">
          <b>{load.status === "tonu" ? "TONU" : "Cancelled"}</b>
          <span>
            {reasonLabel(load.cancelReason)}
            {load.cancelNote ? `. ${load.cancelNote}` : ""}
          </span>
        </p>
      ) : null}
    </div>
  );

  return (
    <LoadCockpit
      title={`Load ${load.loadNumber ?? ""}`}
      sub={sub}
      chips={chips}
      href={`/loads/${load.id}`}
      actions={fellThrough || !may("dispatch") ? null : <LoadEditDialog loadId={load.id} loadNumber={load.loadNumber ?? "This load"} initial={toEditValues(load, stopZones)} scheduleLocked={scheduleLocked} driverName={a && ["dispatched", "accepted"].includes(a.status) ? a.driver.name : null} truckName={load.vehicle?.name ?? null} dealLocked={load.paymentStatus ? "This load has been invoiced, so its truck, rate and miles are what was billed and stay as they are." : settled ? "This load is on a driver statement, so its truck, rate and miles are what the driver was paid on and stay as they are." : null} />}
      footer={footer}
      deck={drawerDeck}
      trip={drawerTrip}
      money={drawerMoney}
      paper={drawerPaper}
      more={drawerMore}
      docsCount={docs.length}
    />
  );
}
