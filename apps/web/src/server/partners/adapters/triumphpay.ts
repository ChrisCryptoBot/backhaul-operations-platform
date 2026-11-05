import { createHmac } from "node:crypto";
import { err, ok } from "@/truelane/partners/contract";
import type { AdapterShapes } from "../call";
import { notImplemented } from "../not-implemented";
import type { NeutralEvent, PartnerEventKind } from "../webhook-core";
import { NotLive, type Adapter, type ProviderAdapter } from "./types";

/**
 * Factoring, modeled after TriumphPay. As with Motive (./motive.ts), these shapes are what the desk ASSUMES a factoring API takes and sends, modeled on how such products work, not taken from the
 * company's documentation: an invoice is submitted with a packet of documents and answered with the factor's own id and a state; the factor later says by webhook that it has funded or
 * paid. When real keys and docs arrive, check these types, the live client's one method, and `triumphEventToNeutral`.
 */
export type TriumphSubmit = { invoice_number: string | null; load_number: string | null; amount: number; documents: string[] };
export type TriumphSubmitted = { id: string; state: "received" | "under_review" | "funded" | "rejected" };

export interface TriumphClient {
  submitInvoice(body: TriumphSubmit): Promise<TriumphSubmitted>;
}

type In = AdapterShapes["factoring"]["in"];
type Out = AdapterShapes["factoring"]["out"];

export const liveTriumphClient: TriumphClient = {
  async submitInvoice() {
    throw new NotLive();
  }
};

/** The factor's state, in the desk's own factoring statuses (the same words the invoice shows). */
export const factoringStateOf = (state: TriumphSubmitted["state"]): string => (state === "funded" ? "funded" : state === "rejected" ? "rejected" : "submitted");

export const toTriumphSubmit = (input: In): TriumphSubmit => ({ invoice_number: input.invoiceNumber, load_number: input.loadNumber, amount: input.amount, documents: input.packet });

export const normalizeTriumphSubmitted = (answer: TriumphSubmitted): Out => ({ referenceId: answer.id, status: factoringStateOf(answer.state) });

// ── The simulator ────────────────────────────────────────────────────────────────────────────

/** The simulator as a client: the same call, answered with a reference that names the invoice so a person can follow it, in the state a real factor answers first. */
export const sandboxTriumphClient: TriumphClient = {
  async submitInvoice(body) {
    return { id: `TP-SBX-${(body.invoice_number ?? body.load_number ?? "INVOICE").replace(/[^A-Za-z0-9-]/g, "").slice(0, 40)}`, state: "under_review" };
  }
};

/** A webhook body in the factor's own shape. `kind` is what happened to the invoice. */
export type TriumphEvent = { event_id: string; event_type: string; created_at: string; data: { invoice_number: string | null; reference_id: string | null; amount?: number } };

type FactoringKind = Extract<PartnerEventKind, `factoring.${string}`>;
const TYPE_FOR: Record<FactoringKind, string> = {
  "factoring.submitted": "invoice.under_review",
  "factoring.funded": "invoice.funded",
  "factoring.paid": "payment.received",
  "factoring.rejected": "invoice.rejected"
};

/**
 * What the simulator sends as the factor's confirmations: a body in the factor's shape and its signature (hex HMAC-SHA256 of the raw bytes, the scheme the receiver checks), so a test or a
 * demo can deliver it to the real receiver in-process. `id` makes the event repeatable: the same id twice is one event.
 */
export function sandboxFactoringEvent(i: { kind: FactoringKind | "ping"; invoiceNumber: string | null; referenceId: string | null; amount?: number; id: string; secret: string; now?: Date }): { raw: string; signature: string } {
  const body: TriumphEvent =
    i.kind === "ping"
      ? { event_id: i.id, event_type: "webhook.test", created_at: (i.now ?? new Date()).toISOString(), data: { invoice_number: null, reference_id: null } }
      : { event_id: i.id, event_type: TYPE_FOR[i.kind], created_at: (i.now ?? new Date()).toISOString(), data: { invoice_number: i.invoiceNumber, reference_id: i.referenceId, ...(i.amount != null ? { amount: i.amount } : {}) } };
  const raw = JSON.stringify(body);
  return { raw, signature: createHmac("sha256", i.secret).update(raw, "utf8").digest("hex") };
}

/** The factor's event into the desk's neutral one. Anything that is not in the factor's shape is null (the receiver then tries the neutral envelope). */
export function triumphEventToNeutral(parsed: unknown): NeutralEvent | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.event_id !== "string" || typeof p.event_type !== "string") return null;
  const data = p.data && typeof p.data === "object" && !Array.isArray(p.data) ? (p.data as Record<string, unknown>) : {};
  const kind = (Object.entries(TYPE_FOR).find(([, type]) => type === p.event_type)?.[0] ?? (p.event_type === "webhook.test" ? "ping" : null)) as PartnerEventKind | null;
  if (!kind) return null;
  const s = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 80) : null);
  return { id: p.event_id.slice(0, 120), kind, reference: s(data.invoice_number), referenceId: s(data.reference_id) };
}

// ── The adapter ──────────────────────────────────────────────────────────────────────────────

async function run(client: TriumphClient, provider: string, input: In) {
  try {
    return ok(normalizeTriumphSubmitted(await client.submitInvoice(toTriumphSubmit(input))));
  } catch (e) {
    return e instanceof NotLive ? notImplemented(provider) : err("upstream_error", "TriumphPay did not answer.");
  }
}

const live: Adapter<In, Out> = ({ provider, input }) => run(liveTriumphClient, provider, input);
const sandbox: Adapter<In, Out> = ({ provider, input }) => run(sandboxTriumphClient, provider, input);

export const triumphAdapter: ProviderAdapter<In, Out> = { live, sandbox };
