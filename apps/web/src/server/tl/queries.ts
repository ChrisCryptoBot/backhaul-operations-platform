import { terminalFilter, type Terminals } from "@/lib/scope";
import { Prisma } from "@prisma/client";
import { grossOf } from "@/lib/load-gross";
import { dueAt } from "@/lib/overdue";
import { customerTermsMap } from "./customers";
import { prisma } from "@/lib/db";
import { defaultInvoiceNumber, invoiceBasis, invoiceReadiness, owedOf, revisedInvoiceNumber } from "@/lib/invoicing";
import { billedOf } from "@/lib/billed";
import { computeAnalytics, type AnalyticsPeriod } from "@/truelane/lib/analytics";
import { evaluateTlLoad, resolveLabour } from "./evaluate";
import { notQuote } from "@/lib/quote-status";
import { toAnalyticsInput, num, numOrNull } from "./convert";
import { detentionOfLoad } from "./detention";
import { podStopsMissing } from "./documents";
import { openSupplementalBalanceByLoad, voidedInvoiceNumbers } from "./invoicing";
import { getThresholds } from "./thresholds";
import { currentWorkspaceId } from "./workspace";
import { workspaceTimezone } from "./zone";
import { stopZoneOf } from "@/server/geo/stop-zone";
import { activeTz } from "@/lib/tz";

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
  // A delivered load's profit is worked on what it earned (paid linehaul and layover), not on the offer it was booked at; everything else, on the offer. Same rules as the phone's finished-load row.
  const finished = l.status === "completed";
  const earnedOffer = finished ? (numOrNull(l.actualRevenue) && num(l.actualRevenue) > 0 ? num(l.actualRevenue) : num(l.quotedRevenue)) + num(l.layoverPay) : num(l.quotedRevenue);
  const priced = profile && l.status !== "tonu" && l.status !== "cancelled" ? (finished ? evaluateTlLoad({ ...l, quotedRevenue: earnedOffer }, profile, l.vehicle) : evaluation) : null;
  const gross = grossOf({ status: l.status, quotedRevenue: num(l.quotedRevenue), actualRevenue: numOrNull(l.actualRevenue), fuelSurcharge: numOrNull(l.fuelSurcharge), layoverPay: numOrNull(l.layoverPay), tonuRevenue: numOrNull(l.tonuRevenue) });
  return {
    id: l.id,
    loadNumber: l.loadNumber,
    status: deskStatusOf(l.status),
    brokerName: l.brokerName,
    origin: l.originAddress,
    destination: l.destinationAddress,
    scheduledDate: l.scheduledDate,
    vehicleName: l.vehicle?.name ?? null,
    quotedRevenue: num(l.quotedRevenue),
    /** What the load earned, the same everywhere (lib/load-gross.ts): paid linehaul else the agreed rate, plus surcharge and layover; a TONU is its fee. */
    grossRevenue: gross,
    tonuRevenue: numOrNull(l.tonuRevenue),
    writeOffAmount: numOrNull(l.writeOffAmount),
    writeOffReason: l.writeOffReason,
    totalMiles: evaluation?.totalMiles ?? null,
    /** Net pay after factoring, the rider and the carrier's cut (the settlement), the phone's "Pay" on a finished load. Null without a truck's cost profile or on a TONU / cancelled load. */
    netPay: priced ? priced.result.decisionRevenue : null,
    /** Profit a mile after every trip cost, and profit an hour of the trip: the phone's "Profit /mi" and "$/hr". Null when the fuel cannot be priced or there are no hours. */
    profitPerMile: priced ? priced.result.verdictMarginPerMi : null,
    profitPerHour: priced ? priced.profitPerHour : null,
    /** When the first stop's window closes (else opens): a load still open after it is past its pickup. */
    pickupClosesAt: l.stops[0]?.timeWindowLatest ?? l.stops[0]?.timeWindowEarliest ?? null,
    /** The first stop's appointment, and the clock at that dock (src/lib/tz.ts: stop local time), so the board can show the dock's time with the carrier's beside it. */
    pickupAt: l.stops[0]?.timeWindowEarliest ?? l.stops[0]?.timeWindowLatest ?? null,
    pickupZone: l.stops[0] ? stopZoneOf(l.stops[0], activeTz()) : null,
    verdict: evaluation?.finalDecision ?? null,
    // Over every mile the verdict counts, on what the load earned: a TONU hauled nothing, so it has no rate a mile.
    perMile: evaluation && evaluation.totalMiles > 0 && l.status !== "tonu" && l.status !== "cancelled" ? gross / evaluation.totalMiles : null,
    // A delivered load is held to the floor it was booked against (frozen at Accept), the same one the KPI uses; an open load to the truck's live floor.
    floorPerMile: l.status === "completed" && numOrNull((l as { snapshotBaseFloorRpm?: unknown }).snapshotBaseFloorRpm as never) != null ? numOrNull((l as { snapshotBaseFloorRpm?: unknown }).snapshotBaseFloorRpm as never) : evaluation?.verdictFloorRpm ?? null,
    driverName: l.assignment?.driver.name ?? null,
    assignmentStatus: l.assignment?.status ?? (l.status === "dispatched" ? "dispatched" : null),
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
    paidAmount: numOrNull(l.paidAmount),
    openHandoff: null as { state: string; locationName: string | null } | null
  };
}

