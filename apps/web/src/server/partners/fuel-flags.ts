import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { FLAG_LABEL, fuelFlags, isFlagCode, type Flag, type FlagCode } from "@/lib/fuel-exceptions";
import { recordAudit } from "@/server/tl/audit";
import { numOrNull, num } from "@/server/tl/convert";
import { currentActor } from "@/server/tl/identity";
import { currentWorkspaceId } from "@/server/tl/workspace";

/**
 * Fuel exception flags, read from the database (lib/fuel-exceptions.ts says what a flag is). A purchase's flags are worked out against the whole fleet's purchases of at least the last
 * FLAG_CONTEXT_DAYS, never against what one screen happens to show: the same purchase has the same flags in every period and every terminal view. The screen then filters rows and counts to
 * its own period and terminals. A person clears a flag with a reason (one FuelFlagReview per purchase and flag code), and can reopen it; both are audited.
 */
export const FLAG_CONTEXT_DAYS = 120;
/** The most purchases one flag reading takes in (the newest ones); a fleet with more in the period is told the flags are of the newest. */
export const FLAG_MAX_ROWS = 20_000;
const DAY = 86_400_000;

export type ClearedFlag = Flag & { note: string; by: string; at: Date };
export type PurchaseFlags = { open: Flag[]; cleared: ClearedFlag[] };
export type FlagReading = { byId: Map<string, PurchaseFlags>; tankUnknownIds: Set<string>; partial: boolean };

/** The day a flag reading starts: the period's first day, or FLAG_CONTEXT_DAYS back, whichever is earlier. */
export const flagContextStart = (viewStart: Date, now: Date): Date => new Date(Math.min(viewStart.getTime(), now.getTime() - FLAG_CONTEXT_DAYS * DAY));

/** Every purchase's flags from `from` on, for the whole fleet, with what a person has cleared. */
export async function readFlags(from: Date, workspaceId = currentWorkspaceId()): Promise<FlagReading> {
  const rows = await prisma.fuelTransaction.findMany({
    where: { workspaceId, postedAt: { gte: from } },
    select: { id: true, vehicleId: true, product: true, status: true, gallons: true, amount: true, pricePerGallon: true, discountPerGallon: true, discount: true, purchasedAt: true, postedAt: true, purchaseState: true, vehicle: { select: { tankCapacityGallons: true } }, flagReviews: { select: { code: true, note: true, reviewedBy: true, reviewedAt: true } } },
    orderBy: [{ postedAt: "desc" }, { id: "asc" }],
    take: FLAG_MAX_ROWS + 1
  });
  const partial = rows.length > FLAG_MAX_ROWS;
  const kept = rows.slice(0, FLAG_MAX_ROWS);
  const { flags } = fuelFlags(
    kept.map((r) => ({
      id: r.id,
      vehicleId: r.vehicleId,
      tankGallons: numOrNull(r.vehicle?.tankCapacityGallons ?? null),
      product: r.product,
      status: r.status,
      gallons: numOrNull(r.gallons),
      amount: num(r.amount),
      pricePerGallon: numOrNull(r.pricePerGallon),
      discountPerGallon: numOrNull(r.discountPerGallon),
      discount: numOrNull(r.discount),
      at: r.purchasedAt?.getTime() ?? null,
      day: r.postedAt.toISOString().slice(0, 10),
      state: r.purchaseState
    }))
  );
  const byId = new Map<string, PurchaseFlags>();
  const tankUnknownIds = new Set<string>();
  for (const r of kept) {
    if (r.product === "road_diesel" && r.vehicleId && r.gallons != null && r.vehicle?.tankCapacityGallons == null && r.status !== "declined" && r.status !== "void") tankUnknownIds.add(r.id);
    const all = flags.get(r.id) ?? [];
    if (all.length === 0) continue;
    const reviewed = new Map(r.flagReviews.map((v) => [v.code, v]));
    const open: Flag[] = [];
    const cleared: ClearedFlag[] = [];
    for (const f of all) {
      const v = reviewed.get(f.code);
      if (v) cleared.push({ ...f, note: v.note, by: v.reviewedBy, at: v.reviewedAt });
      else open.push(f);
    }
    byId.set(r.id, { open, cleared });
  }
  return { byId, tankUnknownIds, partial };
}

export type FlagCounts = { open: number; purchases: number; byCode: Partial<Record<FlagCode, number>>; cleared: number; tankUnknown: number; partial: boolean };

