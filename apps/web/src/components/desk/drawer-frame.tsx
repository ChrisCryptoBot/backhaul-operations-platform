"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { Icon } from "./kit/icons";
import { useUnderlay } from "./underlay";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * The side panel a load opens in over the board. Closes on Esc, a click on the dim area or the close button
 * (all return to the page underneath, see underlay.tsx), keeps Tab inside, and hands focus back to whatever opened it.
 */
export function DrawerFrame({ title, sub, chips, footer, fullHref, children }: { title: string; sub?: React.ReactNode; chips?: React.ReactNode; footer?: React.ReactNode; fullHref: string; children: React.ReactNode }) {
  const router = useRouter();
  const underlay = useUnderlay();
  const panel = React.useRef<HTMLElement>(null);
  const close = React.useCallback(() => router.replace(underlay.current, { scroll: false }), [router, underlay]);

  React.useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>(".dr-close")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".k-scrim")) return; // a dialog is open on top: it owns Esc and Tab
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const els = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (els.length === 0) return;
      const first = els[0]!;
      const last = els[els.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [close]);

  return (
    <div className="dr-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <aside className="dr" ref={panel} role="dialog" aria-modal="true" aria-label={title}>
        <header className="dr-head">
          <div>
            <h2>{title}</h2>
            {sub ? <div className="sub">{sub}</div> : null}
            {chips ? <div className="chips">{chips}</div> : null}
          </div>
          <button type="button" className="dr-close" onClick={close} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="dr-body">{children}</div>
        <footer className="dr-foot">
          {footer}
          {/* A plain link on purpose: a normal page load skips the drawer and shows the load as a full page. */}
          <a href={fullHref} className="tl-btn ghost sm grow">
            Open full page
          </a>
        </footer>
      </aside>
    </div>
  );
}