/** The statuses that are still moving; everything else is History. */
export const OPEN_LOAD_STATUSES = ["draft", "accepted", "in_progress", "scheduled", "dispatched"];

/**
 * The phone also writes "scheduled" (a booked load waiting for its pickup) and "dispatched" (sent, no answer yet). The desk's own table has no such statuses, so a load that arrives with
 * one is read as the desk's equivalent: scheduled is accepted, dispatched is a draft that has been sent. Without this a synced load would be on no tab and in no count.
 */
export const deskStatusOf = (status: string): string => (status === "scheduled" ? "accepted" : status === "dispatched" ? "draft" : status);

/**
 * The live board: the loads still moving, with their verdicts, newest first. Finished loads are not read here (a fleet has tens of thousands of them);
 * History reads them a page at a time (history.ts). Pass scope "all" only for a small, bounded need.
 */
/**
 * `terminal` keeps the loads placed in that terminal (on its truck or with its driver) and the loads not placed anywhere yet, which are everyone's to take.
 */
export async function listBoardRows(workspaceId = currentWorkspaceId(), scope: "open" | "all" = "open", terminal: Terminals = null) {
  const loads = await prisma.load.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      ...notQuote,
      ...(scope === "open" ? { status: { in: OPEN_LOAD_STATUSES } } : {}),
      ...inTerminal(terminal)
    },
    include: loadInclude,
    orderBy: [{ scheduledDate: "desc" }, { createdAt: "desc" }]
  });
  const openHandoffsMap = await openHandoffByLoad(loads.map((l) => l.id), workspaceId);
  return loads.map((l) => {
    const h = openHandoffsMap.get(l.id);
    return { ...boardRowOf(l), openHandoff: h ? { state: h.state, locationName: h.locationName } : null };
  });
}

export async function analyticsFor(period: AnalyticsPeriod, now = new Date(), workspaceId = currentWorkspaceId()) {
  const loads = await prisma.load.findMany({ where: { workspaceId, deletedAt: null, ...notQuote } });
  return computeAnalytics(loads.map(toAnalyticsInput), period, now);
}

export const agingFor = agingSummary;

// ── Load detail, drivers, trucks, invoices ─────────────────────────────────────────────────────

import { pickerOptions, rankDrivers } from "./driver-rank";
import { currentTerminal } from "./terminal";
import { allowedFor, currentAllowed } from "./scope";
import { inTerminal } from "./terminal-sql";
import { agingSummary } from "./aging";
import { rateConTotal } from "@/lib/pay";
import { openHandoffByLoad } from "./relay";
import { driverIsContractor, workspacePaySettings } from "./dispatch";
import { contractorMoney, driverFacingPay, projectLoadToSummary, type LoadSummary, type PayKind } from "./projector";

