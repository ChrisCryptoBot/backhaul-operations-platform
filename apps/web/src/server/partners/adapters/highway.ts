import { err, ok } from "@/truelane/partners/contract";
import type { AdapterShapes } from "../call";
import { notImplemented } from "../not-implemented";
import { NotLive, type Adapter, type ProviderAdapter } from "./types";

/**
 * Carrier vetting, modeled after Highway (Carrier411 is the same kind of thing): look a carrier up by MC or DOT and get its authority status, a safety score, its insurance certificates and any
 * alerts. As with the other adapters, the shapes are what the desk ASSUMES, not the company's documentation. The desk's rule for what the answer means is the normalizer below.
 */
export type HighwayCarrier = {
  carrier: {
    legal_name: string;
    authority_status: "ACTIVE" | "INACTIVE" | "REVOKED";
    /** 0 to 100, higher is safer. */
    safety_score: number | null;
    insurance: Array<{ kind: "AUTO_LIABILITY" | "CARGO"; coverage: number; expires_on: string }>;
    alerts: string[];
  };
};

export interface HighwayClient {
  carrier(q: { mc: string | null; dot: string | null }): Promise<HighwayCarrier>;
}

type In = AdapterShapes["vetting"]["in"];
type Out = AdapterShapes["vetting"]["out"];

export const liveHighwayClient: HighwayClient = {
  async carrier() {
    throw new NotLive();
  }
};

/** The coverage a broker or a customer usually asks of a carrier: a million on the truck, a hundred thousand on the freight. */
export const MIN_LIABILITY = 1_000_000;
export const MIN_CARGO = 100_000;
/** A certificate that lapses within this many days is a reason to look, not yet a failure. */
export const COI_WARN_DAYS = 30;
/** Below this safety score a carrier is a reason to look. */
export const MIN_SAFETY_SCORE = 60;

const day = (iso: string) => Date.parse(`${iso.slice(0, 10)}T23:59:59Z`);

/**
 * The company's answer into the desk's three words. **failed**: the authority is not active, or there is no liability certificate, or one has lapsed. **review**: anything a person should look
 * at (an alert, a safety score under 60, a certificate lapsing within 30 days, coverage under the usual minimum, no cargo certificate). **clear**: none of that. The insurance date the desk keeps
 * is the earlier of the certificates it knows, because the first to lapse is the one that matters.
 */
export function normalizeHighway(answer: HighwayCarrier, now: Date): Out {
  const c = answer.carrier;
  const liability = c.insurance.find((i) => i.kind === "AUTO_LIABILITY");
  const cargo = c.insurance.find((i) => i.kind === "CARGO");
  const dates = c.insurance.map((i) => day(i.expires_on)).filter((t) => Number.isFinite(t));
  const earliest = dates.length > 0 ? Math.min(...dates) : null;
  const flags: string[] = [...c.alerts];
  const lapsed = (i: { expires_on: string } | undefined) => i != null && day(i.expires_on) < now.getTime();
  const soon = (i: { expires_on: string } | undefined) => i != null && !lapsed(i) && day(i.expires_on) - now.getTime() <= COI_WARN_DAYS * 86_400_000;

  let status: Out["status"] = "clear";
  if (c.authority_status !== "ACTIVE") {
    status = "failed";
    flags.push("Operating authority is not active.");
  }
  if (!liability) {
    status = "failed";
    flags.push("No liability certificate on file.");
  } else if (lapsed(liability)) {
    status = "failed";
    flags.push("The liability certificate has lapsed.");
  }
  if (status !== "failed") {
    if (soon(liability) || soon(cargo)) flags.push(`A certificate lapses within ${COI_WARN_DAYS} days.`);
    if (liability && liability.coverage < MIN_LIABILITY) flags.push("Liability coverage is under $1,000,000.");
    if (!cargo) flags.push("No cargo certificate on file.");
    else if (lapsed(cargo)) flags.push("The cargo certificate has lapsed.");
    else if (cargo.coverage < MIN_CARGO) flags.push("Cargo coverage is under $100,000.");
    if (c.safety_score != null && c.safety_score < MIN_SAFETY_SCORE) flags.push(`Safety score ${c.safety_score} is under ${MIN_SAFETY_SCORE}.`);
    if (flags.length > 0) status = "review";
  }
  return { status, coiExpiresAt: earliest == null ? null : new Date(earliest).toISOString().slice(0, 10), safetyScore: c.safety_score, authorityActive: c.authority_status === "ACTIVE", liabilityCoverage: liability?.coverage ?? null, cargoCoverage: cargo?.coverage ?? null, flags };
}

// ── The simulator ────────────────────────────────────────────────────────────────────────────

/**
 * A simulated carrier, chosen by the LAST DIGIT of the MC number (else the DOT number), so a demo can show every outcome on purpose:
 *   0  authority inactive (failed)      1  liability certificate lapses in 12 days (review)      2  safety score 48 (review)
 *   3  cargo coverage $50,000 (review)  4  lapsed liability certificate (failed)                  any other digit  clear: authority active, score 82 to 96, certificates good for months.
 */
export function sandboxHighwayCarrier(q: { mc: string | null; dot: string | null }, now: Date): HighwayCarrier {
  const key = (q.mc ?? q.dot ?? "0").replace(/\D/g, "");
  const digit = key === "" ? 0 : parseInt(key.slice(-1), 10);
  const iso = (days: number) => new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
  const base = { legal_name: `Sandbox Carrier ${key || "0"} LLC`, authority_status: "ACTIVE" as const, safety_score: 82 + (parseInt(key.slice(-2) || "0", 10) % 15), alerts: [] as string[] };
  const insurance = (liab: string, cargo: string | null, cargoCoverage = 100_000) => [{ kind: "AUTO_LIABILITY" as const, coverage: 1_000_000, expires_on: liab }, ...(cargo ? [{ kind: "CARGO" as const, coverage: cargoCoverage, expires_on: cargo }] : [])];
  switch (digit) {
    case 0:
      return { carrier: { ...base, authority_status: "INACTIVE", alerts: ["Authority out of service."], insurance: insurance(iso(200), iso(200)) } };
    case 1:
      return { carrier: { ...base, insurance: insurance(iso(12), iso(200)) } };
    case 2:
      return { carrier: { ...base, safety_score: 48, insurance: insurance(iso(200), iso(200)) } };
    case 3:
      return { carrier: { ...base, insurance: insurance(iso(200), iso(200), 50_000) } };
    case 4:
      return { carrier: { ...base, insurance: insurance(iso(-9), iso(200)) } };
    default:
      return { carrier: { ...base, insurance: insurance(iso(180 + digit * 10), iso(180 + digit * 10)) } };
  }
}

export const sandboxHighwayClient = (now: Date = new Date()): HighwayClient => ({
  async carrier(q) {
    return sandboxHighwayCarrier(q, now);
  }
});

// ── The adapter ──────────────────────────────────────────────────────────────────────────────

async function run(client: HighwayClient, provider: string, input: In) {
  try {
    return ok(normalizeHighway(await client.carrier({ mc: input.mcNumber, dot: input.dotNumber }), new Date()));
  } catch (e) {
    return e instanceof NotLive ? notImplemented(provider) : err("upstream_error", "Highway did not answer.");
  }
}

const live: Adapter<In, Out> = ({ provider, input }) => run(liveHighwayClient, provider, input);
const sandbox: Adapter<In, Out> = ({ provider, input }) => run(sandboxHighwayClient(), provider, input);

export const highwayAdapter: ProviderAdapter<In, Out> = { live, sandbox };
