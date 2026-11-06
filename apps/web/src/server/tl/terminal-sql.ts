import { Prisma } from "@prisma/client";
import { termList, terminalFilter, type Terminals } from "@/lib/scope";

/**
 * The scope in SQL, for a query over `loads l`: the loads on a truck or with a driver of any terminal in the scope, or not placed anywhere yet (the same rule as queries.ts `inTerminal`, which is the Prisma
 * form). Written as sets the database builds once (`in (select ...)`), not a correlated test per load, which read every load for each of the three conditions. `null`, or left out, is everything and adds
 * nothing. An empty list is a scope of no terminals, which leaves only the unplaced loads. A single name or a list: the one type every scoped function takes.
 */
export const terminalSetSql = (terminals: Terminals | undefined, workspaceId: string) => {
  const list = termList(terminals ?? null);
  return list == null
    ? Prisma.empty
    : Prisma.sql` and (l.vehicle_id in (select tv.id from vehicles tv where tv.workspace_id = ${workspaceId} and tv.terminal = any(${list}))
        or l.id in (select ta.load_id from assignments ta join drivers td on td.id = ta.driver_id where td.workspace_id = ${workspaceId} and td.terminal = any(${list}))
        or (l.vehicle_id is null and l.id not in (select tn.load_id from assignments tn)))`;
};

/** The same, under its older name: a terminal, several, or none. */
export const terminalSql = (terminal: Terminals | undefined, workspaceId: string) => terminalSetSql(terminal, workspaceId);

/**
 * Loads placed in the scope (on one of its terminals' trucks or with one of its drivers), and loads not placed anywhere yet, which are everyone's to take: the same rule as `terminalSetSql`, in Prisma form,
 * for a list the database reads with an index. No scope adds nothing.
 */
export const inTerminal = (terminal: Terminals): object => {
  const f = terminalFilter(terminal);
  return f === undefined ? {} : { OR: [{ vehicle: { terminal: f } }, { assignment: { driver: { terminal: f } } }, { vehicleId: null, assignment: null }] };
};
