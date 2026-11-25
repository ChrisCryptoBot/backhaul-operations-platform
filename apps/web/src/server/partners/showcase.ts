import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { quarterOf } from "@/lib/ifta-return";
import { SHOWCASE_WORKSPACE_ID, SIMULATOR_LABEL, STEP_INFO, type Figure, type ShowcaseStep, type StepCard } from "@/lib/showcase";
import { signatureHeader, verifySignatureHeader } from "@/lib/webhook-sign";
import { serveRead } from "@/server/api/handler";
import { createApiKey } from "@/server/api/keys";
import { invoiceLoad } from "@/server/tl/invoicing";
import { finalizeSettlement, startSettlement } from "@/server/tl/settlement";
import { lockWorkspace, roomFor } from "@/server/tl/plan";
import { removeFiles } from "@/server/tl/message-files";
import { collectWorkspaceFileKeys } from "@/server/tl/storage";
import { explicitTenancy } from "@/server/tl/workspace";
import { workspaceTimezone } from "@/server/tl/zone";
import { deliverDue } from "@/server/webhooks/deliver";
import { createEndpoint, sendTestEvent } from "@/server/webhooks/endpoints";
import type { Resolver, Transport } from "@/server/webhooks/transport";
import { SECRET_ENV, WEBHOOK_SECRET_ENV } from "@/truelane/partners/contract";
import { sandboxPayrollEvent } from "./adapters/gusto";
import { SANDBOX_REALM } from "./adapters/oauth-exchange";
import { sandboxTrackingEvent } from "./adapters/project44";
import { resetSandboxBook } from "./adapters/quickbooks";
import { sandboxAllowed } from "./adapters/sandbox";
import { sandboxFactoringEvent } from "./adapters/triumphpay";
import { credentialKeys, unsealWithKeys } from "./credentials-core";
import { saveCredential } from "./credentials";
import { syncEld } from "./eld";
import { factorInvoice } from "./factoring";
import { saveFactoringTerms } from "./factoring-terms";
import { importFuelForLoad } from "./fuel-card";
import { routeIftaMiles } from "./ifta-mileage";
import { beginOAuth, completeOAuth } from "./oauth";
import { sendToPayroll } from "./payroll";
import { syncAccounting } from "./qbo-sync";
import { saveKeysAndConnect } from "./setup";
import { shareLoadLocation } from "./tracking";
import { vetDriverCarrier } from "./vetting";
import { handleWebhook } from "./webhook";

/**
 * The partner showcase (docs/MONEY_PLAN.md, Wave 7 step 5): one load's life through every built-in simulator, the outbound webhooks and the read API, in a fleet of its own
 * (SHOWCASE_WORKSPACE_ID). Every call names that workspace and runs inside explicitTenancy, so nothing here can fall back to the demo fleet's or a real fleet's data, keys or trail. It is
 * offered only where the simulator is allowed (sandboxAllowed: the demo desk, or DESK_PARTNER_SANDBOX=on), and every key it saves starts with sandbox_, so no live company is ever asked.
 * The outbound webhook goes to a receiver built into the desk, in-process: no address is opened, and the address rules are not loosened anywhere.
 *
 * Each step uses the same server functions a person's click does (syncEld, vetDriverCarrier, factorInvoice, sendToPayroll, syncAccounting, ...), so what lands is what a real fleet would
 * see from the simulators. Steps that need an earlier one run it first.
 */
const W = SHOWCASE_WORKSPACE_ID;
const ORIGIN = "https://showcase.desk.invalid";
const RECEIVER_URL = "https://receiver.showcase.invalid/truelane";
const WH_SECRET = "sandbox_showcase_webhook_secret";
const LOAD = "SHOW-1001";
const FORM = { terms: "30", detention: false, lumper: "", layover: "", otherLabel: "", other: "" };
const TERMS = { transport: "api" as const, batchDestination: "", factorName: "Showcase Factor (simulator)", remitName: "", remitAddress: "", lockboxBank: "", routingNumber: "", accountNumber: "", noaText: "", advancePct: "90", feePct: "2.5" };
const SIMULATED: Array<{ provider: string; label: string }> = [
  { provider: "motive", label: "ELD" },
  { provider: "highway", label: "Vetting" },
  { provider: "project44", label: "Tracking" },
  { provider: "wex", label: "Fuel card" },
  { provider: "promiles", label: "Fuel tax" },
  { provider: "triumphpay", label: "Factoring" },
  { provider: "gusto", label: "Payroll" }
];

