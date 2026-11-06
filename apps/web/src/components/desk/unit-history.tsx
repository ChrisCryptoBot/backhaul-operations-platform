import Link from "next/link";
import React from "react";
import { HISTORY_RANGES, byDay, type HistoryEntry, type HistoryKind } from "@/lib/asset-history";
import { dayYear } from "@/lib/desk-format";
import { activeTz, zoneAbbr } from "@/lib/tz";
import { Card } from "./ui";
import { CanGate } from "./kit/can-gate";
import { CheckCallForm, RemoveCheckCall } from "./check-call-form";

/**
 * The History tab of a truck or a trailer: a check-call form on top, then everything the desk knows about where the unit has been and when, a day at a time, newest first. A tractor's stays and a
 * trailer's hooks are kept from the day they began being written, so the screen says so rather than showing an empty week as if nothing happened.
 */
const KIND: Record<HistoryKind, string> = { stay: "Stopped", call: "Call", arrival: "Arrived", load: "Load", hooked: "Hooked", dropped: "Dropped" };

const timeOf = (ms: number): string => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: activeTz() });

function when(e: HistoryEntry): string {
  if (e.until == null || (e.kind !== "stay" && e.kind !== "dropped")) return timeOf(e.at);
  return e.ongoing ? `${timeOf(e.at)} → now` : `${timeOf(e.at)} → ${new Date(e.until).toDateString() === new Date(e.at).toDateString() ? timeOf(e.until) : `${dayYear(new Date(e.until))} ${timeOf(e.until)}`}`;
}

export function UnitHistoryPanel({ unit, entries, days, openLoads, clock, basePath }: { unit: { kind: "truck" | "trailer"; id: string; name: string }; entries: HistoryEntry[]; days: number; openLoads: Array<{ id: string; number: string }>; clock: string; basePath: string }) {
  const groups = byDay(entries, (ms) => dayYear(new Date(ms)));
  return (
    <div id="panel-history" role="tabpanel" aria-labelledby="tab-history">
      <Card title="Log a check call">
        <CanGate caps={["dispatch"]} banner who="A dispatcher" what="check calls">
          <CheckCallForm unit={unit} openLoads={openLoads} clock={clock} />
        </CanGate>
      </Card>

      <div className="eq-range" role="group" aria-label="How far back" style={{ margin: "14px 0 10px", display: "flex", gap: 6, alignItems: "center" }}>
        <span className="tk-label">History</span>
        {HISTORY_RANGES.map((r) => (
          <Link key={r.days} href={`${basePath}?tab=history&days=${r.days}`} replace scroll={false} className={`tl-btn sm${r.days === days ? " primary" : " ghost"}`} aria-current={r.days === days ? "true" : undefined}>
            {r.label}
          </Link>
        ))}
        <span className="tl-sub" style={{ marginLeft: 8 }}>{entries.length} {entries.length === 1 ? "entry" : "entries"} · times on the {zoneAbbr(activeTz())} clock</span>
      </div>

      {groups.length === 0 ? (
        <Card>
          <p className="tl-note">Nothing recorded for the last {days} days. {unit.kind === "truck" ? "A tractor's stops are kept from the first ELD read after this was switched on, and its stops for loads as they are reached." : "A trailer's hooks and drops are kept from the day this was switched on."} Check calls appear as soon as one is logged.</p>
        </Card>
      ) : (
        groups.map((g) => (
          <Card key={g.day} title={g.day}>
            <table className="tl-table" aria-label={`History for ${g.day}`}>
              <tbody>
                {g.entries.map((e) => (
                  <tr key={e.key}>
                    <td style={{ whiteSpace: "nowrap" }}>{when(e)}</td>
                    <td>
                      <span className={`tl-chip ${e.kind === "call" ? "info" : "muted"}`}>{KIND[e.kind]}</span>
                    </td>
                    <td>
                      <div>{e.href ? <Link href={e.href}>{e.title}</Link> : e.title}</div>
                      {e.detail ? <div className="tl-sub">{e.detail}</div> : null}
                      {e.meta ? <div className="tl-sub">{e.meta}</div> : null}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {e.kind === "call" ? (
                        <CanGate caps={["dispatch"]}>
                          <RemoveCheckCall id={e.key.slice("call:".length)} />
                        </CanGate>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ))
      )}
    </div>
  );
}
