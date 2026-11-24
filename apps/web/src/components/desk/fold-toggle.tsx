"use client";

import React from "react";

/**
 * Under a table that has folded columns to fit its room: bring them all back (the table then scrolls sideways, because you asked), or fit it to the screen again. Remembered per table in this browser.
 * The CSS decides whether anything is folded at this width, so the button only shows when there is something to bring back.
 */
export function FoldToggle({ tableId, columns }: { tableId: string; columns: string[] }) {
  const [all, setAll] = React.useState(false);
  const key = `tl_cols_${tableId}`;
  React.useEffect(() => {
    try {
      setAll(window.localStorage.getItem(key) === "all");
    } catch {
      /* storage blocked: the table fits the screen */
    }
  }, [key]);
  React.useEffect(() => {
    document.getElementById(tableId)?.toggleAttribute("data-all", all);
  });
  return (
    <div className="dt-more">
      <button
        type="button"
        className="t-linkbtn"
        aria-pressed={all}
        title={columns.join(", ")}
        onClick={() => {
          const next = !all;
          setAll(next);
          try {
            if (next) window.localStorage.setItem(key, "all");
            else window.localStorage.removeItem(key);
          } catch {
            /* not remembered; it still applies now */
          }
        }}>
        {all ? "Fit to the screen" : "Show all columns"}
      </button>
    </div>
  );
}
