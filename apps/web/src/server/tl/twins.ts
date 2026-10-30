import { prisma } from "@/lib/db";
import { notQuote } from "@/lib/quote-status";

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/**
 * Another load on the desk with this load number from the same customer, or null. The same number from a customer that is not named is still the same number: only two different
 * named customers are two different loads. A saved quote and a deleted load are not loads. Used wherever a load number is typed (a rate confirmation, booking a quote, editing a load).
 */
export async function findTwinLoad(workspaceId: string, number: string | null | undefined, broker: string | null | undefined, exceptId?: string): Promise<{ id: string; brokerName: string | null; loadNumber: string | null } | null> {
  const n = (number ?? "").trim();
  if (n === "") return null;
  const twins = await prisma.load.findMany({ where: { workspaceId, deletedAt: null, ...notQuote, loadNumber: { equals: n, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true, brokerName: true, loadNumber: true } });
  return twins.find((t) => !t.brokerName || !broker || same(t.brokerName, broker)) ?? null;
}

export const duplicateMessage = (twin: { brokerName: string | null; loadNumber: string | null }) => `Load ${twin.loadNumber ?? ""}${twin.brokerName ? ` from ${twin.brokerName}` : ""} is already on the desk.`;
