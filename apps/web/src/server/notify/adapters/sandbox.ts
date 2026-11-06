import { sandboxAllowed } from "@/server/partners/adapters/sandbox";
import type { Channel, Env } from "../types";

/**
 * The simulator channel: it sends nothing, anywhere. It exists so the demo desk shows the whole path (a row in the ledger, "sent" to nowhere) and so a person can see what WOULD go out before a real channel
 * is set up. On only where fake data is expected: the demo desk (sign-in off), or a server whose operator turned `DESK_PARTNER_SANDBOX` on, the same switch the partner simulator uses. On a real fleet's
 * desk it is off, so nothing there is ever marked as told when nobody was.
 */
export const sandbox: Channel = {
  name: "sandbox",
  configured: (env: Env) => sandboxAllowed(env),
  async send() {
    return { ok: true };
  }
};
