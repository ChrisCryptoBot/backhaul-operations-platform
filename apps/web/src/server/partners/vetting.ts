import { prisma } from "@/lib/db";
import { recordAudit } from "@/server/tl/audit";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { callPartner, providerName } from "./call";

/**
 * Carrier vetting: for a driver who runs under a carrier authority (an owner-operator, a leased-on company), check the authority and insurance with the vetting company and keep
 * what it found: clear, needs review, or failed, and when the certificate of insurance lapses. It is a reading kept on the driver, never a rule: it does not stop an assignment.
 */
export const VET_LABEL: Record<string, string> = { unchecked: "Not checked", clear: "Insurance clear", review: "Needs review", failed: "Failed the check" };
export const vetLabel = (s: string) => VET_LABEL[s] ?? s;

export type VetResult = { ok: true; provider: string; status: string; coiExpiresAt: Date | null } | { ok: false; error: string; code?: string };

const digits = (v: string | null) => (v ?? "").replace(/\D/g, "") || null;

export async function vetDriverCarrier(driverId: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<VetResult> {
  const d = await prisma.driver.findFirst({ where: { id: driverId, workspaceId } });
  if (!d) return { ok: false, error: "That driver does not exist." };
  const mc = digits(d.carrierMcNumber);
  const dot = digits(d.carrierDotNumber);
  if (!mc && !dot) return { ok: false, error: "Add the carrier's MC or DOT number first." };
  const { provider, result } = await callPartner("vetting", null, { mcNumber: mc, dotNumber: dot }, workspaceId);
  if (!result.ok) return { ok: false, error: result.message ?? "The check could not be made.", code: result.code };
  const coi = result.data.coiExpiresAt ? new Date(result.data.coiExpiresAt) : null;
  const coiValid = coi && !Number.isNaN(coi.getTime()) ? coi : null;
  await prisma.$transaction(async (tx) => {
    await tx.driver.update({ where: { id: driverId }, data: { vetStatus: result.data.status, coiExpiresAt: coiValid, vetCheckedAt: now } });
    await recordAudit(
      { entity: "fleet", action: "carrier_vetted", summary: `${d.name}: carrier checked with ${providerName(provider)}, ${vetLabel(result.data.status).toLowerCase()}${coiValid ? `, insurance good through ${coiValid.toISOString().slice(0, 10)}` : ""}`, before: { Check: vetLabel(d.vetStatus) }, after: { Check: vetLabel(result.data.status), "Insurance good through": coiValid ? coiValid.toISOString().slice(0, 10) : null }, at: now, workspaceId },
      tx
    );
  });
  return { ok: true, provider, status: result.data.status, coiExpiresAt: coiValid };
}
