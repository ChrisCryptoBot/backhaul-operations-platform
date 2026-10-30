import { Prisma } from "@prisma/client";
import { customerTermsMap } from "./customers";
import { prisma } from "@/lib/db";
import { defaultInvoiceNumber, invoiceReadiness } from "@/lib/invoicing";
import { computeAnalytics, type AnalyticsPeriod } from "@/truelane/lib/analytics";
import { computeAgingSummary } from "@/truelane/lib/invoice";
import { evaluateTlLoad, resolveLabour } from "./evaluate";
import { notQuote } from "@/lib/quote-status";
import { toAgingView, toAnalyticsInput, num, numOrNull } from "./convert";
import { detentionOfLoad } from "./detention";
import { getThresholds } from "./thresholds";
import { currentWorkspaceId } from "./workspace";

/**
 * Read model for the dispatcher screens, all computed from the TrueLane-shaped tables with TrueLane's own math.
 * The page layer (stage 3) calls these; nothing here renders anything.
 */
export const loadInclude = {
  vehicle: { include: { costProfile: true } },
  trailer: true,
  stops: { orderBy: { stopSequence: "asc" as const } },
  assignment: { include: { driver: true } }
};

export type BoardRow = Awaited<ReturnType<typeof listBoardRows>>[number];

type BoardLoad = Prisma.LoadGetPayload<{ include: typeof loadInclude }>;

/** One load as a row of the Loads, Dispatch and History screens, with TrueLane's verdict on the truck's own floor. */
export function boardRowOf(l: BoardLoad) {
  const profile = l.vehicle?.costProfile ?? null;
  const evaluation = profile ? evaluateTlLoad(l, profile, l.vehicle) : null;
  return {
    id: l.id,
    loadNumber: l.loadNumber,
    status: l.status,
    brokerName: l.brokerName,
    origin: l.originAddress,
    destination: l.destinationAddress,
    scheduledDate: l.scheduledDate,
    vehicleName: l.vehicle?.name ?? null,
    quotedRevenue: num(l.quotedRevenue),
    totalMiles: evaluation?.totalMiles ?? null,
    verdict: evaluation?.finalDecision ?? null,
    perMile: evaluation && evaluation.totalMiles > 0 ? evaluation.effectiveGross / evaluation.totalMiles : null,
    floorPerMile: evaluation?.verdictFloorRpm ?? null,
    driverName: l.assignment?.driver.name ?? null,
    assignmentStatus: l.assignment?.status ?? null,
    paymentStatus: l.paymentStatus,
    poNumber: l.poNumber,
    invoiceNumber: l.invoiceNumber,
    brokerMc: l.brokerMcNumber,
    completedAt: l.completedAt,
    cancelledAt: l.cancelledAt,
    cancelReason: l.cancelReason,
    invoicedAt: l.invoicedAt,
    payTermsDays: l.payTermsDays,
    paidAt: l.paidAt,
    invoicedAmount: numOrNull(l.invoicedAmount),
    paidAmount: numOrNull(l.paidAmount)
  };
}

/** The statuses that are still moving; everything else is History. */
export const OPEN_LOAD_STATUSES = ["draft", "accepted", "in_progress"];

/**
 * The live board: the loads still moving, with their verdicts, newest first. Finished loads are not read here (a fleet has tens of thousands of them);
 * History reads them a page at a time (history.ts). Pass scope "all" only for a small, bounded need.
 */
/**
 * `terminal` keeps the loads placed in that terminal (on its truck or with its driver) and the loads not placed anywhere yet, which are everyone's to take.
 */
export async function listBoardRows(workspaceId = currentWorkspaceId(), scope: "open" | "all" = "open", terminal: string | null = null) {
  const loads = await prisma.load.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      ...notQuote,
      ...(scope === "open" ? { status: { in: OPEN_LOAD_STATUSES } } : {}),
      ...(terminal ? { OR: [{ vehicle: { terminal } }, { assignment: { driver: { terminal } } }, { vehicleId: null, assignment: null }] } : {})
    },
    include: loadInclude,
    orderBy: [{ scheduledDate: "desc" }, { createdAt: "desc" }]
  });
  return loads.map(boardRowOf);
}

