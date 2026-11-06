import type { Terminals } from "@/lib/scope";
import { currentTerminals } from "./scope";
import { currentWorkspaceId } from "./workspace";

export { listTerminals } from "./terminals-in-use";

/**
 * What the request is scoped to, for a list: null for everything, the name of one terminal, or a list of several (a region's, or those picked). The scope is the person's choice in the header inside
 * what they are allowed to see (server/tl/scope.ts); a list honours it by passing `await currentTerminal()` as its `terminal`. Outside a request (a script, a test) there is no scope.
 * Kept under its old name so every screen that asked for "the terminal" asks the one thing and gets a permission-checked answer.
 */
export async function currentTerminal(workspaceId = currentWorkspaceId()): Promise<Terminals> {
  return currentTerminals(workspaceId);
}
