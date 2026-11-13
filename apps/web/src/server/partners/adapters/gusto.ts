import { createHash, createHmac } from "node:crypto";
import { Prisma } from "@prisma/client";
import { err, ok } from "@/truelane/partners/contract";
import type { AdapterShapes } from "../call";
import { notImplemented } from "../not-implemented";
import type { NeutralEvent } from "../webhook-core";
import { NotLive, type Adapter, type ProviderAdapter } from "./types";

/**
 * Payroll, modeled after Gusto: a batch of finalized driver statements becomes one payment each, a contractor (1099) paid as a contractor payment and an employee (W-2) as wages, each carrying
 * the desk's own idempotency key so the same statement sent twice is paid once. Gross pay only: no taxes or deductions are worked out here, as the statement is. As with the other adapters,
 * the shapes are what the desk ASSUMES, not the company's documentation.
 */
export type GustoPayment = { idempotency_key: string; worker_id: string; worker_kind: "contractor" | "employee"; amount: string; period_start: string; period_end: string; memo: string };
export type GustoBatch = { run_id: string; payments: Array<{ idempotency_key: string; state: "queued" | "rejected"; reason: string | null }> };

/** A run as the company reports it when asked (the status poll, Wave 4 step 5): processing until it clears, then paid on a day; any payment in it can be refused with a reason. */
export type GustoRun = { run_id: string; status: "processing" | "paid"; paid_at: string | null; payments: Array<{ idempotency_key: string; state: "queued" | "paid" | "rejected"; reason: string | null }> };

/**
 * `context` is only for the simulator, which keeps no state: when the desk sent the run, the desk's clock now, and each payment's worker. A live client asks the company for the run by its id
 * and ignores it.
 */
export type GustoRunQuery = { run_id: string; context: { sent_at: string; as_of: string; payments: Array<{ idempotency_key: string; worker_id: string | null }> } };

export interface GustoClient {
  submitPayments(body: { payments: GustoPayment[] }): Promise<GustoBatch>;
  getRun(query: GustoRunQuery): Promise<GustoRun>;
}

type In = AdapterShapes["payroll"]["in"];
type Out = AdapterShapes["payroll"]["out"];

export const liveGustoClient: GustoClient = {
  async submitPayments() {
    throw new NotLive();
  },
  async getRun() {
    throw new NotLive();
  }
};

/** The desk's statements into the company's payments. A statement for a worker the company does not know (no id) cannot become a payment: it is named, not guessed. */
export function toGustoPayments(input: Extract<In, { statements: Array<{ total: number }> }>): { payments: GustoPayment[]; unknown: string[] } {
  const unknown: string[] = [];
  const payments: GustoPayment[] = [];
  for (const s of input.statements) {
    if (!s.employeeId) {
      unknown.push(s.number);
      continue;
    }
    payments.push({
      idempotency_key: s.idempotencyKey ?? `statement:${s.id}`,
      worker_id: s.employeeId,
      worker_kind: s.workerType === "employee" ? "employee" : "contractor",
      amount: new Prisma.Decimal(s.total).toDecimalPlaces(2).toFixed(2),
      period_start: s.periodStart,
      period_end: s.periodEnd,
      memo: `Driver statement ${s.number}`
    });
  }
  return { payments, unknown };
}

/** The company's answer into the desk's: one run reference for the batch, or a refusal that names what was not accepted (so the desk releases its claim and nothing is marked sent). */
export function normalizeGusto(batch: GustoBatch, unknown: string[]) {
  const rejected = batch.payments.filter((p) => p.state === "rejected");
  if (unknown.length > 0 || rejected.length > 0) {
    const names = [...unknown, ...rejected.map((r) => r.idempotency_key.replace(/^statement:/, ""))];
    return err("bad_request", `Payroll did not accept ${names.length === 1 ? "a statement" : `${names.length} statements`}: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ", and more" : ""}.`);
  }
  return ok<Out>({ reference: batch.run_id, payments: batch.payments.map((p) => ({ id: p.idempotency_key.replace(/^statement:/, ""), status: p.state })) });
}

/**
 * A run's report into the desk's status answer. All refused: rejected. Some refused: mixed (those are released; the rest wait for the run, or are paid if it cleared). None refused: paid once the
 * run cleared, otherwise pending.
 */
export function normalizeGustoRun(run: GustoRun) {
  const payments = run.payments.map((p) => ({ id: p.idempotency_key.replace(/^statement:/, ""), status: p.state === "queued" ? "pending" : p.state, reason: p.reason }));
  const refused = payments.filter((p) => p.status === "rejected").length;
  const state: "pending" | "paid" | "rejected" | "mixed" = refused > 0 && refused === payments.length ? "rejected" : refused > 0 ? "mixed" : run.status === "paid" ? "paid" : "pending";
  return ok<Out>({ reference: run.run_id, state, paidAt: run.status === "paid" ? run.paid_at : null, payments });
}

// ── The simulator ────────────────────────────────────────────────────────────────────────────

/** The simulator's pay run clears this long after it was sent (four days, like a payroll ACH): longer than PAYROLL_POLL_AFTER_DAYS, so the poll meets runs still pending as well as cleared ones. */
export const SANDBOX_CLEAR_HOURS = 96;
/** A worker whose payroll id starts with this is refused by the simulator when its run is asked about, the way a bad bank account is refused after the run was accepted. */
export const SANDBOX_REJECT_PREFIX = "REJECT-";

