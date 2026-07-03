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
type Reliability = KpiOpsAnalytics["reliability"];
type OnTimeBucket = Reliability["otd"];
type DisruptionBreakdown = KpiOpsAnalytics["disruptionBreakdown"];
type RateVarianceHistogram = KpiOpsAnalytics["rateVarianceHistogram"];
type Growth = KpiOpsAnalytics["growth"];

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

// ── Reliability bullet cards (OTD / OTP / firm-appt / missed) ─────────────────

function ReliabilityBullet({
  label,
  bucket,
  target,
  lowerIsBetter = false,
  scaleMin,
  scaleMax
}: {
  label: string;
  bucket: OnTimeBucket | { missed: number; total: number; unverified: number };
  target: number;
  lowerIsBetter?: boolean;
  scaleMin: number;
  scaleMax: number;
}) {
  const numerator = "onTime" in bucket ? bucket.onTime : bucket.missed;
  const { total, unverified } = bucket;
  const pct = total > 0 ? (numerator / total) * 100 : null;
  const clampPos = (v: number) => Math.max(0, Math.min(100, ((v - scaleMin) / (scaleMax - scaleMin)) * 100));
  const pass = pct === null ? null : lowerIsBetter ? pct <= target : pct >= target;

  return (
    <div className="db-bullet" data-screen-label={`Reliability ${label}`}>
      <div className="db-bullet-head">
        <span className="db-bullet-label">{label}</span>
        {pass === null ? (
          <span className="db-ops-chip">—</span>
        ) : (
          <span className={`db-ops-chip ${pass ? "ok" : "neg"}`}>{pass ? "✓" : "✗"}</span>
        )}
      </div>
      <div className="db-bullet-value mono">{pct === null ? "—" : `${pct.toFixed(1)}%`}</div>
      <div className="db-bullet-track">
        <span className="db-bullet-fill" style={{ left: `${clampPos(scaleMin)}%`, width: pct === null ? "0%" : `${clampPos(pct)}%` }} />
        <span className="db-bullet-target" style={{ left: `${clampPos(target)}%` }} title={`Target ${target}%`} />
      </div>
      <div className="db-bullet-foot dim mono">
        <span>
          {numerator}/{total} verified
        </span>
        <span>
          {lowerIsBetter ? "lower is better · " : ""}unverified: {unverified}
        </span>
      </div>
    </div>
  );
}

// ── Cancel & reschedule reason breakdown (paired columns over the 9 reasons) ──

