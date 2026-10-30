import Link from "next/link";
import React from "react";
import { getPlannerData } from "@/server/tl/planner";
import { currentTerminal } from "@/server/tl/terminal";
import { Card, PageHead } from "@/components/desk/ui";
import { DueNow, PlannerGrid } from "@/components/desk/planner-parts";
import { EmptyState } from "@/components/desk/kit/states";
import { planDays } from "@/lib/planner";
import { Pager } from "@/components/desk/pager";
import { asPage } from "@/lib/paging";
import { parseCentralLocal } from "@/lib/zoned";

const WEEK = 7 * 86_400_000;
/** Driver rows shown at a time: a big fleet has far more drivers than fit on a screen. */
const ROWS_PER_PAGE = 50;

/** Who is on what, day by day, and what is due now. `?start=2026-10-26` starts the week on another day. */
export default async function PlannerPage({ searchParams }: { searchParams?: { start?: string; q?: string; page?: string; idle?: string } }) {
  const now = Date.now();
  const from = (searchParams?.start ? parseCentralLocal(`${searchParams.start}T12:00`) : null) ?? now;
  const terminal = await currentTerminal();
  const { days, rows, tray, untimed, watchlist } = await getPlannerData(from, now, 7, undefined, terminal);
  // Noon, so a day with a clock change in it cannot tip the neighbour week's key onto the wrong date.
  const key = (weeks: number) => planDays(days[0]!.start + weeks * WEEK + 12 * 3_600_000, 1, now)[0]!.key;
  const trayCount = new Set(tray.flat().map((i) => i.loadId)).size;
  const conflicts = new Set(rows.flatMap((r) => r.cells.flat()).filter((i) => i.conflict).map((i) => i.loadId)).size;
  // Drivers with something this week come first and are the default view; the rest (nothing on the days shown) are one click away. Searched by name, a page at a time.
  const q = searchParams?.q?.trim() ?? "";
  const showIdle = searchParams?.idle === "1";
  const busy = rows.filter((r) => r.cells.some((c) => c.length > 0));
  const idleCount = rows.length - busy.length;
  const needle = q.toLowerCase();
  const pool = (showIdle ? rows : busy).filter((r) => !needle || r.name.toLowerCase().includes(needle));
  const page = Math.min(asPage(searchParams?.page), Math.max(1, Math.ceil(pool.length / ROWS_PER_PAGE)));
  const shownRows = pool.slice((page - 1) * ROWS_PER_PAGE, page * ROWS_PER_PAGE);
  const href = (p: { page?: number; idle?: boolean; q?: string }) => {
    const u = new URLSearchParams();
    if (searchParams?.start) u.set("start", searchParams.start);
    const text = p.q ?? q;
    if (text) u.set("q", text);
    if (p.idle ?? showIdle) u.set("idle", "1");
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
        <label className="db-sr-only" htmlFor="pl-q">Find a driver</label>
        <input id="pl-q" type="search" name="q" defaultValue={q} placeholder="Find a driver" autoComplete="off" />
        <button type="submit" className="tl-btn sm">Find</button>
        <span className="tl-sub">
          {pool.length} {pool.length === 1 ? "driver" : "drivers"}{showIdle ? "" : " with something this week"}
          {idleCount > 0 ? <> · <Link href={href({ idle: !showIdle, page: 1 })}>{showIdle ? "Only drivers with something this week" : `Show the ${idleCount} with nothing`}</Link></> : null}
        </span>
      </form>
      <PlannerGrid days={days} rows={shownRows} tray={tray} />
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
