import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { KpiPeriod } from "@/lib/kpi-periods";
import type { Terminals } from "@/lib/scope";
import { rowsSince } from "./kpi";
import { terminalSetSql } from "./terminal-sql";
import { workspaceTimezone } from "./zone";
import { currentWorkspaceId } from "./workspace";

/**
 * The few names a KPI filter box offers as you type: lanes, customers, drivers or trucks that appear on the loads the dashboard reads (the period's, in the terminals in view), matching what
 * was typed, a few at a time. A fleet has hundreds of lanes and customers and thousands of drivers and trucks, so the filter is a search, not a list.
 */
export type KpiChoiceField = "lane" | "broker" | "driver" | "truck";
export const CHOICE_LIMIT = 30;

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function kpiChoices(field: KpiChoiceField, q: string, period: KpiPeriod, terminals: Terminals, now = new Date(), workspaceId = currentWorkspaceId()): Promise<string[]> {
  const tz = await workspaceTimezone(workspaceId);
  const since = new Date(rowsSince(period, now.getTime(), tz));
  const text = q.trim().slice(0, 60);
  const scope = terminalSetSql(terminals, workspaceId);
  const base = Prisma.sql`l.workspace_id = ${workspaceId} and l.deleted_at is null and l.status <> 'quote' and coalesce(l.completed_at, l.cancelled_at, l.created_at) >= ${since}${scope}`;
  const match = (expr: Prisma.Sql) => (text ? Prisma.sql` and ${expr} ilike ${like(text)}` : Prisma.empty);
  let rows: Array<{ v: string | null }>;
  if (field === "lane") {
    const lane = Prisma.sql`(coalesce(l.origin_address, '?') || ' → ' || coalesce(l.destination_address, '?'))`;
    rows = await prisma.$queryRaw`select ${lane} as v, count(*) as n from loads l where ${base}${match(lane)} group by 1 order by n desc, 1 limit ${CHOICE_LIMIT}`;
  } else if (field === "broker") {
    rows = await prisma.$queryRaw`select l.broker_name as v, count(*) as n from loads l where ${base} and l.broker_name is not null${match(Prisma.sql`l.broker_name`)} group by 1 order by n desc, 1 limit ${CHOICE_LIMIT}`;
  } else if (field === "driver") {
    rows = await prisma.$queryRaw`select d.name as v, count(*) as n from loads l join assignments a on a.load_id = l.id join drivers d on d.id = a.driver_id where ${base}${match(Prisma.sql`d.name`)} group by 1 order by n desc, 1 limit ${CHOICE_LIMIT}`;
  } else {
    rows = await prisma.$queryRaw`select v.name as v, count(*) as n from loads l join vehicles v on v.id = l.vehicle_id where ${base}${match(Prisma.sql`v.name`)} group by 1 order by n desc, 1 limit ${CHOICE_LIMIT}`;
  }
  return rows.flatMap((r) => (r.v ? [r.v] : []));
}
