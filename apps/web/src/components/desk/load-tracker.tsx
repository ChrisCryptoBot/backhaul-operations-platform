import Link from "next/link";
import React from "react";
import type { LoadTracking } from "@/server/tl/load-tracking";

/**
 * Where it is: the load's lane drawn as a corridor from the pickup to the delivery, the truck's breadcrumb along it and its marker where the ELD last put it, with the speed, road, miles to go, ETA
 * and whether that is on schedule. A truck inside a mile of a stop gets the green geofence line. Drawn as plain SVG from the desk's tokens (no map library in the drawer), and it only shows: it
 * writes no arrival, because detention and money depend on what a person or the driver's phone says.
 */
const W = 640;
const H = 250;
const PAD = 40;

type Pt = { lat: number; lng: number };

function projector(points: Pt[]) {
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const k = Math.cos((midLat * Math.PI) / 180);
  const dx = Math.max((Math.max(...lngs) - Math.min(...lngs)) * k, 0.01);
  const dy = Math.max(Math.max(...lats) - Math.min(...lats), 0.01);
  const s = Math.min((W - 2 * PAD) / dx, (H - 2 * PAD) / dy);
  const cx = (Math.min(...lngs) + Math.max(...lngs)) / 2;
  const cy = (Math.min(...lats) + Math.max(...lats)) / 2;
  return (p: Pt) => ({ x: W / 2 + (p.lng - cx) * k * s, y: H / 2 - (p.lat - cy) * s });
}

const ago = (iso: string) => {
  const m = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m ago`;
};

export function LoadTracker({ t }: { t: LoadTracking }) {
  if (t.status === "no_truck") return <p className="tl-note">No truck is on this load yet. Put one on it to see where it is.</p>;
  if (t.status === "no_lane") return <p className="tl-note">{t.truckName} is on this load, but its stops have no places yet, so there is no lane to draw. Open Route &amp; Stops and check the addresses.</p>;
  if (t.status === "no_position")
    return (
      <p className="tl-note">
        {t.truckName} has not reported a position yet. Connect an ELD in <Link href="/settings?tab=integrations">Settings</Link>, or read it now from Trucks.
      </p>
    );

  const everything: Pt[] = [...t.stops, ...t.trail, t.position];
  const at = projector(everything);
  const corridor = t.stops.map((s) => at(s));
  const crumbs = t.trail.map((p) => at(p));
  const truck = at(t.position);
  const insideStops = new Set(t.geofences.filter((g) => g.inside).map((g) => g.stop));
  const tone = t.position.state === "moving_load" || t.position.state === "moving" ? "var(--label)" : t.position.state === "idling" ? "var(--warn-fill)" : "var(--dim)";
  const heading = t.position.state === "moving_load" || t.position.state === "moving" ? t.position.headingDeg : null;

  return (
    <div className="lt">
      <p className={`lt-head${t.late ? " lt-late" : ""}`}>{t.headline}</p>
      <svg viewBox={`0 0 ${W} ${H}`} className="lt-svg" role="img" aria-label={`${t.truckName}: ${t.headline}`}>
        <polyline points={corridor.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")} fill="none" strokeDasharray="5 4" style={{ stroke: "var(--line-hi)", strokeWidth: 1 }} />
        {crumbs.length > 1 ? <polyline points={crumbs.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")} fill="none" style={{ stroke: "var(--label)", strokeWidth: 2 }} /> : null}
        {t.stops.map((s, i) => {
          const p = corridor[i]!;
          const last = i === t.stops.length - 1;
          return (
            <g key={s.sequence}>
              {insideStops.has(s.sequence) ? <rect x={p.x - 12} y={p.y - 12} width={24} height={24} fill="none" style={{ stroke: "var(--pos-fill)", strokeWidth: 2 }} /> : null}
              <rect x={p.x - 5} y={p.y - 5} width={10} height={10} style={{ stroke: "var(--ink)", strokeWidth: 2, fill: last ? "var(--ink)" : "none" }} />
              <text x={p.x + 10} y={p.y - 9} style={{ fill: "var(--mid)", font: "500 11px var(--mono)" }}>
                {`${s.role === "pickup" ? "PICKUP" : s.role === "delivery" ? "DELIVERY" : "STOP"} · ${s.label}`}
              </text>
            </g>
          );
        })}
        <g transform={heading != null ? `rotate(${heading} ${truck.x.toFixed(1)} ${truck.y.toFixed(1)})` : undefined}>
          <rect x={truck.x - 6} y={truck.y - 6} width={12} height={12} style={{ fill: tone, stroke: "var(--bg)", strokeWidth: 2 }} />
          {heading != null ? <polygon points={`${truck.x.toFixed(1)},${(truck.y - 16).toFixed(1)} ${(truck.x + 6).toFixed(1)},${(truck.y - 7).toFixed(1)} ${(truck.x - 6).toFixed(1)},${(truck.y - 7).toFixed(1)}`} style={{ fill: tone }} /> : null}
        </g>
        <text x={truck.x + 12} y={truck.y + 20} style={{ fill: "var(--ink)", font: "600 11px var(--mono)" }}>
          {t.truckName}
        </text>
      </svg>
      {t.geofences.map((g) => (
        <p key={g.stop} className="lt-geo">{`✔ ${g.text}`}</p>
      ))}
      <p className="lt-sub">Last fix {ago(t.asOf)}. Shown from the ELD; it does not record an arrival on the stop.</p>
    </div>
  );
}
