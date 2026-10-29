import React from "react";

/**
 * The desk's table. Server-rendered: banded column groups over a sticky header, sticky leading columns with a shadow seam,
 * tabular right-aligned figures, one row-state variable (zebra, hover, selected, flagged) and a link in the first cell as the single tab stop per row.
 * Search, row clicks and the density control are added by <DataTableTools> (a small client component) pointing at the same id.
 */
export type Column = {
  key: string;
  label: React.ReactNode;
  /** "num" right-aligns figures (tabular); "ctr" centres. */
  align?: "num" | "ctr";
  /** Pixel width. Required on sticky columns: it sets the left offset of the next one. */
  width?: number;
  /** Pinned to the left while the rest scrolls. Sticky columns must be the first columns. */
  sticky?: boolean;
  /** Band label above this column. Consecutive columns with the same group share one band. */
  group?: string;
  /** Marks a band in the accent colour (for example the money band). */
  accentBand?: boolean;
};

export type Row = {
  id: string;
  /** Click anywhere on the row to go here. */
  href?: string;
  /** "bad" tints the row and puts a red edge on it (a load below its cost, an overdue invoice). */
  flag?: "bad";
  selected?: boolean;
  /** Text matched by the search box. */
  search?: string;
  cells: Record<string, React.ReactNode>;
};

export function DataTable({ id, columns, rows, empty, label }: { id: string; columns: Column[]; rows: Row[]; empty?: React.ReactNode; label: string }) {
  // Left offsets of the sticky columns, from their widths.
  const left: Record<string, number> = {};
  let acc = 0;
  let lastSticky: string | null = null;
  for (const c of columns) {
    if (!c.sticky) continue;
    left[c.key] = acc;
    acc += c.width ?? 120;
    lastSticky = c.key;
  }

  // Bands: runs of consecutive columns that share a group label.
  const bands: Array<{ label: string; span: number; accent?: boolean }> = [];
  for (const c of columns) {
    const g = c.group ?? "";
    const prev = bands[bands.length - 1];
    if (prev && prev.label === g) prev.span += 1;
    else bands.push({ label: g, span: 1, accent: c.accentBand });
  }
  const hasBands = bands.some((b) => b.label !== "");

  const cls = (c: Column, extra = "") => [c.align ?? "", c.sticky ? "is-sticky" : "", c.key === lastSticky ? "is-seam" : "", extra].filter(Boolean).join(" ");
  const style = (c: Column): React.CSSProperties | undefined => {
    const s: React.CSSProperties = {};
    if (c.sticky) s.left = left[c.key];
    if (c.width) {
      s.width = c.width;
      s.minWidth = c.width;
    }
    return Object.keys(s).length ? s : undefined;
  };

  return (
    <div className="dt-wrap">
      <table className="dt" id={id} aria-label={label}>
        <thead>
          {hasBands ? (
            <tr className="dt-band">
              {bands.map((b, i) => (
                <th key={i} colSpan={b.span} className={b.accent ? "dt-band-accent" : undefined} scope="colgroup">
                  {b.label}
                </th>
              ))}
            </tr>
          ) : null}
          <tr className="dt-cols">
            {columns.map((c) => (
              <th key={c.key} className={cls(c)} style={{ ...style(c), ...(hasBands ? {} : { top: 0 }) }} scope="col">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr className="dt-empty-row">
              <td colSpan={columns.length}>{empty ?? "Nothing here."}</td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.id} data-href={r.href} data-flag={r.flag} data-search={(r.search ?? "").toLowerCase()} aria-selected={r.selected ? "true" : undefined}>
                {columns.map((c) => (
                  <td key={c.key} className={cls(c)} style={style(c)}>
                    {r.cells[c.key]}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
