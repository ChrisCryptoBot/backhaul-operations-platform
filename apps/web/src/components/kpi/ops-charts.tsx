"use client";

import React from "react";
import type { KpiOpsAnalytics } from "@/contracts/kpi";

/**
 * Hand-rolled SVG/CSS ops-analytics charts (no chart library). Color follows the
 * art-direction rule: blue accent = data ink (measurement), green/red = verdict,
 * amber = the config watch band, neutral = structural/expected. Every verdict also
 * carries a glyph/label so color is never the only signal.
 */

type Leaderboard = KpiOpsAnalytics["shuttleLeaderboard"];
type DeadheadSplit = KpiOpsAnalytics["deadheadSplit"];
type DeadheadRadius = KpiOpsAnalytics["deadheadRadius"];

function niceCeil(value: number, step: number): number {
  return Math.max(step, Math.ceil(value / step) * step);
}

// ── Hero: shuttle empty-mile leaderboard (V1 ranked threshold bars) ───────────

type LeaderboardMode = "pct" | "mi";

export function ShuttleLeaderboard({
  rows,
  emptyPctAmber,
  emptyPctRed
}: {
  rows: Leaderboard;
  emptyPctAmber: number;
  emptyPctRed: number;
}) {
  const [mode, setMode] = React.useState<LeaderboardMode>("pct");

  if (rows.length === 0) {
    return <div className="db-chart-empty">No shuttle legs this week — nothing to attribute.</div>;
  }

  const valueOf = (r: Leaderboard[number]) => (mode === "pct" ? r.emptyPct : r.deadheadMiles);
  // Worst-first by the metric currently on screen (deadhead miles can tie; empty % rarely does).
  const ranked = [...rows].sort((a, b) => valueOf(b) - valueOf(a));
  const maxValue = Math.max(...ranked.map(valueOf));
  // Percent mode scales against the red threshold so the ticks stay meaningful.
  const scaleMax = mode === "pct" ? niceCeil(Math.max(maxValue, emptyPctRed), 5) : niceCeil(maxValue, 10);
  const regionAvg =
    mode === "pct"
      ? (() => {
          const dh = rows.reduce((s, r) => s + r.deadheadMiles, 0);
          const loaded = rows.reduce((s, r) => s + r.loadedMiles, 0);
          return dh + loaded > 0 ? (dh / (dh + loaded)) * 100 : 0;
        })()
      : rows.reduce((s, r) => s + r.deadheadMiles, 0) / rows.length;

  const pos = (v: number) => `${Math.min(100, (v / scaleMax) * 100)}%`;
  const unit = mode === "pct" ? "%" : " mi";
  const fmt = (v: number) => (mode === "pct" ? `${v.toFixed(1)}%` : `${Math.round(v)} mi`);

  const verdict = (r: Leaderboard[number]): { label: string; cls: string } => {
    if (mode !== "pct") return { label: "", cls: "" };
    if (r.emptyPct >= emptyPctRed) return { label: "OVER RED", cls: "neg" };
    if (r.emptyPct >= emptyPctAmber) return { label: "WATCH", cls: "warn" };
    return { label: "OK", cls: "ok" };
  };

  return (
    <div className="db-ldr">
      <div className="db-ldr-head">
        <div className="db-ldr-toggle" role="group" aria-label="Leaderboard metric">
          <button type="button" className={`db-ldr-toggle-btn ${mode === "pct" ? "active" : ""}`} onClick={() => setMode("pct")}>
            Empty %
          </button>
          <button type="button" className={`db-ldr-toggle-btn ${mode === "mi" ? "active" : ""}`} onClick={() => setMode("mi")}>
            Deadhead mi
          </button>
        </div>
      </div>
      <div className="db-ldr-rows">
        {ranked.map((r, i) => {
          const v = verdict(r);
          return (
            <div key={r.key} className="db-ldr-row">
              <span className="db-ldr-rank mono">{i + 1}</span>
              <span className="db-ldr-name">{r.driverName ?? "Unassigned"}</span>
              <span className="db-ldr-track">
                {/* threshold + region-avg ticks (percent mode only for thresholds) */}
                {mode === "pct" ? (
                  <>
                    <span className="db-ldr-tick warn" style={{ left: pos(emptyPctAmber) }} title={`Amber ${emptyPctAmber}%`} />
                    <span className="db-ldr-tick neg" style={{ left: pos(emptyPctRed) }} title={`Red ${emptyPctRed}%`} />
                  </>
                ) : null}
                <span className="db-ldr-tick avg" style={{ left: pos(regionAvg) }} title={`Region avg ${fmt(regionAvg)}`} />
                <span className={`db-ldr-fill ${v.cls || "ink"}`} style={{ width: pos(valueOf(r)) }} />
              </span>
              <span className="db-ldr-value mono">{fmt(valueOf(r))}</span>
              {v.label ? <span className={`db-ops-chip ${v.cls}`}>{v.label}</span> : <span className="db-ops-chip-spacer" />}
            </div>
          );
        })}
      </div>
      <div className="db-ldr-foot dim">
        <span>
          Attributed empty{unit} · pickup DH → first shuttle leg, delivery DH → final delivery leg. SHUTTLE legs only — PTP
          deadhead-out to DCs is expected and excluded by design.
        </span>
        <span className="db-ldr-legend">
          <span className="db-legend-tick warn" /> amber {emptyPctAmber}%
          <span className="db-legend-tick neg" /> red {emptyPctRed}%
          <span className="db-legend-tick avg" /> region avg {fmt(regionAvg)}
        </span>
      </div>
    </div>
  );
}

