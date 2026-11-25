import { prisma } from "@/lib/db";
import { isPayArrangement, isPayMilesBasis, PAY_ARRANGEMENT_LABEL, PAY_MILES_BASIS_LABEL, type PayArrangement, type PayMilesBasis } from "@/lib/pay-arrangement";
import { recordAudit } from "./audit";
import { currentWorkspaceId } from "./workspace";

export type PaySettingsResult = { ok: true; changed: boolean } | { ok: false; error: string };

/**
 * Configure workspace defaults for how drivers are paid: default arrangement (company vs contractor)
 * and which miles per-mile pay reads (logged/ELD miles vs billable loaded miles).
 */
export async function setWorkspacePaySettings(
  input: { defaultPayArrangement?: unknown; payMilesBasis?: unknown },
  now = new Date(),
  workspaceId = currentWorkspaceId()
): Promise<PaySettingsResult> {
  const prev = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { defaultPayArrangement: true, payMilesBasis: true } });
  if (!prev) return { ok: false, error: "That fleet does not exist." };
  const nextArrangement: PayArrangement = input.defaultPayArrangement === undefined ? (prev.defaultPayArrangement === "contractor" ? "contractor" : "company") : isPayArrangement(input.defaultPayArrangement) ? input.defaultPayArrangement : (null as never);
  if (!nextArrangement) return { ok: false, error: "Pick company driver or independent contractor." };
  const nextBasis: PayMilesBasis = input.payMilesBasis === undefined ? (prev.payMilesBasis === "billable" ? "billable" : "logged") : isPayMilesBasis(input.payMilesBasis) ? input.payMilesBasis : (null as never);
  if (!nextBasis) return { ok: false, error: "Pick logged miles or billable miles." };
  if (prev.defaultPayArrangement === nextArrangement && prev.payMilesBasis === nextBasis) return { ok: true, changed: false };
  await prisma.$transaction(async (tx) => {
    await tx.workspace.update({ where: { id: workspaceId }, data: { defaultPayArrangement: nextArrangement, payMilesBasis: nextBasis } });
    await recordAudit(
      {
        entity: "settings",
        action: "pay_settings_changed",
        summary: `Driver pay defaults set: ${PAY_ARRANGEMENT_LABEL[nextArrangement]}, ${PAY_MILES_BASIS_LABEL[nextBasis]}`,
        before: {
          "Default arrangement": PAY_ARRANGEMENT_LABEL[prev.defaultPayArrangement === "contractor" ? "contractor" : "company"],
          "Per-mile pay basis": PAY_MILES_BASIS_LABEL[prev.payMilesBasis === "billable" ? "billable" : "logged"]
        },
        after: {
          "Default arrangement": PAY_ARRANGEMENT_LABEL[nextArrangement],
          "Per-mile pay basis": PAY_MILES_BASIS_LABEL[nextBasis]
        },
        at: now,
        workspaceId
      },
      tx
    );
  });
  return { ok: true, changed: true };
}
