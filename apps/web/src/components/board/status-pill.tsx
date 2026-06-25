import React from "react";
import { mapStatusPresentation } from "@/lib/ui/status-map";

export function StatusPill({ status }: { status: string }) {
  const view = mapStatusPresentation(status);
  return (
    <span className={`db-pill db-pill-${view.tone}`} data-status={status}>
      {view.label}
    </span>
  );
}
