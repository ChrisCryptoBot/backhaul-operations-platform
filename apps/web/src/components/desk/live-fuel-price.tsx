"use client";

import React from "react";
import { decideFuelFill, weekOf, type FuelKind } from "@/lib/eia";

type Live = { pricePerGallon: number; period: string; regionLabel: string; nationalFallback: boolean };
type Shown = { kind: "filled" | "same" | "ask" | "none"; text: string; live?: Live };

/**
 * "Today's regional price" beside a fuel price box. A click asks EIA (through the desk's own /fuel/eia) for this week's on-highway price for the
 * lane's or the truck's region. An empty box is filled; a box that already holds that price is left; a box holding any other number is never
 * replaced silently: both numbers are shown and the replacement is its own click. The lookup only fills the box; saving is the form's own button.
 */
export function LiveFuelPrice({ fuel, origin, destination, typed, onUse, idle }: { fuel: FuelKind; origin: string; destination?: string; typed: string; onUse: (price: string) => void; idle?: string }) {
  const [busy, setBusy] = React.useState(false);
  const [shown, setShown] = React.useState<Shown | null>(null);

  async function ask() {
    setBusy(true);
    setShown(null);
    try {
      const q = new URLSearchParams({ fuel, origin, destination: destination ?? "" });
      const res = await fetch(`/fuel/eia?${q.toString()}`);
      const out = (await res.json()) as ({ ok: true } & Live) | { ok: false; reason: string };
      if (!out.ok) {
        setShown({ kind: "none", text: out.reason === "no_key" ? "Live fuel prices are off: no EIA key is set on this machine." : "No fuel price could be read right now. Type one." });
        return;
      }
      const price = out.pricePerGallon.toFixed(2);
      const source = `${out.regionLabel}${out.nationalFallback ? " (national, the region had none)" : ""}, ${weekOf(out.period)}, EIA`;
      const fill = decideFuelFill(typed, out.pricePerGallon);
      if (fill.action === "fill") {
        onUse(price);
        setShown({ kind: "filled", text: `Filled $${price} a gallon: ${source}.` });
      } else if (fill.action === "same") {
        setShown({ kind: "same", text: `That is already $${price} a gallon: ${source}.` });
      } else {
        setShown({ kind: "ask", text: `Today's price is $${price} a gallon (${source}). You have ${fill.typed}.`, live: out });
      }
    } catch {
      setShown({ kind: "none", text: "No fuel price could be read right now. Type one." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rc-authority">
      <button type="button" className="tl-btn sm" disabled={busy} aria-busy={busy || undefined} onClick={() => void ask()}>
        {busy ? "Looking it up…" : "Today's regional price"}
      </button>
      {shown ? (
        <span className="tl-sub" role="status">
          {shown.text}
        </span>
      ) : idle ? (
        <span className="tl-sub">{idle}</span>
      ) : null}
      {shown?.kind === "ask" && shown.live ? (
        <>
          <button
            type="button"
            className="tl-btn sm"
            onClick={() => {
              const price = shown.live!.pricePerGallon.toFixed(2);
              onUse(price);
              setShown({ kind: "filled", text: `Replaced with $${price} a gallon.` });
            }}>
            {`Replace with $${shown.live.pricePerGallon.toFixed(2)}`}
          </button>
          <button type="button" className="tl-btn sm" onClick={() => setShown(null)}>
            Keep mine
          </button>
        </>
      ) : null}
    </div>
  );
}
