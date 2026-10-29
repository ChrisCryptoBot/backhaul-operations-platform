"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { compareKeys, nextSort, sortKey, type SortDir, type SortKind } from "@/lib/table-sort";
import { Icon } from "./kit/icons";

type Density = "comfortable" | "compact";

/** The table with this id, and any table whose id continues it with "--" (a long list split into month tables shares one toolbar). */
const tablesOf = (tableId: string) => Array.from(document.querySelectorAll<HTMLElement>(`[id="${tableId}"], [id^="${tableId}--"]`));

/**
 * The toolbar above a <DataTable>: search, the filter chips passed in as children, a row count and the density control.
 * It also makes whole rows clickable (any row with a data-href) without making them focusable: the link in the first cell stays the one tab stop.
 */
export function DataTableTools({ tableId, placeholder = "Search…", children, total }: { tableId: string; placeholder?: string; children?: React.ReactNode; total: number }) {
  const router = useRouter();
  const [q, setQ] = React.useState("");
  const [density, setDensity] = React.useState<Density>("comfortable");
  const [shown, setShown] = React.useState(total);
  const [sortNote, setSortNote] = React.useState("");

  React.useEffect(() => {
    setDensity(document.documentElement.dataset.density === "compact" ? "compact" : "comfortable");
  }, []);

  // Search: hide rows whose text does not match. Done on the DOM so the table stays server-rendered.
  React.useEffect(() => {
    const tables = tablesOf(tableId);
    if (tables.length === 0) return;
    const needle = q.trim().toLowerCase();
    let visible = 0;
    for (const table of tables) {
      table.querySelectorAll<HTMLTableRowElement>("tbody tr[data-search]").forEach((tr) => {
        const match = needle === "" || (tr.dataset.search ?? "").includes(needle);
        tr.hidden = !match;
        if (match) visible += 1;
      });
    }
    setShown(needle === "" ? total : visible);
  }, [q, tableId, total]);

  // Row clicks: a click on a row (not on a link, button or field inside it) opens the row's href.
  React.useEffect(() => {
    const tables = tablesOf(tableId);
    if (tables.length === 0) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("a, button, input, select, textarea, label")) return;
      const tr = target.closest<HTMLTableRowElement>("tr[data-href]");
      if (tr?.dataset.href) router.push(tr.dataset.href);
    };
    for (const table of tables) table.addEventListener("click", onClick);
    return () => {
      for (const table of tables) table.removeEventListener("click", onClick);
    };
  }, [tableId, router]);

  // Sorting: a header button reorders that table's rows in the page and says so in aria-sort on its header cell. Only one column is sorted at a time.
  React.useEffect(() => {
    const tables = tablesOf(tableId);
    if (tables.length === 0) return;
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button.dt-sortbtn");
      const table = btn?.closest("table");
      const th = btn?.closest("th");
      if (!btn || !table || !th) return;
      const col = btn.dataset.sortCol ?? "";
      const kind = (btn.dataset.sortKind === "num" ? "num" : "text") as SortKind;
      const dir = nextSort((th.getAttribute("aria-sort") as SortDir | null) ?? "none");
      table.querySelectorAll("th[aria-sort]").forEach((h) => h.setAttribute("aria-sort", "none"));
      th.setAttribute("aria-sort", dir);
      const colIndex = Array.from(th.parentElement!.children).indexOf(th);
      const body = table.tBodies[0]!;
      const rows = Array.from(body.querySelectorAll<HTMLTableRowElement>("tr[data-i]"));
      const key = (tr: HTMLTableRowElement) => {
        const td = tr.cells[colIndex];
        return sortKey(kind, td?.textContent ?? "", td?.dataset.v);
      };
      const order = dir === "none" ? [...rows].sort((a, b) => Number(a.dataset.i) - Number(b.dataset.i)) : [...rows].sort((a, b) => compareKeys(key(a), key(b), dir) || Number(a.dataset.i) - Number(b.dataset.i));
      for (const tr of order) body.appendChild(tr);
      const name = (btn.textContent ?? col).trim();
      setSortNote(dir === "none" ? "Back to the original order." : `Sorted by ${name}, ${dir}.`);
    };
    for (const table of tables) table.addEventListener("click", onClick);
    return () => {
      for (const table of tables) table.removeEventListener("click", onClick);
    };
  }, [tableId]);

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
      <span className="db-sr-only" role="status">{sortNote}</span>
      <div className="tl-seg" role="group" aria-label="Row density">
        <button type="button" aria-pressed={density === "comfortable"} onClick={() => pick("comfortable")}>Comfortable</button>
        <button type="button" aria-pressed={density === "compact"} onClick={() => pick("compact")}>Compact</button>
      </div>
    </div>
  );
}
