/**
 * What the front door does with a request when sign-in is on. Pure, so the rules can be tested without a browser or a provider; src/middleware.ts only feeds it the facts and
 * carries out the answer. The middleware is the courtesy (send a person where they belong, turn a fetch away with a 401); the real checks are in the server code
 * (src/server/tl/access.ts), which every page, action and route runs again against the member table.
 */
export type Door =
  | { kind: "next" }
  /** Not signed in to the provider: go to the sign-in page. */
  | { kind: "sign_in" }
  /** Signed in but with no desk session yet: make one (src/app/(public)/auth/enter/route.ts) and come back. */
  | { kind: "enter"; next: string }
  /** A fetch or a change with nobody signed in: 401, not a page. */
  | { kind: "unauthorized" };

/** Pages anyone may open: the splash, the sign-in and sign-up pages, asking for a person, the "no desk yet" page and signing out. */
const PUBLIC = [/^\/$/, /^\/sign-in(\/.*)?$/, /^\/sign-up(\/.*)?$/, /^\/enterprise(\/.*)?$/, /^\/no-workspace$/, /^\/auth\/leave$/, /^\/icon\.svg$/];

export const isPublicPath = (path: string): boolean => PUBLIC.some((re) => re.test(path));

export function decide(i: { path: string; method: string; userId: string | null; hasSession: boolean; wantsHtml: boolean; search?: string }): Door {
  if (isPublicPath(i.path)) return { kind: "next" };
  const page = i.method === "GET" && i.wantsHtml;
  if (!i.userId) return page ? { kind: "sign_in" } : { kind: "unauthorized" };
  if (i.path === "/auth/enter") return { kind: "next" };
  if (!i.hasSession && page) return { kind: "enter", next: `${i.path}${i.search ?? ""}` };
  return { kind: "next" };
}

/** Where to go after signing in: a path on this desk only (never another site, never a protocol-relative address). */
export function safeNext(raw: string | null | undefined, fallback = "/loads"): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /[\u0000-\u001f]/.test(raw)) return fallback;
  return raw.startsWith("/auth/") ? fallback : raw;
}
