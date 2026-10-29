import React from "react";
import { Icon, type IconName } from "./icons";

/** Skeleton, empty and error states: one pattern each, used everywhere so loading, nothing-here and failed look consistent. */
export function Skeleton({ width = "100%", height = 14, style }: { width?: number | string; height?: number | string; style?: React.CSSProperties }) {
  return <span className="k-skel" style={{ width, height, ...style }} aria-hidden="true" />;
}

export function TableSkeleton({ rows = 8, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="dt-wrap" role="status" aria-label="Loading">
      <div style={{ display: "grid", gap: 10, padding: 16 }}>
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 16 }}>
            {Array.from({ length: cols }, (_, c) => (
              <Skeleton key={c} height={16} width={c === 0 ? "60%" : "85%"} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function EmptyState({ icon = "inbox", title, children, action }: { icon?: IconName; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="k-empty">
      <span className="ico"><Icon name={icon} /></span>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ title = "Something went wrong", children, retry }: { title?: string; children?: React.ReactNode; retry?: React.ReactNode }) {
  return (
    <div className="k-empty k-error" role="alert">
      <span className="ico"><Icon name="alert" /></span>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {retry}
    </div>
  );
}
