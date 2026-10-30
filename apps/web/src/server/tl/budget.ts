import { NextResponse } from "next/server";
import { currentWorkspaceId } from "./workspace";

/**
 * A daily budget on the routes that spend a paid service's quota (address search, routing, the carrier registry, the fuel price). Per desk, per day. It is kept in the
 * server's memory, so it is a brake on a runaway page or a script, not an exact meter: a second server instance counts for itself and a restart starts the day over. The exact,
 * billed-for meters (rate confirmation reads, and every real Mapbox call: a measure is up to a hundred of them, so the cap that counts is the one on calls) are in the database (the ServiceUsage ledger: src/server/tl/usage.ts, src/lib/spend.ts).
 */
export const BUDGETS = { geo_measure: 60, geo_suggest: 600, fmcsa: 300, eia: 100 } as const;
export type BudgetName = keyof typeof BUDGETS;

const used = new Map<string, number>();

const dayOf = (now: Date) => now.toISOString().slice(0, 10);

/** Count one call; the answer to send (429) when the desk has used today's, otherwise null. */
export function overBudget(name: BudgetName, workspaceId = currentWorkspaceId(), now = new Date()): NextResponse | null {
  const key = `${dayOf(now)}|${workspaceId}|${name}`;
  for (const k of used.keys()) if (!k.startsWith(dayOf(now))) used.delete(k);
  const n = (used.get(key) ?? 0) + 1;
  used.set(key, n);
  return n > BUDGETS[name] ? NextResponse.json({ ok: false, error: "This desk has used today's allowance for that lookup. Try again tomorrow." }, { status: 429 }) : null;
}

/** Forget every count (tests). */
export const resetBudgets = () => used.clear();
