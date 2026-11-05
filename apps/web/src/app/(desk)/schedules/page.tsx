import Link from "next/link";
import React from "react";
import { PageHead } from "@/components/desk/ui";
import { Pager } from "@/components/desk/pager";
import { EmptyState } from "@/components/desk/kit/states";
import { RosterTable, type RosterRow } from "@/components/desk/roster-table";
import { asPage } from "@/lib/paging";
import { zoneAbbr } from "@/lib/tz";
import { checkAccess, requirePage } from "@/server/tl/access";
import { listScheduleRows } from "@/server/tl/shifts";
import { currentTerminal, listTerminals } from "@/server/tl/terminal";

export const metadata = { title: "Schedules · TrueLane" };

/**
 * Schedules: when each driver works, on the carrier's clock. A driver manager or an admin sets the weekly shifts, time off and one-day changes, each driver's code and their home terminal;
 * everyone else on the desk reads it. The Planner shows these as ON SHIFT and OFF DUTY, and warns when a load falls outside a shift. A driver with no schedule is never flagged and is not
 * counted as available.
 */
export default async function SchedulesPage({ searchParams }: { searchParams?: { q?: string; page?: string } }) {
  await requirePage("read");
  const terminal = await currentTerminal();
  const q = searchParams?.q?.trim() ?? "";
  const [data, terminals, access] = await Promise.all([listScheduleRows({ q, page: asPage(searchParams?.page), terminal }), listTerminals(), checkAccess("roster")]);
  const rows: RosterRow[] = data.rows.map((r) => ({
    driverId: r.driverId,
    name: r.name,
    code: r.code,
    terminal: r.terminal,
    week: r.schedule?.week ?? null,
    timeOff: r.timeOff
  }));
  const href = (p: number) => {
    const u = new URLSearchParams();
    if (q) u.set("q", q);
    if (p > 1) u.set("page", String(p));
    const s = u.toString();
    return s ? `/schedules?${s}` : "/schedules";
  };
  return (
    <>
      <PageHead title="Schedules" sub={`When each driver works, on the carrier's clock (${zoneAbbr(data.tz)}). The Planner shows these as on shift and off duty, and warns when a load falls outside a shift.`} />
      {!access.ok ? <p className="tl-note">You can look at schedules. A driver manager or an admin sets them.</p> : null}
      <form className="pl-find" action="/schedules" method="get" role="search" style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 10px", flexWrap: "wrap" }}>
        <label className="db-sr-only" htmlFor="sc-q">Find a driver</label>
        <input id="sc-q" type="search" name="q" defaultValue={q} placeholder="Find a driver or code" autoComplete="off" />
        <button type="submit" className="tl-btn sm">Find</button>
        <span className="tl-sub">
          {data.total} {data.total === 1 ? "driver" : "drivers"}
          {data.unset > 0 ? ` · ${data.unset} with no schedule (never flagged, not counted as available)` : ""}
          {terminals.length === 0 ? <> {"·"} <Link href="/settings">Add terminals in Settings</Link></> : null}
        </span>
      </form>
      {rows.length === 0 ? (
        <EmptyState icon="drivers" title={q ? "No driver matches" : "No drivers yet"}>{q ? "Try a name or a code." : "Add drivers on the Drivers page, then set their shifts here."}</EmptyState>
      ) : (
        <RosterTable rows={rows} terminals={terminals} canEdit={access.ok} />
      )}
      <Pager page={data.page} pageSize={data.pageSize} total={data.total} hrefFor={href} newer="Previous drivers" older="More drivers" />
    </>
  );
}