/** The counts for the purchases in view (`ids`: the period and terminals on screen). */
export function countFlags(reading: FlagReading, ids: Iterable<string>): FlagCounts {
  const out: FlagCounts = { open: 0, purchases: 0, byCode: {}, cleared: 0, tankUnknown: 0, partial: reading.partial };
  for (const id of ids) {
    if (reading.tankUnknownIds.has(id)) out.tankUnknown += 1;
    const f = reading.byId.get(id);
    if (!f) continue;
    if (f.open.length > 0) out.purchases += 1;
    out.open += f.open.length;
    out.cleared += f.cleared.length;
    for (const x of f.open) out.byCode[x.code] = (out.byCode[x.code] ?? 0) + 1;
  }
  return out;
}

export type FlagReviewResult = { ok: true } | { ok: false; error: string };

const NOTE_MAX = 300;

/** The purchase's flags as they stand now (read in the same context the Fuel screen uses for it). */
async function flagsOf(id: string, workspaceId: string, now: Date) {
  const p = await prisma.fuelTransaction.findFirst({ where: { id, workspaceId }, select: { id: true, postedAt: true, location: true, vehicle: { select: { name: true } }, amount: true } });
  if (!p) return null;
  const reading = await readFlags(flagContextStart(new Date(p.postedAt.getTime() - DAY), now), workspaceId);
  return { purchase: p, flags: reading.byId.get(id) ?? { open: [], cleared: [] } };
}

const what = (p: { postedAt: Date; location: string | null; vehicle: { name: string | null } | null; amount: Prisma.Decimal }) => `${p.vehicle?.name ?? "Fuel"} ${p.postedAt.toISOString().slice(0, 10)}${p.location ? `, ${p.location}` : ""} ($${num(p.amount).toFixed(2)})`;

/** Clear one open flag on one purchase, with why. Only that flag: any other flag on the purchase stays open. */
export async function clearFuelFlag(id: string, code: string, note: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<FlagReviewResult> {
  if (!isFlagCode(code)) return { ok: false, error: "That is not a fuel flag." };
  const why = note.trim().replace(/\s+/g, " ");
  if (why.length < 3) return { ok: false, error: "Say why it is all right (a few words)." };
  if (why.length > NOTE_MAX) return { ok: false, error: `Keep the reason under ${NOTE_MAX} characters.` };
  const got = await flagsOf(id, workspaceId, now);
  if (!got) return { ok: false, error: "That purchase is not on this desk." };
  const flag = got.flags.open.find((f) => f.code === code);
  if (!flag) return { ok: false, error: got.flags.cleared.some((f) => f.code === code) ? "That flag is already cleared." : "That purchase does not have that flag now." };
  const by = currentActor();
  try {
    await prisma.$transaction(async (tx) => {
      await tx.fuelFlagReview.create({ data: { workspaceId, fuelTransactionId: id, code, note: why, reviewedBy: by, reviewedAt: now } });
      await recordAudit({ entity: "fleet", entityId: id, action: "fuel_flag_cleared", summary: `Fuel flag "${FLAG_LABEL[code]}" cleared on ${what(got.purchase)}`, reason: why, before: { Flag: FLAG_LABEL[code], Detail: flag.detail }, after: { Flag: `${FLAG_LABEL[code]} (cleared)`, Why: why }, at: now, workspaceId }, tx);
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, error: "That flag is already cleared." };
    throw e;
  }
  return { ok: true };
}

/** Undo a clearance: the flag is open again if it still applies. */
export async function reopenFuelFlag(id: string, code: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<FlagReviewResult> {
  if (!isFlagCode(code)) return { ok: false, error: "That is not a fuel flag." };
  const review = await prisma.fuelFlagReview.findFirst({ where: { workspaceId, fuelTransactionId: id, code }, include: { fuelTransaction: { select: { postedAt: true, location: true, amount: true, vehicle: { select: { name: true } } } } } });
  if (!review) return { ok: false, error: "That flag is not cleared." };
  await prisma.$transaction(async (tx) => {
    const gone = await tx.fuelFlagReview.deleteMany({ where: { id: review.id } });
    if (gone.count === 0) return;
    await recordAudit({ entity: "fleet", entityId: id, action: "fuel_flag_reopened", summary: `Fuel flag "${FLAG_LABEL[code]}" reopened on ${what(review.fuelTransaction)}`, before: { Flag: `${FLAG_LABEL[code]} (cleared)`, Why: review.note }, after: { Flag: FLAG_LABEL[code] }, at: now, workspaceId }, tx);
  });
  return { ok: true };
}

