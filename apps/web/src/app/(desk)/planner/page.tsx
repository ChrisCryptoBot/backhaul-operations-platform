import Link from "next/link";
import React from "react";
import { getPlannerData } from "@/server/tl/planner";
import { currentTerminal } from "@/server/tl/terminal";
import { currentAllowed } from "@/server/tl/scope";
import { Card, PageHead } from "@/components/desk/ui";
import { DueNow, PlannerGrid } from "@/components/desk/planner-parts";
import { EmptyState } from "@/components/desk/kit/states";
import { planDays } from "@/lib/planner";
import { Pager } from "@/components/desk/pager";
import { asPage } from "@/lib/paging";
import { parseCentralLocal } from "@/lib/zoned";

export const metadata = { title: "Planner · TrueLane" };

const WEEK = 7 * 86_400_000;
/** Driver rows shown at a time: a big fleet has far more drivers than fit on a screen. */
const ROWS_PER_PAGE = 50;

/** Who is on what, day by day, and what is due now. `?start=2026-10-26` starts the week on another day. */
export default async function PlannerPage({ searchParams }: { searchParams?: { start?: string; q?: string; page?: string; idle?: string; else?: string } }) {
  const now = Date.now();
  const from = (searchParams?.start ? parseCentralLocal(`${searchParams.start}T12:00`) : null) ?? now;
  const scope = await currentTerminal();
  // A terminal is a home base, not a fence: with one chosen the grid shows its home drivers, and one link brings in everyone else.
  const everyone = searchParams?.else === "1";
  // "Everyone" is everyone the person may see: a limited person's link stays inside their limit.
  const reach = await currentAllowed();
  const terminal = everyone ? reach : scope;
  const { days, rows, tray, untimed, watchlist, balance, tz, hiddenElsewhere } = await getPlannerData(from, now, 7, undefined, terminal, reach);
  // Noon, so a day with a clock change in it cannot tip the neighbour week's key onto the wrong date.
  const key = (weeks: number) => planDays(days[0]!.start + weeks * WEEK + 12 * 3_600_000, 1, now)[0]!.key;
  const trayCount = new Set(tray.flat().map((i) => i.loadId)).size;
  const conflicts = new Set(rows.flatMap((r) => r.cells.flat()).filter((i) => i.conflict).map((i) => i.loadId)).size;
  // Drivers with work this week, or on shift this week with nothing booked (the supply a dispatcher is looking for), are the default view; the rest (no work, and off all week or no schedule) are one click away. Searched by name or code, a page at a time.
  const q = searchParams?.q?.trim() ?? "";
  const showIdle = searchParams?.idle === "1";
  const busy = rows.filter((r) => r.cells.some((c) => c.length > 0) || (r.shifts ?? []).some((s) => s.kind === "on"));
  const idleCount = rows.length - busy.length;
  const unscheduled = rows.filter((r) => r.shifts?.[0]?.kind === "unset").length;
  const needle = q.toLowerCase();
  const pool = (showIdle ? rows : busy).filter((r) => !needle || r.name.toLowerCase().includes(needle) || (r.code ?? "").toLowerCase().includes(needle));
  const page = Math.min(asPage(searchParams?.page), Math.max(1, Math.ceil(pool.length / ROWS_PER_PAGE)));
  const shownRows = pool.slice((page - 1) * ROWS_PER_PAGE, page * ROWS_PER_PAGE);
  const href = (p: { page?: number; idle?: boolean; q?: string; elsewhere?: boolean }) => {
    const u = new URLSearchParams();
    if (searchParams?.start) u.set("start", searchParams.start);
    const text = p.q ?? q;
    if (text) u.set("q", text);
    if (p.idle ?? showIdle) u.set("idle", "1");
    if (p.elsewhere ?? everyone) u.set("else", "1");
    if (p.page && p.page > 1) u.set("page", String(p.page));
    const s = u.toString();
    return s ? `/planner?${s}` : "/planner";
  };
  const onToday = days.some((d) => d.isToday);

  return (
    <>
      <PageHead title="Planner" sub="Who is on what, day by day, and what is due now. A load runs from its first pickup window to its last delivery window.">
        <Link href={`/planner?start=${key(-1)}`} className="tl-btn">Earlier week</Link>
        <Link href="/planner" className="tl-btn" aria-current={onToday ? "true" : undefined}>Today</Link>
        <Link href={`/planner?start=${key(1)}`} className="tl-btn">Later week</Link>
      </PageHead>

      <Card title={`Due now · ${watchlist.length}`} className="tl-card">
        {watchlist.length === 0 ? (
          <EmptyState icon="check" title="Nothing is due or overdue">No stop is past its window, due today or coming up tomorrow.</EmptyState>
        ) : (
          <DueNow items={watchlist} now={now} />
        )}
      </Card>

      <div className="pl-head">
        <h2>
          {days[0]!.label} to {days[6]!.label}
        </h2>
        <span className="tl-sub">
          {trayCount} {trayCount === 1 ? "load needs" : "loads need"} a driver
          {conflicts > 0 ? ` · ${conflicts} double-booked` : ""}
        </span>
        <span className="pl-key" aria-hidden="true">
          <i className="draft" /> assigned, not sent <i className="accepted" /> sent or accepted <i className="in_progress" /> on the road <i className="done" /> delivered
        </span>
      </div>
      <form className="pl-find" action="/planner" method="get" role="search" style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 10px", flexWrap: "wrap" }}>
        {searchParams?.start ? <input type="hidden" name="start" value={searchParams.start} /> : null}
        {showIdle ? <input type="hidden" name="idle" value="1" /> : null}
        {everyone ? <input type="hidden" name="else" value="1" /> : null}
        <label className="db-sr-only" htmlFor="pl-q">Find a driver</label>
        <input id="pl-q" type="search" name="q" defaultValue={q} placeholder="Find a driver or code" autoComplete="off" />
        <button type="submit" className="tl-btn sm">Find</button>
        <span className="tl-sub">
          {pool.length} {pool.length === 1 ? "driver" : "drivers"}{showIdle ? "" : " with work or on shift this week"}
          {idleCount > 0 ? <> · <Link href={href({ idle: !showIdle, page: 1 })}>{showIdle ? "Only drivers with work or on shift" : `Show the ${idleCount} off or with no schedule`}</Link></> : null}
          {scope ? <> · {everyone ? <Link href={href({ elsewhere: false, page: 1 })}>Only {scope} drivers</Link> : <Link href={href({ elsewhere: true, page: 1 })}>Include drivers based elsewhere{hiddenElsewhere > 0 ? ` (${hiddenElsewhere} ${hiddenElsewhere === 1 ? "load" : "loads"} held by them)` : ""}</Link>}</> : null}
          {unscheduled > 0 ? <> · <Link href="/schedules">{unscheduled} {unscheduled === 1 ? "driver has" : "drivers have"} no schedule</Link></> : null}
        </span>
      </form>
      <PlannerGrid days={days} rows={shownRows} tray={tray} balance={balance} tz={tz} />
      <Pager page={page} pageSize={ROWS_PER_PAGE} total={pool.length} hrefFor={(n) => href({ page: n })} newer="Previous drivers" older="More drivers" />
      {untimed.length > 0 ? (
        <Card title={`No times yet · ${untimed.length}`} className="tl-card">
          <p className="tl-note" style={{ marginBottom: 10 }}>These loads have no pickup or delivery time, so they cannot sit on a day. Add the times from the load.</p>
          <ul className="feed">
            {untimed.map((u) => (
              <li key={u.loadId}>
                <Link href={`/loads/${u.loadId}`}>
                  <b>{u.loadNumber ?? "Load"}</b> · {u.lane}
                </Link>
                <span className="tl-sub"> {u.driverName ? `${u.driverName}` : "needs a driver"}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
