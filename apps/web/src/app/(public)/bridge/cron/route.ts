import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { BRIDGE_ENV, bridgeConfig } from "@/server/bridge/core";
import { flushBridgeOutbox, pullBridgeResponses } from "@/server/bridge/service";
import { supabaseTransport } from "@/server/bridge/transport";

/**
 * The driver link's heartbeat: deliver what is waiting for the drivers' phones and read what the phones have written. Called on a schedule (every minute) by whatever runs the desk's cron, with the
 * secret in a header. It does not exist (404) until the server holds the secret and the link's keys, and a wrong secret is a plain 401 with no detail. It touches only fleets that were switched
 * on (a bridge org set); the answer is counts, never a row, an id or a key. Open to a signed-out caller on purpose: the secret is the credential, not a session.
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
  const fleets = await prisma.workspace.findMany({ where: { bridgeOrgId: { not: null } }, select: { id: true } });
  const out = { fleets: fleets.length, delivered: 0, failed: 0, retrying: 0, read: 0, applied: 0, flagged: 0 };
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
    } catch {
      out.retrying += 1;
    }
  }
  return NextResponse.json({ ok: true, ...out });
}
