"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { BrandMark } from "./kit/brand-mark";
import "./splash.css";

const SEEN_KEY = "desk-splash-seen";
export const SLEEP_NOW_EVENT = "desk:sleep-now";

const seen = () => {
  try {
    if (new URLSearchParams(window.location.search).get("intro") === "1") return false;
    return window.sessionStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
};

const markSeen = () => {
  try {
    window.sessionStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* storage blocked */
  }
};

/**
 * The shared TrueLane intro & sleep curtain:
 * - Signature 1.2s T-mark -> wordmark -> gold hairline -> slogan animation
 * - Quiet architectural hairline button on desktop (> 640px)
 * - Bottom-pinned full-width golden bar on mobile (<= 640px)
 */
export function SplashCurtain({
  label = "Enter desk",
  mobileLabel = "Get started",
  leaving,
  onEnter
}: {
  label?: string;
  mobileLabel?: string;
  leaving: boolean;
  onEnter: () => void;
}) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        onEnter();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onEnter]);

  return (
    <div
      className="sp"
      data-leaving={leaving ? "true" : "false"}
      role="dialog"
      aria-modal="true"
      aria-label="TrueLane"
    >
      <div className="sp-inner">
        <BrandMark size={136} className="sp-mark" />
        <h1 className="sp-word">TRUELANE</h1>
        <span className="sp-rule" aria-hidden="true" />
        <p className="sp-slogan">Know your worth — know it truly.</p>
        <button type="button" className="sp-cta-desk" onClick={onEnter}>
          <span>{label}</span>
          <i aria-hidden="true">→</i>
        </button>
      </div>
      <div className="sp-foot-mobile">
        <button type="button" className="sp-cta-gold" onClick={onEnter}>
          {mobileLabel} <i aria-hidden="true">→</i>
        </button>
      </div>
    </div>
  );
}

/**
 * The desk's front door at "/": shows once per browser session (or whenever "?intro=1" is passed),
 * then lifts the curtain into `next`.
 */
export function Splash({ next, label = "Enter desk", mobileLabel = "Get started" }: { next: string; label?: string; mobileLabel?: string }) {
  const router = useRouter();
  const [state, setState] = React.useState<"checking" | "showing" | "leaving">("checking");
  const leavingRef = React.useRef(false);

  React.useEffect(() => {
    if (seen()) {
      router.replace(next);
      return;
    }
    router.prefetch(next);
    setState("showing");
  }, [next, router]);

  const go = React.useCallback(() => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    markSeen();
    router.prefetch(next);
    setState("leaving");
    window.setTimeout(() => router.replace(next), 340);
  }, [next, router]);

  if (state === "checking") return <div className="sp" aria-hidden="true" />;
  return <SplashCurtain label={label} mobileLabel={mobileLabel} leaving={state === "leaving"} onEnter={go} />;
}

/**
 * Idle sleep mode inside the desk shell: after `minutes` without pointer, keyboard, touch or scroll activity
 * (or immediately when `desk:sleep-now` is triggered), drops the full TrueLane intro curtain over the live page
 * without losing open drawers, typed form state, or scroll position underneath.
 */
export function SleepGuard({ minutes }: { minutes: number }) {
  const [phase, setPhase] = React.useState<"awake" | "sleeping" | "waking">("awake");
  const lastActiveRef = React.useRef<number>(Date.now());
  const wakingRef = React.useRef(false);

  const sleepNow = React.useCallback(() => {
    wakingRef.current = false;
    // Blur any active input beneath the curtain so Enter wakes the curtain cleanly instead of submitting a form behind it.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setPhase("sleeping");
  }, []);

  const wake = React.useCallback(() => {
    if (wakingRef.current) return;
    wakingRef.current = true;
    lastActiveRef.current = Date.now();
    setPhase("waking");
    window.setTimeout(() => {
      wakingRef.current = false;
      lastActiveRef.current = Date.now();
      setPhase("awake");
    }, 340);
  }, []);

  React.useEffect(() => {
    const onManual = () => sleepNow();
    window.addEventListener(SLEEP_NOW_EVENT, onManual);
    return () => window.removeEventListener(SLEEP_NOW_EVENT, onManual);
  }, [sleepNow]);

  React.useEffect(() => {
    if (minutes <= 0 || phase !== "awake") return;
    const timeoutMs = minutes * 60_000;
    lastActiveRef.current = Date.now();
    let timerId: number | null = null;

    const schedule = () => {
      if (timerId != null) window.clearTimeout(timerId);
      const elapsed = Date.now() - lastActiveRef.current;
      const remaining = timeoutMs - elapsed;
      if (remaining <= 0) {
        sleepNow();
        return;
      }
      timerId = window.setTimeout(schedule, remaining);
    };

    let lastBump = 0;
    const bump = () => {
      const now = Date.now();
      if (now - lastBump < 1000) return;
      lastBump = now;
      lastActiveRef.current = now;
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible" && Date.now() - lastActiveRef.current >= timeoutMs) {
        sleepNow();
      }
    };

    const events = ["mousemove", "mousedown", "keydown", "touchstart", "wheel", "scroll"] as const;
    for (const ev of events) window.addEventListener(ev, bump, { passive: true, capture: true });
    document.addEventListener("visibilitychange", onVisibility);
    schedule();

    return () => {
      if (timerId != null) window.clearTimeout(timerId);
      for (const ev of events) window.removeEventListener(ev, bump, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [minutes, phase, sleepNow]);

  if (phase === "awake") return null;
  return <SplashCurtain label="Enter desk" mobileLabel="Get started" leaving={phase === "waking"} onEnter={wake} />;
}

/** Button for Settings -> Appearance to preview / trigger Sleep mode on demand. */
export function SleepNowButton() {
  return (
    <button
      type="button"
      className="tl-btn sm"
      onClick={() => window.dispatchEvent(new Event(SLEEP_NOW_EVENT))}
    >
      Sleep now
    </button>
  );
}
