import { currentWorkspaceId } from "@/server/tl/workspace";
import { pullChanged, pullDue, type LivePullResult } from "@/lib/live-messages";
import { pullDriverMessages } from "./messages";
import { flushBridgeOutbox } from "./service";
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

/** Test-only: forget the throttle. */
export function __resetLivePullForTest(): void {
  lastPull.clear();
}
