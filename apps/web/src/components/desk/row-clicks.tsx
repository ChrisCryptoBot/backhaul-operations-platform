"use client";

import { useRouter } from "next/navigation";
import React from "react";

/**
 * Makes a table's rows open what they name: a click on a row with a `data-href`, not on a link, a button or a field inside it. Drawn by DataTable for any table whose rows have somewhere to go, so a row that
 * looks like it opens always does. The link in the first cell stays the one tab stop.
 */
export function RowClicks({ tableId }: { tableId: string }) {
  const router = useRouter();
  React.useEffect(() => {
    const table = document.getElementById(tableId);
    if (!table) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("a, button, input, select, textarea, label, summary, [role=button]")) return;
      // Dragging over a cell to copy its words is not asking to open the row.
      if ((window.getSelection()?.toString() ?? "") !== "") return;
      const href = target.closest<HTMLTableRowElement>("tr[data-href]")?.dataset.href;
      if (href) router.push(href);
    };
    table.addEventListener("click", onClick);
    return () => table.removeEventListener("click", onClick);
  });
  return null;
}
