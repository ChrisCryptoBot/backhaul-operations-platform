"use client";

import React from "react";

export interface ToggleProps {
  on: boolean;
  onChange: (next: boolean) => void;
  label?: React.ReactNode;
  disabled?: boolean;
}

/**
 * Accessible on/off switch (`role="switch"`) styled via `.db-switch` in board.css. Used for
 * boolean reference fields (FSC default, slip-seat, drop-hook required).
 */
export function Toggle({ on, onChange, label, disabled = false }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      className={`db-switch${on ? " on" : ""}`}
      onClick={() => onChange(!on)}
    >
      <span className="track" aria-hidden="true">
        <span className="knob" />
      </span>
      {label ? <span className="db-switch-label">{label}</span> : null}
    </button>
  );
}
