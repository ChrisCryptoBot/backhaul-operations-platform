"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { Icon } from "./kit/icons";

type Density = "comfortable" | "compact";

/**
 * The toolbar above a <DataTable>: search, the filter chips passed in as children, a row count and the density control.
 * It also makes whole rows clickable (any row with a data-href) without making them focusable: the link in the first cell stays the one tab stop.
 */
export function DataTableTools({ tableId, placeholder = "Search…", children, total }: { tableId: string; placeholder?: string; children?: React.ReactNode; total: number }) {
  const router = useRouter();
  const [q, setQ] = React.useState("");
  const [density, setDensity] = React.useState<Density>("comfortable");
  const [shown, setShown] = React.useState(total);

  React.useEffect(() => {
    setDensity(document.documentElement.dataset.density === "compact" ? "compact" : "comfortable");
  }, []);

  // Search: hide rows whose text does not match. Done on the DOM so the table stays server-rendered.
  React.useEffect(() => {
    const table = document.getElementById(tableId);
    if (!table) return;
    const needle = q.trim().toLowerCase();
    let visible = 0;
    table.querySelectorAll<HTMLTableRowElement>("tbody tr[data-search]").forEach((tr) => {
      const match = needle === "" || (tr.dataset.search ?? "").includes(needle);
      tr.hidden = !match;
      if (match) visible += 1;
    });
    setShown(needle === "" ? total : visible);
  }, [q, tableId, total]);

  // Row clicks: a click on a row (not on a link, button or field inside it) opens the row's href.
  React.useEffect(() => {
    const table = document.getElementById(tableId);
    if (!table) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("a, button, input, select, textarea, label")) return;
      const tr = target.closest<HTMLTableRowElement>("tr[data-href]");
      if (tr?.dataset.href) router.push(tr.dataset.href);
    };
    table.addEventListener("click", onClick);
    return () => table.removeEventListener("click", onClick);
  }, [tableId, router]);

  const pick = (d: Density) => {
    setDensity(d);
    document.documentElement.dataset.density = d;
    document.cookie = `desk-density=${d}; path=/; max-age=31536000; samesite=lax`;
  };

  return (
    <div className="dt-toolbar">
      <label className="dt-search">
        <Icon name="search" />
        <span className="db-sr-only">Search this table</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} autoComplete="off" />
      </label>
      {children}
      <span className="dt-spacer" />
      <span className="dt-count" aria-live="polite">{q.trim() === "" ? `${total} rows` : `${shown} of ${total}`}</span>
      <div className="tl-seg" role="group" aria-label="Row density">
        <button type="button" aria-pressed={density === "comfortable"} onClick={() => pick("comfortable")}>Comfortable</button>
        <button type="button" aria-pressed={density === "compact"} onClick={() => pick("compact")}>Compact</button>
      </div>
    </div>
  );
}