export async function getLoadDetail(id: string, workspaceId = currentWorkspaceId(), allowed?: Terminals) {
  const scope = await allowedFor(workspaceId, allowed);
  // The decision is read here only (the board shares loadInclude and does not need it): how the quote became this load.
  const l = await prisma.load.findFirst({ where: { id, workspaceId, deletedAt: null, ...notQuote, ...inTerminal(scope) }, include: { ...loadInclude, decisions: { orderBy: { decidedAt: "desc" as const }, take: 1 } } });
  if (!l) return null;
  const profile = l.vehicle?.costProfile ?? null;
  const evaluation = profile ? evaluateTlLoad(l, profile, l.vehicle) : null;
  // The same offer with the way home flipped: the clip's "what if a load covers the trip back".
  const flipped = profile ? evaluateTlLoad({ ...l, isBackhaul: !l.isBackhaul }, profile, l.vehicle) : null;
  // The best few drivers to take it (and whoever has it now); anyone else is found by searching (/drivers/pick). The trucks it can move to are found the same way.
  // Only a load that can still take a driver shows the form that needs them; ranking every driver for a delivered or cancelled load's page is work nobody sees.
  const assignable = l.status === "draft" || l.status === "accepted";
  const ranked = assignable ? await rankDrivers(l, workspaceId, await currentTerminal(workspaceId), scope) : { options: [], fits: [] };
  const [driverOptions, isContractor, paySettings] = [
    pickerOptions(ranked.options, l.assignment?.driverId),
    l.assignment ? await driverIsContractor(l.assignment.driverId, workspaceId) : false,
    await workspacePaySettings(workspaceId)
  ];
  let driverView: LoadSummary | null = null;
  if (l.assignment) {
    const rcTotal = rateConTotal(num(l.quotedRevenue), num(l.fuelSurcharge));
    const assignmentPay = { kind: l.assignment.payKind as PayKind, rate: num(l.assignment.payRate) };
    driverView = projectLoadToSummary(
      {
        loadNumber: l.loadNumber,
        poNumber: l.poNumber,
        brokerName: l.brokerName,
        trailerType: l.trailerType,
        originAddress: l.originAddress,
        destinationAddress: l.destinationAddress,
        loadedMiles: num(l.loadedMiles),
        weightLbs: l.weightLbs,
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
      driverFacingPay(assignmentPay, rcTotal)
    );
    if (isContractor) driverView.contractor = contractorMoney(assignmentPay, rcTotal, driverView.driver_pay.estimate);
  }
  return {
    load: l,
    evaluation,
    flipped,
    /** Where the driver pay in the verdict came from (this assignment, or the truck's profile), in a sentence. */
    labourNote: profile && evaluation ? resolveLabour(profile, l.assignment, evaluation.totalMiles, rateConTotal(num(l.quotedRevenue), num(l.fuelSurcharge))).note : null,
    driverView,
    driverIsContractor: isContractor,
    paySettings,
    // Who can take this load: a lapsed card blocks outright; being on another load at the same time is a note the dispatcher can override with a reason.
    drivers: driverOptions
  };
}


/** The invoices screen reads each of its lists on its own: "ready" is delivered and not invoiced, "out" is invoiced and unpaid, "paid" is paid (a page at a time). "all" is for the CSV. */
export type InvoiceScope = "ready" | "out" | "paid" | "all";
/** What can be invoiced: a delivered load, or a TONU with a fee (a cancelled load and a saved quote cannot). */
const INVOICEABLE = { OR: [{ status: "completed" }, { status: "tonu", tonuRevenue: { gt: 0 } }] };
/** Loads placed in a terminal (on its truck or with its driver), and loads not placed anywhere yet, which are everyone's to take: the same rule the Loads board uses. */
export { inTerminal };
const SCOPE_WHERE: Record<InvoiceScope, object> = { ready: { paymentStatus: null }, out: { paymentStatus: "invoiced" }, paid: { paymentStatus: "paid" }, all: {} };

/** A search over the words a person has for an invoice: its number, the load's, the customer's PO, the customer. Every word must match something. */
const invoiceSearch = (q?: string) => {
  const terms = (q ?? "").split(/\s+/).filter(Boolean).slice(0, 6);
  const has = (field: "invoiceNumber" | "loadNumber" | "poNumber" | "brokerName", t: string) => ({ [field]: { contains: t, mode: "insensitive" as const } });
  return terms.length ? { AND: terms.map((t) => ({ OR: [has("invoiceNumber", t), has("loadNumber", t), has("poNumber", t), has("brokerName", t)] })) } : {};
};

/** A filter on the invoices that are out: late (on the desk's calendar), part paid, or gone to a factor. */
export type InvoiceShow = "overdue" | "part" | "factored";
export const INVOICE_SHOWS: Array<{ key: InvoiceShow; label: string }> = [
  { key: "overdue", label: "Overdue" },
  { key: "part", label: "Part paid" },
  { key: "factored", label: "With a factor" }
];
export const asInvoiceShow = (v: string | undefined | null): InvoiceShow | null => (INVOICE_SHOWS.some((s) => s.key === v) ? (v as InvoiceShow) : null);

/** A column an invoice list can be ordered by (in the database, so every page is the same list). */
export type InvoiceSort = { key: (typeof INVOICE_SORT_KEYS)[number]; dir: "asc" | "desc" } | null;
export const INVOICE_SORT_KEYS = ["sent", "customer", "broker", "invoice", "amount", "load", "done", "due", "paid"] as const;

type InvoiceFilters = { q?: string; terminal?: Terminals; show?: InvoiceShow | null };

/** An invoice that carries several loads (docs/MONEY_PLAN.md, rule G), with its own money. */
export type SharedInvoice = { id: string; number: string; total: number; paidTotal: number; status: string; paidAt: Date | null; loadIds: string[] };

/**
 * The invoices of several loads, so a list shows each of them once. The lead load stands for the invoice in a list and carries the invoice's own money; the others are left out of the
 * list. The lead is the first load in line order: the order projectToLoads (lib/invoice-records.ts, rule A) shares money out in, so a part payment always reaches the lead first. Few invoices
 * are shared, so this is one small read.
 */
export async function sharedInvoices(workspaceId: string): Promise<{ lead: Map<string, SharedInvoice>; others: Map<string, string> }> {
  const rows = await prisma.$queryRaw<Array<{ id: string; number: string; total: string; paid_total: string; status: string; paid_at: Date | null; load_ids: string[] }>>`
    select i.id, i.number, i.total::text as total, i.paid_total::text as paid_total, i.status, i.paid_at, array_agg(il.load_id order by (select min(x.sort) from invoice_lines x where x.invoice_id = i.id and x.load_id = il.load_id) nulls last, il.load_id) as load_ids
    from invoices i join invoice_loads il on il.invoice_id = i.id
    where i.workspace_id = ${workspaceId} and i.kind = 'invoice' and i.supplement_of_id is null and i.status <> 'void'
    group by i.id having count(*) > 1`;
  const lead = new Map<string, SharedInvoice>();
  const others = new Map<string, string>();
  for (const r of rows) {
    const leadId = r.load_ids[0]!;
    lead.set(leadId, { id: r.id, number: r.number, total: new Prisma.Decimal(r.total).toNumber(), paidTotal: new Prisma.Decimal(r.paid_total).toNumber(), status: r.status, paidAt: r.paid_at, loadIds: r.load_ids });
    for (const id of r.load_ids.slice(1)) others.set(id, leadId);
  }
  return { lead, others };
}

/** The loads an invoice list is made of: the scope, the search, the terminal and the filter. "Overdue" is worked out on the desk's calendar by the database and comes back as the loads it names. */
async function invoiceWhere(scope: InvoiceScope, workspaceId: string, f: InvoiceFilters, now = new Date()) {
  const and: object[] = [INVOICEABLE, inTerminal(f.terminal ?? null)];
  const search = invoiceSearch(f.q);
  if (scope === "ready") and.push(search);
  else {
    // An invoice of several loads shows once, as its lead load. A search for any of its loads (or its number) finds it.
    const shared = await sharedInvoices(workspaceId);
    if (shared.others.size === 0) and.push(search);
    else {
      const otherIds = [...shared.others.keys()];
      const text = (f.q ?? "").trim();
      const viaOthers = text ? (await prisma.load.findMany({ where: { id: { in: otherIds }, deletedAt: null, ...invoiceSearch(text) }, select: { id: true } })).map((x) => shared.others.get(x.id)!) : [];
      and.push(viaOthers.length > 0 ? { OR: [search, { id: { in: viaOthers } }] } : search);
      and.push({ id: { notIn: otherIds } });
    }
  }
  if (f.show === "part") {
    // An invoice of several loads is part paid when the invoice is (its own paid total), not when its lead load happens to show a share.
    const partLeads = scope === "ready" ? [] : [...(await sharedInvoices(workspaceId)).lead.entries()].filter(([, inv]) => inv.paidTotal > 0).map(([id]) => id);
    and.push(partLeads.length > 0 ? { OR: [{ paidAmount: { gt: 0 } }, { id: { in: partLeads } }] } : { paidAmount: { gt: 0 } });
  }
  if (f.show === "factored") and.push({ factoringStatus: { not: "none" } });
  if (f.show === "overdue") {
    const tz = await workspaceTimezone(workspaceId);
    const late = await prisma.$queryRaw<Array<{ id: string }>>`
      select l.id from loads l
      where l.workspace_id = ${workspaceId} and l.deleted_at is null and l.payment_status = 'invoiced' and l.invoiced_at is not null
        and ((l.invoiced_at at time zone 'UTC') at time zone ${tz})::date + coalesce(l.pay_terms_days, 0) < (${now}::timestamp at time zone 'UTC' at time zone ${tz})::date`;
    and.push({ id: { in: late.map((r) => r.id) } });
  }
  return { workspaceId, deletedAt: null, ...SCOPE_WHERE[scope], AND: and };
}

export async function countInvoices(scope: InvoiceScope, workspaceId = currentWorkspaceId(), q?: string, terminal: Terminals = null, show: InvoiceShow | null = null) {
  return prisma.load.count({ where: await invoiceWhere(scope, workspaceId, { q, terminal, show }) });
}

/** Oldest first for what still has to be sent or collected (the one waiting longest is the one to chase), newest first for what is paid. */
const INVOICE_ORDER = {
  ready: [{ completedAt: "asc" as const }, { id: "asc" as const }],
  out: [{ invoicedAt: { sort: "asc" as const, nulls: "last" as const } }, { completedAt: "asc" as const }, { id: "asc" as const }],
  paid: [{ invoicedAt: { sort: "desc" as const, nulls: "last" as const } }, { completedAt: "desc" as const }, { id: "asc" as const }],
  all: [{ invoicedAt: { sort: "desc" as const, nulls: "last" as const } }, { completedAt: "desc" as const }, { id: "asc" as const }]
};

const orderFor = (scope: InvoiceScope, sort: InvoiceSort): Prisma.LoadOrderByWithRelationInput[] => {
  if (!sort) return INVOICE_ORDER[scope];
  const d = sort.dir;
  const field: Record<string, Prisma.LoadOrderByWithRelationInput> = {
    sent: { invoicedAt: { sort: d, nulls: "last" } },
    customer: { brokerName: { sort: d, nulls: "last" } },
    broker: { brokerName: { sort: d, nulls: "last" } },
    paid: { paidAt: { sort: d, nulls: "last" } },
    due: { invoicedAt: { sort: d, nulls: "last" } },
    invoice: { invoiceNumber: { sort: d, nulls: "last" } },
    amount: scope === "ready" ? { quotedRevenue: d } : scope === "paid" ? { paidAmount: { sort: d, nulls: "last" } } : { invoicedAmount: { sort: d, nulls: "last" } },
    load: { loadNumber: { sort: d, nulls: "last" } },
    done: { completedAt: d }
  };
  return [field[sort.key]!, { id: "asc" }];
};

export async function listInvoiceRows(workspaceId = currentWorkspaceId(), opts: { scope?: InvoiceScope; skip?: number; take?: number; q?: string; terminal?: Terminals; show?: InvoiceShow | null; sort?: InvoiceSort; lean?: boolean } = {}) {
  const scope = opts.scope ?? "all";
  const light = scope === "paid" || scope === "out";
  const where = await invoiceWhere(scope, workspaceId, { q: opts.q, terminal: opts.terminal, show: opts.show });
  const loadRows = async () => {
    if (opts.sort?.key === "due" || opts.sort?.key === "amount") {
      const dir = opts.sort.dir === "asc" ? 1 : -1;
      const sortKey = opts.sort.key;
      // A shared invoice's lead row shows the invoice's own money, so it sorts by that too, not by the lead load's share.
      const sharedForSort = sortKey === "amount" && scope !== "ready" ? await sharedInvoices(workspaceId) : null;
      const pairs: Array<{ id: string; v: number | null }> =
        sortKey === "due"
          ? (await prisma.load.findMany({ where, select: { id: true, invoicedAt: true, payTermsDays: true } })).map((m) => ({
              id: m.id,
              v: dueAt(m.invoicedAt, m.payTermsDays)?.getTime() ?? null
            }))
          : (await prisma.load.findMany({
              where,
              select: { id: true, status: true, invoicedAmount: true, paidAmount: true, quotedRevenue: true, fuelSurcharge: true, tonuRevenue: true }
            })).map((m) => {
              if (scope === "ready") {
                const b = invoiceBasis({ status: m.status, quotedRevenue: num(m.quotedRevenue), fuelSurcharge: num(m.fuelSurcharge), tonuRevenue: numOrNull(m.tonuRevenue) });
                return { id: m.id, v: new Prisma.Decimal(b.rate).plus(b.surcharge).toNumber() };
              }
              const inv = sharedForSort?.lead.get(m.id);
              if (inv) {
                if (scope === "paid") return { id: m.id, v: inv.paidTotal > 0 ? inv.paidTotal : inv.total };
                const left = new Prisma.Decimal(inv.total).minus(inv.paidTotal);
                return { id: m.id, v: left.isNegative() ? 0 : left.toNumber() };
              }
              const billed =
                m.invoicedAmount != null
                  ? num(m.invoicedAmount)
                  : billedOf({ invoicedAmount: null, status: m.status, quotedRevenue: num(m.quotedRevenue), fuelSurcharge: numOrNull(m.fuelSurcharge), tonuRevenue: numOrNull(m.tonuRevenue) });
              if (scope === "paid") return { id: m.id, v: m.paidAmount != null ? num(m.paidAmount) : billed };
              const paid = m.paidAmount != null ? num(m.paidAmount) : null;
              return { id: m.id, v: paid != null ? (owedOf(billed, paid) ?? billed) : billed };
            });
      pairs.sort((a, b) => {
        const va = a.v;
        const vb = b.v;
        if (va == null && vb == null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        if (va !== vb) return (va - vb) * dir;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      const from = opts.skip ?? 0;
      const ids = (opts.take ? pairs.slice(from, from + opts.take) : pairs.slice(from)).map((m) => m.id);
      if (ids.length === 0) return [];
      const found = light
        ? await prisma.load.findMany({ where: { id: { in: ids } } })
        : await prisma.load.findMany({ where: { id: { in: ids } }, include: { stops: true, vehicle: { include: { costProfile: true } } } });
      const byId = new Map(found.map((l) => [l.id, l]));
      return ids.map((id) => byId.get(id)).filter((l): l is NonNullable<typeof l> => l != null);
    }
    return light
      ? prisma.load.findMany({
          where,
          orderBy: orderFor(scope, opts.sort ?? null),
          ...(opts.skip ? { skip: opts.skip } : {}),
          ...(opts.take ? { take: opts.take } : {})
        })
      : prisma.load.findMany({
          where,
          include: { stops: true, vehicle: { include: { costProfile: true } } },
          orderBy: orderFor(scope, opts.sort ?? null),
          ...(opts.skip ? { skip: opts.skip } : {}),
          ...(opts.take ? { take: opts.take } : {})
        });
  };
  const [rawLoads, thresholds, customerTerms] = await Promise.all([
    loadRows(),
    getThresholds(workspaceId),
    scope === "ready" || scope === "all" ? customerTermsMap(workspaceId) : Promise.resolve(new Map<string, number>())
  ]);
  type FullLoad = Prisma.LoadGetPayload<{ include: { stops: true; vehicle: { include: { costProfile: true } } } }>;
  const loads: FullLoad[] = light ? rawLoads.map((l) => ({ ...l, stops: [], vehicle: null })) : (rawLoads as FullLoad[]);
  // Only a load waiting to be invoiced is offered a number, and one that was invoiced and taken back is offered the next revision of it.
  const [voidedNumbers, missingPods] =
    scope === "ready"
      ? await Promise.all([voidedInvoiceNumbers(loads.map((l) => l.id), workspaceId), podStopsMissing(loads.map((l) => l.id), workspaceId)])
      : [new Map<string, Set<string>>(), new Map<string, number>()];
  // When each out invoice was last chased, from its history (one read for the page).
  const chased = new Map<string, Date>();
  if (!opts.lean && (scope === "out" || scope === "all") && loads.length > 0) {
    const outIds = loads.filter((l) => l.paymentStatus === "invoiced").map((l) => l.id);
    if (outIds.length > 0) {
      const g = await prisma.auditEvent.groupBy({ by: ["loadId"], where: { workspaceId, action: "invoice_chased", loadId: { in: outIds } }, _max: { createdAt: true } });
      for (const r of g) if (r.loadId && r._max.createdAt) chased.set(r.loadId, r._max.createdAt);
    }
  }
  // Each row says whether it stands for an invoice of several loads (the invoice's own money and every load number), and whether it is an invoice with no record (imported history).
  const sharedAll = scope === "ready" ? null : await sharedInvoices(workspaceId);
  const otherNumbers = new Map<string, string>();
  if (sharedAll && sharedAll.lead.size > 0) {
    const need = loads.flatMap((l) => sharedAll.lead.get(l.id)?.loadIds.slice(1) ?? []);
    if (need.length > 0) for (const x of await prisma.load.findMany({ where: { id: { in: need } }, select: { id: true, loadNumber: true } })) otherNumbers.set(x.id, x.loadNumber ?? "");
  }
  const withRecord = new Set<string>();
  const suppOpen = scope === "ready" || loads.length === 0 ? new Map<string, number>() : await openSupplementalBalanceByLoad(loads.map((l) => l.id), workspaceId);
  if (scope !== "ready" && loads.length > 0) {
    const ids = loads.filter((l) => l.paymentStatus !== null).map((l) => l.id);
    if (ids.length > 0) for (const r of await prisma.invoiceLoad.findMany({ where: { loadId: { in: ids }, invoice: { kind: "invoice", supplementOfId: null, status: { not: "void" } } }, select: { loadId: true } })) withRecord.add(r.loadId);
  }
  return loads.map((l) => {
    const basis = invoiceBasis({ status: l.status, quotedRevenue: num(l.quotedRevenue), fuelSurcharge: num(l.fuelSurcharge), tonuRevenue: numOrNull(l.tonuRevenue) });
    const rate = basis.rate;
    // A TONU hauled nothing, so it carries no detention; already-invoiced rows keep what was billed on their invoice.
    const billable = light || basis.tonu ? 0 : detentionOfLoad(l, thresholds.detentionGraceMinutes).billable;
    const billed = billedOf({ invoicedAmount: numOrNull(l.invoicedAmount), status: l.status, quotedRevenue: num(l.quotedRevenue), fuelSurcharge: numOrNull(l.fuelSurcharge), tonuRevenue: numOrNull(l.tonuRevenue) });
    const paidAmount = numOrNull(l.paidAmount);
    const extraOpen = suppOpen.get(l.id) ?? 0;
    const parentPaid = l.paymentStatus === "paid";
    const row = {
      id: l.id,
      loadNumber: l.loadNumber,
      poNumber: l.poNumber,
      broker: l.brokerName,
      brokerMc: l.brokerMcNumber,
      origin: l.originAddress,
      destination: l.destinationAddress,
      lane: `${l.originAddress ?? "?"} → ${l.destinationAddress ?? "?"}`,
      completedAt: l.completedAt,
      invoiceNumber: l.invoiceNumber,
      brokerEmail: l.brokerEmail,
      brokerPhone: l.brokerPhone,
      lastChasedAt: chased.get(l.id) ?? null,
      factoringStatus: l.factoringStatus,
      invoicedAt: l.invoicedAt,
      paidAt: l.paidAt,
      paidMethod: l.paidMethod,
      payTermsDays: l.payTermsDays,
      status: l.paymentStatus,
      amount: billed,
      /** What a load not yet invoiced would bill if invoiced now with its detention (the invoice dialog's total to start from). */
      readyAmount: new Prisma.Decimal(billed).plus(l.paymentStatus === null ? billable : 0).toDecimalPlaces(2).toNumber(),
      detentionBillable: billable,
      writeOffAmount: numOrNull(l.writeOffAmount),
      writeOffReason: l.writeOffReason,
      paidAmount,
      supplementalOpen: extraOpen,
      /** What is still owed on an invoice that is out (plus open supplemental balances even if parent is paid). */
      balance: l.paymentStatus === "invoiced" || extraOpen > 0 ? (owedOf(billed, paidAmount, { supplementalOpen: extraOpen, parentPaid }) ?? billed) : 0,
      /** Negative when the broker paid less than the invoice. */
      paidDifference: l.paymentStatus === "paid" && paidAmount != null ? new Prisma.Decimal(paidAmount).minus(billed).toDecimalPlaces(2).toNumber() : null,
      invoiceContext: { rate, surcharge: basis.surcharge, detention: billable, rateLabel: basis.label, defaultTerms: l.payTermsDays ?? customerTerms.get((l.brokerName ?? "").trim().toLowerCase()) ?? thresholds.defaultPayTermsDays },
      defaultNumber: revisedInvoiceNumber(defaultInvoiceNumber(l.loadNumber, l.id), voidedNumbers.get(l.id) ?? new Set()),
      readiness: invoiceReadiness({ ...l, quotedRevenue: rate, paidLinehaul: numOrNull(l.actualRevenue), podStopsMissing: missingPods.get(l.id) ?? null }),
      /** More than one load on this invoice: the row stands for the whole invoice and carries its money. */
      loadsOnInvoice: 1,
      /** The invoice's record id, when the row is an invoice with a record. */
      invoiceId: null as string | null,
      /** An invoice (or payment) on the load with no invoice record behind it: imported history that carried no invoice number (docs/MONEY_PLAN.md, gap 16). */
      imported: scope !== "ready" && l.paymentStatus !== null && !withRecord.has(l.id)
    };
    const inv = sharedAll?.lead.get(l.id);
    if (!inv) return row;
    // The lead load of an invoice of several loads: the invoice's own number and money, and every load number on it.
    const parentOwing = parentPaid ? new Prisma.Decimal(0) : new Prisma.Decimal(inv.total).minus(inv.paidTotal);
    const parentPositive = parentOwing.isNegative() ? new Prisma.Decimal(0) : parentOwing;
    const totalOwing = parentPositive.plus(extraOpen);
    return {
      ...row,
      loadNumber: [l.loadNumber ?? "", ...inv.loadIds.slice(1).map((id) => otherNumbers.get(id) ?? "")].filter(Boolean).join(", "),
      invoiceNumber: inv.number,
      amount: inv.total,
      readyAmount: inv.total,
      paidAmount: inv.paidTotal > 0 ? inv.paidTotal : null,
      balance: l.paymentStatus === "invoiced" || extraOpen > 0 ? totalOwing.toDecimalPlaces(2).toNumber() : 0,
      paidDifference: l.paymentStatus === "paid" && inv.paidTotal > 0 ? new Prisma.Decimal(inv.paidTotal).minus(inv.total).toDecimalPlaces(2).toNumber() : null,
      loadsOnInvoice: inv.loadIds.length,
      invoiceId: inv.id,
      imported: false
    };
  });
}
