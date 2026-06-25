import { NextResponse } from "next/server";
import { drainQueues } from "@/server/queue-drain";

/**
 * Drains the SQS parse + recompute queues. Designed to be hit by a scheduled trigger
 * (Vercel Cron) on an interval, since nothing else consumes SQS in production. Guarded by
 * WORKER_SHARED_SECRET, accepted either as an `x-worker-secret` header (manual/worker call)
 * or an `Authorization: Bearer <secret>` header (Vercel Cron). When the secret is unset the
 * route is open for local dev — Phase 3 hardening requires it in production.
 */

// SQS receive uses long-polling; give the function room beyond Vercel's default.
export const maxDuration = 60;

function isAuthorized(request: Request): boolean {
  const sharedSecret = process.env.WORKER_SHARED_SECRET;
  if (!sharedSecret) {
    // Open for local dev only; never run unauthenticated in production.
    return process.env.NODE_ENV !== "production";
  }
  if (request.headers.get("x-worker-secret") === sharedSecret) {
    return true;
  }
  return request.headers.get("authorization") === `Bearer ${sharedSecret}`;
}

async function handleDrain(request: Request): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const result = await drainQueues();
    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// Vercel Cron issues a GET.
export async function GET(request: Request) {
  return handleDrain(request);
}

// POST is supported for manual / programmatic triggering.
export async function POST(request: Request) {
  return handleDrain(request);
}
