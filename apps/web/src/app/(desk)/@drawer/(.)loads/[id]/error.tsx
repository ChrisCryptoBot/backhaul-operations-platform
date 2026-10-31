"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { ErrorState } from "@/components/desk/kit/states";

/** The load could not be read while it was opening in the drawer. The page underneath stays; this offers another try, or the load as a full page. */
export default function LoadDrawerError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  return (
    <div className="dr-scrim" onMouseDown={(e) => e.target === e.currentTarget && router.back()}>
      <aside className="dr" role="alertdialog" aria-modal="true" aria-label="This load could not open">
        <div className="dr-body">
          <ErrorState
            title="This load could not open"
            retry={
              <button type="button" className="tl-btn primary" onClick={() => reset()}>
                Try again
              </button>
            }>
            The desk could not read it just now. Try again, or reload the page.
          </ErrorState>
          <button type="button" className="tl-btn ghost sm" onClick={() => router.back()} style={{ marginTop: 10 }}>
            Close
          </button>
        </div>
      </aside>
    </div>
  );
}
