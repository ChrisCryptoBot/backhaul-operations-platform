import { UNREACHABLE, isLostConnection } from "@/lib/connection";

/** Said when a server call threw rather than answered: a role that does not allow it, or the desk failing. It may or may not have gone through, so it says to look. */
export const DID_NOT_GO = "That did not go through. Check that you have dispatcher access and the connection, reload the load to see where it stands, and try again.";

/**
 * Run a server call from a dialog so a throw is an answer too: a dialog that waits on a call that threw would sit on "Saving..." for good, and say nothing. Gives the value, or
 * the sentence to show.
 */
export async function tried<T>(call: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await call() };
  } catch (e) {
    return { ok: false, message: isLostConnection(e) ? UNREACHABLE : DID_NOT_GO };
  }
}
