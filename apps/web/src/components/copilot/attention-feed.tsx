"use client";

import React from "react";
import type { LoadAlertRollup } from "@/lib/ui/load-alerts";
import { alertKindToFix, type AlertFix } from "@/lib/ui/alert-fix";

interface AttentionFeedProps {
  rollups: LoadAlertRollup[];
  selectedLoadId: string | null;
  onSelect: (loadId: string) => void;
  /**
   * Phase B: resolve an obligation in-panel. When provided, reasons with a
   * deterministic one-click fix (see `alertKindToFix`) render a "Fix" button
   * that seeds a copilot confirm card. Omitted → feed is view-only (click→drawer).
   */
  onFix?: (fix: AlertFix) => void;
}

const MAX_REASONS = 3;

function Chevron() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The board's "Needs attention" list, folded into the copilot as its default
 * surface. Same derivation and sort order as the old standalone rail
 * (obligations, then severity, then count); clicking a load still opens its
 * drawer via `onSelect`. Its own bounded scroll region keeps it from crowding
 * the chat, and a section-level collapse tucks it away without hiding the chat.
 * Renders nothing when the board is all-clear so the copilot stays uncluttered.
 */
export function AttentionFeed({ rollups, selectedLoadId, onSelect, onFix }: AttentionFeedProps) {
  const total = rollups.length;
  const [collapsed, setCollapsed] = React.useState(false);
  // Loads whose full alert list is expanded (per-load, persists across refresh).
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());
  const toggleExpanded = React.useCallback((loadId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(loadId)) next.delete(loadId);
      else next.add(loadId);
      return next;
    });
  }, []);

  if (total === 0) return null;

  return (
    <section className="db-cop-attn" data-collapsed={collapsed} aria-label="Needs attention">
      <button
        type="button"
        className="db-cop-attn-head"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
        title={collapsed ? "Show what needs attention" : "Hide"}
      >
        <span className="db-cop-attn-title">Needs attention</span>
        <span className="db-cop-attn-total active">{total}</span>
        <span className="db-cop-attn-chev" data-collapsed={collapsed}><Chevron /></span>
      </button>
      {!collapsed ? (
        <ul className="db-cop-attn-list">
          {rollups.map((rollup) => {
            const sev = rollup.topSeverity?.toLowerCase() ?? "info";
            const isExpanded = expanded.has(rollup.loadId);
            const hasMore = rollup.count > MAX_REASONS;
            const shown = isExpanded ? rollup.alerts : rollup.alerts.slice(0, MAX_REASONS);
            return (
              <li key={rollup.loadId}>
                <div className={`db-cop-attn-item sev-${sev}${selectedLoadId === rollup.loadId ? " selected" : ""}`}>
                  <button type="button" className="db-cop-attn-item-top" onClick={() => onSelect(rollup.loadId)}>
                    <span className="db-cop-attn-ref mono">{rollup.ref}</span>
                    <span className={`db-cop-attn-sev ${sev}`}>{rollup.topSeverity}</span>
                    {rollup.count > 1 ? <span className="db-cop-attn-count">{rollup.count}</span> : null}
                  </button>
                  <ul className="db-cop-attn-reasons">
                    {shown.map((alert) => {
                      const fix = onFix ? alertKindToFix(alert.kind, rollup.loadId, rollup.ref) : null;
                      return (
                        <li key={alert.key} className={fix ? "has-fix" : undefined}>
                          <button
                            type="button"
                            className={`db-cop-attn-reason${alert.isObligation ? " obl" : ""}`}
                            onClick={() => onSelect(rollup.loadId)}
                            title="Open this load to address it"
                          >
                            {alert.label}
                          </button>
                          {fix ? (
                            <button
                              type="button"
                              className="db-cop-attn-fix"
                              onClick={() => onFix!(fix)}
                              title={fix.summary}
                            >
                              {fix.label}
                            </button>
                          ) : null}
                        </li>
                      );
                    })}
                    {hasMore ? (
                      <li>
                        <button
                          type="button"
                          className="db-cop-attn-more"
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
      ) : null}
    </section>
  );
}
