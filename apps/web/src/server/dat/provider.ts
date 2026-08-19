import type { DatEquipment, DatRateType } from "@prisma/client";
import { getDatApiKey } from "@/server/dat/settings";

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
const DAT_RATEVIEW_URL =
  process.env.DAT_RATEVIEW_URL ?? "https://analytics.api.dat.com/linehaulrates/v1/lookups";

const EQUIPMENT_TO_DAT: Record<DatEquipment, string> = {
  VAN: "VAN",
  REEFER: "REEFER",
  FLATBED: "FLATBED"
};

class LiveDatProvider implements DatRateProvider {
  readonly kind = "dat" as const;
  constructor(private readonly apiKey: string) {}

  private async getAccessToken(): Promise<string> {
    const res = await fetch(DAT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ scope: "rateview" })
    });
    if (!res.ok) {
      throw new Error(`DAT token request failed (${res.status})`);
    }
    const data = (await res.json()) as { accessToken?: string; token?: string };
    const token = data.accessToken ?? data.token;
    if (!token) {
      throw new Error("DAT token response missing accessToken");
    }
    return token;
  }

  async getLaneRate(req: LaneRateRequest): Promise<LaneRateResult> {
    const token = await this.getAccessToken();
    const res = await fetch(DAT_RATEVIEW_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        origin: { city: req.originCity, stateOrProvince: req.originState },
        destination: { city: req.destCity, stateOrProvince: req.destState },
        equipment: EQUIPMENT_TO_DAT[req.equipment],
        rateType: req.rateType === "CONTRACT" ? "CONTRACT" : "SPOT",
        includeMyRate: false
      })
    });
    if (!res.ok) {
      throw new Error(`DAT RateView lookup failed (${res.status})`);
    }
    const data = (await res.json()) as DatRateViewResponse;
    return mapDatResponse(data);
  }
}

interface DatRateViewResponse {
  rate?: {
    perMile?: { low?: number; average?: number; high?: number };
    perTrip?: { average?: number };
    fuelSurchargePerMile?: number;
    averageFuelSurchargePerMileUsd?: number;
    mileage?: number;
    reports?: number;
    timeframe?: string;
    escalationType?: string;
  };
}

function mapDatResponse(data: DatRateViewResponse): LaneRateResult {
  const r = data.rate ?? {};
  const avg = r.perMile?.average;
  if (typeof avg !== "number") {
    throw new Error("DAT response missing per-mile average");
  }
  return {
    ratePerMileLow: r.perMile?.low ?? avg,
    ratePerMileAvg: avg,
    ratePerMileHigh: r.perMile?.high ?? avg,
    fuelPerMile: r.fuelSurchargePerMile ?? r.averageFuelSurchargePerMileUsd ?? null,
    mileage: r.mileage ?? null,
    reportCount: r.reports ?? null,
    timeframe: r.timeframe ?? null,
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
  const key = await getDatApiKey();
  if (key) {
    return new LiveDatProvider(key);
  }
  return new MockDatProvider();
}
