import { CAPABILITIES, CAPABILITY_LABEL, type Capability } from "@/truelane/partners/contract";
import { PLAN_KEYS, planOf, type PlanKey } from "./plans";

/**
 * What a plan may use of the partner surface, and when a call to a company may move money for real (docs/MONEY_PLAN.md, Wave 7 step 1, Gap 14). Pure: no database, no network; the server reads
 * the workspace's plan and switch and the environment, and hands them over (src/server/partners/gates.ts).
 *
 * Plans (Chris, 2026-11-13, D1): the core money path (factoring, payroll, accounting) and every other company kind are on every plan; the read API and outbound webhooks start at Pro. A feature
 * cannot be added without a row here (a test fails), so nothing new is quietly open to every plan or closed to all of them.
 */
export const FEATURES = [...CAPABILITIES, "read_api", "outbound_webhooks"] as const;
export type Feature = (typeof FEATURES)[number];

export const FEATURE_PLAN: Record<Feature, PlanKey> = {
  factoring: "starter",
  eld: "starter",
  fuel_card: "starter",
  tracking: "starter",
  vetting: "starter",
  payroll: "starter",
  ifta: "starter",
  accounting: "starter",
  read_api: "pro",
  outbound_webhooks: "pro"
};

export const FEATURE_LABEL: Record<Feature, string> = { ...CAPABILITY_LABEL, read_api: "The read API", outbound_webhooks: "Outbound webhooks" };

export const isFeature = (v: unknown): v is Feature => typeof v === "string" && (FEATURES as readonly string[]).includes(v);

/** Whether a plan has a feature: the plan is the feature's lowest plan or above it. */
export const allowed = (feature: Feature, plan: PlanKey): boolean => PLAN_KEYS.indexOf(plan) >= PLAN_KEYS.indexOf(FEATURE_PLAN[feature]);

/** Why a plan cannot use a feature, in words, or null when it can. */
export function featureRefusal(feature: Feature, plan: PlanKey): string | null {
  if (allowed(feature, plan)) return null;
  return `${FEATURE_LABEL[feature]} comes with the ${planOf(FEATURE_PLAN[feature]).label} plan and up; this fleet is on ${planOf(plan).label}. Talk to a person to change the plan.`;
}

/**
 * The money-moving switch (D2). A call that would send money through a company for real (an invoice sold to a factor, a pay run sent to payroll) needs two things:
 *   1. the server's operator has set MONEY_MOVING_COUNSEL_APPROVED=yes, saying counsel signed off this deployment (no fleet can turn that on by itself); and
 *   2. the fleet's admin has switched it on for this workspace, with a reason (audited).
 * The simulator (a sandbox_ key on the demo desk) always passes: it moves nothing. Reading from a company (payroll's status check, a factor's status) never needs the switch.
 */
export const MONEY_MOVING_ENV = "MONEY_MOVING_COUNSEL_APPROVED";
export const MONEY_MOVING: readonly Capability[] = ["factoring", "payroll"];

export const counselApproved = (env: Record<string, string | undefined>): boolean => env[MONEY_MOVING_ENV]?.trim().toLowerCase() === "yes";

/** Whether this call to a company would move money. Factoring's only call is a submit; payroll's is a send unless it is the status check. */
export function movesMoney(capability: string, input: unknown): boolean {
  if (capability === "factoring") return true;
  if (capability === "payroll") return !(input && typeof input === "object" && (input as { op?: unknown }).op === "status");
  return false;
}

export type MoneyVerdict = { ok: true } | { ok: false; reason: "counsel" | "workspace"; message: string };

export function moneyMovingVerdict(i: { capability: string; mode: "live" | "sandbox" | "refused"; counsel: boolean; workspaceLive: boolean }): MoneyVerdict {
  if (!(MONEY_MOVING as readonly string[]).includes(i.capability) || i.mode !== "live") return { ok: true };
  const what = i.capability === "payroll" ? "Sending pay runs to payroll" : "Selling invoices to a factor";
  if (!i.counsel) return { ok: false, reason: "counsel", message: `${what} for real is not switched on for this server: it waits for counsel's sign-off. Nothing was sent.` };
  if (!i.workspaceLive) return { ok: false, reason: "workspace", message: `${what} for real is switched off for this fleet. An admin switches it on in Settings, Integrations. Nothing was sent.` };
  return { ok: true };
}

/** A reason for flipping the switch: said in the audit trail, so it must say something. */
export const SWITCH_REASON_MIN = 8;
export const SWITCH_REASON_MAX = 300;
export function switchReason(raw: unknown): { ok: true; reason: string } | { ok: false; error: string } {
  const reason = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (reason.length < SWITCH_REASON_MIN) return { ok: false, error: `Say why, in a few words (at least ${SWITCH_REASON_MIN} characters): it goes in the audit trail.` };
  return { ok: true, reason: reason.slice(0, SWITCH_REASON_MAX) };
}
