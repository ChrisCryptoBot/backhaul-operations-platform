"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { pullAnswersNowAction } from "@/app/(desk)/actions";

/** How often an open queue looks again. */
export const LIVE_EVERY_MS = 30_000;

/**
 * Keeps the Dispatch queue current while it is on screen: every half minute (and when the tab comes back) it asks the driver link for new answers, for someone who may dispatch, then draws
 * the page again. It waits while a window is open or a field has the cursor, so nothing someone is typing or choosing moves under them.
 */
export function LiveRefresh({ pull }: { pull: boolean }) {
  const router = useRouter();
  React.useEffect(() => {
    let stopped = false;
    const busy = () => document.querySelector("dialog[open], [role=dialog]") != null || (document.activeElement != null && document.activeElement.matches("input, textarea, select"));
    // The first look, as the page opens, only draws again when the link brought something new: the page was just drawn.
    const tick = async (first = false) => {
      if (stopped || document.hidden || busy()) return;
      const out = pull ? await pullAnswersNowAction().catch(() => null) : null;
      if (first && !out?.changed) return;
      if (!stopped && !busy()) router.refresh();
    };
    void tick(true);
    const timer = window.setInterval(() => void tick(), LIVE_EVERY_MS);
    const back = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", back);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", back);
    };
  }, [pull, router]);
  return null;
}
