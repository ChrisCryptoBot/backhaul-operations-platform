"use client";

import React from "react";
import { ErrorState } from "@/components/desk/kit/states";

export default function SettlementsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorState
      title="Settlements could not load"
      retry={
        <button type="button" className="tl-btn primary" onClick={() => reset()}>
          Try again
        </button>
      }>
      The desk could not read driver statements right now. Check the connection, then try again.
    </ErrorState>
  );
}
