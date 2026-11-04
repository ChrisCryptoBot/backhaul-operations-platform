"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { Icon } from "./kit/icons";
import { useUnderlay } from "./underlay";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

interface ScrubState {
  index: number;
  total: number;
  prevHref: string | null;
  nextHref: string | null;
}

/**
 * The side panel a load opens in over the board.
 * Supports:
 * - High-visibility scrim (no blur, load board stays interactive/legible)
 * - Dock expansion mode (toggle via `\` key or header icon)
 * - Global board scrubbing (J / K or Down / Up) to switch loads without closing
 * - Pinned console header deck & docked workbench navigation
 * - Closes on Esc, backdrop click, or close button
 */
export function DrawerFrame({
  title,
  sub,
  chips,
  deck,
  nav,
  footer,
  fullHref,
  children
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  chips?: React.ReactNode;
  deck?: React.ReactNode;
  nav?: React.ReactNode;
  footer?: React.ReactNode;
  fullHref: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const underlay = useUnderlay();
  const panel = React.useRef<HTMLElement>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [scrub, setScrub] = React.useState<ScrubState | null>(null);
  const deckRef = React.useRef<HTMLDivElement>(null);
  const [deckHeight, setDeckHeight] = React.useState<number | null>(null);
  const [isDragging, setIsDragging] = React.useState(false);
  const [showShortcuts, setShowShortcuts] = React.useState(false);

  // Measure bounds: min = Route Ribbon container height, max = natural full deck height
  const getDeckBounds = React.useCallback(() => {
    if (!deckRef.current) return { min: 68, max: 240 };
    const firstChild = deckRef.current.firstElementChild as HTMLElement | null;
    const topHeight = firstChild ? firstChild.offsetHeight + 24 : 68; // Top container + padding
    const max = deckRef.current.scrollHeight;
    return { min: topHeight, max: Math.max(topHeight, max) };
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const bounds = getDeckBounds();
    const startY = e.clientY;
    const startHeight = deckHeight ?? (deckRef.current?.offsetHeight || bounds.max);

    setIsDragging(true);
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = moveEvent.clientY - startY;
      const nextHeight = Math.max(bounds.min, Math.min(bounds.max, startHeight + deltaY));
      setDeckHeight(nextHeight);
    };

    const onMouseUp = () => {
      setIsDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const handleDoubleClick = () => {
    const bounds = getDeckBounds();
    if (deckHeight !== null && deckHeight <= bounds.min + 10) {
      setDeckHeight(bounds.max);
    } else {
      setDeckHeight(bounds.min);
    }
  };

  const close = React.useCallback(() => router.replace(underlay.current, { scroll: false }), [router, underlay]);

  const goTo = React.useCallback(
    (href: string | null) => {
      if (!href) return;
      router.replace(href, { scroll: false });
    },
    [router]
  );

  // Update scrub state from underlying table rows
  React.useEffect(() => {
    const updateScrub = () => {
      const rows = Array.from(document.querySelectorAll<HTMLTableRowElement>("table.dt tbody tr[data-href]"));
      if (rows.length === 0) {
        setScrub(null);
        return;
      }
      const idx = rows.findIndex((r) => r.getAttribute("data-href") === fullHref);
      if (idx !== -1) {
        setScrub({
          index: idx + 1,
          total: rows.length,
          prevHref: idx > 0 ? rows[idx - 1].getAttribute("data-href") : null,
          nextHref: idx < rows.length - 1 ? rows[idx + 1].getAttribute("data-href") : null
        });
        // Keep active row visible in background board
        rows[idx].scrollIntoView({ block: "nearest" });
      } else {
        setScrub(null);
      }
    };

    updateScrub();
  }, [fullHref]);

  React.useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>(".dr-close")?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".k-scrim")) return; // a dialog is open on top: it owns Esc and Tab
      const target = e.target as HTMLElement | null;
      const isInput = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);

      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }

      if (isInput) return;

      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setShowShortcuts((prev) => !prev);
        return;
      }

      if (e.key === "\\") {
        e.preventDefault();
        setExpanded((prev) => !prev);
        return;
      }

      if (e.key === "j" || e.key === "J" || e.key === "ArrowDown") {
        const rows = Array.from(document.querySelectorAll<HTMLTableRowElement>("table.dt tbody tr[data-href]"));
        const idx = rows.findIndex((r) => r.getAttribute("data-href") === fullHref);
        if (idx !== -1 && idx < rows.length - 1) {
          e.preventDefault();
          const nextHref = rows[idx + 1].getAttribute("data-href");
          if (nextHref) {
            router.replace(nextHref, { scroll: false });
            rows[idx + 1].scrollIntoView({ block: "nearest" });
          }
        }
        return;
      }

      if (e.key === "k" || e.key === "K" || e.key === "ArrowUp") {
        const rows = Array.from(document.querySelectorAll<HTMLTableRowElement>("table.dt tbody tr[data-href]"));
        const idx = rows.findIndex((r) => r.getAttribute("data-href") === fullHref);
        if (idx > 0) {
          e.preventDefault();
          const prevHref = rows[idx - 1].getAttribute("data-href");
          if (prevHref) {
            router.replace(prevHref, { scroll: false });
            rows[idx - 1].scrollIntoView({ block: "nearest" });
          }
        }
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
  }, [close, fullHref, router]);

  return (
    <div className="dr-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <aside className="dr" ref={panel} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : "Load details"} data-expanded={expanded ? "true" : undefined}>
        {/* Pinned console dock: Header, Metrics Deck, and Workbench Navigation stay 100% fixed at top */}
        <div className="dr-pinned-top">
          <header className="dr-head">
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2>{title}</h2>
              {sub ? <div className="sub">{sub}</div> : null}
              {chips ? <div className="chips">{chips}</div> : null}
            </div>
            <div className="dr-ctrls">
              {scrub ? (
                <div className="dr-nav-scrub" title="Scrub through loads (J = next, K = prev)">
                  <span>{scrub.index} / {scrub.total}</span>
                  <button
                    type="button"
                    className="dr-btn-icon"
                    disabled={!scrub.prevHref}
                    onClick={() => goTo(scrub.prevHref)}
                    aria-label="Previous load (K)"
                    title="Previous load (K)">
                    <Icon name="chevronUp" size={14} />
                  </button>
                  <button
                    type="button"
                    className="dr-btn-icon"
                    disabled={!scrub.nextHref}
                    onClick={() => goTo(scrub.nextHref)}
                    aria-label="Next load (J)"
                    title="Next load (J)">
                    <Icon name="chevronDown" size={14} />
                  </button>
                  <span className="cp-kbd">J/K</span>
                </div>
              ) : null}
              <button
                type="button"
                className="dr-btn-icon"
                onClick={() => setExpanded((prev) => !prev)}
                aria-label={expanded ? "Collapse drawer width (\\)" : "Expand dock width (\\)"}
                title={expanded ? "Collapse drawer (\\)" : "Expand dock (\\)"}>
                <Icon name={expanded ? "collapse" : "expand"} size={16} />
              </button>
              <span className="cp-kbd">\</span>
              <button
                type="button"
                className="dr-btn-icon"
                onClick={() => setShowShortcuts((prev) => !prev)}
                aria-label="Keyboard shortcuts (?)"
                title="Keyboard shortcuts (?)">
                <Icon name="help" size={15} />
              </button>
              <span className="cp-kbd">?</span>
              <button type="button" className="dr-close" onClick={close} aria-label="Close drawer (Esc)" title="Close (Esc)">
                <Icon name="close" size={16} />
              </button>
            </div>
          </header>

          {deck ? (
            <div
              ref={deckRef}
              className="dr-deck-strip"
              style={{
                height: deckHeight != null ? `${deckHeight}px` : undefined,
                overflow: "hidden",
                transition: isDragging ? "none" : "height 160ms cubic-bezier(0.2, 0, 0, 1)"
              }}>
              {deck}
            </div>
          ) : null}
          {nav ? <div className="dr-nav-strip">{nav}</div> : null}
          <div
            className="dr-resizer"
            onMouseDown={handleMouseDown}
            onDoubleClick={handleDoubleClick}
            data-dragging={isDragging ? "true" : undefined}
            title="Drag north/south to expand or retract console deck (Double-click to toggle)"
            role="separator"
            aria-orientation="horizontal"
          />
        </div>

        {/* Scrollable body: starts right below the workbench tab bar, zero gap, zero underlap */}
        <div className="dr-body">{children}</div>

        <footer className="dr-foot">
          {footer}
          {/* A plain link on purpose: a normal page load skips the drawer and shows the load as a full page. */}
          <a href={fullHref} className="tl-btn ghost sm grow">
            Open full page
          </a>
        </footer>
      </aside>

      {/* Keyboard Shortcuts Modal */}
      {showShortcuts ? (
        <div className="cp-kbd-modal" role="dialog" aria-modal="true" aria-label="Keyboard Shortcuts" onClick={() => setShowShortcuts(false)}>
          <div className="cp-kbd-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="cp-kbd-head">
              <h3>Cockpit Hotkeys & Navigation</h3>
              <button type="button" className="dr-close" onClick={() => setShowShortcuts(false)} aria-label="Close shortcuts">
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="cp-kbd-list">
              <div className="cp-kbd-row">
                <span>Scrub Next / Previous Load</span>
                <span className="cp-kbd">J / K (or ↓ / ↑)</span>
              </div>
              <div className="cp-kbd-row">
                <span>Switch Workbench Tabs (1–4)</span>
                <span className="cp-kbd">1, 2, 3, 4</span>
              </div>
              <div className="cp-kbd-row">
                <span>Toggle Drawer Dock Width</span>
                <span className="cp-kbd">\</span>
              </div>
              <div className="cp-kbd-row">
                <span>Cycle Attached Documents</span>
                <span className="cp-kbd">← / →</span>
              </div>
              <div className="cp-kbd-row">
                <span>Expand / Retract Console Deck</span>
                <span className="cp-kbd">Drag line / Double-click</span>
              </div>
              <div className="cp-kbd-row">
                <span>Close Drawer or Active Modal</span>
                <span className="cp-kbd">Esc</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
