"use client";

import React from "react";
import { Modal } from "../kit/modal";

export type ChartTable = { head: string[]; rows: string[][] };

/**
 * The "Expand" control on a KPI card. It opens the same chart large (`large` when the big view shows more than the card does, such as every lane
 * rather than the busiest seven) with the numbers behind it in a table. The chart arrives already rendered by the server, so nothing is fetched or recomputed.
 */
export function ExpandChart({ title, unit, table, large, children }: { title: string; unit?: string; table?: ChartTable; large?: React.ReactNode; children?: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button type="button" className="kc-expand" onClick={() => setOpen(true)} aria-label={`Expand ${title}`} aria-haspopup="dialog">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />
        </svg>
        <span>Expand</span>
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        eyebrow="KPI dashboard"
        title={title}
        wide
        xl
        footer={
          <button type="button" className="tl-btn" data-autofocus onClick={() => setOpen(false)}>
            Close
          </button>
        }>
        {unit ? <p className="kc-unit kc-xl-unit">{unit}</p> : null}
        <div className="kc-xl">{large ?? children}</div>
        {table ? (
          <div className="kc-tab-wrap">
            <table className="kc-tab">
              <thead>
                <tr>
                  {table.head.map((h, i) => (
                    <th key={h} scope="col" className={i === 0 ? undefined : "num"}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r, ri) => (
                  <tr key={ri}>
                    {r.map((c, i) => (i === 0 ? <th key={i} scope="row">{c}</th> : <td key={i} className="num">{c}</td>))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