export type ShowcaseResult = { ok: true; cards: StepCard[]; apiSample?: string } | { ok: false; error: string; cards?: StepCard[] };

export const showcaseAllowed = (): boolean => sandboxAllowed();
const refused = (): ShowcaseResult => ({ ok: false, error: "The showcase runs only where the built-in simulator is allowed (the demo desk). It never runs on a live desk." });

/** The receiver built into the desk: checks each delivery's signature with the endpoint's own secret and keeps the last few, in memory. Nothing leaves the process. */
const received: Array<{ eventId: string; type: string; verified: boolean; at: Date }> = [];
const sealedSecretOf = async () => (await prisma.webhookEndpoint.findFirst({ where: { workspaceId: W }, select: { sealedSecret: true } }))?.sealedSecret ?? null;
const secretNow = async () => {
  const sealed = await sealedSecretOf();
  return sealed ? (unsealWithKeys(sealed, credentialKeys(process.env as Record<string, string | undefined>))?.values.secret ?? null) : null;
};
const builtInReceiver: Transport = async (r) => {
  const secret = await secretNow();
  const t = Number.parseInt(r.headers["x-truelane-timestamp"] ?? "0", 10);
  const verified = secret != null && verifySignatureHeader(r.headers["x-truelane-signature"] ?? null, secret, r.body, t);
  let type = "?";
  try {
    type = String((JSON.parse(r.body) as { type?: unknown }).type ?? "?");
  } catch {
    /* not JSON */
  }
  received.unshift({ eventId: r.headers["x-truelane-event-id"] ?? "?", type, verified, at: new Date() });
  received.splice(20);
  return { ok: true, status: verified ? 200 : 401 };
};
// The built-in receiver has no address of its own; the delivery path resolves one anyway (it checks every address), so it is handed a public placeholder that is never connected to.
const builtInResolver: Resolver = async () => [{ address: "93.184.216.34", family: 4 }];
// Delivered at the later of the step's clock and the real one: an invoice's event is stamped with the real clock when it is written.
const deliveryDeps = (now: Date) => ({ now: new Date(Math.max(now.getTime(), Date.now())), transport: builtInReceiver, resolver: builtInResolver, production: true, workspaceId: W });

