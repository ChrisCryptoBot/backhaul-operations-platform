import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PROVIDERS } from "@/truelane/partners/contract";
import { recordAudit } from "@/server/tl/audit";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { callPartner, providerName } from "./call";

/**
 * Fuel cards: a truck is told which card it buys fuel on, and a trip's fuel can be filled in from that card's purchases while the trip was running. The import only READS: it
 * hands the screen a total to put in the fuel box when the dispatcher clicks, and the screen never overwrites a number that was typed.
 */
export type FuelCardResult = { ok: true; provider: string; amount: number; gallons: number | null; purchases: number } | { ok: false; error: string; code?: string };

const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export async function importFuelForLoad(loadId: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<FuelCardResult> {
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null }, include: { stops: true, vehicle: { include: { costProfile: true } } } });
  if (!load) return { ok: false, error: "That load does not exist." };
  const profile = load.vehicle?.costProfile;
  if (!load.vehicle || !profile?.fuelCardAccountId) return { ok: false, error: "This truck has no fuel card set. Add it on the truck's page." };
  const starts = load.stops.map((s) => s.timeWindowEarliest ?? s.timeWindowLatest).filter((d): d is Date => d != null);
  const ends = load.stops.map((s) => s.timeWindowLatest ?? s.timeWindowEarliest).filter((d): d is Date => d != null);
  const since = starts.length > 0 ? new Date(Math.min(...starts.map((d) => d.getTime())) - 86_400_000) : null;
  const until = ends.length > 0 ? new Date(Math.max(...ends.map((d) => d.getTime())) + 2 * 86_400_000) : null;
  const { provider, result } = await callPartner("fuel_card", profile.fuelCardProvider, { vehicleName: load.vehicle.name, accountId: profile.fuelCardAccountId, since: dayOf(since), until: dayOf(until) }, workspaceId);
  if (!result.ok) return { ok: false, error: result.message ?? "The fuel card could not be reached.", code: result.code };
  const inWindow = result.data.purchases.filter((p) => (!since || p.on >= dayOf(since)!) && (!until || p.on <= dayOf(until)!));
  const amount = inWindow.reduce((s, p) => s.plus(p.amount), new Prisma.Decimal(0)).toDecimalPlaces(2).toNumber();
  const gallons = inWindow.some((p) => p.gallons != null) ? inWindow.reduce((s, p) => s.plus(p.gallons ?? 0), new Prisma.Decimal(0)).toDecimalPlaces(2).toNumber() : null;
  await recordAudit({ entity: "load", action: "fuel_imported", loadId, loadNumber: load.loadNumber, summary: `${inWindow.length} fuel ${inWindow.length === 1 ? "purchase" : "purchases"} ($${amount.toFixed(2)}) read from ${providerName(provider)} for ${load.vehicle.name ?? "the truck"}`, before: null, after: { Purchases: String(inWindow.length), Fuel: `$${amount.toFixed(2)}` }, at: now, workspaceId });
  return { ok: true, provider, amount, gallons, purchases: inWindow.length };
}

export type SaveFuelCard = { ok: true; changed: boolean } | { ok: false; error: string };

/** Which card and account a truck buys fuel on. Blank both to clear it. */
export async function saveFuelCard(vehicleId: string, provider: string, accountId: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<SaveFuelCard> {
  const p = provider.trim();
  const a = accountId.trim();
  if (p && !PROVIDERS.fuel_card.includes(p)) return { ok: false, error: "Pick a card from the list." };
  if (a.length > 60) return { ok: false, error: "That account is too long." };
  if (p && !a) return { ok: false, error: "Type the account on the card." };
  if (!p && a) return { ok: false, error: "Pick the card the account is on." };
  const truck = await prisma.vehicle.findFirst({ where: { id: vehicleId, workspaceId }, include: { costProfile: true } });
  if (!truck) return { ok: false, error: "That truck does not exist." };
  if (!truck.costProfile) return { ok: false, error: "Give the truck a cost profile first." };
  const before = { Card: truck.costProfile.fuelCardProvider ? providerName(truck.costProfile.fuelCardProvider) : null, Account: truck.costProfile.fuelCardAccountId };
  const after = { Card: p ? providerName(p) : null, Account: a || null };
  if (before.Card === after.Card && before.Account === after.Account) return { ok: true, changed: false };
  await prisma.$transaction(async (tx) => {
    await tx.costProfile.update({ where: { vehicleId }, data: { fuelCardProvider: p || null, fuelCardAccountId: a || null } });
    await recordAudit({ entity: "fleet", action: "cost_profile_changed", summary: `${truck.name}: fuel card ${p ? `set to ${providerName(p)}` : "cleared"}`, before, after, at: now, workspaceId }, tx);
  });
  return { ok: true, changed: true };
}