export function DisruptionBreakdownChart({ breakdown }: { breakdown: DisruptionBreakdown }) {
  const active = breakdown.reasons.filter((r) => r.cancel > 0 || r.reschedule > 0);
  const max = Math.max(1, ...active.map((r) => Math.max(r.cancel, r.reschedule)));
  const w = (v: number) => `${(v / max) * 100}%`;

  return (
    <div className="db-reasons">
      <div className="db-reasons-head">
        <span className="db-legend-item">
          <span className="db-legend-sw" style={{ background: "var(--db-neg)" }} /> Cancels
        </span>
        <span className="db-legend-item">
          <span className="db-legend-sw" style={{ background: "var(--db-warn)" }} /> Reschedules
        </span>
        {breakdown.trackedFromWeekIso ? (
          <span className="db-reasons-tracked dim mono">
            Tracked from {(breakdown.trackedFromWeekIso.split("-")[1] ?? breakdown.trackedFromWeekIso).toUpperCase()}
          </span>
        ) : null}
      </div>
      {active.length === 0 ? (
        <div className="db-chart-empty">No cancels or reschedules recorded this week.</div>
      ) : (
        <div className="db-reasons-rows">
          {active.map((r) => (
            <div key={r.reason} className="db-reasons-row">
              <span className="db-reasons-label dim">{r.label}</span>
              <span className="db-reasons-bars">
                <span className="db-reasons-bar-line">
                  <span className="db-reasons-bar neg" style={{ width: w(r.cancel) }} />
                  <span className="mono db-reasons-num">{r.cancel}</span>
                </span>
                <span className="db-reasons-bar-line">
                  <span className="db-reasons-bar warn" style={{ width: w(r.reschedule) }} />
                  <span className="mono db-reasons-num">{r.reschedule}</span>
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Reliability tab body ─────────────────────────────────────────────────────

export function OpsReliabilityTab({ ops }: { ops: KpiOpsAnalytics }) {
  const r = ops.reliability;
  const target = ops.config.onTimeTargetPct;
  return (
    <div className="db-chart-group">
      <div className="db-chart-card" data-screen-label="On-time reliability">
        <div className="db-chart-card-head">
          <span className="db-chart-card-title">On-time reliability</span>
          <span className="db-chart-card-unit">% of verified loads · target {target}%</span>
        </div>
        <div className="db-bullet-grid">
          <ReliabilityBullet label="On-Time Delivery" bucket={r.otd} target={target} scaleMin={80} scaleMax={100} />
          <ReliabilityBullet label="On-Time Pickup" bucket={r.otp} target={target} scaleMin={80} scaleMax={100} />
          <ReliabilityBullet label="Firm Appt On-Time" bucket={r.firmAppt} target={target} scaleMin={80} scaleMax={100} />
          <ReliabilityBullet label="Missed Appointments" bucket={r.missed} target={2} lowerIsBetter scaleMin={0} scaleMax={8} />
        </div>
      </div>
      <div className="db-chart-card" data-screen-label="Cancel and reschedule reasons">
        <div className="db-chart-card-head">
          <span className="db-chart-card-title">Cancel &amp; reschedule reasons</span>
          <span className="db-chart-card-unit">counts · why loads slipped</span>
        </div>
        <DisruptionBreakdownChart breakdown={ops.disruptionBreakdown} />
      </div>
    </div>
  );
}

// ── Rate-vs-target variance histogram ($100 bins) ─────────────────────────────

export function RateVarianceHistogramChart({ hist }: { hist: RateVarianceHistogram }) {
  if (hist.count === 0 || hist.bins.length === 0) {
    return <div className="db-chart-empty">No rated loads with a lane target this week.</div>;
  }
  const W = 620;
  const H = 190;
  const padL = 10;
  const padR = 10;
  const padTop = 12;
  const padBottom = 26;
  const plotW = W - padL - padR;
  const plotH = H - padTop - padBottom;
  const n = hist.bins.length;
  const bw = plotW / n;
  const maxCount = Math.max(...hist.bins.map((b) => b.count));
  const xAt = (dollars: number) => {
    const lo = hist.bins[0].lo;
    return padL + ((dollars - lo) / (n * hist.binSize)) * plotW;
  };
  const zeroX = xAt(0);
  const medianX = hist.median === null ? null : xAt(hist.median);
  const baseY = padTop + plotH;

  return (
    <svg
      width="100%"
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Histogram of per-load dollar variance versus lane target"
    >
      <line x1={padL} y1={baseY} x2={W - padR} y2={baseY} stroke="var(--db-border-soft)" strokeWidth="1" />
      {hist.bins.map((b, i) => {
        const h = maxCount > 0 ? (b.count / maxCount) * plotH : 0;
        const x = padL + i * bw;
        return (
          <rect
            key={b.lo}
            x={x + 1}
            y={baseY - h}
            width={Math.max(0, bw - 2)}
            height={h}
            fill={b.underTarget ? "var(--db-neg)" : "var(--db-accent)"}
            opacity={b.count === 0 ? 0.15 : 0.9}
          />
        );
      })}
      {/* $0 target line */}
      <line x1={zeroX} y1={padTop - 4} x2={zeroX} y2={baseY} stroke="var(--db-fg)" strokeWidth="1.5" />
      <text x={zeroX} y={padTop - 6} className="mono" fontSize="9" fill="var(--db-fg)" textAnchor="middle">
        $0
      </text>
      {/* median marker */}
      {medianX !== null ? (
        <>
          <line x1={medianX} y1={padTop} x2={medianX} y2={baseY} stroke="var(--db-fg-dim)" strokeWidth="1" strokeDasharray="3 3" />
          <text x={medianX} y={baseY + 11} className="mono" fontSize="9" fill="var(--db-fg-dim)" textAnchor="middle">
            median ${Math.round(hist.median ?? 0)}
          </text>
        </>
      ) : null}
      <text x={padL} y={baseY + 11} className="mono" fontSize="9" fill="var(--db-fg-dim)">
        ${hist.bins[0].lo}
      </text>
      <text x={W - padR} y={baseY + 11} className="mono" fontSize="9" fill="var(--db-fg-dim)" textAnchor="end">
        ${hist.bins[n - 1].hi}
      </text>
    </svg>
  );
}

// ── Volume & revenue growth (diverging WoW % columns) ─────────────────────────

export function GrowthBars({ growth }: { growth: Growth }) {
  const rows = [
    { key: "loads", label: "Load volume", pct: growth.loadCount.pct },
    { key: "revenue", label: "Line-haul revenue", pct: growth.lineHaulRevenue.pct }
  ];
  const max = Math.max(5, ...rows.map((r) => Math.abs(r.pct ?? 0)));
  return (
    <div className="db-growth">
      {rows.map((r) => {
        const pct = r.pct;
        const half = pct === null ? 0 : (Math.abs(pct) / max) * 50;
        const positive = (pct ?? 0) >= 0;
        return (
          <div key={r.key} className="db-growth-row">
            <span className="db-growth-label dim">{r.label}</span>
            <span className="db-growth-track">
              <span className="db-growth-axis" />
              {pct === null ? (
                <span className="db-growth-na dim mono">no prior</span>
              ) : (
                <span
                  className={`db-growth-bar ${positive ? "pos" : "neg"}`}
                  style={{ left: positive ? "50%" : `${50 - half}%`, width: `${half}%` }}
                />
              )}
            </span>
            <span className={`db-growth-val mono ${pct === null ? "dim" : positive ? "pos" : "neg"}`}>
              {pct === null ? "—" : `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`}
            </span>
          </div>
        );
      })}
    </div>
  );
}