/**
 * The simulator as a client: the same batch is the same run (its id is a hash of the idempotency keys, so sending a statement twice never makes a second run), and a payment of nothing or
 * less is rejected the way a real payroll company would.
 */
export const sandboxGustoClient: GustoClient = {
  async submitPayments(body) {
    const keys = body.payments.map((p) => p.idempotency_key).sort().join("|");
    return {
      run_id: `GUS-SBX-${createHash("sha256").update(keys).digest("hex").slice(0, 10).toUpperCase()}`,
      payments: body.payments.map((p) => (new Prisma.Decimal(p.amount).lte(0) ? { idempotency_key: p.idempotency_key, state: "rejected" as const, reason: "Amount must be above zero." } : { idempotency_key: p.idempotency_key, state: "queued" as const, reason: null }))
    };
  },
  // Stateless and the same for the same question: pending until SANDBOX_CLEAR_HOURS after it was sent, then paid on that hour; a REJECT- worker is refused whatever the clock says.
  async getRun({ run_id, context }) {
    const sent = new Date(context.sent_at).getTime();
    const clearsAt = sent + SANDBOX_CLEAR_HOURS * 3_600_000;
    const cleared = new Date(context.as_of).getTime() >= clearsAt;
    return {
      run_id,
      status: cleared ? "paid" : "processing",
      paid_at: cleared ? new Date(clearsAt).toISOString() : null,
      payments: context.payments.map((p) =>
        p.worker_id?.startsWith(SANDBOX_REJECT_PREFIX) ? { idempotency_key: p.idempotency_key, state: "rejected" as const, reason: "The worker's bank account could not be verified." } : { idempotency_key: p.idempotency_key, state: cleared ? ("paid" as const) : ("queued" as const), reason: null }
      )
    };
  }
};

/** A webhook body in the company's own shape: the run cleared, a payment in it was refused (naming the payment by the desk's key, with the reason), or a test. */
export type GustoEvent = { uuid: string; event_type: string; resource_uuid: string; timestamp: string; payment_idempotency_key?: string; reason?: string };

export function sandboxPayrollEvent(i: { kind: "payroll.paid" | "payroll.rejected" | "ping"; runId: string | null; id: string; secret: string; now?: Date; statementId?: string; reason?: string }): { raw: string; signature: string } {
  const body: GustoEvent = {
    uuid: i.id,
    event_type: i.kind === "ping" ? "webhook.test" : i.kind === "payroll.rejected" ? "payment.rejected" : "payroll.paid",
    resource_uuid: i.runId ?? "",
    timestamp: (i.now ?? new Date()).toISOString(),
    ...(i.kind === "payroll.rejected" ? { ...(i.statementId ? { payment_idempotency_key: `statement:${i.statementId}` } : {}), reason: i.reason ?? "Rejected." } : {})
  };
  const raw = JSON.stringify(body);
  return { raw, signature: createHmac("sha256", i.secret).update(raw, "utf8").digest("hex") };
}

export function gustoEventToNeutral(parsed: unknown): NeutralEvent | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.uuid !== "string" || typeof p.event_type !== "string") return null;
  const kind = p.event_type === "payroll.paid" ? "payroll.paid" : p.event_type === "payment.rejected" ? "payroll.rejected" : p.event_type === "webhook.test" ? "ping" : null;
  if (!kind) return null;
  const ref = typeof p.resource_uuid === "string" && p.resource_uuid.trim() !== "" ? p.resource_uuid.trim().slice(0, 80) : null;
  // A refusal names the payment by the desk's own key ("statement:<id>"), so only that statement is released.
  const key = typeof p.payment_idempotency_key === "string" && p.payment_idempotency_key.startsWith("statement:") ? p.payment_idempotency_key.slice("statement:".length, 120) : null;
  const reason = typeof p.reason === "string" && p.reason.trim() !== "" ? p.reason.trim().slice(0, 200) : null;
  return { id: p.uuid.slice(0, 120), kind, reference: ref, referenceId: kind === "payroll.rejected" ? key : null, stop: null, ...(kind === "payroll.rejected" ? { detail: reason } : {}) };
}

// ── The adapter ──────────────────────────────────────────────────────────────────────────────

async function run(client: GustoClient, provider: string, input: In) {
  try {
    if (input.op === "status") {
      const query: GustoRunQuery = { run_id: input.reference, context: { sent_at: input.sentAt, as_of: input.asOf, payments: input.statements.map((s) => ({ idempotency_key: `statement:${s.id}`, worker_id: s.employeeId })) } };
      return normalizeGustoRun(await client.getRun(query));
    }
    const { payments, unknown } = toGustoPayments(input);
    // Nothing is sent for a statement the company cannot pay; the whole batch waits, so a person fixes the worker's setup and sends it again.
    if (unknown.length > 0) return normalizeGusto({ run_id: "", payments: [] }, unknown);
    return normalizeGusto(await client.submitPayments({ payments }), unknown);
  } catch (e) {
    return e instanceof NotLive ? notImplemented(provider) : err("upstream_error", "Gusto did not answer.");
  }
}

const live: Adapter<In, Out> = ({ provider, input }) => run(liveGustoClient, provider, input);
const sandbox: Adapter<In, Out> = ({ provider, input }) => run(sandboxGustoClient, provider, input);

export const gustoAdapter: ProviderAdapter<In, Out> = { live, sandbox };
