import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { BRIDGE_ENV, bridgeConfig } from "@/server/bridge/core";
import { flushBridgeOutbox, mirrorDriverStatus, pullBridgeResponses, pullDriverMessages, purgeDriverMessages } from "@/server/bridge/service";
import { supabaseTransport } from "@/server/bridge/transport";
import { fleetsWithLinksToPull, pullDriverLinks } from "@/server/bridge/links";

/**
 * The driver link's heartbeat: deliver what is waiting for the drivers' phones and read what the phones have written. Called on a schedule (every minute) by whatever runs the desk's cron, with the
 * secret in a header. It does not exist (404) until the server holds the secret and the link's keys, and a wrong secret is a plain 401 with no detail. It first reads claimed phone links (fleets
 * already linked, and fleets with a code waiting), then touches only fleets that were switched on (a bridge org set); the answer is counts, never a row, an id or a key. Open to a signed-out caller on purpose: the secret is the credential, not a session.
 */
export const dynamic = "force-dynamic";

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function POST(req: NextRequest) {
  const secret = process.env[BRIDGE_ENV.cron]?.trim();
  const cfg = bridgeConfig(process.env as Record<string, string | undefined>);
  if (!secret || !cfg) return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  const given = req.headers.get("x-bridge-cron") ?? "";
  if (!same(given, secret)) return NextResponse.json({ ok: false, error: "Not allowed." }, { status: 401 });

  const transport = supabaseTransport(cfg);
  // Phone links first (Phase 2 step 1): a driver who just typed their code is linked before this minute's deliveries, and a fleet's first link switches it onto the bridge.
  const linking = await fleetsWithLinksToPull();
  const links = { linked: 0, unlinked: 0 };
  for (const id of linking) {
    try {
      const got = await pullDriverLinks(transport, { workspaceId: id });
      links.linked += got.linked;
      links.unlinked += got.unlinked;
    } catch {
      // The link check failing for one fleet never stops the others or the deliveries below.
    }
  }
  const fleets = await prisma.workspace.findMany({ where: { bridgeOrgId: { not: null } }, select: { id: true } });
  const out = { fleets: fleets.length, delivered: 0, failed: 0, retrying: 0, read: 0, applied: 0, flagged: 0, messages: 0, purged: 0, clocks: 0, ...links };
  for (const f of fleets) {
    // One fleet failing (the link down, a bad row) never stops the others.
    try {
      const sent = await flushBridgeOutbox(transport, { workspaceId: f.id });
      const got = await pullBridgeResponses(transport, { workspaceId: f.id });
      out.delivered += sent.delivered;
      out.failed += sent.failed;
      out.retrying += sent.retrying;
      out.read += got.read;
      out.applied += got.applied;
      out.flagged += got.flagged;
      // Phase 2 step 3: what drivers wrote, and read marks both ways.
      const said = await pullDriverMessages(transport, { workspaceId: f.id });
      out.messages += said.taken;
      // Retention: messages read more than a day ago leave the bridge (the desk keeps the record). After the pull, so the last read marks are in.
      const purged = await purgeDriverMessages(transport, { workspaceId: f.id });
      out.purged += purged.removed;
      // Phase 2 step 4: the HOS read mirror, written only when a driver's clocks changed since the last run.
      const mirrored = await mirrorDriverStatus(transport, { workspaceId: f.id });
      out.clocks += mirrored.written;
    } catch {
      out.retrying += 1;
    }
  }
  return NextResponse.json({ ok: true, ...out });
}
