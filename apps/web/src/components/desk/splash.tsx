"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { BrandMark } from "./kit/brand-mark";
import "./splash.css";

const SEEN_KEY = "desk-splash-seen";

const seen = () => {
  try {
    return window.sessionStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false; // storage blocked: show it; the worst case is seeing it twice
  }
};
const markSeen = () => {
  try {
    window.sessionStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* nothing to do */
  }
};

/**
 * The desk's front door: the phone app's launch intro, then a button. It is the page at "/", so a link straight into a screen never sees it,
 * and a browser session sees it once (a second visit to "/" goes straight through).
 * Nothing here waits on the network: the screen sits on the brand ground until the button is pressed.
 */
export function Splash({ next, label = "Continue" }: { next: string; label?: string }) {
  const router = useRouter();
  const [state, setState] = React.useState<"checking" | "showing" | "leaving">("checking");
  const button = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (seen()) {
      router.replace(next);
      return;
    }
    setState("showing");
  }, [next, router]);

  React.useEffect(() => {
    if (state === "showing") button.current?.focus({ preventScroll: true });
  }, [state]);

  const go = () => {
    if (state !== "showing") return;
    markSeen();
    router.prefetch(next);
    setState("leaving");
    // The slide takes 320ms (a plain 120ms fade under Reduce Motion); leave a beat longer so the screen is never cut off mid-move.
    window.setTimeout(() => router.replace(next), 340);
  };

  if (state === "checking") return <div className="sp" aria-hidden="true" />;
  return (
    <div className="sp" data-leaving={state === "leaving" ? "true" : "false"} role="dialog" aria-modal="true" aria-label="TrueLane">
      <div className="sp-inner">
        <BrandMark size={136} className="sp-mark" />
        <h1 className="sp-word">TRUELANE</h1>
        <span className="sp-rule" aria-hidden="true" />
        <p className="sp-slogan">Know your worth — know it truly.</p>
        <button ref={button} type="button" className="sp-cta" onClick={go}>
          {label} <i aria-hidden="true">→</i>
        </button>
      </div>
    </div>
  );
}
