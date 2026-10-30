// VENDORED from TrueLane supabase/functions/_shared/partners/contract.ts @ 56845b0a+E3 (uncommitted in the phone repo). Do not edit; run scripts/vendor-truelane.mjs.
// The partner-API contract: which capabilities TrueLane can hand to an outside company, which companies are candidates for each, the NAMES of the secrets
// each one needs (never values), the status words, the packet a factor is sent, and the one result shape every partner function answers with.
// PURE, NO IMPORTS: it runs in Deno (the Edge Functions), in the app's jest, and is vendored into the dispatch desk (scripts/vendor-truelane.mjs).
//
// Nothing here knows a partner's endpoint or payload. Companies are not final: until one is chosen its adapter answers `not_implemented`, and a missing
// secret answers `not_configured`. Neither is an error the person sees as a failure; both are a 200 with `ok: false` and the code.

// ── Capabilities and providers ──────────────────────────────────────────────────────────────

export const CAPABILITIES = ["factoring", "eld", "fuel_card", "tracking", "vetting", "payroll", "ifta"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** The candidate companies for each capability (not final). The first is the default. */
export const PROVIDERS: Record<Capability, readonly string[]> = {
  factoring: ["triumphpay"],
  eld: ["motive", "samsara"],
  fuel_card: ["atob", "wex"],
  tracking: ["project44", "fourkites"],
  vetting: ["highway"],
  payroll: ["gusto"],
  ifta: ["promiles"],
};

/** What each capability is called to a person. */
export const CAPABILITY_LABEL: Record<Capability, string> = {
  factoring: "Factoring",
  eld: "ELD and telematics",
  fuel_card: "Fuel cards",
  tracking: "Shipment tracking",
  vetting: "Carrier vetting",
  payroll: "Payroll",
  ifta: "IFTA",
};

/** The Edge Function secrets a provider needs, by NAME. All must be set for the provider to count as configured. */
export const SECRET_ENV: Record<string, readonly string[]> = {
  triumphpay: ["TRIUMPHPAY_API_KEY"],
  motive: ["MOTIVE_API_KEY"],
  samsara: ["SAMSARA_API_KEY"],
  atob: ["ATOB_API_KEY"],
  wex: ["WEX_API_KEY"],
  project44: ["PROJECT44_CLIENT_ID", "PROJECT44_CLIENT_SECRET"],
  fourkites: ["FOURKITES_API_KEY"],
  highway: ["HIGHWAY_API_KEY"],
  gusto: ["GUSTO_CLIENT_ID", "GUSTO_CLIENT_SECRET"],
  promiles: ["PROMILES_API_KEY"],
};

/** The secret each provider's webhooks are signed with, by name. */
export const WEBHOOK_SECRET_ENV: Record<string, string> = {
  triumphpay: "TRIUMPHPAY_WEBHOOK_SECRET",
  motive: "MOTIVE_WEBHOOK_SECRET",
  samsara: "SAMSARA_WEBHOOK_SECRET",
  atob: "ATOB_WEBHOOK_SECRET",
  wex: "WEX_WEBHOOK_SECRET",
  project44: "PROJECT44_WEBHOOK_SECRET",
  fourkites: "FOURKITES_WEBHOOK_SECRET",
  highway: "HIGHWAY_WEBHOOK_SECRET",
  gusto: "GUSTO_WEBHOOK_SECRET",
  promiles: "PROMILES_WEBHOOK_SECRET",
};

export const ALL_PROVIDERS: readonly string[] = CAPABILITIES.flatMap((c) => PROVIDERS[c]);

export function isCapability(v: unknown): v is Capability {
  return typeof v === "string" && (CAPABILITIES as readonly string[]).includes(v);
}

/** The provider a call is for: the one asked for if it is a candidate for the capability, else the default; null when one was asked for and is not a candidate. */
export function resolveProvider(capability: Capability, requested: unknown): string | null {
  if (requested == null || requested === "") return PROVIDERS[capability][0] ?? null;
  return typeof requested === "string" && PROVIDERS[capability].includes(requested) ? requested : null;
}

export type EnvReader = (name: string) => string | undefined;

/** Every secret the provider needs is set (and not blank). Read inside the request, never at load time. */
export function providerConfigured(provider: string, env: EnvReader): boolean {
  const names = SECRET_ENV[provider];
  return !!names && names.length > 0 && names.every((n) => (env(n) ?? "").trim() !== "");
}

/** The secret names a provider still lacks (for the readiness report; names only). */
export function missingSecrets(provider: string, env: EnvReader): string[] {
  return (SECRET_ENV[provider] ?? []).filter((n) => (env(n) ?? "").trim() === "");
}

// ── Status words (the columns the migration adds) ────────────────────────────────────────────

export const FACTORING_STATUSES = ["none", "requested", "submitted", "funded", "rejected", "paid"] as const;
export type FactoringStatus = (typeof FACTORING_STATUSES)[number];
export const ELD_PROVIDER_VALUES = ["none", ...PROVIDERS.eld] as const;
export const FUEL_CARD_PROVIDER_VALUES = ["none", ...PROVIDERS.fuel_card] as const;
export const VET_STATUSES = ["unchecked", "clear", "review", "failed"] as const;
export type VetStatus = (typeof VET_STATUSES)[number];
export const PAYROLL_STATUSES = ["none", "ready", "sent", "failed"] as const;
export const CONNECTION_STATUSES = ["pending", "connected", "error", "revoked"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

// ── The packet a factor is sent ─────────────────────────────────────────────────────────────

export const PACKET_KINDS = ["invoice", "rate_confirmation", "proof_of_delivery"] as const;
export type PacketKind = (typeof PACKET_KINDS)[number];
export type PacketItem = { kind: PacketKind; required: boolean };
/** The ordered manifest: the invoice is required, the rate confirmation and the proof of delivery help the factor but are optional ("Send anyway"). */
export const FACTORING_PACKET: readonly PacketItem[] = [
  { kind: "invoice", required: true },
  { kind: "rate_confirmation", required: false },
  { kind: "proof_of_delivery", required: false },
];

export const PACKET_LABEL: Record<PacketKind, string> = { invoice: "Invoice", rate_confirmation: "Rate confirmation", proof_of_delivery: "Proof of delivery" };

/** Which items of the manifest are missing from what is on hand: `required` ones block, `optional` ones are a note. */
export function packetGaps(present: readonly string[], manifest: readonly PacketItem[] = FACTORING_PACKET): { required: PacketKind[]; optional: PacketKind[] } {
  const have = new Set(present);
  return {
    required: manifest.filter((i) => i.required && !have.has(i.kind)).map((i) => i.kind),
    optional: manifest.filter((i) => !i.required && !have.has(i.kind)).map((i) => i.kind),
  };
}

// ── The result every partner function answers with ───────────────────────────────────────────

export const ERROR_CODES = [
  "not_configured", // a secret the provider needs is not set
  "not_implemented", // the provider is not chosen or its adapter is not written
  "not_connected", // this account has not connected the provider
  "unauthenticated",
  "bad_json",
  "bad_request",
  "method_not_allowed",
  "invalid_signature",
  "upstream_error", // anything unexpected, including the partner failing
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type PartnerResult<T = unknown> = { ok: true; data: T } | { ok: false; code: ErrorCode; message?: string; field?: string };

export const ok = <T>(data: T): PartnerResult<T> => ({ ok: true, data });
export const err = (code: ErrorCode, message?: string, field?: string): PartnerResult<never> => ({ ok: false, code, ...(message ? { message } : {}), ...(field ? { field } : {}) });

/**
 * The HTTP status for a result. A partner not being set up is not a server fault, so `not_configured`, `not_implemented` and `not_connected` are a 200 with
 * `ok: false` (the existing functions answer a missing secret with 500; these deliberately do not). Only a bad caller or request, or an unexpected failure, is not 200.
 */
export function statusOf(r: PartnerResult): number {
  if (r.ok) return 200;
  switch (r.code) {
    case "unauthenticated":
      return 401;
    case "bad_json":
    case "bad_request":
      return 400;
    case "method_not_allowed":
      return 405;
    case "invalid_signature":
      return 401;
    case "upstream_error":
      return 502;
    default:
      return 200;
  }
}

// ── Hours of service (a caution, never a decision) ───────────────────────────────────────────

export type HosCaution = { level: "none" | "caution" | "short"; message: string | null };

/**
 * How a trip's driving compares with the hours a driver has left on the clock, as the ELD last reported them. A warning only: the trip's verdict, the cost floor
 * and every vendored rule are untouched. "short" is more driving than hours left; "caution" is within 15% of the hours left.
 */
export function hosCaution(driveHours: number | null | undefined, availableHours: number | null | undefined): HosCaution {
  if (driveHours == null || availableHours == null || !Number.isFinite(driveHours) || !Number.isFinite(availableHours) || driveHours <= 0) return { level: "none", message: null };
  const h = (n: number) => `${Math.round(n * 10) / 10} h`;
  if (driveHours > availableHours) return { level: "short", message: `The trip is about ${h(driveHours)} of driving; the driver has ${h(Math.max(0, availableHours))} left on the clock.` };
  if (driveHours >= availableHours * 0.85) return { level: "caution", message: `The trip is about ${h(driveHours)} of driving, nearly all of the ${h(availableHours)} the driver has left.` };
  return { level: "none", message: null };
}
