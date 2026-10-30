"use client";

import Link from "next/link";
import type { UnitUse } from "@/lib/plans";

/** " (2 of 3)" for an Add button, or nothing when the plan has no limit on it. */
export const countText = (use?: UnitUse) => (use && use.limit != null ? ` (${use.used} of ${use.limit})` : "");

/**
 * What an Add button becomes at its plan's limit: the button, disabled, with the reason beside it and a way forward. The server refuses the add regardless (src/server/tl/plan.ts);
 * this is so a person is told before they fill a form in, not after.
 */
export function AtLimit({ use, label }: { use: UnitUse; label: string }) {
  const reason = `Your plan holds ${use.limit} ${use.word}, and ${use.used} ${use.used === 1 ? "is" : "are"} in service.`;
  return (
    <>
      <button type="button" className="tl-btn primary" disabled aria-disabled="true" title={reason}>
        {label}
      </button>
      <Link href="/settings#plan" className="tl-btn" title={reason}>
        {use.used} of {use.limit} {use.word} · Change plan
      </Link>
    </>
  );
}
