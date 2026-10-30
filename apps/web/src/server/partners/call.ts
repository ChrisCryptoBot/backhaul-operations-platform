import { prisma } from "@/lib/db";
import { PROVIDERS, SECRET_ENV, err, isCapability, providerConfigured, resolveProvider, type Capability, type PartnerResult } from "@/truelane/partners/contract";
import { currentWorkspaceId } from "@/server/tl/workspace";

/**
 * The one path every call to a partner company takes from the desk, the same order as the Edge Functions' (supabase/functions/_shared/partners/run.ts): the provider is
 * chosen, its secrets are checked (server environment, read at the time of the call, never sent to the browser), the workspace's connection is checked, and only then the
 * provider's adapter is called. No company is chosen yet, so every adapter is the stub below and answers `not_implemented`: a result, not an error, that a screen shows as
 * "not connected yet". The adapters live in a registry so the day a company is chosen its call replaces one entry, and a test can stand one in.
 */
export type Adapter<I = never, O = unknown> = (call: { provider: string; input: I }) => Promise<PartnerResult<O>>;

export const notImplemented = (provider: string): PartnerResult<never> => err("not_implemented", `${provider} is not connected to TrueLane yet.`);

const stub: Adapter<never, never> = async ({ provider }) => notImplemented(provider);

/** What each capability's adapter reads and answers: the desk's own shapes, not any company's. */
export type AdapterShapes = {
  factoring: { in: { loadId: string; loadNumber: string | null; invoiceNumber: string | null; amount: number; packet: string[] }; out: { referenceId: string; status: string } };
  eld: { in: { vehicles: Array<{ id: string; name: string | null; eldVehicleId: string | null }> }; out: { vehicles: Array<{ id: string; eldVehicleId: string | null; hosAvailableHours: number | null }> } };
  fuel_card: { in: { vehicleName: string | null; accountId: string; since: string | null; until: string | null }; out: { purchases: Array<{ on: string; gallons: number | null; amount: number }> } };
  tracking: { in: { loadId: string; share: boolean }; out: { sharing: boolean } };
  vetting: { in: { mcNumber: string | null; dotNumber: string | null }; out: { status: "clear" | "review" | "failed"; coiExpiresAt: string | null } };
  payroll: { in: { statements: Array<{ id: string; number: string; employeeId: string | null; workerType: string | null; total: number; periodStart: string; periodEnd: string }> }; out: { reference: string } };
  ifta: { in: { quarter: string; vehicles: Array<{ id: string; name: string | null }> }; out: { jurisdictions: Array<{ state: string; miles: number; gallons: number }> } };
};

export const partnerAdapters: { [K in Capability]: Adapter<AdapterShapes[K]["in"], AdapterShapes[K]["out"]> } = {
  factoring: stub as never,
  eld: stub as never,
  fuel_card: stub as never,
  tracking: stub as never,
  vetting: stub as never,
  payroll: stub as never,
  ifta: stub as never
};

const env = (name: string) => process.env[name];

export type PartnerState = { provider: string; configured: boolean; connected: boolean; /** Why a call would not go through now, in words, or null. */ reason: string | null };

const NAME: Record<string, string> = { triumphpay: "TriumphPay", motive: "Motive", samsara: "Samsara", atob: "AtoB", wex: "WEX", project44: "project44", fourkites: "FourKites", highway: "Highway", gusto: "Gusto", promiles: "ProMiles" };
export const providerName = (p: string) => NAME[p] ?? p;

/** Where a capability stands for this workspace: the provider a call would use, whether its keys are set, and whether the workspace connected it. Booleans and words only. */
export async function partnerState(capability: Capability, requested?: string | null, workspaceId = currentWorkspaceId()): Promise<PartnerState> {
  const provider = resolveProvider(capability, requested ?? undefined) ?? PROVIDERS[capability][0]!;
  const configured = providerConfigured(provider, env);
  const connected = configured && (await prisma.partnerConnection.count({ where: { workspaceId, capability, provider, status: "connected" } })) > 0;
  const reason = !configured ? `${providerName(provider)} has no keys on the server yet.` : !connected ? `${providerName(provider)} is not connected for this fleet. Connect it in Settings.` : null;
  return { provider, configured, connected, reason };
}

/** Make a call: provider, keys, connection, then the adapter. Returns the provider used with the result, so a caller can say which company answered. */
export async function callPartner<K extends Capability>(capability: K, requested: string | null | undefined, input: AdapterShapes[K]["in"], workspaceId = currentWorkspaceId()): Promise<{ provider: string; result: PartnerResult<AdapterShapes[K]["out"]> }> {
  if (!isCapability(capability)) return { provider: "", result: err("bad_request", "Unknown capability.") };
  const provider = resolveProvider(capability, requested ?? undefined);
  if (!provider) return { provider: "", result: err("bad_request", "That company is not one TrueLane works with for this.", "provider") };
  if (!providerConfigured(provider, env)) return { provider, result: err("not_configured", `${providerName(provider)} has no keys on the server yet.`) };
  const connected = await prisma.partnerConnection.count({ where: { workspaceId, capability, provider, status: "connected" } });
  if (connected === 0) return { provider, result: err("not_connected", `${providerName(provider)} is not connected for this fleet.`) };
  try {
    return { provider, result: await (partnerAdapters[capability] as Adapter<AdapterShapes[K]["in"], AdapterShapes[K]["out"]>)({ provider, input }) };
  } catch {
    // Whatever the company's call threw is not shown or kept: a reading that failed is "upstream_error".
    return { provider, result: err("upstream_error", `${providerName(provider)} did not answer.`) };
  }
}

export const secretNamesOf = (provider: string): readonly string[] => SECRET_ENV[provider] ?? [];
