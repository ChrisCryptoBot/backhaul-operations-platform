import React from "react";
import type { Delta } from "@/lib/kpi-view";
import { ExpandChart, type ChartTable } from "./expand";
import { Tip, type TipData } from "../kit/tooltip";

/**
 * The frame every KPI chart sits in: a title with its unit, the chart, a one-line "so what" caption, and a folded
 * "how this is worked out". A chart with nothing to show says so in words instead of drawing an empty axis.
 */
export function ChartFrame({ title, unit, caption, formula, empty, children, className, table, large }: { title: string; unit?: string; caption?: React.ReactNode; formula?: string; empty?: React.ReactNode; children?: React.ReactNode; className?: string; table?: ChartTable; large?: React.ReactNode }) {
  return (
    <section className={`kc${className ? ` ${className}` : ""}`}>
      <header>
        <h2>{title}</h2>
        {unit ? <span className="kc-unit">{unit}</span> : null}
        {!empty && table ? (
          <ExpandChart title={title} unit={unit} table={table} large={large}>
            {children}
          </ExpandChart>
        ) : null}
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
export function DeltaChip({ delta, title, tip }: { delta: Delta | null; title?: string; tip?: TipData }) {
  if (!delta) return null;
  const word = delta.tone === "good" ? "better" : delta.tone === "bad" ? "worse" : "";
  const chip = (
    <>
      <i aria-hidden="true">{delta.glyph}</i>
      <span aria-hidden="true">{delta.text}</span>
    </>
  );
  const label = `${delta.text}${word ? `, ${word}` : ""}${title ? `. ${title}` : ""}`;
  // With figures to show, the chip opens a tooltip (hover or focus); with only a short note it keeps the plain title.
  return tip ? (
    <Tip className={`dl ${delta.tone}`} tip={tip} focusable>
      <span className="db-sr-only">{label}</span>
      {chip}
    </Tip>
  ) : (
    <span className={`dl ${delta.tone}`} title={title} aria-label={label}>
      {chip}
    </span>
  );
}

/** "Dallas, TX → Atlanta, GA" as "Dallas → Atlanta". */
export const shortLane = (lane: string) => lane.split(" → ").map((c) => c.split(",")[0]).join(" → ");
