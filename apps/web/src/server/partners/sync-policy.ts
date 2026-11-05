import type { Capability } from "@/truelane/partners/contract";

/**
 * How each kind of partner reaches the desk (docs/PARTNER_BACKBONE.md). Pure: no database, so the schedule, the cron answer and the Settings screen read the same table.
 *   poll       the desk asks on a clock (the schedule runs it), so silence is a fault: after `staleAfterMinutes` with no answer the connection is "overdue".
 *   events     the company tells the desk by webhook (a factor funds an invoice, a payroll run clears, a shipment moves). Silence is normal, so there is nothing to be overdue about; the
 *              reachability of a company that only speaks when something happens is shown by its last event, and a "test" ping from the company's dashboard.
 *   on_demand  the desk asks when a person asks (import a trip's fuel, work out a quarter), never on a clock.
 * A company's own adapter decides what a poll does; until one is live it answers "not implemented", which is waiting, not failing (sync.ts).
 */
export type SyncMode = "poll" | "events" | "on_demand";
export type SyncPolicy = { mode: SyncMode; everyMinutes?: number; staleAfterMinutes?: number; rhythm: string };

export const SYNC_POLICY: Record<Capability, SyncPolicy> = {
  eld: { mode: "poll", everyMinutes: 15, staleAfterMinutes: 90, rhythm: "Hours of service are read every 15 minutes." },
  vetting: { mode: "poll", everyMinutes: 24 * 60, staleAfterMinutes: 3 * 24 * 60, rhythm: "Carrier checks are repeated once a day." },
  factoring: { mode: "events", rhythm: "The company tells the desk when an invoice is funded or paid." },
  payroll: { mode: "events", rhythm: "The company tells the desk when a pay run clears." },
  tracking: { mode: "events", rhythm: "The company tells the desk where a shared load is." },
  fuel_card: { mode: "on_demand", rhythm: "Fuel is read from the card when you ask, on a trip." },
  ifta: { mode: "on_demand", rhythm: "A quarter is worked out when you ask." }
};

/** The capabilities the schedule runs, with how often (minutes). */
export const POLLED: Record<string, number> = Object.fromEntries(Object.entries(SYNC_POLICY).filter(([, p]) => p.mode === "poll").map(([k, p]) => [k, p.everyMinutes!]));

/**
 * Whether a connection that should be read on a clock has gone quiet: it is live (connected or in error), its kind is polled, and nothing has answered for longer than its policy allows
 * (counted from the last answer, else from when it was connected). Kinds that are told by webhook, or asked for by a person, are never overdue.
 */
export function isOverdue(c: { capability: string; status: string; lastSyncedAt: Date | null; connectedAt: Date | null }, now: Date): boolean {
  const p = SYNC_POLICY[c.capability as Capability];
  if (!p || p.mode !== "poll" || (c.status !== "connected" && c.status !== "error")) return false;
  const since = c.lastSyncedAt ?? c.connectedAt;
  return since != null && now.getTime() - since.getTime() > p.staleAfterMinutes! * 60_000;
}

export const rhythmOf = (capability: string): string => SYNC_POLICY[capability as Capability]?.rhythm ?? "";
