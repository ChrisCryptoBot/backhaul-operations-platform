import { prisma } from "@/lib/db";

/**
 * Webhook events are kept so that a company that sends the same event twice is heard once. That only has to hold for as long as a company could reasonably retry, so rows older than this are
 * removed. (A delivery that late would be judged again, and a status change is still only ever applied as one allowed step from where the invoice is, so a replay cannot move it backwards.)
 * Nothing but an id, a kind and the outcome is ever stored, never a body.
 */
export const EVENT_KEEP_DAYS = 90;

export async function purgeOldEvents(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - EVENT_KEEP_DAYS * 86_400_000);
  return (await prisma.partnerEvent.deleteMany({ where: { receivedAt: { lt: cutoff } } })).count;
}
