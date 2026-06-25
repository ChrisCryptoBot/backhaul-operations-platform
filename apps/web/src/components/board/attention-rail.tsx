"use client";

import React from "react";
import { ChevronRightIcon } from "@/components/icons";
import type { LoadAlertRollup } from "@/lib/ui/load-alerts";

interface AttentionRailProps {
  rollups: LoadAlertRollup[];
  selectedLoadId: string | null;
  onSelect: (loadId: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

const MAX_REASONS = 3;

/**
 * Persistent "Needs Attention" rail. Lists every load with open alert items,
 * already sorted most-demanding-first (obligations, then severity, then count),
 * and opens the load drawer on click. Collapses to a thin strip that still shows
 * the count so it's never fully hidden.
 */
export function AttentionRail({ rollups, selectedLoadId, onSelect, collapsed, onToggleCollapsed }: AttentionRailProps) {
  const total = rollups.length;
  // Loads whose full alert list is expanded (per-load, persists across board refresh).
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());
  const toggleExpanded = React.useCallback((loadId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(loadId)) next.delete(loadId);
      else next.add(loadId);
      return next;
    });
  }, []);

  if (collapsed) {
    return (
      <aside className="db-attention-rail collapsed" aria-label="Needs attention">
        <button
          type="button"
          className="db-attn-expand"
          onClick={onToggleCollapsed}
          aria-label={`Expand needs attention (${total})`}
          title={`${total} load${total === 1 ? "" : "s"} need attention`}
        >
          <span className={`db-attn-expand-count${total > 0 ? " active" : ""}`}>{total}</span>
          <span className="db-attn-expand-label">ATTENTION</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="db-attention-rail" aria-label="Needs attention">
      <header className="db-attn-head">
        <span className="db-attn-title">Needs attention</span>
        <span className={`db-attn-total${total > 0 ? " active" : ""}`}>{total}</span>
        <button
          type="button"
          className="db-attn-collapse"
          onClick={onToggleCollapsed}
          aria-label="Collapse needs attention"
          title="Collapse"
        >
          <ChevronRightIcon size={14} />
        </button>
      </header>
      {total === 0 ? (
        <div className="db-attn-empty dim">All clear — nothing needs attention.</div>
      ) : (
        <ul className="db-attn-list">
          {rollups.map((rollup) => {
            const sev = rollup.topSeverity?.toLowerCase() ?? "info";
            const isExpanded = expanded.has(rollup.loadId);
            const hasMore = rollup.count > MAX_REASONS;
            const shown = isExpanded ? rollup.alerts : rollup.alerts.slice(0, MAX_REASONS);
            return (
              <li key={rollup.loadId}>
                <div className={`db-attn-item sev-${sev}${selectedLoadId === rollup.loadId ? " selected" : ""}`}>
                  <button type="button" className="db-attn-item-top" onClick={() => onSelect(rollup.loadId)}>
                    <span className="db-attn-ref mono">{rollup.ref}</span>
                    <span className={`db-attn-sev ${sev}`}>{rollup.topSeverity}</span>
                    {rollup.count > 1 ? <span className="db-attn-count">{rollup.count}</span> : null}
                  </button>
                  <ul className="db-attn-reasons">
                    {shown.map((alert) => (
                      <li key={alert.key}>
                        <button
                          type="button"
                          className={`db-attn-reason${alert.isObligation ? " obl" : ""}`}
                          onClick={() => onSelect(rollup.loadId)}
                          title="Open this load to address it"
                        >
                          {alert.label}
                        </button>
                      </li>
                    ))}
                    {hasMore ? (
                      <li>
                        <button
                          type="button"
                          className="db-attn-more"
                          aria-expanded={isExpanded}
                          onClick={() => toggleExpanded(rollup.loadId)}
                        >
                          {isExpanded ? "show less" : `+${rollup.count - MAX_REASONS} more`}
                        </button>
                      </li>
                    ) : null}
                  </ul>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
