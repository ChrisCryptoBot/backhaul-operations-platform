import React from "react";
import type { Delta } from "@/lib/kpi-view";

/**
 * The frame every KPI chart sits in: a title with its unit, the chart, a one-line "so what" caption, and a folded
 * "how this is worked out". A chart with nothing to show says so in words instead of drawing an empty axis.
 */
export function ChartFrame({ title, unit, caption, formula, empty, children, className }: { title: string; unit?: string; caption?: React.ReactNode; formula?: string; empty?: React.ReactNode; children?: React.ReactNode; className?: string }) {
  return (
    <section className={`kc${className ? ` ${className}` : ""}`}>
      <header>
        <h3>{title}</h3>
        {unit ? <span className="kc-unit">{unit}</span> : null}
      </header>
      {empty ? <div className="kc-empty">{empty}</div> : <div className="kc-body">{children}</div>}
      {caption && !empty ? <p className="kc-cap">{caption}</p> : null}
      {formula ? (
        <details className="kc-how">
          <summary>How this is worked out</summary>
          <p>{formula}</p>
        </details>
      ) : null}
    </section>
  );
}

/** Change against the previous period. Colour is the judgement (green better, red worse), the glyph is the direction. */
export function DeltaChip({ delta, title }: { delta: Delta | null; title?: string }) {
  if (!delta) return null;
  const word = delta.tone === "good" ? "better" : delta.tone === "bad" ? "worse" : "";
  return (
    <span className={`dl ${delta.tone}`} title={title} aria-label={`${delta.text}${word ? `, ${word}` : ""}`}>
      <i aria-hidden="true">{delta.glyph}</i>
      <span aria-hidden="true">{delta.text}</span>
    </span>
  );
}

/** "Dallas, TX → Atlanta, GA" as "Dallas → Atlanta". */
export const shortLane = (lane: string) => lane.split(" → ").map((c) => c.split(",")[0]).join(" → ");
