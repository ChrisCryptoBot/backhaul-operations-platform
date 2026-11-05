/**
 * The driver link, pure part (docs/DRIVER_LINK_DESIGN.md): who is bridged, what a bridge row looks like, how a driver's answer is read and in what order it is applied, and when a failed
 * delivery is tried again. No database, no network, no clock but the one passed in, so every rule can be tested.
 */
import { Prisma } from "@prisma/client";

export const BRIDGE_ENV = { url: "BRIDGE_SUPABASE_URL", key: "BRIDGE_SUPABASE_SERVICE_KEY", cron: "BRIDGE_CRON_SECRET" } as const;

export type BridgeConfig = { url: string; key: string };

/** The transport's address and key, or null when the server does not hold them. Read at the time of the call; never stored, logged or sent to a browser. */
export function bridgeConfig(env: Record<string, string | undefined>): BridgeConfig | null {
  const url = env[BRIDGE_ENV.url]?.trim();
  const key = env[BRIDGE_ENV.key]?.trim();
  if (!url || !key || !/^https:\/\//.test(url)) return null;
  return { url: url.replace(/\/+$/, ""), key };
}

export type BridgeMode = { mode: "bridged" } | { mode: "manual"; reason: string };

/** Whether a load's driver is reached through the bridge, or the dispatcher records their answers. Anything less than all three is manual, and says why in words. */
export function bridgeMode(i: { workspaceOrgId: string | null; serverReady: boolean; driverPhoneUserId: string | null }): BridgeMode {
  if (!i.workspaceOrgId) return { mode: "manual", reason: "This fleet is not connected to its drivers' phones yet." };
  if (!i.serverReady) return { mode: "manual", reason: "The driver link is not switched on for this server yet." };
  if (!i.driverPhoneUserId) return { mode: "manual", reason: "This driver has no phone account on the desk: you record their answers." };
  return { mode: "bridged" };
}

/** A row of `bridge.external_dispatch`, as the desk reads it. Only the columns the desk uses. */
export type BridgeRow = {
  id: string;
  org_id: string;
  assigned_driver_id: string;
  source_load_id: string | null;
  kind: string;
  status: "draft" | "dispatched" | "reassigned" | "cancelled" | string;
  assignment_version: number;
  execution_version: number;
  sync_seq: number;
  load_summary: unknown;
  driver_response: unknown;
  replaced_by_dispatch_id: string | null;
};

/** What the desk writes when it first puts a load on a driver's phone: the columns it owns, and none of the phone's. */
export function newDispatchRow(i: { orgId: string; phoneUserId: string; loadId: string; summary: unknown; assignmentVersion: number }) {
  return { org_id: i.orgId, assigned_driver_id: i.phoneUserId, source_system: "truelane_desk", source_load_id: i.loadId, kind: "dispatch", status: "dispatched", assignment_version: i.assignmentVersion, load_summary: i.summary, updated_by: "desk" };
}

/** An update of an existing row. A re-offer clears the driver's answer, as the contract says, so they answer again; a plain update leaves it, and reaches the driver on their next pull. */
export function updateDispatchRow(i: { summary: unknown; assignmentVersion: number; reoffer: boolean }) {
  return { load_summary: i.summary, assignment_version: i.assignmentVersion, status: "dispatched", ...(i.reoffer ? { driver_response: null } : {}), updated_by: "desk" };
}

/** Terminal states the desk writes and never deletes: the phone's signal to take the load off the driver. */
export const closeDispatchRow = (status: "reassigned" | "cancelled", assignmentVersion: number, replacedBy: string | null) => ({ status, assignment_version: assignmentVersion, ...(replacedBy ? { replaced_by_dispatch_id: replacedBy } : {}), updated_by: "desk" });

// ── the driver's answer ──────────────────────────────────────────────────────────────────────────────────────────

export type ExecState = "accepted" | "declined" | "in_progress" | "completed";
export const EXEC_STATES: readonly ExecState[] = ["accepted", "declined", "in_progress", "completed"];

export type DriverAnswer = {
  state: ExecState;
  acceptedAt: string | null;
  declinedReason: string | null;
  startedAt: string | null;
  completedAt: string | null;
  actualMiles: number | null;
  /** Storage paths of proof of delivery, each checked to sit inside this fleet's own folder. */
  podRefs: Array<{ stopSeq: number | null; path: string }>;
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 500): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);
const when = (v: unknown): string | null => {
  const s = text(v, 40);
  return s && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : null;
};
const miles = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 20_000 ? new Prisma.Decimal(v).toDecimalPlaces(1).toNumber() : null);

