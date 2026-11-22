"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { pullMessagesNowAction } from "@/app/(desk)/actions";
import { LIVE_POLL_MS, refreshDue } from "@/lib/live-messages";

/**
 * Keeps the Messages page current without a reload (lib/live-messages.ts). Only while the tab is visible; looks again the moment the tab comes back. The refresh re-reads the server page
 * and keeps what the dispatcher is typing (the composer's text is a kept draft, and client state survives a refresh).
 */
export function LiveMessages() {
  const router = useRouter();
  const lastRefresh = React.useRef(Date.now());
  const busy = React.useRef(false);

  React.useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (stopped || busy.current || document.visibilityState !== "visible") return;
      busy.current = true;
      try {
        const out = await pullMessagesNowAction();
        const now = Date.now();
        if (!stopped && refreshDue({ changed: out.changed, lastRefreshAt: lastRefresh.current, now })) {
          lastRefresh.current = now;
          router.refresh();
        }
      } catch {
        // A missed look is fine: the next one, or the minute cron, catches up.
      } finally {
        busy.current = false;
      }
    };
    const id = window.setInterval(() => void tick(), LIVE_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);

  return null;
}
