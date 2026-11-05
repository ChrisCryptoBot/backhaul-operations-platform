import { CAPABILITIES, PROVIDERS, type Capability } from "@/truelane/partners/contract";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { prisma } from "@/lib/db";
import { keyMode } from "./adapters/sandbox";
import { connectPartner } from "./connections";
import { saveCredential, workspaceReader, type SaveCredentialResult } from "./credentials";

/** The kind of service a company is for (Motive: ELD). A company is in exactly one list in the contract. */
export const capabilityOf = (provider: string): Capability | null => CAPABILITIES.find((c) => PROVIDERS[c].includes(provider)) ?? null;

export type SaveAndConnect = Extract<SaveCredentialResult, { ok: true }> & { sandbox: boolean; connected: boolean } | Extract<SaveCredentialResult, { ok: false }>;

/**
 * Saving a fleet's keys, and what follows from them. A real key is saved and waits for a person to press Connect (a connection to a company that has not been tried says nothing). A test key,
 * one that starts with `sandbox_` on the demo desk, runs the built-in simulator, which cannot fail or cost anything, so it is connected at once: entering a test credential is the whole setup.
 * On a desk where the simulator is not allowed, the key is saved like any other and the first call explains.
 */
export async function saveKeysAndConnect(provider: string, raw: Record<string, unknown>, now = new Date(), workspaceId = currentWorkspaceId()): Promise<SaveAndConnect> {
  const saved = await saveCredential(provider, raw, now, workspaceId);
  if (!saved.ok) return saved;
  const sandbox = keyMode(provider, await workspaceReader(provider, workspaceId)) === "sandbox";
  const capability = capabilityOf(provider);
  if (!sandbox || !capability) return { ...saved, sandbox, connected: false };
  const already = await prisma.partnerConnection.count({ where: { workspaceId, capability, provider, status: "connected" } });
  if (already > 0) return { ...saved, sandbox, connected: true };
  const out = await connectPartner(capability, provider, "Simulator", now, workspaceId);
  return { ...saved, sandbox, connected: out.ok };
}
