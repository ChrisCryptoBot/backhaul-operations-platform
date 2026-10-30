"use client";

import React from "react";
import { sparkPath, sparkPoints } from "@/lib/kpi-view";
import { TipPopup, type TipData } from "../kit/tooltip";

export type TrendPanel = {
  title: string;
  unit: string;
  values: Array<number | null>;
  /** The same values as words ("$1,166", "18.6%"), one per week, null for a week with nothing to show. */
  texts: Array<string | null>;
};
export type TrendWeekTip = { label: string; tip: TipData };

const W = 220;
const H = 56;

/**
 * The four weekly charts. Point at one and the same week lights up in all four, with that week's figures in a tooltip and in each chart's readout line.
 * Arrow keys walk the weeks from the keyboard; Escape lets go. Every number shown here was worked out by the server (`trend`), nothing is recomputed in the browser.
 */
export function TrendGrid({ panels, weeks }: { panels: TrendPanel[]; weeks: TrendWeekTip[] }) {
  const n = weeks.length;
  const [active, setActive] = React.useState<{ i: number; anchor: DOMRect } | null>(null);
  const first = weeks[0]?.label;

  const at = (el: HTMLElement, i: number, panel: TrendPanel) => {
    const r = el.getBoundingClientRect();
    const pts = sparkPoints(panel.values, W, H);
    const x = (pts[i]?.x ?? (n <= 1 ? W / 2 : 3 + (i * (W - 6)) / (n - 1))) / W;
    setActive({ i, anchor: new DOMRect(r.left + x * r.width, r.top, 0, r.height) });
  };

  const fromPointer = (e: React.PointerEvent<HTMLDivElement>, panel: TrendPanel) => {
    const r = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    at(e.currentTarget, Math.round(frac * (n - 1)), panel);
  };

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>, panel: TrendPanel) => {
    const cur = active?.i ?? n - 1;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      at(e.currentTarget, Math.min(n - 1, Math.max(0, cur + (e.key === "ArrowRight" ? 1 : -1))), panel);
    } else if (e.key === "Escape") {
      setActive(null);
    }
  };

  return (
    <div className="sm-grid">
      {panels.map((p) => {
        const s = sparkPath(p.values, W, H);
        const pts = sparkPoints(p.values, W, H);
        const lastVal = [...p.texts].reverse().find((t) => t != null) ?? null;
        const i = active?.i ?? null;
        const pt = i == null ? null : pts[i];
        return (
          <figure className="sm" key={p.title}>
            <figcaption>
              {p.title} <span>{p.unit}</span>
            </figcaption>
            <div
              className="sm-plot"
              tabIndex={0}
              role="group"
              aria-label={`${p.title}, last twelve weeks${lastVal != null ? `, ending at ${lastVal}` : ""}. Use the left and right arrow keys to read each week.`}
              onPointerMove={(e) => fromPointer(e, p)}
              onPointerLeave={() => setActive(null)}
              onFocus={(e) => at(e.currentTarget, n - 1, p)}
              onBlur={() => setActive(null)}
              onKeyDown={(e) => onKey(e, p)}>
              <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                <line x1="0" x2={W} y1={H - 1} y2={H - 1} className="sm-base" />
                {s.d ? <path d={s.d} className="sm-line" /> : null}
              </svg>
              {i == null && s.last ? <i className="sm-end" style={{ left: `${(s.last.x / W) * 100}%`, top: `${(s.last.y / H) * 100}%` }} /> : null}
              {i != null && pts[i] ? <i className="sm-guide" style={{ left: `${(pts[i]!.x / W) * 100}%` }} /> : null}
              {pt ? <i className="sm-end live" style={{ left: `${(pt.x / W) * 100}%`, top: `${(pt.y / H) * 100}%` }} /> : null}
            </div>
            <div className="sm-ends">
              <span>{i == null ? first : weeks[i]?.label}</span>
              <b>{i == null ? (lastVal ?? "—") : (p.texts[i] ?? "—")}</b>
            </div>
          </figure>
        );
      })}
      {active && weeks[active.i] ? <TipPopup anchor={active.anchor} tip={weeks[active.i]!.tip} /> : null}
    </div>
  );
}
