"use client";

import React from "react";

/** Opens the browser's print dialog, which also saves a PDF. When `documentTitle` is given, the saved PDF defaults to that file name. */
export function PrintButton({ documentTitle }: { documentTitle?: string | null }) {
  function print() {
    const clean = (documentTitle ?? "").trim();
    if (!clean) {
      window.print();
      return;
    }
    const previous = document.title;
    document.title = clean;
    try {
      window.print();
    } finally {
      document.title = previous;
    }
  }

  return (
    <button type="button" className="tl-btn primary" onClick={print}>
      Print or save as PDF
    </button>
  );
}
