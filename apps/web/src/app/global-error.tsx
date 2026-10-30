"use client";

import React from "react";

/** The last resort: the root layout itself failed, so this brings its own html and body and no styles from outside. */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", background: "#0e1117", color: "#e8edf2", fontFamily: "system-ui, sans-serif", textAlign: "center" }}>
        <main style={{ padding: 24 }}>
          <h1 style={{ fontSize: 26, margin: "0 0 8px" }}>The desk could not load</h1>
          <p style={{ color: "#9aa7b4", margin: "0 0 20px" }}>Something failed before the page could start. Try again in a moment.</p>
          <button type="button" onClick={() => reset()} style={{ minHeight: 44, padding: "0 24px", border: 0, borderRadius: 6, background: "#e8a020", color: "#0e1117", fontWeight: 600, cursor: "pointer" }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
