import { deckHero } from "@/lib/deck-hero";
import Link from "next/link";
import { grossOf } from "@/lib/load-gross";
import { dueAt as dueAtOf } from "@/lib/overdue";
import { notFound } from "next/navigation";
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
import { WaiveDetentionButton } from "./waive-detention";
import { getThresholds } from "@/server/tl/thresholds";
import { settlementOfLoad } from "@/server/tl/settlement";
import { AssignFields } from "./assign-fields";
import { DeclineNote } from "./load-view-fields";
import { AssignTrailer } from "./trailer-forms";
import { trailerBlocker } from "@/lib/trailer-clearance";
import { acknowledgeDiscrepancyAction, assignAction, discrepancyAction, dropAction, receiveAction, reopenCancelledAction, reopenDeliveredAction, respondAction, retryBridgeAction, sendAction, unassignAction, undoPaidAction, undoStartAction, voidInvoiceAction } from "@/app/(desk)/actions";
import { InvoiceDialog, LoadEditDialog, PaidDialog, TripEntry } from "./load-actions";
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
import { Icon } from "./kit/icons";
import { Tip, type TipData } from "./kit/tooltip";
import { dateTime, miles, PAY_KIND_LABEL, payLabel, perMile, signedPct, stopTime, usd } from "@/lib/desk-format";
import { rateConTotal } from "@/lib/pay";
import { telHref } from "@/lib/contact";
import { LoadCockpit, SplitDocViewer, DriverCabSheet } from "./load-cockpit";
import { LoadTracker } from "./load-tracker";
import { getLoadTracking } from "@/server/tl/load-tracking";
import "./cockpit.css";

const TONE: Record<string, "ok" | "warn" | "bad"> = { accept: "ok", caution: "warn", reject: "bad" };

/**
 * TrueLane Dispatch Cockpit
 * Function-first, high-density operations cockpit reflecting the mobile app engineering.
 * 3-tier layout:
 * - Tier 1: Pinned Status & Compliance Deck
 * - Tier 2: 4 Specialized Workbenches (Route, Margin, Docs, Partners)
 * - Tier 3: Pinned Action Foot
 */
