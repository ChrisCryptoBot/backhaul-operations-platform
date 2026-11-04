"use client";

import React from "react";
import { ErrorState } from "@/components/desk/kit/states";

export default function PayrollError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorState
      title="Payroll could not load"
      retry={
        <button type="button" className="tl-btn primary" onClick={() => reset()}>
          Try again
        </button>
      }>
      The desk could not read finalized payroll statements right now. Check the connection, then try again.
    </ErrorState>
  );
}
