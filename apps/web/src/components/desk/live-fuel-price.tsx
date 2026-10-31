"use client";

import React from "react";
import { decideFuelFill, weekOf, type FuelKind } from "@/lib/eia";
import { addressReady } from "@/lib/geo";

type Live = { pricePerGallon: number; period: string; regionLabel: string; nationalFallback: boolean };
type Shown = { kind: "filled" | "same" | "ask" | "none"; text: string; live?: Live };

/**
 * "Today's regional price" beside a fuel price box. With `auto`, an empty box fills itself with it, so a price is never left blank for want of a click: the figure stays editable,
 * a figure someone typed is never replaced, and one that was filled for another region is replaced when the region changes. A click asks EIA (through the desk's own /fuel/eia) for this week's on-highway price for the
 * lane's or the truck's region. An empty box is filled; a box that already holds that price is left; a box holding any other number is never
 * replaced silently: both numbers are shown and the replacement is its own click. The lookup only fills the box; saving is the form's own button.
 */
export function LiveFuelPrice({ fuel, origin, destination, typed, onUse, idle, auto, autoFilled }: { fuel: FuelKind; origin: string; destination?: string; typed: string; onUse: (price: string) => void; idle?: string; auto?: boolean; /** The figure in the box was filled by this lookup (kept with a quote), so a newer week replaces it. */ autoFilled?: boolean }) {
  const [busy, setBusy] = React.useState(false);
  const [shown, setShown] = React.useState<Shown | null>(null);
  // The price this component last put in the box, and the lookup it last tried on its own: a box still holding the first is not the person's, and a lookup is not repeated for the same place.
  const filled = React.useRef<string | null>(autoFilled ? typed.trim() : null);
  const tried = React.useRef("");
  const latest = React.useRef({ typed, onUse });
  latest.current = { typed, onUse };

  async function ask(byItself = false) {
    setBusy(true);
    if (!byItself) setShown(null);
    try {
      const q = new URLSearchParams({ fuel, origin, destination: destination ?? "" });
      const res = await fetch(`/fuel/eia?${q.toString()}`);
      const out = (await res.json()) as ({ ok: true } & Live) | { ok: false; reason: string };
      if (!out.ok) {
        if (byItself) return;
        setShown({ kind: "none", text: out.reason === "no_key" ? "Live fuel prices are off: no EIA key is set on this machine." : "No fuel price could be read right now. Type one." });
        return;
      }
      const price = out.pricePerGallon.toFixed(2);
      if (byItself) {
        // On its own it only ever fills an empty box, or swaps a figure it put there itself; anything typed is left alone.
        const now = latest.current.typed.trim();
        if (now === "" || now === filled.current) {
          filled.current = price;
          latest.current.onUse(price);
          setShown({ kind: "filled", text: `Filled with this week's price, $${price} a gallon: ${out.regionLabel}${out.nationalFallback ? " (national, the region had none)" : ""}, ${weekOf(out.period)}, EIA. Type over it to use your own.` });
        }
        return;
      }
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
      if (!byItself) setShown({ kind: "none", text: "No fuel price could be read right now. Type one." });
    } finally {
      setBusy(false);
    }
  }

  // Fill an empty box by itself, a moment after the place stops changing (an address half typed is not a place yet).
  React.useEffect(() => {
    if (!auto) return;
    const place = `${fuel}|${origin.trim().toLowerCase()}|${(destination ?? "").trim().toLowerCase()}`;
    if (tried.current === place) return;
    const ours = typed.trim() === "" || typed.trim() === filled.current;
    const ready = origin.trim() === "" || addressReady(origin);
    if (!ours || !ready) return;
    const t = window.setTimeout(() => {
      tried.current = place;
      void ask(true);
    }, 700);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, fuel, origin, destination, typed]);

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
