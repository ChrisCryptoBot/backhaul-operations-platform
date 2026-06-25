"use client";

import React from "react";

export interface EmptyStateProps {
  title: string;
  copy?: React.ReactNode;
  /** Optional icon rendered in a rounded chip above the title (non-inline mode). */
  icon?: React.ReactNode;
  /** Optional call-to-action button (e.g. "Add lane"). */
  action?: {
    label: string;
    onClick: () => void;
  };
  /** Render inline (centered, wrapping) like the board's empty-board state. */
  inline?: boolean;
}

/**
 * Shared empty-state block, reusing the board's `.db-uistate` styling. Replaces the bare
 * "No … yet." placeholder rows on the reference pages with a titled, optionally actionable card.
 * In non-inline mode an optional `icon` renders in a chip above the title.
 */
export function EmptyState({ title, copy, icon, action, inline = false }: EmptyStateProps) {
  return (
    <div className={`db-uistate${inline ? " db-uistate-inline" : " db-uistate-stack"}`} role="status">
      {!inline && icon ? (
        <span className="db-empty-ic" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <div>
        <h2 className="db-uistate-title">{title}</h2>
        {copy ? <p className="db-uistate-copy">{copy}</p> : null}
      </div>
      {action ? (
        <button type="button" className="db-btn" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
