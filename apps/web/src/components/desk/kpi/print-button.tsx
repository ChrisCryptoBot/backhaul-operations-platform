"use client";

import React from "react";

/** Opens the browser's print dialog, which also saves a PDF. */
export function PrintButton() {
  return (
    <button type="button" className="tl-btn primary" onClick={() => window.print()}>
      Print or save as PDF
    </button>
  );
}
