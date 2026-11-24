import React from "react";

/** A section that is there when it is wanted and out of the way when it is not: its name and the one fact about it on a line, the rest under it. Closed is still on the page, so a typed field in it is kept. */
export function Fold({ title, meta, open = false, children }: { title: string; meta?: React.ReactNode; open?: boolean; children: React.ReactNode }) {
  return (
    <details className="lv-fold" open={open || undefined}>
      <summary>
        <b>{title}</b>
        {meta ? <span>{meta}</span> : null}
      </summary>
      <div className="lv-fold-body">{children}</div>
    </details>
  );
}
