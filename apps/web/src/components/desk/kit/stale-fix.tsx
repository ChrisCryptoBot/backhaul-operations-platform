import React from "react";
import { lateText } from "@/lib/planner";

/** A position too old to speak of as now, said as that: the drawer, the radar and the unit pages all say it this way. */
export function StaleFix({ minutes, children }: { minutes: number; children?: React.ReactNode }) {
  return (
    <p className="t-stale" role="status">
      Last position is {lateText(minutes)} old.
      {children ? <span>{children}</span> : null}
    </p>
  );
}