export async function analyticsFor(period: AnalyticsPeriod, now = new Date(), workspaceId = currentWorkspaceId()) {
  const loads = await prisma.load.findMany({ where: { workspaceId, deletedAt: null, ...notQuote } });
  return computeAnalytics(loads.map(toAnalyticsInput), period, now);
}

export const agingFor = agingSummary;

// ── Load detail, drivers, trucks, invoices ─────────────────────────────────────────────────────

import { pickerOptions, rankDrivers } from "./driver-rank";
import { currentTerminal } from "./terminal";
import { agingSummary } from "./aging";
import { rateConTotal } from "@/lib/pay";
import { driverFacingPay, projectLoadToSummary, type LoadSummary, type PayKind } from "./projector";

export async function getLoadDetail(id: string, workspaceId = currentWorkspaceId()) {
  // The decision is read here only (the board shares loadInclude and does not need it): how the quote became this load.
  const l = await prisma.load.findFirst({ where: { id, workspaceId, deletedAt: null, ...notQuote }, include: { ...loadInclude, decisions: { orderBy: { decidedAt: "desc" as const }, take: 1 } } });
  if (!l) return null;
  const profile = l.vehicle?.costProfile ?? null;
  const evaluation = profile ? evaluateTlLoad(l, profile, l.vehicle) : null;
  // The same offer with the way home flipped: the clip's "what if a load covers the trip back".
  const flipped = profile ? evaluateTlLoad({ ...l, isBackhaul: !l.isBackhaul }, profile, l.vehicle) : null;
  // The best few drivers to take it (and whoever has it now); anyone else is found by searching (/drivers/pick). The trucks it can move to are found the same way.
  const ranked = await rankDrivers(l, workspaceId, await currentTerminal(workspaceId));
  const driverOptions = pickerOptions(ranked.options, l.assignment?.driverId);
  let driverView: LoadSummary | null = null;
  if (l.assignment) {
    driverView = projectLoadToSummary(
      {
        loadNumber: l.loadNumber,
        poNumber: l.poNumber,
        brokerName: l.brokerName,
        trailerType: l.trailerType,
        originAddress: l.originAddress,
        destinationAddress: l.destinationAddress,
        loadedMiles: num(l.loadedMiles),
        stops: l.stops.map((s) => ({
          stopSequence: s.stopSequence,
          stopType: s.stopType,
          stopRole: s.stopRole,
          addressString: s.addressString,
          timeWindowEarliest: s.timeWindowEarliest,
          timeWindowLatest: s.timeWindowLatest,
          referenceNumbers: s.referenceNumbers,
          stopNotes: s.stopNotes
        }))
      },
      driverFacingPay({ kind: l.assignment.payKind as PayKind, rate: num(l.assignment.payRate) }, rateConTotal(num(l.quotedRevenue), num(l.fuelSurcharge)))
    );
  }
  return {
    load: l,
    evaluation,
    flipped,
    /** Where the driver pay in the verdict came from (this assignment, or the truck's profile), in a sentence. */
    labourNote: profile && evaluation ? resolveLabour(profile, l.assignment, evaluation.totalMiles, rateConTotal(num(l.quotedRevenue), num(l.fuelSurcharge))).note : null,
    driverView,
    // Who can take this load: a lapsed card blocks outright; being on another load at the same time is a note the dispatcher can override with a reason.
    drivers: driverOptions
  };
}


/** The invoices screen reads each of its lists on its own: "ready" is delivered and not invoiced, "out" is invoiced and unpaid, "paid" is paid (a page at a time). "all" is for the CSV. */
export type InvoiceScope = "ready" | "out" | "paid" | "all";
const SCOPE_WHERE: Record<InvoiceScope, object> = { ready: { paymentStatus: null }, out: { paymentStatus: "invoiced" }, paid: { paymentStatus: "paid" }, all: {} };