/** A whole number from a count the database or the phone gave (a sequence, a version): parsed, not rounded, so nothing is guessed. */
export const wholeOf = (v: unknown): number => {
  const n = Number.parseInt(String(v ?? 0), 10);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The phone's `driver_response`, read strictly: a state that is one of four, bounded numbers, valid times, and proof paths that stay inside this fleet's folder (a path that climbs out of it,
 * or points at another fleet's files, is dropped, not followed). Anything that is not an object, or has no valid state, is null: the desk ignores it and says so.
 */
export function parseDriverResponse(raw: unknown, orgId: string): DriverAnswer | null {
  if (!isObj(raw)) return null;
  const state = raw.state;
  if (typeof state !== "string" || !(EXEC_STATES as readonly string[]).includes(state)) return null;
  const completion = isObj(raw.completion) ? raw.completion : {};
  const refs = Array.isArray(raw.pod_refs) ? raw.pod_refs : [];
  const prefix = `${orgId}/`;
  const podRefs: DriverAnswer["podRefs"] = [];
  for (const r of refs.filter(isObj).slice(0, 40)) {
    const path = text(r.path, 400);
    // The folder rule: a proof the phone filed under the driver's own id sits at "<driver>/<load>/..." in the pod bucket; one the fleet owns sits under "<org>/...". Neither may climb out.
    if (path == null || path.includes("..") || path.startsWith("/") || (!path.startsWith(prefix) && path.split("/").length < 3)) continue;
    podRefs.push({ stopSeq: typeof r.stop_seq === "number" && Number.isInteger(r.stop_seq) && r.stop_seq >= 0 ? r.stop_seq : null, path });
  }
  return {
    state: state as ExecState,
    acceptedAt: when(raw.accepted_at),
    declinedReason: text(raw.declined_reason),
    startedAt: when(raw.started_at),
    completedAt: when(completion.completed_at),
    actualMiles: miles(completion.actual_total_miles),
    podRefs
  };
}

/** The desk's assignment statuses, in the order a trip goes. A declined or unsent assignment is not on the way. */
const ORDER: Record<string, number> = { dispatched: 0, accepted: 1, in_progress: 2, completed: 3 };

export type Interpretation =
  | { kind: "apply"; steps: ExecState[] }
  | { kind: "ignore"; why: string }
  /** Recorded and shown as an alert, not applied: the phone and the desk disagree about where the load is. */
  | { kind: "flag"; why: string };

/**
 * What to do with a row the phone has moved. The phone's own rules allow no skipping, but the desk reads at its own pace and a row holds only the latest state, so a pull can find
 * "in progress" for a load the desk still shows as sent: the steps in between (accepted) are applied first, in order. Behind the desk (the phone says accepted for a load the desk
 * has already started) is old news and ignored; a phone answer for a load the desk shows cancelled, reassigned or taken off is flagged, never applied.
 */
export function interpretRow(i: { row: Pick<BridgeRow, "assigned_driver_id" | "execution_version" | "driver_response" | "status">; orgId: string; phoneUserId: string | null; deskStatus: string | null; seenExecutionVersion: number }): Interpretation {
  if (i.row.assigned_driver_id !== i.phoneUserId) return { kind: "flag", why: "The answer came from a phone that is not this driver's." };
  if (i.row.execution_version <= i.seenExecutionVersion) return { kind: "ignore", why: "Already applied." };
  const answer = parseDriverResponse(i.row.driver_response, i.orgId);
  if (!answer) return { kind: "ignore", why: "No readable answer yet." };
  if (i.row.status !== "dispatched") return { kind: "flag", why: `The phone says ${answer.state}, but the desk has taken this load off the driver.` };
  if (i.deskStatus == null || !(i.deskStatus in ORDER)) return { kind: "flag", why: `The phone says ${answer.state}, but the desk shows this load as ${i.deskStatus ?? "not assigned"}.` };
  if (answer.state === "declined") return i.deskStatus === "dispatched" ? { kind: "apply", steps: ["declined"] } : { kind: "flag", why: "The phone says declined, but the desk already has the driver on this load." };
  const target = answer.state === "accepted" ? 1 : answer.state === "in_progress" ? 2 : 3;
  const at = ORDER[i.deskStatus]!;
  if (target <= at) return { kind: "ignore", why: "The desk is already there." };
  const path: ExecState[] = ["accepted", "in_progress", "completed"];
  return { kind: "apply", steps: path.slice(at, target) };
}

// ── retries ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Minutes before the next try after this many failures: 1, 5, 15, 60, then a day. */
export const backoffMinutes = (failures: number): number => [1, 5, 15, 60][failures - 1] ?? 1440;
export const MAX_ATTEMPTS = 5;
export const nextAttemptAt = (now: Date, failures: number): Date => new Date(now.getTime() + backoffMinutes(failures) * 60_000);

/** The word a failed delivery is kept under: a code, never a response body, a header or a key. */
export type FailureWord = "unreachable" | "rejected" | "version_clash" | "unsafe" | "not_configured" | "no_phone_account";
export const FAILURE_TEXT: Record<FailureWord, string> = {
  unreachable: "The driver link could not be reached.",
  rejected: "The driver link refused the load.",
  version_clash: "The load changed while it was being sent.",
  unsafe: "The load carries something a driver must not see.",
  not_configured: "The driver link is not switched on.",
  no_phone_account: "This driver has no phone account."
};
