import { prisma } from "@/lib/db";
import { counselApproved, featureRefusal, moneyMovingVerdict, switchReason, type Feature } from "@/lib/partner-gates";
import { effectivePlan } from "@/lib/plans";
import { recordAudit } from "@/server/tl/audit";
import { lockWorkspace } from "@/server/tl/plan";
import { providerConfigured, resolveProvider, type Capability } from "@/truelane/partners/contract";
import { keyMode } from "./adapters/sandbox";
import { workspaceReader } from "./credentials";

/**
 * The server half of src/lib/partner-gates.ts: reads the workspace's plan, its money-moving switch and the environment, and answers in words. Every function here takes the workspace
 * explicitly (no default): a gate must never be asked about the wrong fleet.
 */
type Env = Record<string, string | undefined>;
const env = (): Env => process.env as Env;

export type Gate = { ok: true } | { ok: false; error: string; code: "plan" | "money_moving_off" };

/** Whether this workspace's plan has a feature. A workspace with no plan, or a word that is not a plan, is held to Starter. */
export async function checkFeature(feature: Feature, workspaceId: string): Promise<Gate> {
  const row = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true } });
  const why = featureRefusal(feature, effectivePlan(row?.plan));
  return why ? { ok: false, error: why, code: "plan" } : { ok: true };
}

export type MoneyMovingState = { counsel: boolean; live: boolean; by: string | null; at: Date | null; reason: string | null };

export async function moneyMovingState(workspaceId: string, e: Env = env()): Promise<MoneyMovingState> {
  const row = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { moneyMovingLive: true, moneyMovingBy: true, moneyMovingAt: true, moneyMovingReason: true } });
  return { counsel: counselApproved(e), live: row?.moneyMovingLive ?? false, by: row?.moneyMovingBy ?? null, at: row?.moneyMovingAt ?? null, reason: row?.moneyMovingReason ?? null };
}

/** Whether a call to this company, in this mode, may move money for this fleet. Sandbox and the kinds that move no money always pass. */
export async function assertMoneyMovingAllowed(capability: string, mode: "live" | "sandbox" | "refused", workspaceId: string, e: Env = env()): Promise<Gate> {
  if (mode !== "live") return { ok: true };
  const st = await moneyMovingState(workspaceId, e);
  const v = moneyMovingVerdict({ capability, mode, counsel: st.counsel, workspaceLive: st.live });
  return v.ok ? { ok: true } : { ok: false, error: v.message, code: "money_moving_off" };
}

/** The same check from the fleet's connected company for a kind: which company a call would go to (as callPartner picks it) and whether its key is the simulator's. */
export async function checkMoneyMoving(capability: Capability, workspaceId: string, requested: string | null = null, e: Env = env()): Promise<Gate> {
  const provider = resolveProvider(capability, requested ?? undefined);
  if (!provider) return { ok: true }; // callPartner refuses an unknown company itself
  const reader = await workspaceReader(provider, workspaceId);
  // Missing keys and a company not connected are said first, by callPartner, in the order a person fixes them; the switch is the last thing between a ready call and the company.
  if (!providerConfigured(provider, reader)) return { ok: true };
  if ((await prisma.partnerConnection.count({ where: { workspaceId, capability, provider, status: "connected" } })) === 0) return { ok: true };
  const mode = keyMode(provider, reader, e);
  return assertMoneyMovingAllowed(capability, mode, workspaceId, e);
}

export type SwitchResult = { ok: true; changed: boolean; live: boolean } | { ok: false; error: string };

/**
 * An admin flips the switch for this fleet, with a reason. Turning it on needs the server's counsel sign-off; turning it off never does (anyone may stop money moving). Made under the workspace
 * lock, from the value it was read at, and audited in the same transaction.
 */
export async function setMoneyMoving(input: { on: boolean; reason: unknown }, who: string, now: Date, workspaceId: string, e: Env = env()): Promise<SwitchResult> {
  const r = switchReason(input.reason);
  if (!r.ok) return r;
  if (input.on && !counselApproved(e)) return { ok: false, error: "This server has not been signed off for moving money (counsel's sign-off is set by whoever runs it). The switch stays off." };
  const name = who.trim().slice(0, 120) || "Admin";
  return prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const row = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { moneyMovingLive: true } });
    if (!row) return { ok: false as const, error: "That fleet does not exist." };
    if (row.moneyMovingLive === input.on) return { ok: true as const, changed: false, live: input.on };
    await tx.workspace.update({ where: { id: workspaceId }, data: { moneyMovingLive: input.on, moneyMovingBy: name, moneyMovingAt: now, moneyMovingReason: r.reason } });
    const word = (v: boolean) => (v ? "On" : "Off");
    await recordAudit(
      { entity: "partner", action: "money_moving_switched", summary: `Money moving through companies switched ${input.on ? "on" : "off"} by ${name}: ${r.reason}`, before: { "Money moving": word(row.moneyMovingLive) }, after: { "Money moving": word(input.on), Reason: r.reason }, at: now, workspaceId },
      tx
    );
    return { ok: true as const, changed: true, live: input.on };
  });
}
