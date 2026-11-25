"use client";

import React from "react";
import { MAX_LOADS_PER_INVOICE } from "@/lib/customer-key";
import { usd } from "@/lib/desk-format";
import { TogetherDialog, togetherProblem, type TogetherLoad } from "./invoice-together";

export type SelectableLoad = {
  id: string;
  loadNumber: string | null;
  customer: string | null;
  mc: string | null;
  together?: TogetherLoad | null;
};

type Ctx = {
  loads: Map<string, SelectableLoad>;
  picked: string[];
  toggle: (id: string) => void;
  clear: () => void;
  canBill: boolean;
};

const LoadsSelectContext = React.createContext<Ctx | null>(null);

export function LoadsSelectProvider({
  loads,
  canBill,
  children
}: {
  loads: SelectableLoad[];
  canBill: boolean;
  children: React.ReactNode;
}) {
  const map = React.useMemo(() => new Map(loads.map((l) => [l.id, l])), [loads]);
  const [picked, setPicked] = React.useState<string[]>([]);
  React.useEffect(() => {
    setPicked((p) => (p.every((id) => map.has(id)) ? p : p.filter((id) => map.has(id))));
  }, [map]);
  const value = React.useMemo<Ctx>(
    () => ({
      loads: map,
      picked,
      canBill,
      toggle: (id) =>
        setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX_LOADS_PER_INVOICE ? p : [...p, id])),
      clear: () => setPicked([])
    }),
    [map, picked, canBill]
  );
  return <LoadsSelectContext.Provider value={value}>{children}</LoadsSelectContext.Provider>;
}

/** Row checkbox for board multi-select ("Export selected" and "Invoice together"). */
export function LoadPick({ id }: { id: string }) {
  const ctx = React.useContext(LoadsSelectContext);
  const load = ctx?.loads.get(id);
  if (!ctx || !load) return null;
  const on = ctx.picked.includes(id);
  return (
    <input
      type="checkbox"
      className="tl-pick"
      checked={on}
      onChange={() => ctx.toggle(id)}
      aria-label={`Select ${load.loadNumber ?? "this load"}`}
      title="Select loads to export CSV or invoice together"
    />
  );
}

export function LoadsSelectBar() {
  const ctx = React.useContext(LoadsSelectContext);
  const [open, setOpen] = React.useState(false);
  if (!ctx || ctx.picked.length === 0) return null;
  const chosen = ctx.picked.map((id) => ctx.loads.get(id)).filter((l): l is SelectableLoad => !!l);
  const readyLoads = chosen.map((c) => c.together).filter((t): t is TogetherLoad => !!t);
  const ineligible = chosen.find((c) => !c.together);
  const invoiceProblem =
    chosen.length < 2
      ? "Tick at least two finished loads of the same customer to invoice together."
      : ineligible
        ? `${ineligible.loadNumber ?? "One selected load"} is not delivered and waiting for an invoice.`
        : togetherProblem(readyLoads);
  const readyCents = readyLoads.reduce((s, l) => s + l.cents, 0);
  const exportHref = `/export/loads?ids=${encodeURIComponent(chosen.map((c) => c.id).join(","))}`;

  return (
    <div className="tl-together" role="region" aria-label="Selected loads">
      <span>
        <b>{chosen.length}</b> {chosen.length === 1 ? "load" : "loads"} selected
        {readyLoads.length === chosen.length && chosen.length > 0 ? <> · <b>{usd(readyCents / 100, 2)}</b></> : null}
        {chosen[0]?.customer ? ` · ${chosen[0].customer}` : ""}
      </span>
      {ctx.canBill && chosen.length >= 2 && invoiceProblem ? (
        <span className="tl-note warn" role="status">
          {invoiceProblem}
        </span>
      ) : null}
      <span className="tl-together-act">
        <button type="button" className="tl-btn ghost sm" onClick={ctx.clear}>
          Clear
        </button>
        <a className="tl-btn sm" href={exportHref}>
          Export selected
        </a>
        {ctx.canBill ? (
          <button
            type="button"
            className="tl-btn primary sm"
            disabled={!!invoiceProblem}
            title={invoiceProblem ?? "Put these loads on one invoice"}
            onClick={() => setOpen(true)}>
            Invoice together
          </button>
        ) : null}
      </span>
      {open && !invoiceProblem && readyLoads.length >= 2 ? (
        <TogetherDialog chosen={readyLoads} onClose={() => setOpen(false)} onDone={ctx.clear} />
      ) : null}
    </div>
  );
}
