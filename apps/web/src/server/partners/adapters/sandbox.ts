import { SECRET_ENV } from "@/truelane/partners/contract";

/**
 * The sandbox simulator's switch. A company's key that starts with `sandbox_` asks for the built-in simulator instead of the company: the adapter answers realistic payloads (a tractor's
 * position, a driver's clocks, a factor's confirmations) from inside the desk, with no network call of any kind.
 *
 * It only works where fake data is expected: on the demo desk (sign-in off), or on a server whose operator turned `DESK_PARTNER_SANDBOX` on. On a real fleet's desk a `sandbox_` key is refused
 * with a plain message, so no fleet can be handed invented hours or positions by typing a word into a box.
 */
export const SANDBOX_PREFIX = "sandbox_";
export const SANDBOX_SWITCH_ENV = "DESK_PARTNER_SANDBOX";

type Env = Record<string, string | undefined>;

/** Whether this server may run the simulator at all. */
export const sandboxAllowed = (env: Env = process.env): boolean => env.DESK_AUTH !== "on" || env[SANDBOX_SWITCH_ENV]?.trim() === "on";

export type KeyMode = "live" | "sandbox" | "refused";

/** What a company's primary key asks for: the company (live), the simulator (sandbox), or the simulator on a server where it is not allowed (refused). */
export function keyMode(provider: string, secret: (name: string) => string | undefined, env: Env = process.env): KeyMode {
  const primary = SECRET_ENV[provider]?.[0];
  const value = primary ? secret(primary) : undefined;
  if (typeof value !== "string" || !value.trim().startsWith(SANDBOX_PREFIX)) return "live";
  return sandboxAllowed(env) ? "sandbox" : "refused";
}

/** A small stable number from a string (FNV-1a), so the simulator's answers are the same for the same truck and the same quarter hour, and tests can pin them. */
export function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
