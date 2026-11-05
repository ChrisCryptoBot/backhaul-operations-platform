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

export interface GustoClient {
  submitPayments(body: { payments: GustoPayment[] }): Promise<GustoBatch>;
}

type In = AdapterShapes["payroll"]["in"];
type Out = AdapterShapes["payroll"]["out"];

export const liveGustoClient: GustoClient = {
  async submitPayments() {
    throw new NotLive();
  }
};

/** The desk's statements into the company's payments. A statement for a worker the company does not know (no id) cannot become a payment: it is named, not guessed. */
export function toGustoPayments(input: In): { payments: GustoPayment[]; unknown: string[] } {
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

// ── The simulator ────────────────────────────────────────────────────────────────────────────

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
  }
};

/** A webhook body in the company's own shape: the run cleared, or a test. */
export type GustoEvent = { uuid: string; event_type: string; resource_uuid: string; timestamp: string };

export function sandboxPayrollEvent(i: { kind: "payroll.paid" | "ping"; runId: string | null; id: string; secret: string; now?: Date }): { raw: string; signature: string } {
  const body: GustoEvent = { uuid: i.id, event_type: i.kind === "ping" ? "webhook.test" : "payroll.paid", resource_uuid: i.runId ?? "", timestamp: (i.now ?? new Date()).toISOString() };
  const raw = JSON.stringify(body);
  return { raw, signature: createHmac("sha256", i.secret).update(raw, "utf8").digest("hex") };
}

export function gustoEventToNeutral(parsed: unknown): NeutralEvent | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.uuid !== "string" || typeof p.event_type !== "string") return null;
  const kind = p.event_type === "payroll.paid" ? "payroll.paid" : p.event_type === "webhook.test" ? "ping" : null;
  if (!kind) return null;
  const ref = typeof p.resource_uuid === "string" && p.resource_uuid.trim() !== "" ? p.resource_uuid.trim().slice(0, 80) : null;
  return { id: p.uuid.slice(0, 120), kind, reference: ref, referenceId: null, stop: null };
}

// ── The adapter ──────────────────────────────────────────────────────────────────────────────

async function run(client: GustoClient, provider: string, input: In) {
  try {
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
