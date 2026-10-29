import React from "react";
import { Skeleton, TableSkeleton } from "@/components/desk/kit/states";

/** Shown while a desk page's data is loading: the page head and a table-shaped skeleton, so the layout does not jump. */
export default function Loading() {
  return (
    <>
      <div style={{ marginBottom: 20, display: "grid", gap: 10 }}>
        <Skeleton width={220} height={30} />
        <Skeleton width={420} height={14} />
      </div>
      <TableSkeleton />
    </>
  );
}