// ── Deadhead split: controllable (shuttle, amber) vs expected (PTP, neutral) ──

export function DeadheadSplitChart({ split }: { split: DeadheadSplit }) {
  const rows = [
    { key: "controllable", label: "Controllable · shuttle", cls: "warn", pu: split.controllable.pickupDh, del: split.controllable.deliveryDh },
    { key: "expected", label: "Expected · PTP", cls: "neutral", pu: split.expected.pickupDh, del: split.expected.deliveryDh }
  ];
  const max = Math.max(1, ...rows.flatMap((r) => [r.pu, r.del]));
  const w = (v: number) => `${(v / max) * 100}%`;

  return (
    <div className="db-split">
      <div className="db-split-axis-label">
        <span>← Pickup DH</span>
        <span>Delivery DH →</span>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="db-split-row">
          <span className="db-split-lane dim">{r.label}</span>
          <span className="db-split-bars">
            <span className="db-split-side left">
              <span className="mono db-split-num">{Math.round(r.pu)}</span>
              <span className={`db-split-bar ${r.cls} left`} style={{ width: w(r.pu) }} />
            </span>
            <span className="db-split-axis" />
            <span className="db-split-side right">
              <span className={`db-split-bar ${r.cls} right`} style={{ width: w(r.del) }} />
              <span className="mono db-split-num">{Math.round(r.del)}</span>
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Avg shuttle deadhead radius: simple weekly line (no band, v1) ─────────────

export function DeadheadRadiusLine({ points }: { points: DeadheadRadius }) {
  if (points.length < 2) {
    return <div className="db-chart-empty">Not enough weeks to plot a radius trend yet.</div>;
  }
  const W = 620;
  const H = 150;
  const padX = 34;
  const padY = 18;
  const values = points.map((p) => p.avgRadius);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const span = maxV - minV || 1;
  const x = (i: number) => padX + (i / (points.length - 1)) * (W - padX * 2);
  const y = (v: number) => padY + (1 - (v - minV) / span) * (H - padY * 2);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.avgRadius).toFixed(1)}`).join(" ");
  const shortWeek = (w: string) => (w.split("-")[1] ?? w).toUpperCase();

  return (
    <svg
      width="100%"
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Weekly average shuttle deadhead radius trend"
    >
      <line x1={padX} y1={padY} x2={padX} y2={H - padY} stroke="var(--db-border-soft)" strokeWidth="1" />
      <line x1={padX} y1={H - padY} x2={W - padX} y2={H - padY} stroke="var(--db-border-soft)" strokeWidth="1" />
      <path d={path} fill="none" stroke="var(--db-accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => (
        <circle key={p.weekIso} cx={x(i)} cy={y(p.avgRadius)} r="2.5" fill="var(--db-accent)" />
      ))}
      <text x={padX} y={H - 4} className="mono" fontSize="9" fill="var(--db-fg-dim)">
        {shortWeek(points[0].weekIso)}
      </text>
      <text x={W - padX} y={H - 4} className="mono" fontSize="9" fill="var(--db-fg-dim)" textAnchor="end">
        {shortWeek(points[points.length - 1].weekIso)}
      </text>
      <text x={4} y={y(maxV) + 3} className="mono" fontSize="9" fill="var(--db-fg-dim)">
        {maxV.toFixed(0)}
      </text>
      <text x={4} y={y(minV) + 3} className="mono" fontSize="9" fill="var(--db-fg-dim)">
        {minV.toFixed(0)}
      </text>
    </svg>
  );
}

// ── Drivers tab body (composes the three charts) ─────────────────────────────

export function OpsDriversTab({ ops }: { ops: KpiOpsAnalytics }) {
  return (
    <div className="db-chart-group">
      <div className="db-chart-card" data-screen-label="Shuttle empty-mile leaderboard">
        <div className="db-chart-card-head">
          <span className="db-chart-card-title">Shuttle deadhead · driver leaderboard</span>
          <span className="db-chart-card-unit">worst-first · attributed empty miles</span>
        </div>
        <ShuttleLeaderboard
          rows={ops.shuttleLeaderboard}
          emptyPctAmber={ops.config.emptyPctAmber}
          emptyPctRed={ops.config.emptyPctRed}
        />
      </div>

      <div className="db-chart-row">
        <div className="db-chart-card" data-screen-label="Deadhead split per load">
          <div className="db-chart-card-head">
            <span className="db-chart-card-title">Deadhead split</span>
            <span className="db-chart-card-unit">total mi · pickup vs delivery</span>
          </div>
          <DeadheadSplitChart split={ops.deadheadSplit} />
        </div>
        <div className="db-chart-card" data-screen-label="Avg shuttle deadhead radius">
          <div className="db-chart-card-head">
            <span className="db-chart-card-title">Avg shuttle deadhead radius</span>
            <span className="db-chart-card-unit">avg pickup DH on shuttle loads · weekly</span>
          </div>
          <DeadheadRadiusLine points={ops.deadheadRadius} />
        </div>
      </div>
    </div>
  );
}
