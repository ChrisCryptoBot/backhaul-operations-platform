"use client";

import React from "react";
import { ErrorState } from "@/components/desk/kit/states";

/** The page failed to load (for example the database is unreachable). The shell stays; this replaces only the page. */
export default function DeskError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorState
      title="This page could not load"
      retry={
        <button type="button" className="tl-btn primary" onClick={() => reset()}>
          Try again
        </button>
      }>
      The desk could not read its data. Check that the demo database is running, then try again.
    </ErrorState>
  );
}