/** A search over the words a person has for an invoice: its number, the load's, the customer's PO, the customer. Every word must match something. */
const invoiceSearch = (q?: string) => {
  const terms = (q ?? "").split(/\s+/).filter(Boolean).slice(0, 6);
  const has = (field: "invoiceNumber" | "loadNumber" | "poNumber" | "brokerName", t: string) => ({ [field]: { contains: t, mode: "insensitive" as const } });
  return terms.length ? { AND: terms.map((t) => ({ OR: [has("invoiceNumber", t), has("loadNumber", t), has("poNumber", t), has("brokerName", t)] })) } : {};
};

export async function countInvoices(scope: InvoiceScope, workspaceId = currentWorkspaceId(), q?: string) {
  return prisma.load.count({ where: { workspaceId, deletedAt: null, status: "completed", ...SCOPE_WHERE[scope], ...invoiceSearch(q) } });
}

/** Oldest first for what still has to be sent or collected (the one waiting longest is the one to chase), newest first for what is paid. */
const INVOICE_ORDER = {
  ready: [{ completedAt: "asc" as const }],
  out: [{ invoicedAt: { sort: "asc" as const, nulls: "last" as const } }, { completedAt: "asc" as const }],
  paid: [{ invoicedAt: { sort: "desc" as const, nulls: "last" as const } }, { completedAt: "desc" as const }],
  all: [{ invoicedAt: { sort: "desc" as const, nulls: "last" as const } }, { completedAt: "desc" as const }]
};

export async function listInvoiceRows(workspaceId = currentWorkspaceId(), opts: { scope?: InvoiceScope; skip?: number; take?: number; q?: string } = {}) {
  const [loads, thresholds, customerTerms] = await Promise.all([
    prisma.load.findMany({
      where: { workspaceId, deletedAt: null, status: "completed", ...SCOPE_WHERE[opts.scope ?? "all"], ...invoiceSearch(opts.q) },
      include: { stops: true, vehicle: { include: { costProfile: true } } },
      orderBy: INVOICE_ORDER[opts.scope ?? "all"],
      ...(opts.skip ? { skip: opts.skip } : {}),
      ...(opts.take ? { take: opts.take } : {})
    }),
    getThresholds(workspaceId),
    customerTermsMap(workspaceId)
  ]);
  return loads.map((l) => {
    const rate = num(l.quotedRevenue);
    const billable = detentionOfLoad(l, thresholds.detentionGraceMinutes).billable;
    const billed = num(l.invoicedAmount ?? l.actualRevenue ?? l.quotedRevenue);
    const paidAmount = numOrNull(l.paidAmount);
    return {
      id: l.id,
      loadNumber: l.loadNumber,
      poNumber: l.poNumber,
      broker: l.brokerName,
      origin: l.originAddress,
      destination: l.destinationAddress,
      lane: `${l.originAddress ?? "?"} → ${l.destinationAddress ?? "?"}`,
      completedAt: l.completedAt,
      invoiceNumber: l.invoiceNumber,
      factoringStatus: l.factoringStatus,
      invoicedAt: l.invoicedAt,
      paidAt: l.paidAt,
      payTermsDays: l.payTermsDays,
      status: l.paymentStatus,
      amount: billed,
      paidAmount,
      /** Negative when the broker paid less than the invoice. */
      paidDifference: l.paymentStatus === "paid" && paidAmount != null ? new Prisma.Decimal(paidAmount).minus(billed).toDecimalPlaces(2).toNumber() : null,
      invoiceContext: { rate, surcharge: num(l.fuelSurcharge), detention: billable, defaultTerms: l.payTermsDays ?? customerTerms.get((l.brokerName ?? "").trim().toLowerCase()) ?? thresholds.defaultPayTermsDays },
      defaultNumber: defaultInvoiceNumber(l.loadNumber, l.id),
      readiness: invoiceReadiness({ ...l, quotedRevenue: rate })
    };
  });
}
