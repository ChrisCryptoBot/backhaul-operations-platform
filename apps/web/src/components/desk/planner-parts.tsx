import Link from "next/link";
import React from "react";
import type { DayCol, DueItem, PlannerItem, PlannerRow } from "@/lib/planner";
import { spanText, timeText } from "@/lib/planner";
import { dateTime } from "@/lib/desk-format";
import { Icon } from "./kit/icons";

const STATE_LABEL: Record<DueItem["state"], string> = { past_due: "Past due", today: "Due today", upcoming: "Coming up", done: "Reached today" };
const clock = (d: Date) => new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });

function dueWords(i: DueItem, now: number): string {
  if (i.state === "past_due") return `The window closed at ${clock(i.due)}; ${spanText(i.minutesOver ?? 0)} over and nobody has arrived`;
  if (i.state === "today") return `Due by ${clock(i.due)}, in ${spanText((i.due.getTime() - now) / 60_000)}`;
  if (i.state === "upcoming") return `Due ${dateTime(i.due)}`;
  return i.late ? `Arrived ${clock(i.arrivedAt!)}, ${spanText(i.minutesLate ?? 0)} after the window closed` : `Arrived ${clock(i.arrivedAt!)}, on time`;
}

/** The stops that need eyes now, each with a bar in its priority colour: past due, due today, coming up, reached today. */
export function DueNow({ items, now }: { items: DueItem[]; now: number }) {
  return (
    <div>
      <div className="wl-key" aria-hidden="true">
        {(["past_due", "today", "upcoming", "done"] as const).map((s) => (
          <span key={s}>
            <i className={s} /> {STATE_LABEL[s]}
          </span>
        ))}
      </div>
      <ul className="wl">
        {items.map((i) => (
          <li key={`${i.loadId}-${i.stopRole}-${i.due.getTime()}`} className={`wl-row ${i.state}`}>
            <span className="wl-bar" aria-hidden="true" />
            <div className="wl-main">
              <div>
                <Link href={`/loads/${i.loadId}`}>{i.loadNumber}</Link> · <span style={{ textTransform: "capitalize" }}>{i.stopRole}</span> · {i.city}
                {i.driverName ? <span className="tl-sub"> · {i.driverName}</span> : <span className="tl-sub"> · no driver</span>}
              </div>
              <div className="wl-sub">{dueWords(i, now)}</div>
            </div>
            <span className={`tl-chip ${i.state === "past_due" ? "bad" : i.state === "today" ? "warn" : i.state === "upcoming" ? "info" : i.late ? "warn" : "ok"}`}>{i.state === "done" ? (i.late ? "Late" : "On time") : STATE_LABEL[i.state]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Chip({ i }: { i: PlannerItem }) {
  const cls = ["pl-load", i.status, i.conflict ? "conflict" : "", i.notSent ? "notsent" : "", i.done ? "done" : ""].filter(Boolean).join(" ");
  return (
    <Link href={`/loads/${i.loadId}`} className={cls} title={`${i.loadNumber}: ${i.lane}${i.conflict ? ". The driver is on another load at the same time." : ""}${i.notSent ? " Assigned, not sent yet." : ""}`}>
      <b>
        {i.loadNumber}
        {i.conflict ? (
          <span className="pl-warn" role="img" aria-label="Double-booked">
            <Icon name="alert" size={13} />
          </span>
        ) : null}
      </b>
      <span>{i.lane}</span>
      <small>{timeText(i)}</small>
    </Link>
  );
}

/** Drivers down the side, days across the top, each load as a block in the cells it runs through. */
export function PlannerGrid({ days, rows, tray }: { days: DayCol[]; rows: PlannerRow[]; tray: PlannerItem[][] }) {
  return (
    <div className="pl-wrap">
      <table className="pl" aria-label="Loads by driver and day">
        <thead>
          <tr>
            <th scope="col" className="pl-who">Driver</th>
            {days.map((d) => (
              <th scope="col" key={d.key} className={d.isToday ? "today" : undefined}>
                {d.weekday} <span>{d.label}</span>
                {d.isToday ? <em>today</em> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="pl-tray">
            <th scope="row" className="pl-who">
              Needs a driver
              <span>{new Set(tray.flat().map((i) => i.loadId)).size} loads</span>
            </th>
            {tray.map((cell, i) => (
              <td key={days[i]!.key} className={days[i]!.isToday ? "today" : undefined}>
                {cell.map((x) => (
                  <Chip key={x.loadId} i={x} />
                ))}
              </td>
            ))}
          </tr>
          {rows.map((r) => (
            <tr key={r.driverId}>
              <th scope="row" className="pl-who">
                {r.name}
              </th>
              {r.cells.map((cell, i) => (
                <td key={days[i]!.key} className={days[i]!.isToday ? "today" : undefined}>
                  {cell.map((x) => (
                    <Chip key={x.loadId} i={x} />
                  ))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
