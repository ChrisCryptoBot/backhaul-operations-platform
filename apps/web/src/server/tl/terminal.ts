import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { TERMINAL_COOKIE, scopeOf } from "@/lib/terminal";
import { currentWorkspaceId } from "./workspace";

/**
 * Terminals as the server sees them. There is no terminal table: the terminals offered are the distinct values on the trucks and drivers (two index scans),
 * and the dispatcher's scope is a cookie the header sets. A list honours the scope by passing `await currentTerminal()` as its `terminal`.
 */
export async function listTerminals(workspaceId = currentWorkspaceId()): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ terminal: string }>>`
    select terminal from vehicles where workspace_id = ${workspaceId} and terminal is not null and archived_at is null
    union
    select terminal from drivers where workspace_id = ${workspaceId} and terminal is not null and active
    order by 1`;
  return rows.map((r) => r.terminal);
}

/**
 * The terminal the dispatcher has chosen in the header, or null for all of them. Outside a request (a script, a test) there is no cookie and so no scope;
 * a cookie naming a terminal nobody works out of any more is ignored rather than showing an empty desk.
 */
export async function currentTerminal(workspaceId = currentWorkspaceId()): Promise<string | null> {
  let raw: string | undefined;
  try {
    raw = cookies().get(TERMINAL_COOKIE)?.value;
  } catch {
    return null;
  }
  if (!raw) return null;
  return scopeOf(raw, await listTerminals(workspaceId));
}
