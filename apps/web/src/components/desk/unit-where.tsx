import Link from "next/link";
import React from "react";
import type { UnitWhere } from "@/lib/whereabouts";
import { Card } from "./ui";
import { StaleFix } from "./kit/stale-fix";
import { UnitMap } from "./radar-map";

/**
 * The Where-it-is tab of a truck or a trailer: the place in words first, then the facts a dispatcher locating equipment asks for (who has it, what it is on, what it is hooked to, what
 * it is costing), and a map of its last position. Read only; every line is from what the desk already stores, and a line with nothing behind it is left out rather than guessed.
 */
export function UnitWherePanel({ u }: { u: UnitWhere }) {
  const w = u.where;
  // What an old fix read is what was true then: the labels say so, and the place is where it was last seen. A dropped trailer stands where it was left.
  const old = w?.stale === true && !(u.kind === "trailer" && !u.hitched);
  const rows: Array<{ k: string; v: React.ReactNode }> = [];
  if (u.driver) rows.push({ k: "Driver", v: u.driver });
  if (u.load) rows.push({ k: "On load", v: <><Link href={`/loads/${u.load.id}`}>{u.load.number}</Link>{u.load.route ? ` · ${u.load.route}` : ""}</> });
  if (u.hitched) rows.push({ k: u.hitched.kind === "trailer" ? "Pulling" : "Hooked to", v: u.hitched.id ? <Link href={u.hitched.kind === "trailer" ? `/trailers/${u.hitched.id}` : `/fleet/${u.hitched.id}`}>{u.hitched.name}</Link> : u.hitched.name });
  if (u.idle) rows.push({ k: old ? "Idle when last read" : "Idle", v: <span className="rd-leak">{`■ ${u.idle}`}</span> });
  if (u.dwell) rows.push({ k: "Dwell", v: <span className="rd-leak">{`■ ${u.dwell}`}</span> });
  if (u.typedPlace) rows.push({ k: "Noted as", v: u.typedPlace });
  if (w?.nearestStop) rows.push({ k: "Nearest stop on file", v: `${w.nearestStop.name} · ${w.nearestStop.miles} mi` });
  if (w?.town && !w.label.includes(w.town)) rows.push({ k: "Nearest town", v: w.town });

  return (
    <div id="panel-where" role="tabpanel" aria-labelledby="tab-where">
      <section className="tk-hero" aria-label="Where it is">
        <div>
          <div className="tk-label">{old ? "Last seen" : "Where it is"}</div>
          <div className="qt-big">{w ? w.label : "No position yet"}</div>
          <p className="tl-sub" style={{ marginTop: 6 }}>
            {w ? [w.coords, w.ageText && !old ? `last fix ${w.ageText}` : null].filter(Boolean).join(" · ") : "It shows here as soon as an ELD reports where it is."}
          </p>
          {old && w?.ageMinutes != null ? <StaleFix minutes={w.ageMinutes}>It may have moved since.</StaleFix> : null}
        </div>
        <dl className="tk-facts">
          <div>
            <dt>{old ? "Status then" : "Status"}</dt>
            <dd>{u.state ?? "No signal"}</dd>
          </div>
          <div>
            <dt>{old ? "Speed then" : "Speed"}</dt>
            <dd>{u.speed ?? (w ? "Standing" : "—")}</dd>
          </div>
          <div>
            <dt>{old ? "Road then" : "Road"}</dt>
            <dd>{w?.road ?? "—"}</dd>
          </div>
        </dl>
      </section>
      <div className="tl-grid cols-2" style={{ marginTop: 14 }}>
        <Card title={old ? "On file" : "Right now"}>
          {rows.length === 0 ? (
            <p className="tl-note">Nothing else is attached to it at the moment.</p>
          ) : (
            <dl className="tl-kv">
              {rows.map(({ k, v }) => (
                <React.Fragment key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </React.Fragment>
              ))}
            </dl>
          )}
          <p className="tl-note" style={{ marginTop: 10 }}>
            A named place comes from the stops of your own loads: a unit that is standing within 300 metres of one is &ldquo;at&rdquo; it. Anywhere else the nearest town is named. A truck passing a dock is never called &ldquo;at&rdquo; it.
          </p>
        </Card>
        <Card title="On the map">
          {u.lat != null && u.lng != null ? <UnitMap unit={{ id: u.id, kind: u.kind, name: u.name, lat: u.lat, lng: u.lng, icon: u.icon, headingDeg: u.headingDeg }} /> : <p className="tl-note">There is no position to draw yet.</p>}
        </Card>
      </div>
    </div>
  );
}
