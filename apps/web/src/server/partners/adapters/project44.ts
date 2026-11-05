import { createHmac } from "node:crypto";
import { err, ok } from "@/truelane/partners/contract";
import type { AdapterShapes } from "../call";
import { notImplemented } from "../not-implemented";
import type { NeutralEvent } from "../webhook-core";
import { seedOf } from "./sandbox";
import { NotLive, type Adapter, type ProviderAdapter } from "./types";

/**
 * Shipment tracking, modeled after project44 (FourKites is the same kind of thing): the carrier opens a shipment for a load with its stops, the network answers with a shipment id and a link a
 * customer can follow, and as the truck crosses a stop's geofence it says so, by event. Sharing a truck's position is the carrier's choice per load (tracking.ts): this adapter is only ever
 * asked after that yes. As with the other adapters, the shapes are what the desk ASSUMES, not the company's documentation.
 */
export type P44Shipment = { shipment_id: string; tracking_url: string; status: "active" | "stopped" };
export type P44Events = { events: Array<{ event_id: string; type: "geofence.entered" | "geofence.exited"; stop_sequence: number; occurred_at: string }> };

export interface P44Client {
  openShipment(body: { reference: string; stops: Array<{ sequence: number; type: string; city: string; lat: number | null; lng: number | null; window_opens: string | null }> }): Promise<P44Shipment>;
  stopShipment(shipmentId: string): Promise<P44Shipment>;
  events(shipmentId: string): Promise<P44Events>;
}

type In = AdapterShapes["tracking"]["in"];
type Out = AdapterShapes["tracking"]["out"];

export const liveP44Client: P44Client = {
  async openShipment() {
    throw new NotLive();
  },
  async stopShipment() {
    throw new NotLive();
  },
  async events() {
    throw new NotLive();
  }
};

/** The shipment's reference is the load's own number, so the network's page and the desk's name the same thing. */
export const shipmentId = (loadId: string) => `p44-${seedOf(loadId).toString(16)}`;

/** The network's answers into the desk's: sharing or not, the link to follow, and the geofence crossings as milestones. */
export function normalizeP44(shipment: P44Shipment, events: P44Events | null): Out {
  return {
    sharing: shipment.status === "active",
    shareUrl: shipment.status === "active" ? shipment.tracking_url : null,
    milestones: (events?.events ?? []).map((e) => ({ stop: e.stop_sequence, kind: e.type === "geofence.entered" ? ("arrived" as const) : ("departed" as const), at: e.occurred_at }))
  };
}

// ── The simulator ────────────────────────────────────────────────────────────────────────────

/**
 * The simulator as a client, with the shipment's stops in hand so its geofence events follow the load's own windows: a stop whose window has opened is entered a few minutes in and left
 * about an hour later, as far as `now` has got. The link is on a reserved name that never resolves, so even if someone pasted it nothing real would be reached.
 */
export function sandboxP44Client(input: In, now: Date = new Date()): P44Client {
  const open = (id: string, status: P44Shipment["status"]): P44Shipment => ({ shipment_id: id, tracking_url: `https://track.sandbox.invalid/s/${id}`, status });
  return {
    async openShipment(body) {
      return open(`p44-${seedOf(body.reference).toString(16)}`, "active");
    },
    async stopShipment(id) {
      return open(id, "stopped");
    },
    async events(id) {
      const events: P44Events["events"] = [];
      for (const s of input.stops ?? []) {
        const opens = s.opensAt ? Date.parse(s.opensAt) : NaN;
        if (!Number.isFinite(opens) || opens > now.getTime()) continue;
        const entered = opens + (5 + (seedOf(`${id}:${s.sequence}`) % 20)) * 60_000;
        if (entered <= now.getTime()) events.push({ event_id: `${id}:${s.sequence}:in`, type: "geofence.entered", stop_sequence: s.sequence, occurred_at: new Date(entered).toISOString() });
        const exited = entered + (45 + (seedOf(`${id}:${s.sequence}:x`) % 60)) * 60_000;
        if (exited <= now.getTime()) events.push({ event_id: `${id}:${s.sequence}:out`, type: "geofence.exited", stop_sequence: s.sequence, occurred_at: new Date(exited).toISOString() });
      }
      return { events };
    }
  };
}

/** A webhook body in the network's own shape, and the neutral event it reads back as. */
export type P44Event = { event_id: string; event_type: string; shipment_reference: string; stop_sequence?: number; occurred_at: string };

export function sandboxTrackingEvent(i: { kind: "tracking.arrived" | "tracking.departed" | "ping"; loadNumber: string | null; stop: number; id: string; secret: string; now?: Date }): { raw: string; signature: string } {
  const body: P44Event =
    i.kind === "ping"
      ? { event_id: i.id, event_type: "webhook.test", shipment_reference: "", occurred_at: (i.now ?? new Date()).toISOString() }
      : { event_id: i.id, event_type: i.kind === "tracking.arrived" ? "geofence.entered" : "geofence.exited", shipment_reference: i.loadNumber ?? "", stop_sequence: i.stop, occurred_at: (i.now ?? new Date()).toISOString() };
  const raw = JSON.stringify(body);
  return { raw, signature: createHmac("sha256", i.secret).update(raw, "utf8").digest("hex") };
}

export function p44EventToNeutral(parsed: unknown): NeutralEvent | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.event_id !== "string" || typeof p.event_type !== "string") return null;
  const kind = p.event_type === "geofence.entered" ? "tracking.arrived" : p.event_type === "geofence.exited" ? "tracking.departed" : p.event_type === "webhook.test" ? "ping" : null;
  if (!kind) return null;
  const ref = typeof p.shipment_reference === "string" && p.shipment_reference.trim() !== "" ? p.shipment_reference.trim().slice(0, 80) : null;
  return { id: p.event_id.slice(0, 120), kind, reference: ref, referenceId: null, stop: typeof p.stop_sequence === "number" && Number.isInteger(p.stop_sequence) ? p.stop_sequence : null };
}

// ── The adapter ──────────────────────────────────────────────────────────────────────────────

async function run(client: P44Client, provider: string, input: In) {
  try {
    const reference = input.loadNumber ?? input.loadId;
    if (!input.share) return ok(normalizeP44(await client.stopShipment(shipmentId(input.loadId)), null));
    const shipment = await client.openShipment({
      reference,
      stops: (input.stops ?? []).map((s) => ({ sequence: s.sequence, type: s.role, city: s.city, lat: s.lat ?? null, lng: s.lng ?? null, window_opens: s.opensAt ?? null }))
    });
    return ok(normalizeP44(shipment, await client.events(shipment.shipment_id)));
  } catch (e) {
    return e instanceof NotLive ? notImplemented(provider) : err("upstream_error", "project44 did not answer.");
  }
}

const live: Adapter<In, Out> = ({ provider, input }) => run(liveP44Client, provider, input);
const sandbox: Adapter<In, Out> = ({ provider, input }) => run(sandboxP44Client(input), provider, input);

export const p44Adapter: ProviderAdapter<In, Out> = { live, sandbox };
