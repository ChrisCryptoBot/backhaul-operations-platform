import { Prisma } from "@prisma/client";

/**
 * The terminal scope in SQL, for a query over `loads l`: the same loads as queries.ts inTerminal (on a truck or with a driver of that terminal, or not placed anywhere yet). Written as sets
 * the database builds once (`in (select ...)`), not a correlated test per load, which read every load for each of the three conditions. Empty for no terminal.
 */
export const terminalSql = (terminal: string | null | undefined, workspaceId: string) =>
  terminal
    ? Prisma.sql` and (l.vehicle_id in (select tv.id from vehicles tv where tv.workspace_id = ${workspaceId} and tv.terminal = ${terminal})
        or l.id in (select ta.load_id from assignments ta join drivers td on td.id = ta.driver_id where td.workspace_id = ${workspaceId} and td.terminal = ${terminal})
        or (l.vehicle_id is null and l.id not in (select tn.load_id from assignments tn)))`
    : Prisma.empty;
