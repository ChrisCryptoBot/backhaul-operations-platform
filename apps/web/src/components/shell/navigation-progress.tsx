"use client";

import React from "react";

/**
 * A slim, fixed accent bar pinned to the very top of the viewport, shown while a
 * client-side route transition is pending. The sidebar owns the `useTransition`
 * pending state and renders this so the cue survives the blocking navigation
 * (the current screen stays mounted until the destination is ready). Purely
 * presentational; the sweep + reduced-motion behaviour live in `.db-nav-progress`.
 */
export function NavigationProgress({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div className="db-nav-progress" role="progressbar" aria-hidden="true">
      <i />
    </div>
  );
}
