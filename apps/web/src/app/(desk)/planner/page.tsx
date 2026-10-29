import Link from "next/link";
import React from "react";
import { getPlannerData } from "@/server/tl/planner";
import { Card, PageHead } from "@/components/desk/ui";
import { DueNow, PlannerGrid } from "@/components/desk/planner-parts";
import { EmptyState } from "@/components/desk/kit/states";
import { planDays } from "@/lib/planner";
import { parseCentralLocal } from "@/lib/zoned";

const WEEK = 7 * 86_400_000;

/** Who is on what, day by day, and what is due now. `?start=2026-10-26` starts the week on another day. */
export default async function PlannerPage({ searchParams }: { searchParams?: { start?: string } }) {
  const now = Date.now();
  const from = (searchParams?.start ? parseCentralLocal(`${searchParams.start}T12:00`) : null) ?? now;
  const { days, rows, tray, watchlist } = await getPlannerData(from, now, 7);
  // Noon, so a day with a clock change in it cannot tip the neighbour week's key onto the wrong date.
  const key = (weeks: number) => planDays(days[0]!.start + weeks * WEEK + 12 * 3_600_000, 1, now)[0]!.key;
  const trayCount = new Set(tray.flat().map((i) => i.loadId)).size;
  const conflicts = new Set(rows.flatMap((r) => r.cells.flat()).filter((i) => i.conflict).map((i) => i.loadId)).size;
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
      <PlannerGrid days={days} rows={rows} tray={tray} />
    </>
  );
}