export async function LoadView({ id, variant }: { id: string; variant: "drawer" | "page" }) {
  const detail = await getLoadDetail(id);
  if (!detail) notFound();

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
  const heroGross = delivered ? earned : evaluation?.effectiveGross ?? num(load.quotedRevenue);
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
    pickupRefs: [...refList(load.pickupNumbers), ...load.stops.filter((s) => s.stopRole === "pickup").flatMap((s) => refList(s.referenceNumbers))],
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
    stops: ["in_progress", "completed"].includes(load.status) ? load.stops.map((s) => ({ sequence: s.stopSequence, role: (s.stopRole ?? s.stopType) === "pickup" || s.stopType === "origin" ? "pickup" : "delivery", arrivedAt: s.arrivedAt, waitMinutes: s.waitMinutes, fromPhone: s.arrivedSource === "phone" })) : undefined
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
  const deliveryStopOptions = load.stops.filter((s) => (s.stopRole ?? s.stopType) === "delivery").map((s) => ({ id: s.id, label: `Stop ${s.stopSequence}, ${s.facilityName ?? s.addressString}` }));
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
  const weightOk = weightVal == null || weightVal <= 45000;
  const trailerOk = !!load.trailer || !!load.trailerType;
  const driverOk = !!a && (a.status === "accepted" || a.status === "dispatched" || a.status === "in_progress");
  const refsOk = gaps.length === 0;
  const floorThreshold = delivered && frozenFloor != null ? frozenFloor : (evaluation?.verdictFloorRpm ?? 0);
  const floorOk = allIn != null && floorThreshold > 0 && allIn >= floorThreshold;

  // Margin Ledger Math
  const revLinehaul = num(load.quotedRevenue);
  const revFsc = num(load.fuelSurcharge);
  const revDetention = dt.billedExtra > 0 ? dt.billedExtra : (load.status === "completed" ? dt.billable : 0);
  const revLayover = num(load.layoverPay);
  const revTonu = num(load.tonuRevenue);
  const totalRev = revLinehaul + revFsc + revDetention + revLayover + revTonu;

  const expDriver = a?.payEstimate != null ? num(a.payEstimate) : 0;
  const expFuel = num(load.expenseFuelActual) > 0 ? num(load.expenseFuelActual) : (evaluation?.fuelCost?.totalFuelCost ?? 0);
  const expTolls = num(load.expenseTolls);
  const expRider = num(load.insuranceRiderFlat);
  const expMisc = Math.max(0, num(load.expenseMisc));
  const totalExp = expDriver + expFuel + expTolls + expRider + expMisc;

  const netProfit = totalRev - totalExp;
  const netMarginPct = totalRev > 0 ? (netProfit / totalRev) * 100 : 0;
  const netProfitPerMile = totalMiles > 0 ? netProfit / totalMiles : 0;

  // Deck figures. One hero: the margin against the floor when the load has a floor, else what it pays (a load not judged yet must never leave the header blank).
  const deckTonu = load.status === "tonu";
  const deckLead = deckHero({ tonu: deckTonu, allIn, floor: floorThreshold, verdictTone: tone });
  const deckHasFloor = deckLead.hasFloor;
  const deckMargin = deckLead.margin;
  const deckGross = usd(heroGross, Number.isInteger(heroGross) ? 0 : 2);
  const deckHeroTone = deckLead.tone;
  const deckHeroText = deckTonu ? usd(earned, 2) : deckMargin != null ? `${deckMargin >= 0 ? "+" : "−"}${usd(Math.abs(deckMargin), 2)}/mi` : deckGross;
  const deckHeroLabel = deckTonu ? "TONU fee" : deckMargin != null ? (deckMargin >= 0 ? "over your floor" : "under your floor") : allIn != null ? `gross pay, ${perMile(allIn)} every mile` : "gross pay";
  // Only what is not clear shows: a healthy gate says nothing.
  const deckGates: { cls: string; title: string; text: string }[] = [];
  if (!weightOk) deckGates.push({ cls: "warn", title: "Weight validation", text: `WEIGHT: ${weightVal ? `${(weightVal / 1000).toFixed(1)}k lbs` : "NOT SET"}` });
  if (!trailerOk) deckGates.push({ cls: "bad", title: "Trailer clearance", text: `TRAILER: ${load.trailer ? load.trailer.number : load.trailerType ? load.trailerType.replace(/_/g, " ") : "NO TRAILER"}` });
  if (!driverOk) deckGates.push({ cls: a ? "warn" : "bad", title: "Driver assignment & HOS clearance", text: `DRIVER: ${a ? `${a.driver.name} (${a.status})` : "UNASSIGNED"}` });
  if (!refsOk) deckGates.push({ cls: "warn", title: "Documentation & reference numbers", text: `PAPERS: MISSING ${gapsPhrase(gaps).toUpperCase()}` });

  // ── Tier 1: Pinned Console Deck Strip ────────────────────────────────────────────────────────
  const deck = (
    <>
      {/* Route Ribbon */}
      <div className="cp-ribbon">
        <div className="cp-ribbon-stop">
          <span className="cp-sub">Pickup</span>
          <span className="cp-city" title={load.originAddress ?? undefined}>{originCity}</span>
          <span style={{ fontSize: 11, color: "var(--db-fg-dim)" }}>
            {firstStop?.timeWindowEarliest ? stopTime(firstStop.timeWindowEarliest, zoneOfStop(firstStop)) : "Window open"}
          </span>
        </div>

        <div className="cp-ribbon-mid">
          <div className="cp-ribbon-line">
            <span>{loadedMiles} mi</span>
            <span style={{ color: "var(--db-fg-dim)" }}>→</span>
          </div>
          <div className="cp-ribbon-dh">
            {totalMiles} total mi · {wayHome.toLowerCase()}
          </div>
          {a ? (
            <div className="cp-ribbon-telemetry" style={{ marginTop: 4 }}>
              <span className="cp-telemetry-ping" />
              <span>{a.driver.name} · {a.status === "in_progress" ? "On Road" : a.status === "dispatched" ? "Dispatched" : a.status === "accepted" ? "En Route" : "Assigned"}</span>
            </div>
          ) : null}
        </div>

        <div className="cp-ribbon-stop" style={{ textAlign: "right" }}>
          <span className="cp-sub">Delivery</span>
          <span className="cp-city" title={load.destinationAddress ?? undefined}>{destCity}</span>
          <span style={{ fontSize: 11, color: "var(--db-fg-dim)" }}>
            {lastStop?.timeWindowEarliest ? stopTime(lastStop.timeWindowEarliest, zoneOfStop(lastStop)) : "Window open"}
          </span>
        </div>
      </div>

      {/* Deck: one hero and one summary line (gross pay stays on it), then only the gates that are not clear. */}
      <div className="cp-deck-hero">
        <div className={`cp-hero-fig ${deckHeroTone}`}>{deckHeroText}</div>
        <div className="cp-hero-lbl">{deckHeroLabel}</div>
      </div>
      <div className="cp-deck-line" title={load.vehicle ? `${load.vehicle.name}, ${load.vehicle.type?.replace("_", " ")}` : "Fleet base floor"}>
        {deckLead.grossInLine ? <span><b>{deckGross}</b> {delivered ? "paid" : "gross"}</span> : null}
        {deckTonu ? <span><b>{miles(totalMiles)}</b> {wayHome.toLowerCase()}</span> : null}
        {deckLead.grossInLine && allIn != null ? <span><b>{perMile(allIn)}</b> every mile</span> : null}
        {!deckTonu && perLoaded != null ? <span><b>{perMile(perLoaded)}</b> loaded</span> : null}
        {!deckTonu ? (deckHasFloor || floorThreshold > 0 ? <span>floor <b>{perMile(floorThreshold)}</b></span> : <span>no floor yet</span>) : null}
        {paidDiffers ? <span>paid <b>{usd(paidLine!, 2)}</b> vs {usd(num(load.quotedRevenue), 2)} agreed</span> : null}
      </div>
      {deckGates.length > 0 ? (
        <div className="cp-gates">
          {deckGates.map((g) => (
            <span key={g.title} className={`cp-gate ${g.cls}`} title={g.title}>{g.text}</span>
          ))}
        </div>
      ) : null}

      {readOnlyNote}

      {alerts.length > 0 ? (
        <div style={{ marginTop: "var(--db-1)" }}>
          <AlertList alerts={alerts} />
        </div>
      ) : null}

      {fellThrough ? (
        <div className="sec-box" style={{ marginTop: "var(--db-1)", borderLeft: "3px solid var(--db-neg)" }}>
          <b>{load.status === "tonu" ? "TONU (Truck Ordered Not Used)" : "Load Cancelled"}</b> · {reasonLabel(load.cancelReason)}
          {load.cancelNote ? <div className="tl-note" style={{ marginTop: 4 }}>{load.cancelNote}</div> : null}
          {load.status === "tonu" && load.tonuMiles != null ? <div className="tl-sub">Truck drove {num(load.tonuMiles)} mi for it.</div> : null}
        </div>
      ) : null}
    </>
  );

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
                  {l.payEstimate != null ? ` · pay as it stood ${usd(num(l.payEstimate), 2)}` : ""}
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
                  <ReceiveForm action={receiveAction} loadId={load.id} handoff={{ id: b.id, type: b.type, locationName: b.locationName, tractorOutName: b.tractorOutName, sealNumber: b.sealNumber }} drivers={relayOptions.drivers} trucks={relayOptions.trucks} rateConTotal={rateConTotal(num(load.quotedRevenue), num(load.fuelSurcharge))} blockedByDiscrepancy={b.state === "disputed"} />
                  {b.state === "dropped" ? <DiscrepancyForm action={discrepancyAction} loadId={load.id} handoffId={b.id} location={b.locationName ?? "the handoff"} /> : null}
                </div>
              ) : null}
            </div>
          );
        })}
        {canHandOff && a ? (
          <div style={{ marginTop: 12 }}>
            <DropForm action={dropAction} loadId={load.id} loadNumber={load.loadNumber ?? "this load"} driverName={a.driver.name} />
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
            <dt>Pay</dt>
            <dd>{PAY_KIND_LABEL[a.payKind] ?? a.payKind} · {payLabel(a.payKind, num(a.payRate))}</dd>
            <dt>Estimate (display only)</dt>
            <dd>{usd(a.payEstimate == null ? null : num(a.payEstimate), 2)}</dd>
            <dt>Status</dt>
            <dd><AssignmentChip status={a.status} /></dd>
            {settled ? (
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
          <RecallForm action={unassignAction} loadId={load.id} driverName={a.driver.name} loadNumber={load.loadNumber ?? "this load"} accepted={a.status === "accepted"} />
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

  const stopsSec = (
    <section className="sec">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--db-2)" }}>
        <h3 style={{ margin: 0 }}>Stops Sequence</h3>
        {fellThrough ? null : (
          <LoadEditDialog loadId={load.id} loadNumber={load.loadNumber ?? "This load"} initial={toEditValues(load, stopZones)} scheduleLocked={scheduleLocked} driverName={a && ["dispatched", "accepted"].includes(a.status) ? a.driver.name : null} truckName={load.vehicle?.name ?? null} dealLocked={load.paymentStatus ? "This load has been invoiced, so its truck, rate and miles are what was billed and stay as they are." : settled ? "This load is on a driver statement, so its truck, rate and miles are what the driver was paid on and stay as they are." : null} />
        )}
      </div>

      <div className="sec-box">
        <table className="tl-table" aria-label="Stops">
          <tbody>
            {load.stops.map((s) => {
              const closes = s.timeWindowLatest && s.timeWindowEarliest && s.timeWindowLatest.getTime() !== s.timeWindowEarliest.getTime() ? s.timeWindowLatest : null;
              const contact = [s.contactName, s.contactPhone].filter(Boolean).join(" · ");
              return (
                <tr key={s.id}>
                  <td style={{ width: 24 }}>{s.stopSequence}</td>
                  <td>
                    <b style={{ textTransform: "capitalize" }}>{s.stopRole ?? s.stopType}</b> · {s.facilityName ?? s.addressString}
                    <div className="tl-sub">{s.addressString}</div>
                    {contact ? <div className="tl-sub">{contact}</div> : null}
                    {s.stopNotes ? <div className="tl-sub" style={{ color: "var(--db-warn)" }}>{s.stopNotes}</div> : null}
                  </td>
                  <td className="num">
                    <div>{stopTime(s.timeWindowEarliest, zoneOfStop(s))}</div>
                    {closes ? <div className="tl-sub">closes {stopTime(closes, zoneOfStop(s))}</div> : null}
                    <div className="tl-sub">{Array.isArray(s.referenceNumbers) && (s.referenceNumbers as string[]).length > 0 ? (s.referenceNumbers as string[]).join(", ") : "no reference number"}</div>
                    {s.sealNumber ? <div className="tl-sub">seal {s.sealNumber}</div> : null}
                    {s.arrivedAt ? (
                      <div className="tl-sub">
                        arrived {stopTime(s.arrivedAt, zoneOfStop(s))}
                        {s.waitMinutes != null ? ` · waited ${s.waitMinutes} min` : ""}
                        {s.arrivedSource === "phone" ? " · from the driver's phone" : ""}
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <dl className="tl-kv" style={{ marginTop: 10 }}>
          <dt>Miles (empty pickup · loaded · empty home)</dt>
          <dd>
            {num(load.pickupDeadheadMiles)} · {loadedMiles} · {load.isBackhaul ? 0 : num(load.returnDeadheadMiles)}
            {milesVariance ? (
              <div className={`tl-sub${milesVariance.over ? " warn" : ""}`}>
                Quoted {milesVariance.quoted} mi, drove {milesVariance.actual} mi ({milesVariance.pct > 0 ? "+" : ""}
                {(milesVariance.pct * 100).toFixed(1)}%){milesVariance.over ? ": more than 8% off, quote per-mile was inaccurate" : ""}
              </div>
            ) : null}
          </dd>
          <dt>Customer PO</dt>
          <dd>{load.poNumber ?? "—"}</dd>
          <dt>Credit & Terms</dt>
          <dd>{load.channel ?? "dispatch"} · {load.payTermsDays != null ? termsLabel(load.payTermsDays) : load.paymentTerms ?? "terms not set"}</dd>
          <dt>Freight Specs</dt>
          <dd>
            {load.trailerType ? load.trailerType.replace(/_/g, " ") : "Trailer not stated"}
            {load.weightLbs != null ? ` · ${load.weightLbs.toLocaleString("en-US")} lb` : ""}
            {load.hazmatClass ? ` · hazmat ${load.hazmatClass}` : ""}
            {size ? <div className="tl-sub">{size}</div> : null}
            {needs.length > 0 ? <div className="tl-sub">Needs {needs.join(", ")}</div> : null}
          </dd>
          {load.notes ? (
            <>
              <dt>Dispatcher Notes</dt>
              <dd>{load.notes}</dd>
            </>
          ) : null}
        </dl>

        {may("billing_details") ? (
          <div style={{ marginTop: 10 }}>
            <BillingDetailsDialog
              loadId={load.id}
              loadNumber={load.loadNumber ?? "This load"}
              invoiced={!!load.paymentStatus}
              initial={{ brokerName: load.brokerName ?? "", brokerMcNumber: load.brokerMcNumber ?? "", brokerPhone: load.brokerPhone ?? "", brokerEmail: load.brokerEmail ?? "", poNumber: load.poNumber ?? "", payTermsDays: load.payTermsDays != null ? String(load.payTermsDays) : "", revenueNote: load.revenueNote ?? "" }}
            />
          </div>
        ) : null}
      </div>
    </section>
  );

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
            <p className="tl-note" style={{ marginTop: 6 }}>
              Detention waived: &ldquo;{waivedReason}&rdquo;.
            </p>
          ) : load.status === "completed" && dt.unbilled > 0 && may("bill") ? (
            <div style={{ marginTop: 8 }}>
              <WaiveDetentionButton loadId={load.id} loadNumber={load.loadNumber} amount={dt.unbilled} />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );

  const routeWorkbench = (
    <>
      {gate(stopsSec, "dispatch", "billing_details")}
      {docksSec}
      {gate(driverSec, "dispatch")}
      {gate(relaySec, "dispatch")}
      {gate(trailerSec, "dispatch")}
      {gate(tripSec, "dispatch", "figures")}
      <DriverCabSheet
        driverView={driverView}
        driverName={a?.driver.name ?? null}
        equipmentType={load.trailer?.number ? `Trailer ${load.trailer.number}` : (load.trailerType ?? null)}
      />
    </>
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

  const marginWorkbench = (
    <>
      <section className="sec">
        <h3>TrueLane Margin Ledger</h3>
        <div className="cp-ledger">
          <div className="cp-ledger-card rev">
            <h4>Gross Revenue Breakdown</h4>
            <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Quoted Linehaul</span>
                <span className="num">{usd(revLinehaul, 2)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Fuel Surcharge (FSC)</span>
                <span className="num">{usd(revFsc, 2)}</span>
              </div>
              {revDetention > 0 ? (
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Detention Billed</span>
                  <span className="num">{usd(revDetention, 2)}</span>
                </div>
              ) : null}
              {revLayover > 0 ? (
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Layover Pay</span>
                  <span className="num">{usd(revLayover, 2)}</span>
                </div>
              ) : null}
              {revTonu > 0 ? (
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>TONU Fee</span>
                  <span className="num">{usd(revTonu, 2)}</span>
                </div>
              ) : null}
            </div>
            <div className="cp-ledger-total">
              <span>Total Revenue</span>
              <span className="num" style={{ fontSize: 16, color: "var(--db-pos)" }}>{usd(totalRev, 2)}</span>
            </div>
          </div>

          <div className="cp-ledger-card exp">
            <h4>Operating Expenses</h4>
            <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Driver Pay Estimate</span>
                <span className="num">{usd(expDriver, 2)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Fuel ({num(load.expenseFuelActual) > 0 ? "Actual" : "Forecast"})</span>
                <span className="num">{usd(expFuel, 2)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Tolls</span>
                <span className="num">{usd(expTolls, 2)}</span>
              </div>
              {expRider > 0 ? (
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Insurance Rider</span>
                  <span className="num">{usd(expRider, 2)}</span>
                </div>
              ) : null}
              {expMisc > 0 ? (
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Miscellaneous / Lumpers</span>
                  <span className="num">{usd(expMisc, 2)}</span>
                </div>
              ) : null}
            </div>
            <div className="cp-ledger-total">
              <span>Total Direct Cost</span>
              <span className="num" style={{ fontSize: 16, color: "var(--db-neg)" }}>{usd(totalExp, 2)}</span>
            </div>
          </div>

          <div className="cp-net-summary">
            <div>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--db-fg-dim)" }}>
                Net Operating Margin
              </div>
              <div style={{ fontFamily: "var(--db-font-head)", fontSize: 24, fontWeight: 700, color: netProfit >= 0 ? "var(--db-pos)" : "var(--db-neg)" }}>
                {usd(netProfit, 2)} ({netMarginPct.toFixed(1)}%)
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--db-fg-dim)" }}>
                Net Per Mile (All Miles)
              </div>
              <div style={{ fontFamily: "var(--db-font-head)", fontSize: 18, fontWeight: 700, color: "var(--db-fg)" }}>
                {perMile(netProfitPerMile)}
              </div>
            </div>
          </div>
        </div>
      </section>

      {countSec}
    </>
  );

  // ── Tab 3: Documents & Proof Workbench ─────────────────────────────────────────────────────
  const docsWorkbench = (
    <section className="sec">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--db-2)" }}>
        <h3 style={{ margin: 0 }}>Document Inspection & Verification</h3>
        <span className="tl-sub">Rate Confirmations, Bills of Lading & Proof of Delivery</span>
      </div>
      {gate(
        <SplitDocViewer
          loadId={load.id}
          items={docs.map((d) => ({
            id: d.id,
            kind: d.kind,
            name: d.name,
            bytes: d.bytes,
            when: dateTime(d.createdAt),
            by: d.addedBy,
            stop: stopLabelOf(d.stopId),
            toDriver: d.toDriver
          }))}
          deliveryStops={deliveryStopOptions}
          locked={docsLocked}
          defaultKind={load.status === "completed" ? "pod" : "rate_con"}
        />,
        "documents"
      )}
    </section>
  );

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

  const HOLDER_VERB: Record<string, string> = { assigned: "Assigned to", reassigned: "Changed to", sent: "Sent to", accepted: "Accepted by", declined: "Declined by", recalled: "Recalled from", removed: "Taken off" };
  const holderSec = holders.length === 0 ? null : (
    <section className="sec">
      <h3>Who Held It · {holders.length}</h3>
      <div className="sec-box">
        <ul className="feed">
          {holders.map((h) => (
            <li key={h.id}>
              <div>
                <b>{HOLDER_VERB[h.kind] ?? h.kind}</b> {h.driverName ?? "a driver"}
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

  const partnersWorkbench = (
    <>
      {gate(trackingSec, "dispatch")}
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

      {gate(invoiceSec, "bill")}
      {decisionSec}
      {whereSec}
      {holderSec}
      {activitySec}
      {gate(moreSec, "dispatch")}
    </>
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
          {load.paymentStatus === "invoiced" ? <PaidDialog loadId={load.id} invoiceNumber={load.invoiceNumber} billed={billed} owing={owing} canWriteOff={may("writeoff")} /> : null}
          {load.paymentStatus === "invoiced" && (load.factoringStatus === "none" || load.factoringStatus === "rejected") && !(paidAmount != null && paidAmount > 0) ? (
            <ConfirmForm action={voidInvoiceAction} fields={{ loadId: load.id }} label="Take the invoice back" title={`Take back ${load.invoiceNumber ?? "this invoice"}?`} eyebrow="Invoice" confirmLabel="Take it back" destructive askReason>
              <p className="tl-note">For an invoice made for the wrong amount or the wrong customer.</p>
            </ConfirmForm>
          ) : null}
          {load.paymentStatus === "paid" || (load.paymentStatus === "invoiced" && paidAmount != null && paidAmount > 0) ? (
            <ConfirmForm action={undoPaidAction} fields={{ loadId: load.id }} label="Undo payment" title={`Take back the latest payment on ${load.invoiceNumber ?? "this invoice"}?`} eyebrow="Payment" confirmLabel="Take it back" destructive askReason>
              <p className="tl-note">For a payment entered against the wrong invoice.</p>
            </ConfirmForm>
          ) : null}
        </>,
        "bill"
      )}
    </>
  );

  const chips = (
    <>
      <StatusChip status={load.status} />
      {fellThrough ? null : <VerdictChip verdict={evaluation?.finalDecision ?? null} />}
      {a ? <AssignmentChip status={a.status} /> : null}
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

  return (
    <LoadCockpit
      variant={variant}
      title={`Load ${load.loadNumber ?? ""}`}
      sub={sub}
      chips={chips}
      fullHref={`/loads/${load.id}`}
      footer={footer}
      deck={deck}
      routeWorkbench={routeWorkbench}
      marginWorkbench={marginWorkbench}
      docsWorkbench={docsWorkbench}
      partnersWorkbench={partnersWorkbench}
      trackingWorkbench={<LoadTracker t={tracking} />}
      docsCount={docs.length}
      alertsCount={alerts.length}
    />
  );
}
