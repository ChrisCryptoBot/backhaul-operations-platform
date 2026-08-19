import type { DatEquipment, DatRateType } from "@prisma/client";
import { getDatCredentials } from "@/server/dat/settings";

// ── DAT rate provider abstraction ────────────────────────────────────────────
// One narrow interface with two implementations: a live DAT iQ / RateView client
// (OAuth2, to spec) and a deterministic mock. The mock lets the whole negotiation
// tool work end-to-end in dev; the instant a real key is saved in Settings, the
// live client takes over with no other code change.

export interface LaneRateRequest {
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
  equipment: DatEquipment;
  rateType: DatRateType;
}

export interface LaneRateResult {
  ratePerMileLow: number;
  ratePerMileAvg: number;
  ratePerMileHigh: number;
  /** Fuel surcharge per mile, when the provider breaks it out. */
  fuelPerMile: number | null;
  /** Practical road miles from the provider, when returned. */
  mileage: number | null;
  reportCount: number | null;
  timeframe: string | null;
  /** "dat" for live data, "mock" for the deterministic dev stand-in. */
  source: "dat" | "mock";
}

export interface DatRateProvider {
  readonly kind: "dat" | "mock";
  getLaneRate(req: LaneRateRequest): Promise<LaneRateResult>;
}

// ── Live DAT iQ / RateView client ────────────────────────────────────────────
// DAT's rate API is an enterprise entitlement reached with an OAuth2 token minted
// from an organization service account. The exact endpoints are gated behind that
// contract, so this client is written to the documented shape and is only selected
// when a key is present + active. Any auth/transport failure throws, letting the
// orchestrator fall back to the mock in dev.

const DAT_TOKEN_URL =
  process.env.DAT_TOKEN_URL ?? "https://identity.api.dat.com/access/v1/token/organization";
const DAT_USER_TOKEN_URL =
  process.env.DAT_USER_TOKEN_URL ?? "https://identity.api.dat.com/access/v1/token/user";
const DAT_RATEVIEW_URL =
  process.env.DAT_RATEVIEW_URL ?? "https://analytics.api.dat.com/linehaulrates/v1/lookups";

const EQUIPMENT_TO_DAT: Record<DatEquipment, string> = {
  VAN: "VAN",
  REEFER: "REEFER",
  FLATBED: "FLATBED"
};

export interface LiveDatCredentials {
  token?: string | null;
  username?: string | null;
  password?: string | null;
  userEmail?: string | null;
}

class LiveDatProvider implements DatRateProvider {
  readonly kind = "dat" as const;
  constructor(private readonly creds: LiveDatCredentials) {}

