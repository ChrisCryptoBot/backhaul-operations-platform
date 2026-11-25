/**
 * OS&D (overage, shortage, damage, refused) freight claims tracked under 49 CFR Part 370:
 * carrier must acknowledge within 30 days of receipt and pay, decline, or make a firm compromise offer within 120 days.
 * Pure: zero database or React dependencies.
 */
export const CLAIM_TYPES = ["overage", "shortage", "damage", "refused"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];
export const CLAIM_TYPE_LABEL: Record<ClaimType, string> = {
  overage: "Overage",
  shortage: "Shortage",
  damage: "Damage",
  refused: "Refused freight"
};
export const isClaimType = (v: unknown): v is ClaimType => typeof v === "string" && (CLAIM_TYPES as readonly string[]).includes(v);

export const CLAIM_STATUSES = ["open", "acknowledged", "settled", "denied", "closed"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  open: "Open",
  acknowledged: "Acknowledged",
  settled: "Settled",
  denied: "Denied",
  closed: "Closed"
};
export const isClaimStatus = (v: unknown): v is ClaimStatus => typeof v === "string" && (CLAIM_STATUSES as readonly string[]).includes(v);

export const CLAIM_ACK_DAYS = 30;
export const CLAIM_DECIDE_DAYS = 120;
const DAY_MS = 86_400_000;

/** Statutory 49 CFR Part 370 deadlines from the claim's opened date: +30 days to acknowledge, +120 days to decide. */
export function claimDeadlines(openedAt: Date): { ackBy: Date; decideBy: Date } {
  const t = openedAt.getTime();
  return {
    ackBy: new Date(t + CLAIM_ACK_DAYS * DAY_MS),
    decideBy: new Date(t + CLAIM_DECIDE_DAYS * DAY_MS)
  };
}

export type ClaimCreateInput = {
  type: string;
  pieces?: string | number | null;
  amount?: string | number | null;
  claimant?: string | null;
  externalNumber?: string | null;
  openedAt?: string | Date | null;
  note?: string | null;
};

export type CheckedClaimCreate = {
  type: ClaimType;
  pieces: number | null;
  amount: number | null;
  claimant: string | null;
  externalNumber: string | null;
  openedAt: Date;
  ackBy: Date;
  decideBy: Date;
  note: string | null;
};

export type ClaimUpdateInput = {
  type?: string;
  status?: string;
  pieces?: string | number | null;
  amount?: string | number | null;
  claimant?: string | null;
  externalNumber?: string | null;
  note?: string | null;
};

export type CheckedClaimUpdate = {
  type?: ClaimType;
  status?: ClaimStatus;
  pieces?: number | null;
  amount?: number | null;
  claimant?: string | null;
  externalNumber?: string | null;
  note?: string | null;
};

const txt = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed.slice(0, max);
};

function parseWholePieces(raw: string | number | null | undefined): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw == null || raw === "") return { ok: true, value: null };
  const s = typeof raw === "number" ? String(raw) : raw.trim().replace(/,/g, "");
  if (s === "") return { ok: true, value: null };
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 100_000) return { ok: false, error: "Pieces: a whole number from 1 to 100,000." };
  return { ok: true, value: n };
}

function parseClaimAmount(raw: string | number | null | undefined): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw == null || raw === "") return { ok: true, value: null };
  const s = typeof raw === "number" ? (Number.isFinite(raw) ? raw.toFixed(2) : "NaN") : raw.trim().replace(/,/g, "");
  if (s === "") return { ok: true, value: null };
  const n = Number(s);
  if (!/^\d+(\.\d{1,2})?$/.test(s) || !Number.isFinite(n) || n <= 0 || n > 10_000_000) {
    return { ok: false, error: "Claim amount: dollars and cents above zero (up to $10,000,000)." };
  }
  return { ok: true, value: n };
}

function parseOpenedDate(raw: string | Date | null | undefined, now: Date): { ok: true; value: Date } | { ok: false; error: string } {
  if (raw == null || raw === "") return { ok: true, value: now };
  if (raw instanceof Date) {
    return Number.isFinite(raw.getTime()) ? { ok: true, value: raw } : { ok: false, error: "Opened date is invalid." };
  }
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T12:00:00Z`);
    if (Number.isFinite(d.getTime())) return { ok: true, value: d };
  }
  const ms = Date.parse(s);
  if (Number.isFinite(ms)) return { ok: true, value: new Date(ms) };
  return { ok: false, error: "Opened date: use YYYY-MM-DD." };
}

export function validateClaimCreate(raw: ClaimCreateInput, now = new Date()): { ok: true; value: CheckedClaimCreate } | { ok: false; error: string } {
  if (!isClaimType(raw.type)) return { ok: false, error: "Pick an OS&D claim type (overage, shortage, damage, or refused freight)." };
  const pieces = parseWholePieces(raw.pieces);
  if (!pieces.ok) return pieces;
  const amount = parseClaimAmount(raw.amount);
  if (!amount.ok) return amount;
  const opened = parseOpenedDate(raw.openedAt, now);
  if (!opened.ok) return opened;
  const claimant = txt(raw.claimant, 120);
  const externalNumber = txt(raw.externalNumber, 60);
  const note = txt(raw.note, 1000);
  const { ackBy, decideBy } = claimDeadlines(opened.value);
  return {
    ok: true,
    value: {
      type: raw.type,
      pieces: pieces.value,
      amount: amount.value,
      claimant,
      externalNumber,
      openedAt: opened.value,
      ackBy,
      decideBy,
      note
    }
  };
}

export function validateClaimUpdate(raw: ClaimUpdateInput): { ok: true; value: CheckedClaimUpdate } | { ok: false; error: string } {
  const out: CheckedClaimUpdate = {};
  if (raw.type !== undefined) {
    if (!isClaimType(raw.type)) return { ok: false, error: "Pick a valid claim type." };
    out.type = raw.type;
  }
  if (raw.status !== undefined) {
    if (!isClaimStatus(raw.status)) return { ok: false, error: "Pick a valid claim status." };
    out.status = raw.status;
  }
  if (raw.pieces !== undefined) {
    const pieces = parseWholePieces(raw.pieces);
    if (!pieces.ok) return pieces;
    out.pieces = pieces.value;
  }
  if (raw.amount !== undefined) {
    const amount = parseClaimAmount(raw.amount);
    if (!amount.ok) return amount;
    out.amount = amount.value;
  }
  if (raw.claimant !== undefined) out.claimant = txt(raw.claimant, 120);
  if (raw.externalNumber !== undefined) out.externalNumber = txt(raw.externalNumber, 60);
  if (raw.note !== undefined) out.note = txt(raw.note, 1000);
  return { ok: true, value: out };
}
