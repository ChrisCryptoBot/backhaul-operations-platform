import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "./workspace";

/**
 * Terminals as the server sees them: the managed list (terminal-list.ts) together with any value still in use on a driver or a truck that the list does not have (a row written before the list
 * existed, or by a script), so nothing in use ever disappears from the picker.
 */
export async function listTerminals(workspaceId = currentWorkspaceId()): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ terminal: string }>>`
    select name as terminal from terminals where workspace_id = ${workspaceId} and archived_at is null
    union
    select terminal from vehicles where workspace_id = ${workspaceId} and terminal is not null and archived_at is null
    union
    select terminal from drivers where workspace_id = ${workspaceId} and terminal is not null and active
    order by 1`;
  // One spelling per terminal, ignoring case: the list's own name wins.
  const seen = new Map<string, string>();
  for (const r of rows) if (!seen.has(r.terminal.toLowerCase())) seen.set(r.terminal.toLowerCase(), r.terminal);
  return [...seen.values()];
}
