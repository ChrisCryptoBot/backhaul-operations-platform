"use client";

import React from "react";
import type { DiffRow } from "@/lib/audit-diff";
import { Modal } from "./kit/modal";

/** "Details" on an audit row: the before and after, field by field, and the reason if one was given. */
export function DiffButton({ title, eyebrow, rows, reason }: { title: string; eyebrow?: string; rows: DiffRow[]; reason?: string | null }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button type="button" className="tl-btn ghost sm" onClick={() => setOpen(true)}>
        Details
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        eyebrow={eyebrow}
        footer={
          <button type="button" className="tl-btn" onClick={() => setOpen(false)}>
            Close
          </button>
        }>
        <table className="diff" aria-label="What changed">
          <thead>
            <tr>
              <th>Field</th>
              <th>Before</th>
              <th>After</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.field}>
                <td>{r.field}</td>
                <td>{r.from}</td>
                <td className={r.changed ? "chg" : undefined}>{r.to}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {reason ? <p className="tl-note" style={{ marginTop: 12 }}>Reason: {reason}</p> : null}
      </Modal>
    </>
  );
}
