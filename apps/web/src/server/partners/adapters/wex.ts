import { Prisma } from "@prisma/client";
import { err, ok } from "@/truelane/partners/contract";
import type { AdapterShapes } from "../call";
import { notImplemented } from "../not-implemented";
import { SANDBOX_HUBS } from "./motive";
import { seedOf } from "./sandbox";
import { NotLive, type Adapter, type ProviderAdapter } from "./types";

/**
 * Fuel cards, modeled after WEX (Comdata is the same shape of thing): a card account's purchases, each with the merchant, the gallons, the posted price, the card's discount a gallon and what
 * was actually charged. As with the other adapters, the field names are what the desk ASSUMES such an API uses, not taken from the company's documentation; when keys and docs arrive,
 * check `WexTransactions`, the live client's one method and nothing else.
 */
export type WexTransactions = {
  transactions: Array<{
    transaction_id: string;
    /** ISO timestamp the purchase posted. */
    posted_at: string;
    /** The card account and the unit the card is assigned to. */
    account: string;
    unit: string;
    merchant: { name: string; city: string; state: string };
    product: "DIESEL" | "REEFER_DIESEL" | "DEF";
    gallons: number;
    price_per_gallon: number;
    discount_per_gallon: number;
    /** What the card was charged, after the discount. */
    total: number;
  }>;
};

export interface WexClient {
  transactions(q: { account: string; from: string | null; to: string | null }): Promise<WexTransactions>;
}

type In = AdapterShapes["fuel_card"]["in"];
type Out = AdapterShapes["fuel_card"]["out"];

export const liveWexClient: WexClient = {
  async transactions() {
    throw new NotLive();
  }
};

const d2 = (n: number) => new Prisma.Decimal(n).toDecimalPlaces(2).toNumber();

/**
 * The company's purchases into the desk's. Only this unit's, only the days asked for. Diesel and reefer diesel count as fuel and have gallons; DEF (exhaust fluid) is money spent at the
 * pump but not fuel, so it adds to the charge and not to the gallons. The amount is what the card was charged: the discount is already taken off.
 */
export function normalizeWex(input: In, tx: WexTransactions): Out {
  const unit = (input.vehicleName ?? "").trim().toLowerCase();
  const rows = tx.transactions.filter((t) => t.account === input.accountId && (unit === "" || t.unit.trim().toLowerCase() === unit));
  return {
    purchases: rows
      .filter((t) => (!input.since || t.posted_at.slice(0, 10) >= input.since) && (!input.until || t.posted_at.slice(0, 10) <= input.until))
      .map((t) => ({
        id: t.transaction_id,
        on: t.posted_at.slice(0, 10),
        gallons: t.product === "DEF" ? null : t.gallons,
        amount: d2(t.total),
        location: `${t.merchant.name}, ${t.merchant.city}, ${t.merchant.state}`,
        pricePerGallon: t.price_per_gallon,
        discountPerGallon: t.discount_per_gallon,
        discount: d2(new Prisma.Decimal(t.discount_per_gallon).times(t.gallons).toNumber())
      }))
  };
}

// ── The simulator ────────────────────────────────────────────────────────────────────────────

const MERCHANTS = ["Love's Travel Stop", "Pilot Flying J", "TA Travel Center", "Petro Stopping Center", "Casey's", "Buc-ee's"];

/**
 * A simulated card account: a purchase about every day and a half for the unit over the days asked for (the last week when none are), at hubs along real freight lanes, 70 to 140 gallons at a
 * posted price near the diesel average with the card's discount, and now and then a DEF fill. The same unit and the same day always give the same purchases.
 */
export function sandboxWexTransactions(input: In, now: Date): WexTransactions {
  const day = 86_400_000;
  const end = input.until ? Date.parse(`${input.until}T23:59:59Z`) : now.getTime();
  const start = input.since ? Date.parse(`${input.since}T00:00:00Z`) : end - 7 * day;
  const unit = input.vehicleName ?? "Unit";
  const out: WexTransactions["transactions"] = [];
  const first = start - (start % day);
  for (let t = first; t <= end; t += day) {
    const seed = seedOf(`${input.accountId}:${unit}:${t}`);
    if (seed % 3 === 0) continue; // not every day has a fill
    const hub = SANDBOX_HUBS[seed % SANDBOX_HUBS.length]!;
    const gallons = 70 + (seedOf(`g:${seed}`) % 71);
    const price = d2(3.55 + (seedOf(`p:${seed}`) % 71) / 100);
    const discount = d2(0.1 + (seedOf(`d:${seed}`) % 36) / 100);
    const postedAt = new Date(t + (6 + (seed % 14)) * 3_600_000);
    if (postedAt.getTime() > end) continue;
    const [city = "", state = ""] = hub.city.split(", ");
    out.push({
      transaction_id: `wex-sbx-${seed.toString(16)}`,
      posted_at: postedAt.toISOString(),
      account: input.accountId,
      unit,
      merchant: { name: MERCHANTS[seed % MERCHANTS.length]!, city, state },
      product: "DIESEL",
      gallons,
      price_per_gallon: price,
      discount_per_gallon: discount,
      total: d2(new Prisma.Decimal(price).minus(discount).times(gallons).toNumber())
    });
    if (seed % 7 === 0) out.push({ transaction_id: `wex-sbx-def-${seed.toString(16)}`, posted_at: postedAt.toISOString(), account: input.accountId, unit, merchant: { name: MERCHANTS[seed % MERCHANTS.length]!, city, state }, product: "DEF", gallons: 4, price_per_gallon: 4.2, discount_per_gallon: 0, total: 16.8 });
  }
  return { transactions: out };
}

/** The simulator as a client: the company's one call, answered for the unit the desk is asking about (a real account holds every unit's cards; the normalizer picks this one's). */
export const sandboxWexClient = (unit: string | null, now: Date = new Date()): WexClient => ({
  async transactions(q) {
    return sandboxWexTransactions({ vehicleName: unit, accountId: q.account, since: q.from, until: q.to }, now);
  }
});

// ── The adapter ──────────────────────────────────────────────────────────────────────────────

async function run(client: WexClient, provider: string, input: In) {
  try {
    const tx = await client.transactions({ account: input.accountId, from: input.since, to: input.until });
    return ok(normalizeWex(input, tx));
  } catch (e) {
    return e instanceof NotLive ? notImplemented(provider) : err("upstream_error", "WEX did not answer.");
  }
}

const live: Adapter<In, Out> = ({ provider, input }) => run(liveWexClient, provider, input);
const sandbox: Adapter<In, Out> = ({ provider, input }) => run(sandboxWexClient(input.vehicleName, new Date()), provider, input);

export const wexAdapter: ProviderAdapter<In, Out> = { live, sandbox };
