"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { keptText, parseKept, splitStorageKey } from "@/lib/split";
import { uiZoom } from "@/lib/ui-zoom";
import { Icon } from "./kit/icons";
import { useUnderlay } from "./underlay";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
const DECK_SPLIT_ID = "drawer-deck";
const DECK_COLLAPSE_SNAP = 44;
const DECK_FULL_SNAP = 8;
const DECK_KEY_STEP = 32;

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
  actions,
  footer,
  href,
  label,
  children
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  chips?: React.ReactNode;
  deck?: React.ReactNode;
  nav?: React.ReactNode;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  /** The load's address: how the rows of the table underneath know which one is open (J and K step through them). */
  href: string;
  /** What the drawer is called to a screen reader, when its title is more than words. */
  label?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const underlay = useUnderlay();
  const panel = React.useRef<HTMLElement>(null);
  const deckRef = React.useRef<HTMLDivElement>(null);
  const deckInnerRef = React.useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [scrub, setScrub] = React.useState<ScrubState | null>(null);
  const [showShortcuts, setShowShortcuts] = React.useState(false);
  const [deckSize, setDeckSize] = React.useState<number | null>(null);
  const [deckCollapsed, setDeckCollapsed] = React.useState(false);
  const [deckDragging, setDeckDragging] = React.useState(false);
  const [liveDeckHeight, setLiveDeckHeight] = React.useState<number | null>(null);
  const [deckNatural, setDeckNatural] = React.useState(320);
  const liveDeckHeightRef = React.useRef<number | null>(null);
  const deckNaturalRef = React.useRef(320);
  const deckDrag = React.useRef<{ startY: number; startHeight: number; maxHeight: number; moved: boolean } | null>(null);
  // The key handler below is set up once, so it reads this ref: Esc closes the shortcuts sheet first, and only the next Esc closes the drawer.
  const shortcutsOpen = React.useRef(false);
  shortcutsOpen.current = showShortcuts;

  const persistDeck = React.useCallback((next: { size: number | null; hidden: boolean }) => {
    try {
      window.localStorage.setItem(splitStorageKey(DECK_SPLIT_ID), keptText(next));
    } catch {
      /* blocked storage just forgets the choice */
    }
  }, []);

  const useLayout = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;
  useLayout(() => {
    try {
      const kept = parseKept(window.localStorage.getItem(splitStorageKey(DECK_SPLIT_ID)), false);
      setDeckCollapsed(kept.hidden);
      setDeckSize(kept.size != null && kept.size >= DECK_COLLAPSE_SNAP ? kept.size : null);
    } catch {
      /* blocked storage uses default expanded deck */
    }
  }, []);

  const deckHidden = Boolean(deck && deckCollapsed && !deckDragging);

  React.useEffect(() => {
    if (!deck || deckHidden) return;
    const inner = deckInnerRef.current;
    if (!inner) return;
    const readNatural = () => {
      const h = inner.offsetHeight;
      if (h > 0) {
        deckNaturalRef.current = h;
        setDeckNatural(h);
      }
    };
    readNatural();
    const ro = new ResizeObserver(readNatural);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [deck, deckHidden]);

  const deckStyle = React.useMemo<React.CSSProperties | undefined>(() => {
    if (deckDragging && liveDeckHeight != null) return { height: liveDeckHeight };
    if (!deckCollapsed && deckSize != null) return { maxHeight: deckSize };
    return undefined;
  }, [deckDragging, liveDeckHeight, deckCollapsed, deckSize]);

  const deckPct = React.useMemo(() => {
    const max = Math.max(1, deckNatural);
    if (deckDragging && liveDeckHeight != null) return Math.min(100, Math.round((liveDeckHeight / max) * 100));
    if (deckCollapsed) return 0;
    if (deckSize != null) return Math.min(100, Math.round((deckSize / max) * 100));
    return 100;
  }, [deckNatural, deckDragging, liveDeckHeight, deckCollapsed, deckSize]);

  const toggleDeckCollapsed = React.useCallback(() => {
    if (deckCollapsed) {
      setDeckCollapsed(false);
      setDeckSize(null);
      persistDeck({ size: null, hidden: false });
    } else {
      setDeckCollapsed(true);
      persistDeck({ size: null, hidden: true });
    }
  }, [deckCollapsed, persistDeck]);

  const onSplitPointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const startHeight = deckCollapsed ? 0 : (deckRef.current?.offsetHeight ?? deckNaturalRef.current);
      const maxHeight = Math.max(deckInnerRef.current?.offsetHeight || deckNaturalRef.current, startHeight);
      deckDrag.current = { startY: e.clientY, startHeight, maxHeight, moved: false };
      liveDeckHeightRef.current = startHeight;
      setLiveDeckHeight(startHeight);
      setDeckDragging(true);
    },
    [deckCollapsed]
  );

  const onSplitPointerMove = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = deckDrag.current;
    if (!d) return;
    const measured = deckInnerRef.current?.offsetHeight ?? 0;
    if (measured > 0) {
      deckNaturalRef.current = measured;
      d.maxHeight = Math.max(measured, d.startHeight);
      setDeckNatural(measured);
    }
    const rawDelta = (e.clientY - d.startY) / uiZoom();
    if (Math.abs(rawDelta) > 2) d.moved = true;
    const next = Math.max(0, Math.min(d.maxHeight, Math.round(d.startHeight + rawDelta)));
    liveDeckHeightRef.current = next;
    setLiveDeckHeight(next);
  }, []);

  const onSplitPointerUp = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = deckDrag.current;
      if (!d) return;
      deckDrag.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      const finalH = liveDeckHeightRef.current ?? d.startHeight;
      liveDeckHeightRef.current = null;
      setLiveDeckHeight(null);
      setDeckDragging(false);
      if (!d.moved) return;

      if (finalH <= DECK_COLLAPSE_SNAP) {
        setDeckCollapsed(true);
        setDeckSize(null);
        persistDeck({ size: null, hidden: true });
      } else if (finalH >= d.maxHeight - DECK_FULL_SNAP) {
        setDeckCollapsed(false);
        setDeckSize(null);
        persistDeck({ size: null, hidden: false });
      } else {
        setDeckCollapsed(false);
        setDeckSize(finalH);
        persistDeck({ size: finalH, hidden: false });
      }
    },
    [persistDeck]
  );

  const onSplitDoubleClick = React.useCallback(() => {
    if (deckCollapsed || deckSize != null) {
      setDeckCollapsed(false);
      setDeckSize(null);
      persistDeck({ size: null, hidden: false });
    } else {
      setDeckCollapsed(true);
      setDeckSize(null);
      persistDeck({ size: null, hidden: true });
    }
  }, [deckCollapsed, deckSize, persistDeck]);

  const onSplitKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleDeckCollapsed();
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        setDeckCollapsed(true);
        setDeckSize(null);
        persistDeck({ size: null, hidden: true });
        return;
      }
      const max = Math.max(deckInnerRef.current?.offsetHeight || deckNaturalRef.current, DECK_COLLAPSE_SNAP + 24);
      if (e.key === "End") {
        e.preventDefault();
        setDeckCollapsed(false);
        setDeckSize(null);
        persistDeck({ size: null, hidden: false });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (deckCollapsed) return;
        const current = deckRef.current?.offsetHeight ?? deckSize ?? max;
        const next = current - DECK_KEY_STEP;
        if (next <= DECK_COLLAPSE_SNAP) {
          setDeckCollapsed(true);
          setDeckSize(null);
          persistDeck({ size: null, hidden: true });
        } else {
          setDeckCollapsed(false);
          setDeckSize(next);
          persistDeck({ size: next, hidden: false });
        }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (deckCollapsed) {
          const openAt = Math.min(max, Math.max(DECK_COLLAPSE_SNAP + 24, DECK_KEY_STEP * 3));
          const full = openAt >= max - DECK_FULL_SNAP;
          setDeckCollapsed(false);
          setDeckSize(full ? null : openAt);
          persistDeck({ size: full ? null : openAt, hidden: false });
          return;
        }
        if (deckSize == null) return;
        const current = deckRef.current?.offsetHeight ?? deckSize;
        const next = current + DECK_KEY_STEP;
        if (next >= max - DECK_FULL_SNAP) {
          setDeckCollapsed(false);
          setDeckSize(null);
          persistDeck({ size: null, hidden: false });
        } else {
          setDeckSize(next);
          persistDeck({ size: next, hidden: false });
        }
      }
    },
    [deckCollapsed, deckSize, persistDeck, toggleDeckCollapsed]
  );

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
      const idx = rows.findIndex((r) => r.getAttribute("data-href") === href);
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
  }, [href]);

  React.useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>(".dr-close")?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".k-scrim")) return; // a dialog is open on top: it owns Esc and Tab
      const target = e.target as HTMLElement | null;
      const isInput = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      const isSeparator = target?.getAttribute("role") === "separator";

      if (e.key === "Escape") {
        e.preventDefault();
        if (shortcutsOpen.current) setShowShortcuts(false);
        else close();
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

      if (e.key === "j" || e.key === "J" || (e.key === "ArrowDown" && !isSeparator)) {
        const rows = Array.from(document.querySelectorAll<HTMLTableRowElement>("table.dt tbody tr[data-href]"));
        const idx = rows.findIndex((r) => r.getAttribute("data-href") === href);
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

      if (e.key === "k" || e.key === "K" || (e.key === "ArrowUp" && !isSeparator)) {
        const rows = Array.from(document.querySelectorAll<HTMLTableRowElement>("table.dt tbody tr[data-href]"));
        const idx = rows.findIndex((r) => r.getAttribute("data-href") === href);
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
  }, [close, href, router]);

  return (
    <div className="dr-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <aside className="dr" ref={panel} role="dialog" aria-modal="true" aria-label={label ?? (typeof title === "string" ? title : "Load details")} data-expanded={expanded ? "true" : undefined}>
        {/* Pinned console dock: Header, Metrics Deck, and Workbench Navigation stay 100% fixed at top */}
        <div
          className="dr-pinned-top"
          data-deck-collapsed={deck && deckCollapsed && !deckDragging ? "true" : undefined}
          data-deck-dragging={deckDragging ? "true" : undefined}>
          <header className="dr-head">
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2>{title}</h2>
              {sub ? <div className="sub">{sub}</div> : null}
              {chips ? <div className="chips">{chips}</div> : null}
            </div>
            <div className="dr-ctrls">
              {actions}
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
                </div>
              ) : null}
              <button type="button" className="dr-close" onClick={close} aria-label="Close drawer (Esc)" title="Close (Esc)">
                <Icon name="close" size={16} />
              </button>
            </div>
          </header>

          {deck ? (
            <div
              id="dr-deck-panel"
              ref={deckRef}
              className="dr-deck-strip"
              data-sized={deckDragging || (!deckCollapsed && deckSize != null) ? "true" : undefined}
              hidden={deckHidden}
              style={deckStyle}>
              <div ref={deckInnerRef} className="lv-deck">
                {deck}
              </div>
            </div>
          ) : null}
          {nav || deck ? (
            <div className="dr-nav-strip">
              {nav}
              {deck ? (
                <button
                  type="button"
                  className="dr-deck-toggle"
                  onClick={toggleDeckCollapsed}
                  aria-expanded={!deckCollapsed}
                  aria-controls="dr-deck-panel"
                  title={deckCollapsed ? "Expand load summary" : "Collapse load summary to see more below"}>
                  <Icon name={deckCollapsed ? "chevronDown" : "chevronUp"} size={13} />
                  <span>{deckCollapsed ? "Show summary" : "Collapse"}</span>
                </button>
              ) : null}
            </div>
          ) : null}
          {deck ? (
            <div
              className="dr-split-bar"
              role="separator"
              aria-orientation="horizontal"
              aria-label="Drag to resize or collapse load summary"
              aria-controls="dr-deck-panel"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={deckPct}
              tabIndex={0}
              onPointerDown={onSplitPointerDown}
              onPointerMove={onSplitPointerMove}
              onPointerUp={onSplitPointerUp}
              onPointerCancel={onSplitPointerUp}
              onDoubleClick={onSplitDoubleClick}
              onKeyDown={onSplitKeyDown}
              title="Drag up to collapse or down to expand. Double-click to toggle.">
              <span className="dr-split-grip" aria-hidden="true" />
            </div>
          ) : null}
        </div>

        {/* Scrollable body: starts right below the workbench tab bar, zero gap, zero underlap */}
        <div className="dr-body">{children}</div>

        <footer className="dr-foot">{footer}</footer>
      </aside>

      {/* Keyboard Shortcuts Modal */}
      {showShortcuts ? (
        <div className="cp-kbd-modal" role="dialog" aria-modal="true" aria-label="Keyboard Shortcuts" onClick={() => setShowShortcuts(false)}>
          <div className="cp-kbd-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="cp-kbd-head">
              <h3>Shortcuts</h3>
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
                <span>Switch tabs</span>
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