const minutes = (m: number | null | undefined) => (m == null ? "not read" : `${(m - (m % 60)) / 60}h ${String(m % 60).padStart(2, "0")}m`);
const usd = (d: { toFixed(n: number): string } | null | undefined) => (d == null ? "none" : `$${d.toFixed(2)}`);
const pretty = (v: unknown, max = 1400) => {
  const text = JSON.stringify(v, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n  …` : text;
};

/** Start again: the showcase fleet is removed and made afresh, with its simulators connected, a truck, a driver who runs under their own authority, and one load on the road. */
export async function resetShowcase(now = new Date()): Promise<ShowcaseResult> {
  if (!showcaseAllowed()) return refused();
  await wipeShowcase();
  await explicitTenancy(W, async () => {
    await prisma.workspace.create({ data: { id: W, name: "Showcase fleet (simulators)", plan: "pro", remitTo: "Showcase Factor (simulator)" } });
    for (const s of SIMULATED) {
      const keys: Record<string, string> = {};
      for (const name of SECRET_ENV[s.provider] ?? []) keys[name] = `sandbox_showcase_${name.toLowerCase()}`;
      const wh = WEBHOOK_SECRET_ENV[s.provider];
      if (wh) keys[wh] = WH_SECRET;
      const out = await saveKeysAndConnect(s.provider, keys, now, W);
      if (!out.ok) throw new Error(`${s.label}: ${out.error}`);
    }
    const qbo = await saveCredential("quickbooks", { QUICKBOOKS_CLIENT_ID: "sandbox_showcase_client", QUICKBOOKS_CLIENT_SECRET: "sandbox_showcase_secret" }, now, W);
    if (!qbo.ok) throw new Error(qbo.error);
    resetSandboxBook(SANDBOX_REALM, W);
    await saveFactoringTerms(TERMS, "Showcase", now, W);
    // The showcase fleet's truck and driver are made inside the plan's room check, like every other way a truck or driver is made (tests/plan-guard.test.ts).
    const { truck, driver } = await prisma.$transaction(async (tx) => {
      await lockWorkspace(tx, W);
      const roomT = await roomFor("truck", 1, W, tx);
      if (!roomT.ok) throw new Error(roomT.message);
      const truck = await tx.vehicle.create({
        data: {
          workspaceId: W,
          name: "SHOW-T1",
          costProfile: { create: { monthlyInsurance: 800, monthlyAuthority: 100, monthlyPhoneSubscriptions: 60, monthlyLoanPayment: 0, estimatedMonthlyMiles: 9000, maintenanceReservePerMile: 0.15, tireReservePerMile: 0.04, driverHourlyTarget: 25, lastFuelPricePerGallon: 3.9, breakEvenRpm: 1.6, survivalFloorRpm: 1.3, archetype: "solo_owner", fuelCardProvider: "wex", fuelCardAccountId: "SHOW-CARD-01" } }
        }
      });
      const roomD = await roomFor("driver", 1, W, tx);
      if (!roomD.ok) throw new Error(roomD.message);
      const driver = await tx.driver.create({
        data: { workspaceId: W, name: "Sam Showcase", assignedVehicleId: truck.id, cdlExpiry: new Date(now.getTime() + 600 * 86_400_000), medicalCardExpiry: new Date(now.getTime() + 300 * 86_400_000), carrierMcNumber: "1234565", carrierDotNumber: "3456785", payrollWorkerType: "contractor", payrollEmployeeId: "gus-show-0001" }
      });
      return { truck, driver };
    });
    const pickup = new Date(now.getTime() - 30 * 3_600_000);
    const drop = new Date(now.getTime() - 4 * 3_600_000);
    await prisma.load.create({
      data: {
        workspaceId: W,
        loadNumber: LOAD,
        brokerName: "Showcase Logistics (sample)",
        brokerMcNumber: "MC-SAMPLE",
        status: "in_progress",
        vehicleId: truck.id,
        originAddress: "Dallas, TX",
        destinationAddress: "Tulsa, OK",
        loadedMiles: 257,
        pickupDeadheadMiles: 12,
        quotedRevenue: 1850,
        scheduledDate: pickup,
        stops: {
          create: [
            { stopSequence: 1, stopType: "pickup", addressString: "Dallas, TX", facilityName: "Sample DC Dallas", lat: 32.7767, lng: -96.797, timeWindowEarliest: pickup, timeWindowLatest: new Date(pickup.getTime() + 2 * 3_600_000) },
            { stopSequence: 2, stopType: "delivery", addressString: "Tulsa, OK", facilityName: "Sample Store Tulsa", lat: 36.154, lng: -95.9928, timeWindowEarliest: drop, timeWindowLatest: new Date(drop.getTime() + 2 * 3_600_000) }
          ]
        },
        assignment: { create: { driverId: driver.id, payKind: "cpm", payRate: 0.6, status: "accepted" } }
      }
    });
    const ep = await createEndpoint({ url: RECEIVER_URL, label: "Built-in receiver", events: ["invoice.created", "invoice.voided", "credit_memo.created", "credit_memo.voided", "payment.applied", "payment.reversed", "statement.finalized", "statement.voided"] }, "Showcase", now, W, { resolver: builtInResolver, production: true });
    if (!ep.ok) throw new Error(ep.error);
  });
  received.length = 0;
  return { ok: true, cards: await showcaseSnapshot() };
}

export async function wipeShowcase() {
  const fileKeys = await collectWorkspaceFileKeys(W);
  await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
  await prisma.driverLedgerEntry.deleteMany({ where: { workspaceId: W } });
  await prisma.settlement.deleteMany({ where: { workspaceId: W } });
  await prisma.assignment.deleteMany({ where: { load: { workspaceId: W } } });
  await prisma.workspace.deleteMany({ where: { id: W } });
  await removeFiles(fileKeys);
}

const ids = async () => {
  const load = await prisma.load.findFirst({ where: { workspaceId: W, loadNumber: LOAD }, include: { assignment: true } });
  const driver = await prisma.driver.findFirst({ where: { workspaceId: W } });
  return { load, driver };
};

type Step = (now: Date) => Promise<void>;

const STEPS: Record<ShowcaseStep, Step> = {
  eld: async (now) => {
    const out = await syncEld(now, W);
    if (!out.ok) throw new Error(out.error);
  },
  vetting: async (now) => {
    const { driver } = await ids();
    const out = await vetDriverCarrier(driver!.id, now, W);
    if (!out.ok) throw new Error(out.error);
  },
  tracking: async (now) => {
    const { load } = await ids();
    if (!load) throw new Error("Reset the showcase first.");
    if (load.status === "completed") return;
    const shared = await shareLoadLocation(load.id, true, true, W, now);
    if (!shared.ok) throw new Error(shared.error);
    const conn = await prisma.partnerConnection.findFirstOrThrow({ where: { workspaceId: W, capability: "tracking" } });
    for (const [kind, stop] of [["tracking.arrived", 1], ["tracking.departed", 1], ["tracking.arrived", 2]] as const) {
      const ev = sandboxTrackingEvent({ kind, loadNumber: LOAD, stop, id: `show_trk_${kind}_${stop}_${randomBytes(3).toString("hex")}`, secret: WH_SECRET, now });
      await handleWebhook({ provider: conn.provider, token: conn.webhookToken!, raw: ev.raw, signature: ev.signature, now });
    }
    // The showcase delivers the load (a dispatcher or the driver's phone does this on a real desk).
    await prisma.$transaction(async (tx) => {
      await tx.load.update({ where: { id: load.id }, data: { status: "completed", completedAt: now } });
      await tx.assignment.updateMany({ where: { loadId: load.id }, data: { status: "completed" } });
      await tx.stop.updateMany({ where: { loadId: load.id }, data: { arrivedAt: now } });
    });
  },
  fuel: async (now) => {
    const { load } = await ids();
    const out = await importFuelForLoad(load!.id, now, W);
    if (!out.ok) throw new Error(out.error);
  },
  ifta: async (now) => {
    await need("tracking", now);
    const out = await routeIftaMiles(quarterOf(now, await workspaceTimezone(W)), now, W);
    if (!out.ok) throw new Error(out.error);
  },
  factoring: async (now) => {
    await need("tracking", now);
    let { load } = await ids();
    if (!load!.invoiceNumber) {
      const inv = await invoiceLoad(load!.id, { form: { ...FORM, number: "SHOW-INV-1001" } }, now, W);
      if (!inv.ok) throw new Error(inv.error);
      ({ load } = await ids());
    }
    if (load!.factoringStatus === "none" || load!.factoringStatus === "rejected") {
      const sent = await factorInvoice(load!.id, { sendAnyway: true }, now, W);
      if (!sent.ok) throw new Error(sent.error);
      ({ load } = await ids());
    }
    if (load!.factoringStatus === "requested" || load!.factoringStatus === "submitted") {
      const conn = await prisma.partnerConnection.findFirstOrThrow({ where: { workspaceId: W, capability: "factoring" } });
      const ev = sandboxFactoringEvent({ kind: "factoring.funded", invoiceNumber: load!.invoiceNumber, referenceId: load!.factoringReferenceId, amount: 1850, id: `show_fund_${randomBytes(4).toString("hex")}`, secret: WH_SECRET, now });
      const a = await handleWebhook({ provider: conn.provider, token: conn.webhookToken!, raw: ev.raw, signature: ev.signature, now });
      if (a.status !== 200) throw new Error("The desk's receiver refused the funding event.");
    }
  },
  payroll: async (now) => {
    await need("tracking", now);
    const { driver } = await ids();
    let st = await prisma.settlement.findFirst({ where: { workspaceId: W, status: { in: ["draft", "final"] } }, orderBy: { createdAt: "desc" } });
    if (!st) {
      const day = (d: Date) => d.toISOString().slice(0, 10);
      const made = await startSettlement({ driverId: driver!.id, start: day(new Date(now.getTime() - 6 * 86_400_000)), end: day(new Date(now.getTime() + 86_400_000)) }, now, W);
      if (!made.ok) throw new Error(made.error);
      st = await prisma.settlement.findFirstOrThrow({ where: { workspaceId: W }, orderBy: { createdAt: "desc" } });
    }
    if (st.status === "draft") {
      const fin = await finalizeSettlement(st.id, { hours: {}, adjustments: [] }, now, W);
      if (!fin.ok) throw new Error(fin.error);
      st = await prisma.settlement.findUniqueOrThrow({ where: { id: st.id } });
    }
    if (!st.payrollSentAt) {
      const sent = await sendToPayroll([st.id], now, W);
      if (!sent.ok) throw new Error(sent.error);
      st = await prisma.settlement.findUniqueOrThrow({ where: { id: st.id } });
    }
    if (!st.paidAt && st.payrollReference) {
      const conn = await prisma.partnerConnection.findFirstOrThrow({ where: { workspaceId: W, capability: "payroll" } });
      const ev = sandboxPayrollEvent({ kind: "payroll.paid", runId: st.payrollReference, id: `show_pay_${randomBytes(4).toString("hex")}`, secret: WH_SECRET, now });
      await handleWebhook({ provider: conn.provider, token: conn.webhookToken!, raw: ev.raw, signature: ev.signature, now });
    }
  },
  quickbooks: async (now) => {
    await need("factoring", now);
    await need("payroll", now);
    const token = await prisma.partnerOAuthToken.findFirst({ where: { workspaceId: W, provider: "quickbooks", status: "active" } });
    if (!token) {
      const begun = await beginOAuth("quickbooks", { origin: ORIGIN, who: "Showcase" }, now, W);
      if (!begun.ok) throw new Error(begun.error);
      const q = Object.fromEntries(new URL(begun.url).searchParams);
      const done = await completeOAuth("quickbooks", { state: q.state, code: q.code, accountId: q.realmId }, { origin: ORIGIN, who: "Showcase" }, now, W);
      if (!done.ok) throw new Error(done.error);
    }
    const out = await syncAccounting({ who: "Showcase" }, now, W);
    if (!out.ok) throw new Error([out.error, ...out.problems].join(" "));
  },
  webhook: async (now) => {
    const due = await prisma.webhookDelivery.count({ where: { workspaceId: W, status: { in: ["pending", "failed"] } } });
    if (due > 0) await deliverDue({ ...deliveryDeps(now), limit: 100 });
    else {
      const ep = await prisma.webhookEndpoint.findFirstOrThrow({ where: { workspaceId: W } });
      const t = await sendTestEvent(ep.id, "Showcase", now, W, deliveryDeps(now));
      if (!t.ok) throw new Error(t.error);
    }
  },
  read_api: async () => {
    /* run by runShowcaseStep, which also returns the answer */
  }
};

async function need(step: ShowcaseStep, now: Date) {
  if (step === "tracking") {
    const { load } = await ids();
    if (load?.status === "completed") return;
  }
  if (step === "factoring") {
    const { load } = await ids();
    if (load?.factoringStatus === "funded" || load?.factoringStatus === "paid") return;
  }
  if (step === "payroll") {
    const st = await prisma.settlement.findFirst({ where: { workspaceId: W, paidAt: { not: null } } });
    if (st) return;
  }
  await STEPS[step](now);
}

/** Run one step (and any earlier step it needs). Answers every card as it now stands, and for the read API the answer it got. */
export async function runShowcaseStep(step: ShowcaseStep, now = new Date()): Promise<ShowcaseResult> {
  if (!showcaseAllowed()) return refused();
  const exists = await prisma.workspace.count({ where: { id: W } });
  if (!exists) {
    const r = await resetShowcase(now);
    if (!r.ok) return r;
  }
  try {
    let apiSample: string | undefined;
    await explicitTenancy(W, async () => {
      if (step === "read_api") apiSample = await callReadApi(now);
      else await STEPS[step](now);
    });
    return { ok: true, cards: await showcaseSnapshot(), ...(apiSample ? { apiSample } : {}) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 300) : "The step did not finish.", cards: await showcaseSnapshot() };
  }
}

/** A fresh read key for the showcase fleet (older showcase keys are revoked), and GET /api/v1/invoices with it, through the real handler. The key itself is never shown. */
async function callReadApi(now: Date): Promise<string> {
  await prisma.partnerApiKey.updateMany({ where: { workspaceId: W, revokedAt: null }, data: { revokedAt: now, revokedBy: "Showcase" } });
  const made = await createApiKey({ label: "Showcase read key", scopes: ["invoices", "payments", "settlements", "loads"] }, "Showcase", now, W, "test");
  if (!made.ok) throw new Error(made.error);
  const res = await serveRead(new Request("https://showcase.desk.invalid/api/v1/invoices?limit=2", { headers: { authorization: `Bearer ${made.key}` } }), "invoices", { now: () => now });
  const body = await res.json();
  const head = `GET /api/v1/invoices?limit=2\nAuthorization: Bearer ${made.masked}\n\n${res.status} · x-request-id: ${res.headers.get("x-request-id")} · x-ratelimit-remaining: ${res.headers.get("x-ratelimit-remaining")}\n`;
  return `${head}${pretty(body, 1800)}`;
}

/** Every card as the showcase fleet's records now stand (read back from the database, so a reload shows the same). */
export async function showcaseSnapshot(): Promise<StepCard[]> {
  const ws = await prisma.workspace.findUnique({ where: { id: W }, select: { id: true } });
  const card = (step: ShowcaseStep, done: boolean, figures: Figure[], code: string | null = null, note: string | null = null): StepCard => ({ step, done, figures, code, note: note ?? `${STEP_INFO[step].modeledOn}. ${SIMULATOR_LABEL}.` });
  if (!ws) return (Object.keys(STEPS) as ShowcaseStep[]).map((s) => card(s, false, [], null, "Reset the showcase to make its fleet."));
  const [{ load, driver }, truck, fuel, miles, inv, st, refs, dels, keys] = await Promise.all([
    ids(),
    prisma.vehicle.findFirst({ where: { workspaceId: W } }),
    prisma.fuelTransaction.findMany({ where: { workspaceId: W } }),
    prisma.iftaMileage.findMany({ where: { workspaceId: W } }),
    prisma.invoice.findFirst({ where: { workspaceId: W, kind: "invoice" }, orderBy: { createdAt: "desc" } }),
    prisma.settlement.findFirst({ where: { workspaceId: W, status: { in: ["final", "void"] } }, orderBy: { createdAt: "desc" } }),
    prisma.externalRef.findMany({ where: { workspaceId: W, provider: "quickbooks" } }),
    prisma.webhookDelivery.findMany({ where: { workspaceId: W }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 12 }),
    prisma.partnerApiKey.findMany({ where: { workspaceId: W }, orderBy: { createdAt: "desc" }, take: 1 })
  ]);
  const trackEvents = await prisma.auditEvent.count({ where: { workspaceId: W, action: "partner_event", summary: { startsWith: "Tracking:" } } });
  const cards: StepCard[] = [];

  cards.push(
    card("eld", driver?.hosSyncedAt != null, driver?.hosSyncedAt ? [
      ["Truck", truck?.name ?? "SHOW-T1"],
      ["Position", truck?.lastLat != null && truck.lastLng != null ? `${truck.lastLat.toFixed(4)}, ${truck.lastLng.toFixed(4)}` : "not read"],
      ["Speed", truck?.lastSpeedMph != null ? `${truck.lastSpeedMph.toFixed(0)} mph` : "not read"],
      ["Drive left", minutes(driver.hosDriveMinutes)],
      ["Shift left", minutes(driver.hosShiftMinutes)],
      ["Cycle left", minutes(driver.hosCycleMinutes)]
    ] : [])
  );
  const flags = Array.isArray(driver?.vetFlags) ? (driver!.vetFlags as unknown[]).map(String) : [];
  cards.push(
    card("vetting", driver?.vetCheckedAt != null, driver?.vetCheckedAt ? [
      ["Carrier", `MC ${driver.carrierMcNumber} · DOT ${driver.carrierDotNumber}`],
      ["Verdict", driver.vetStatus],
      ["Authority", driver.vetAuthorityActive == null ? "not said" : driver.vetAuthorityActive ? "active" : "not active"],
      ["Safety score", driver.vetSafetyScore != null ? String(driver.vetSafetyScore) : "not said"],
      ["Reasons", flags.length > 0 ? flags.slice(0, 3).join("; ") : "none"]
    ] : [])
  );
  cards.push(
    card("tracking", load?.status === "completed", load?.trackingShareUrl || load?.status === "completed" ? [
      ["Tracking link", load?.trackingShareUrl ?? "stopped"],
      ["Signed events taken", String(trackEvents)],
      ["Load", `${LOAD}: ${load?.status === "completed" ? "delivered" : load?.status ?? ""}`]
    ] : [])
  );
  const counted = fuel.filter((f) => f.status === "settled" || f.status == null);
  const gal = counted.reduce((s, f) => s.plus(f.gallons ?? 0), new Prisma.Decimal(0));
  const charged = counted.reduce((s, f) => s.plus(f.amount), new Prisma.Decimal(0));
  const saved = counted.reduce((s, f) => s.plus((f.discountPerGallon ?? new Prisma.Decimal(0)).times(f.gallons ?? 0)), new Prisma.Decimal(0));
  cards.push(card("fuel", fuel.length > 0, fuel.length > 0 ? [["Purchases", String(counted.length)], ["Gallons", gal.toFixed(1)], ["Charged", usd(charged)], ["Card discount", usd(saved)]] : []));
  const byState = new Map<string, Prisma.Decimal>();
  for (const m of miles) byState.set(m.jurisdiction, (byState.get(m.jurisdiction) ?? new Prisma.Decimal(0)).plus(m.miles));
  const total = [...byState.values()].reduce((s, v) => s.plus(v), new Prisma.Decimal(0));
  cards.push(card("ifta", miles.length > 0, miles.length > 0 ? [...[...byState.entries()].sort((a, b) => b[1].cmp(a[1])).map(([j, v]): Figure => [j, `${v.toFixed(1)} mi`]), ["Total", `${total.toFixed(1)} mi`]] : []));
  cards.push(
    card("factoring", inv?.factoringFundedAt != null, inv ? [
      ["Invoice", `${inv.number} · ${usd(inv.total)}`],
      ["Factor state", inv.factoringStatus],
      ["Reference", inv.factoringReferenceId ?? "none yet"],
      ["Advance", usd(inv.factoringAdvance)],
      ["Fee", usd(inv.factoringFee)],
      ["Reserve", usd(inv.factoringReserve)]
    ] : [])
  );
  const run = st?.payrollReference && !st.payrollReference.startsWith("pending:") ? st.payrollReference : null;
  cards.push(
    card("payroll", st?.paidAt != null, st ? [
      ["Statement", `${st.number} · ${usd(st.total)}`],
      ["Pay run", run ?? "not sent"],
      ["Cleared", st.paidAt ? `paid by ${st.paidMethod ?? "payroll"}` : "not yet"]
    ] : [])
  );
  const invRef = refs.find((r) => r.entity === "invoice");
  cards.push(card("quickbooks", refs.length > 0, refs.length > 0 ? [["Records in the books", String(refs.length)], ["Invoice in QuickBooks", invRef ? `Id ${invRef.externalId}` : "not pushed"], ["Bills, customers, items", String(refs.filter((r) => r.entity !== "invoice").length)]] : []));

  const sent = dels.filter((d) => d.status === "sent");
  const last = sent[0];
  let code: string | null = null;
  if (last) {
    const secret = await secretNow();
    const body = JSON.stringify(last.payload);
    const t = last.sentAt ? (last.sentAt.getTime() - (last.sentAt.getTime() % 1000)) / 1000 : 0;
    const sig = secret ? signatureHeader(secret, t, body) : "(secret unreadable)";
    const ok = secret ? verifySignatureHeader(sig, secret, body, t) : false;
    code = `POST ${RECEIVER_URL}\nx-truelane-event-id: ${last.eventId}\nx-truelane-timestamp: ${t}\nx-truelane-signature: ${sig}\n\nSignature checked by the receiver: ${ok ? "valid" : "INVALID"}\n\n${pretty(last.payload)}`;
  }
  cards.push(card("webhook", sent.length > 0, dels.length > 0 ? [["Sent and verified", String(sent.length)], ["Waiting", String(dels.filter((d) => d.status === "pending" || d.status === "failed").length)], ["Events", [...new Set(dels.map((d) => d.type))].join(", ")]] : [], code));
  cards.push(card("read_api", keys.length > 0, keys.length > 0 ? [["Key", `${keys[0]!.prefix}_…${keys[0]!.last4}`], ["Reads", keys[0]!.scopes.join(", ")]] : []));
  return cards;
}

/** For the page: whether the showcase fleet exists yet. */
export const showcaseExists = async (): Promise<boolean> => (await prisma.workspace.count({ where: { id: W } })) > 0;
