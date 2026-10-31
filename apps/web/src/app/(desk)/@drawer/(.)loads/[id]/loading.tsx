import React from "react";
import { Skeleton } from "@/components/desk/kit/states";

/** The drawer while the load is being read: the panel is there at once, with its shape, so opening a load never feels like nothing happened. */
export default function LoadDrawerLoading() {
  return (
    <div className="dr-scrim">
      <aside className="dr" role="dialog" aria-modal="true" aria-label="Loading the load" aria-busy="true">
        <header className="dr-head">
          <div style={{ display: "grid", gap: 8 }}>
            <Skeleton width={180} height={22} />
            <Skeleton width={260} height={12} />
          </div>
        </header>
        <div className="dr-body" style={{ display: "grid", gap: 14 }}>
          <Skeleton height={90} />
          <Skeleton height={140} />
          <Skeleton height={140} />
        </div>
      </aside>
    </div>
  );
}
