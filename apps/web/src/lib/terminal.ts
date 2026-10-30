/**
 * Terminals: the yard, branch or region that runs a truck or a driver. A big fleet is read one terminal at a time, so the header holds a scope
 * (a cookie, "All terminals" when there is none) that the fleet lists, the planner, the quote's fits and every truck / driver picker honour.
 * Free text on the truck and the driver; the terminals offered are simply the distinct values in use. Pure, shared by the server and the browser.
 */
export const TERMINAL_COOKIE = "desk-terminal";
/** The id of the one `<datalist>` the shell renders, so any terminal box in the desk can offer the terminals already in use. */
export const TERMINAL_LIST_ID = "desk-terminals";
export const TERMINAL_MAX_LENGTH = 40;

/** A terminal as typed or read from a cookie: trimmed, one space between words, at most 40 characters; blank means no terminal. */
export function asTerminal(v: string | null | undefined): string | null {
  const t = (v ?? "").replace(/\s+/g, " ").trim().slice(0, TERMINAL_MAX_LENGTH);
  return t === "" ? null : t;
}

/** What a list is scoped to: the chosen terminal, or null for all of them. A terminal nobody uses (an old cookie) scopes to nothing, so it is dropped. */
export function scopeOf(cookie: string | null | undefined, terminals: readonly string[]): string | null {
  const t = asTerminal(cookie ? safeDecode(cookie) : null);
  return t && terminals.includes(t) ? t : null;
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}
