import React from "react";
import { Skeleton, TableSkeleton } from "@/components/desk/kit/states";

/** Shown while Invoices is loading: header, stat tiles and table skeleton so the layout does not jump. */
export default function InvoicesLoading() {
  return (
    <>
      <div style={{ marginBottom: 20, display: "grid", gap: 10 }}>
        <Skeleton width={180} height={30} />
        <Skeleton width={420} height={14} />
      </div>
      <div className="tl-grid cols-4" style={{ marginBottom: 16 }}>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="tl-stat">
            <Skeleton width={110} height={12} />
            <Skeleton width={90} height={26} style={{ marginTop: 8 }} />
          </div>
        ))}
      </div>
      <TableSkeleton />
    </>
  );
}
