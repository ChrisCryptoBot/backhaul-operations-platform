/**
 * What FMCSA says about a motor carrier or broker, by MC (docket) number. Ported from TrueLane's lib/fmcsa.ts (which cannot be vendored: it
 * reads the phone's env wrapper) with its parser and normalisers unchanged; the authority reading is the desk's. Pure, so it is tested without
 * a key.
 *
 * Only a broker or a carrier has an MC. A shipper or a direct customer has none, and that is never a problem: the lookup is for a customer
 * that gave one, to show whether the authority behind it is live. It is display only; nothing here is saved or blocks a save.
 */
export const FMCSA_BASE = "https://mobile.fmcsa.dot.gov/qc/services/carriers";

export type FmcsaCarrier = {
  legalName: string | null;
  dbaName: string | null;
  dotNumber: string | null;
  mcNumber: string | null;
  allowedToOperate: string | null;
  brokerAuthorityStatus: string | null;
  commonAuthorityStatus: string | null;
  phyCity: string | null;
  phyState: string | null;
};

function str(value: unknown): string | null {
  if (typeof value === "string") {
    const t = value.trim();
    return t.length > 0 ? t : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Digits only. Null when empty after stripping. */
export function normalizeDotNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.trim().replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

/** Digits only after an optional MC / MX / FF prefix. Null when empty. */
export function normalizeMcNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const stripped = raw
    .trim()
    .toUpperCase()
    .replace(/^(MC|MX|FF)[-\s]*/, "")
    .replace(/\D/g, "");
  return stripped.length > 0 ? stripped : null;
}

function carrierRecord(json: unknown): Record<string, unknown> | null {
  if (!json || typeof json !== "object") return null;
  const content = (json as { content?: unknown }).content;
  // A multi-carrier reply is capped at 50 (an array); a single DOT or MC lookup often returns one { carrier } object. Both are read.
  const rows = Array.isArray(content) ? content : content != null ? [content] : [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const carrier = (row as { carrier?: unknown }).carrier;
    if (carrier && typeof carrier === "object") return carrier as Record<string, unknown>;
  }
  return null;
}

export function parseFmcsaCarrier(json: unknown): FmcsaCarrier | null {
  const carrier = carrierRecord(json);
  if (!carrier) return null;
  const legalName = str(carrier.legalName);
  const dbaName = str(carrier.dbaName);
  const dotNumber = str(carrier.dotNumber);
  const mcNumber = str(carrier.mcNumber);
  if (!legalName && !dbaName && !dotNumber && !mcNumber) return null;
  return {
    legalName,
    dbaName,
    dotNumber,
    mcNumber,
    // The documented field is allowToOperate; live payloads commonly say allowedToOperate.
    allowedToOperate: str(carrier.allowedToOperate) ?? str(carrier.allowToOperate),
    brokerAuthorityStatus: str(carrier.brokerAuthorityStatus),
    commonAuthorityStatus: str(carrier.commonAuthorityStatus),
    phyCity: str(carrier.phyCity),
    phyState: str(carrier.phyState)
  };
}

// ── What the desk shows ────────────────────────────────────────────────────────────────────────

export type AuthorityState = "broker" | "carrier" | "inactive" | "not_found" | "unavailable";

export const AUTHORITY_LABEL: Record<AuthorityState, string> = {
  broker: "Broker authority active",
  carrier: "Carrier authority only, not a broker",
  inactive: "Found, no active authority",
  not_found: "No carrier with that MC",
  unavailable: "Lookup unavailable"
};

export type AuthorityResult = { state: AuthorityState; label: string; name: string | null; place: string | null };

/** The phone reads brokerAuthorityStatus "A" as broker authority; a carrier's own authority is commonAuthorityStatus "A". A carrier told not to operate is inactive. */
export function authorityOf(c: FmcsaCarrier): AuthorityResult {
  const name = c.legalName ?? c.dbaName;
  const place = [c.phyCity ? c.phyCity.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase()) : null, c.phyState].filter(Boolean).join(", ") || null;
  const barred = (c.allowedToOperate ?? "").toUpperCase() === "N";
  const state: AuthorityState = barred ? "inactive" : c.brokerAuthorityStatus === "A" ? "broker" : c.commonAuthorityStatus === "A" ? "carrier" : "inactive";
  return { state, label: AUTHORITY_LABEL[state], name, place };
}

/** A lookup that found nothing, or could not run. */
export const noAuthority = (state: "not_found" | "unavailable"): AuthorityResult => ({ state, label: AUTHORITY_LABEL[state], name: null, place: null });

/**
 * The name to put in the customer box, or null to leave it. Only ever fills an empty box: a name somebody typed (a trade name, a shipper's
 * own wording) is never replaced by the registered one.
 */
export function nameToFill(current: string | null | undefined, found: AuthorityResult): string | null {
  if ((current ?? "").trim() !== "") return null;
  return found.name;
}
