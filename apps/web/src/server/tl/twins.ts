import { prisma } from "@/lib/db";
import { notQuote } from "@/lib/quote-status";

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/**
 * Another load on the desk with this load number or rate-confirmation number from the same customer, or null.
 * When both loads carry a `customerId`, match by `customerId` even if the text spelling differs; otherwise fall back to case-insensitive `brokerName`.
 */
type Db = Pick<typeof prisma, "load">;

export async function findTwinLoad(
  workspaceId: string,
  number: string | null | undefined,
  broker: string | null | undefined,
  exceptId?: string,
  db: Db = prisma,
  customerId?: string | null,
  rateConNumber?: string | null
): Promise<{ id: string; brokerName: string | null; customerId: string | null; loadNumber: string | null; rateConNumber: string | null } | null> {
  const n = (number ?? "").trim();
  const rc = (rateConNumber ?? "").trim();
  const candidates = [...new Set([n, rc].filter(Boolean))];
  if (candidates.length === 0) return null;
  const orConds = candidates.flatMap((val) => [
    { loadNumber: { equals: val, mode: "insensitive" as const } },
    { rateConNumber: { equals: val, mode: "insensitive" as const } }
  ]);
  const twins = await db.load.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      ...notQuote,
      OR: orConds,
      ...(exceptId ? { id: { not: exceptId } } : {})
    },
    select: { id: true, brokerName: true, customerId: true, loadNumber: true, rateConNumber: true }
  });
  return (
    twins.find((t) => {
      if (customerId && t.customerId) return t.customerId === customerId;
      return !t.brokerName || !broker || same(t.brokerName, broker);
    }) ?? null
  );
}

export const duplicateMessage = (twin: { brokerName: string | null; loadNumber: string | null; rateConNumber?: string | null }) =>
  `Load ${twin.loadNumber ?? twin.rateConNumber ?? ""}${twin.brokerName ? ` from ${twin.brokerName}` : ""} is already on the desk.`;
