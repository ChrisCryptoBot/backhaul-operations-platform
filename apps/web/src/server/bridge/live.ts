import { currentWorkspaceId } from "@/server/tl/workspace";
import { pullChanged, pullDue, type LivePullResult } from "@/lib/live-messages";
import { pullDriverMessages } from "./messages";
import { flushBridgeOutbox, pullBridgeResponses } from "./service";
import type { BridgeTransport } from "./transport";

/** When each fleet was last pulled for the live Messages page, in this server process. A second process may pull once more per window; the pull and flush are idempotent. */
const lastPull = new Map<string, number>();

/**
 * The Messages page's "look now": deliver the fleet's waiting messages and take in what the phones wrote, with the same flusher and puller the cron runs, throttled per fleet
 * (lib/live-messages.ts). `pulled: false` when another tab already looked within the window.
 */
export async function pullMessagesNow(transport: BridgeTransport, opts: { workspaceId?: string; now?: Date } = {}): Promise<LivePullResult> {
  const workspaceId = opts.workspaceId ?? currentWorkspaceId();
  const now = opts.now ?? new Date();
  if (!pullDue(lastPull.get(workspaceId) ?? null, now.getTime())) return { pulled: false, changed: false };
  lastPull.set(workspaceId, now.getTime());
  const sent = await flushBridgeOutbox(transport, { workspaceId, now });
  const got = await pullDriverMessages(transport, { workspaceId, now });
  return { pulled: true, changed: pullChanged({ delivered: sent.delivered, taken: got.taken, readByDriver: got.readByDriver }) };
}

/** When each fleet's driver answers were last pulled for the Dispatch queue, in this server process (the same idempotent flush and pull the cron runs). */
const lastAnswers = new Map<string, number>();
/** How often the queue may look on the link for one fleet, however many tabs have it open. */
export const ANSWERS_EVERY_MS = 20_000;

/**
 * The Dispatch queue's "look now": deliver what is waiting for the drivers' phones and apply the answers they wrote, throttled per fleet. `changed` when anything was delivered, applied
 * or flagged, so the queue knows to draw itself again.
 */
export async function pullAnswersNow(transport: BridgeTransport, opts: { workspaceId?: string; now?: Date } = {}): Promise<LivePullResult> {
  const workspaceId = opts.workspaceId ?? currentWorkspaceId();
  const now = opts.now ?? new Date();
  const last = lastAnswers.get(workspaceId) ?? null;
  if (last != null && now.getTime() - last < ANSWERS_EVERY_MS) return { pulled: false, changed: false };
  lastAnswers.set(workspaceId, now.getTime());
  const sent = await flushBridgeOutbox(transport, { workspaceId, now });
  const got = await pullBridgeResponses(transport, { workspaceId, now });
  return { pulled: true, changed: sent.delivered + got.applied + got.flagged > 0 };
}

/** Test-only: forget the throttle. */
export function __resetLivePullForTest(): void {
  lastPull.clear();
  lastAnswers.clear();
}
