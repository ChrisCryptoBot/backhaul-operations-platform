import React from "react";
import { LockIcon } from "@/components/icons";

export interface PermissionDeniedProps {
  /** Policy resource that gates this surface (shown in the meta line). */
  resource?: string;
  /** Viewer's role that was denied (shown in the meta line). */
  role?: string;
}

/**
 * Styled admin-gate surface for restricted screens (Settings, Audit). Reuses the
 * shared empty-state chrome with a warn-tinted lock chip and a policy meta line,
 * so a denied viewer sees a calm explanation inside the app shell rather than a
 * bare error card.
 */
export function PermissionDenied({ resource = "SYSTEM_SETTINGS", role = "your role" }: PermissionDeniedProps) {
  return (
    <div className="db-uistate db-uistate-stack db-denied" role="status">
      <span className="db-empty-ic" aria-hidden="true">
        <LockIcon size={20} />
      </span>
      <div>
        <h2 className="db-uistate-title">Admin access required</h2>
        <p className="db-uistate-copy">
          This area is restricted to administrators. Ask a system admin if you need access, or switch to a
          region where you hold the role.
        </p>
      </div>
      <div className="db-denied-meta">
        policy: {resource} · READ denied for role {role}
      </div>
    </div>
  );
}
