import { prisma } from "@/lib/db";
import { earliestUnfrozenTrackSince } from "@/server/tl/detention-evidence";
import { FIXABLE_DETAILS } from "./webhook";

/**
 * Webhook events are kept so that a company that sends the same event twice is heard once. That only has to hold for as long as a company could reasonably retry, so rows older than this are
 * removed. (A delivery that late would be judged again, and a status change is still only ever applied as one allowed step from where the invoice is, so a replay cannot move it backwards.)
 * The body is kept only while it may be needed again (server/partners/webhook.ts), and an open issue is never removed by age.
 */
export const EVENT_KEEP_DAYS = 90;

/** Position fixes are kept a week: long enough for a load's breadcrumb and a few days of idle time, short enough that a fleet of thousands does not pile up rows. */
export const PING_KEEP_DAYS = 7;

export async function purgeOldPings(now = new Date(), earliestProtected?: Date | null): Promise<number> {
  const weekAgo = new Date(now.getTime() - PING_KEEP_DAYS * 86_400_000);
  const protectedUntil = earliestProtected !== undefined ? earliestProtected : await earliestUnfrozenTrackSince(now);
  const cutoff = protectedUntil && protectedUntil < weekAgo ? protectedUntil : weekAgo;
  return (await prisma.vehiclePing.deleteMany({ where: { at: { lt: cutoff } } })).count;
}

/**
 * A tractor's stays (where it stood and for how long) are kept thirteen months: a full year back and a month of room, enough to settle a dispute or compare a season. Only closed stays go; one still
 * open is the tractor's current stay. Check calls and trailer hooks are business records and are not purged here.
 */
export const STAY_KEEP_DAYS = 400;

export async function purgeOldStays(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STAY_KEEP_DAYS * 86_400_000);
  return (await prisma.unitStay.deleteMany({ where: { leftAt: { not: null, lt: cutoff } } })).count;
}

/**
 * Webhook events past the keeping period. An open issue is never removed by age (Wave 7 step 4, D6): one that failed (its body kept), one stuck part way, or one not used for a reason a
 * person can fix stays until someone settles it on Partner issues, and then 90 more days. Everything else goes 90 days after it arrived.
 */
export async function purgeOldEvents(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - EVENT_KEEP_DAYS * 86_400_000);
  return (
    await prisma.partnerEvent.deleteMany({
      where: {
        OR: [
          { resolvedAt: { lt: cutoff } },
          { resolvedAt: null, receivedAt: { lt: cutoff }, outcome: "applied" },
          // ignored, unless for a reason a person can fix (an open issue)
          { resolvedAt: null, receivedAt: { lt: cutoff }, outcome: "ignored", OR: [{ detail: null }, { detail: { notIn: [...FIXABLE_DETAILS] } }, { eventId: { contains: ":poll:" } }] }
        ]
      }
    })
  ).count;
}

/** Outbound webhook deliveries: a sent one 90 days after it went, a settled one 90 days after it was settled. One that failed or gave up and is not settled stays on Partner issues. */
export async function purgeOldDeliveries(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - EVENT_KEEP_DAYS * 86_400_000);
  return (await prisma.webhookDelivery.deleteMany({ where: { OR: [{ status: "sent", sentAt: { lt: cutoff } }, { resolvedAt: { lt: cutoff } }] } })).count;
}
