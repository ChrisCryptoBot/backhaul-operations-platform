/**
 * The partner read API's rules (docs/MONEY_PLAN.md, Wave 7 step 2). Pure: the key's shape, scopes, paging, cursors and the rate window. The server half is src/server/api/*.
 *
 * A key is `tlk_<live|test>_<8 lookup characters>_<43 characters: 32 random bytes, base64url>`. The first part (`tlk_live_ab12cd34`) is the key's public prefix: shown on screen and used to find
 * the row; the whole key is never stored, only its SHA-256. 256 random bits cannot be guessed or brute-forced from the hash, so a slow password hash buys nothing here (a password has a few
 * dozen bits; this has 256). `test` keys are made on the demo desk, `live` everywhere else; they work the same way and only say where they came from.
 */
export const API_SCOPES = ["invoices", "payments", "settlements", "loads"] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export const SCOPE_LABEL: Record<ApiScope, string> = { invoices: "Invoices", payments: "Payments", settlements: "Driver statements", loads: "Loads" };
export const isScope = (v: unknown): v is ApiScope => typeof v === "string" && (API_SCOPES as readonly string[]).includes(v);

export type KeyMode = "live" | "test";
export const LOOKUP_LENGTH = 8;
export const SECRET_BYTES = 32;
const KEY_RE = /^(tlk_(live|test)_[a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;

export const formatKey = (mode: KeyMode, lookup: string, secret: string): string => `tlk_${mode}_${lookup}_${secret}`;

/** The key's public prefix and mode, or null when the text is not shaped like one of our keys (checked before any database read). */
export function parseKey(raw: string): { prefix: string; mode: KeyMode } | null {
  const m = KEY_RE.exec(raw);
  return m ? { prefix: m[1]!, mode: m[2] as KeyMode } : null;
}

/** The token of an `Authorization: Bearer <key>` header, or null. */
export function bearerOf(header: string | null | undefined): string | null {
  if (!header || header.length > 200) return null;
  const m = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
  return m ? m[1]! : null;
}

/** What a screen shows of a key: its prefix and its last four characters. */
export const maskKey = (prefix: string, last4: string): string => `${prefix}_…${last4}`;

export const LABEL_MAX = 60;
export const MAX_ACTIVE_KEYS = 20;

export function cleanKeyInput(i: { label: unknown; scopes: unknown }): { ok: true; label: string; scopes: ApiScope[] } | { ok: false; error: string } {
  const label = typeof i.label === "string" ? i.label.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX) : "";
  if (label.length < 2) return { ok: false, error: "Name the key (who or what uses it), so it can be told apart and revoked later." };
  const raw = Array.isArray(i.scopes) ? i.scopes : [];
  if (raw.some((s) => !isScope(s))) return { ok: false, error: "That is not something a key can read." };
  const scopes = API_SCOPES.filter((s) => raw.includes(s));
  if (scopes.length === 0) return { ok: false, error: "Tick at least one thing the key may read." };
  return { ok: true, label, scopes };
}

/** Page size: 50 when not given, held to 1..100; anything that is not a whole number is refused. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
export function readLimit(raw: string | null): { ok: true; limit: number } | { ok: false; error: string } {
  if (raw == null || raw === "") return { ok: true, limit: DEFAULT_LIMIT };
  if (!/^-?\d{1,6}$/.test(raw)) return { ok: false, error: `limit must be a whole number from 1 to ${MAX_LIMIT}.` };
  const n = Number.parseInt(raw, 10);
  return { ok: true, limit: Math.min(MAX_LIMIT, Math.max(1, n)) };
}

/**
 * A cursor is where the last page ended: the row's creation time and id, in that order, which is the order every list is read in (oldest first, ties by id), so a page never repeats or skips a
 * row however many are added after it. Opaque to the caller (base64url of a small JSON).
 */
export type Cursor = { t: Date; id: string };
export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify({ t: c.t.toISOString(), id: c.id }), "utf8").toString("base64url");
}
export function decodeCursor(raw: string | null): { ok: true; cursor: Cursor | null } | { ok: false; error: string } {
  if (raw == null || raw === "") return { ok: true, cursor: null };
  const bad = { ok: false as const, error: "after is not a cursor this API gave out." };
  if (raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw)) return bad;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { t?: unknown; id?: unknown };
    if (typeof v.t !== "string" || typeof v.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v.id)) return bad;
    const t = new Date(v.t);
    if (Number.isNaN(t.getTime()) || t.toISOString() !== v.t) return bad;
    return { ok: true, cursor: { t, id: v.id } };
  } catch {
    return bad;
  }
}

/** The rate window: so many requests a key may make in a fixed minute (D3). Counted on the key's row in the database, so every server instance shares one count. */
export const RATE_LIMIT = 60;
export const RATE_WINDOW_MS = 60_000;
/** `last_used_at` is written at most this often, so a busy key is not a write on every request. */
export const LAST_USED_EVERY_MS = 60_000;

/** Whole seconds until the window opens again (at least 1), for Retry-After. */
export function retryAfterSeconds(windowStart: Date, now: Date): number {
  return Math.max(1, Math.ceil((windowStart.getTime() + RATE_WINDOW_MS - now.getTime()) / 1000));
}