  /**
   * Resolve a bearer token. A pre-minted token is used directly; otherwise DAT's
   * documented service-account 2-step OAuth: org token → user token.
   */
  private async getAccessToken(): Promise<string> {
    if (this.creds.token) return this.creds.token;
    const { username, password } = this.creds;
    if (!username || !password) throw new Error("DAT credentials missing");

    const orgRes = await fetch(DAT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    if (!orgRes.ok) throw new Error(`DAT org token failed (${orgRes.status})`);
    const orgData = (await orgRes.json()) as { accessToken?: string; token?: string };
    const orgToken = orgData.accessToken ?? orgData.token;
    if (!orgToken) throw new Error("DAT org token response missing accessToken");

    const userRes = await fetch(DAT_USER_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${orgToken}` },
      body: JSON.stringify({ username: this.creds.userEmail ?? username })
    });
    if (!userRes.ok) throw new Error(`DAT user token failed (${userRes.status})`);
    const userData = (await userRes.json()) as { accessToken?: string; token?: string };
    const userToken = userData.accessToken ?? userData.token;
    if (!userToken) throw new Error("DAT user token response missing accessToken");
    return userToken;
  }

  async getLaneRate(req: LaneRateRequest): Promise<LaneRateResult> {
    const token = await this.getAccessToken();
    // RateView /lookups takes an ARRAY of lookup requests.
    const res = await fetch(DAT_RATEVIEW_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify([
        {
          origin: { city: req.originCity, stateOrProvince: req.originState },
          destination: { city: req.destCity, stateOrProvince: req.destState },
          rateType: req.rateType === "CONTRACT" ? "CONTRACT" : "SPOT",
          equipment: EQUIPMENT_TO_DAT[req.equipment],
          includeMyRate: false
        }
      ])
    });
    if (!res.ok) throw new Error(`DAT RateView lookup failed (${res.status})`);
    return mapDatResponse((await res.json()) as unknown);
  }
}

// Loose shapes to tolerate DAT response variants (array vs object; nested `response`).
interface DatLooseRate {
  perMile?: { low?: number; average?: number; avg?: number; high?: number };
  rateUsdPerMile?: { low?: number; average?: number; avg?: number; high?: number };
  averageUsdPerMile?: number;
  averageFuelSurchargePerMileUsd?: number;
  fuelSurchargePerMile?: number;
  mileage?: number;
  reports?: number;
  companies?: number;
  timeframe?: string;
  escalationType?: string;
}
interface DatLooseNode {
  response?: { rate?: DatLooseRate; mileage?: number };
  rate?: DatLooseRate;
  mileage?: number;
}
interface DatLooseRoot {
  rateResponses?: DatLooseNode[];
  rate?: DatLooseRate;
}

function firstOf<T>(value: T[] | T | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Defensively map DAT's rate response (array/object; nested `response.rate`). */
function mapDatResponse(payload: unknown): LaneRateResult {
  const root = (Array.isArray(payload) ? payload[0] : payload) as DatLooseRoot & DatLooseNode;
  const node = firstOf(root?.rateResponses) ?? root;
  const rate: DatLooseRate = node?.response?.rate ?? node?.rate ?? (root?.rate ?? {});
  const perMile = rate.perMile ?? rate.rateUsdPerMile ?? {};
  const avg = perMile.average ?? perMile.avg ?? rate.averageUsdPerMile;
  if (typeof avg !== "number") throw new Error("DAT response missing per-mile average");
  return {
    ratePerMileLow: perMile.low ?? avg,
    ratePerMileAvg: avg,
    ratePerMileHigh: perMile.high ?? avg,
    fuelPerMile: rate.averageFuelSurchargePerMileUsd ?? rate.fuelSurchargePerMile ?? null,
    mileage: rate.mileage ?? node?.response?.mileage ?? node?.mileage ?? null,
    reportCount: rate.reports ?? rate.companies ?? null,
    timeframe: rate.timeframe ?? rate.escalationType ?? null,
    source: "dat"
  };
}

// ── Deterministic mock provider ──────────────────────────────────────────────
// Stable pseudo-rates derived from the lane string so the same lane always returns
// the same numbers in dev/tests. Ranges are realistic NE dry-van/reefer spot rates.

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff; // 0..1
}

class MockDatProvider implements DatRateProvider {
  readonly kind = "mock" as const;

  async getLaneRate(req: LaneRateRequest): Promise<LaneRateResult> {
    const key = `${req.originCity},${req.originState}>${req.destCity},${req.destState}|${req.equipment}|${req.rateType}`;
    const seed = hashString(key);
    const equipmentLift = req.equipment === "REEFER" ? 0.35 : req.equipment === "FLATBED" ? 0.25 : 0;
    const contractDip = req.rateType === "CONTRACT" ? -0.15 : 0;
    // Base all-in-ish line-haul $/mi in a realistic 1.85–2.65 band.
    const avg = Number((1.85 + seed * 0.8 + equipmentLift + contractDip).toFixed(2));
    const low = Number((avg * 0.86).toFixed(2));
    const high = Number((avg * 1.18).toFixed(2));
    const fuelPerMile = Number((0.45 + seed * 0.12).toFixed(2));
    return {
      ratePerMileLow: low,
      ratePerMileAvg: avg,
      ratePerMileHigh: high,
      fuelPerMile,
      mileage: null,
      reportCount: 20 + Math.floor(seed * 120),
      timeframe: "30-day",
      source: "mock"
    };
  }
}

/**
 * Selects the provider for a lookup. Live DAT is used only when a key is present +
 * active AND mock is not forced; otherwise the deterministic mock is returned so the
 * feature is fully usable before DAT credentials are provisioned.
 */
export async function resolveDatProvider(): Promise<DatRateProvider> {
  if (process.env.DAT_FORCE_MOCK === "true") {
    return new MockDatProvider();
  }
  const creds = await getDatCredentials();
  const hasToken = Boolean(creds.token);
  const hasServiceAccount = Boolean(creds.username && creds.password);
  if (hasToken || hasServiceAccount) {
    return new LiveDatProvider(creds);
  }
  return new MockDatProvider();
}
