"use client";

import React from "react";
import { clampSize, keptText, parseKept, splitStorageKey, stepSize } from "@/lib/split";

/**
 * Two panes with a bar between them that is dragged, and nudged from the keyboard (arrows, Home, End). A double-click puts it back; Expand and Contract push the first pane to its largest
 * and smallest; Hide folds it away to a slim bar with a Show button. What was chosen is remembered per `id` (this browser, guarded: private windows and blocked storage just forget it).
 *
 * `orientation="vertical"` stacks them (first above second; the bar is horizontal and is dragged up and down), `"horizontal"` puts the first on the left. The first pane's size is in pixels; the
 * second takes the rest and never gets less than `minSecond`. `tools` is extra buttons for the bar (a link to the full screen, say).
 */
export function SplitPane({
  id,
  orientation,
  first,
  second,
  defaultSize,
  min = 120,
  minSecond = 160,
  firstLabel,
  tools
}: {
  id: string;
  orientation: "vertical" | "horizontal";
  first: React.ReactNode;
  second: React.ReactNode;
  defaultSize: number;
  min?: number;
  minSecond?: number;
  /** What the first pane is called in the buttons: "map" gives "Hide map" and "Show map". */
  firstLabel: string;
  tools?: React.ReactNode;
}) {
  const box = React.useRef<HTMLDivElement>(null);
  const [size, setSize] = React.useState(defaultSize);
  const [hidden, setHidden] = React.useState(false);
  const [total, setTotal] = React.useState(0);
  const [dragging, setDragging] = React.useState(false);
  const drag = React.useRef<{ at: number; from: number } | null>(null);
  const vertical = orientation === "vertical";

  // What the container can give the first pane: all of it but the second pane's minimum and the bar.
  const BAR = 28;
  const limits = React.useMemo(() => ({ min, max: total > 0 ? total - minSecond - BAR : Math.max(defaultSize, min) }), [min, minSecond, total, defaultSize]);
  const current = clampSize(size, limits);

  const keep = React.useCallback(
    (next: { size?: number; hidden?: boolean }) => {
      try {
        window.localStorage.setItem(splitStorageKey(id), keptText({ size: next.size ?? size, hidden: next.hidden ?? hidden }));
      } catch {
        /* nothing kept; the split still works */
      }
    },
    [id, size, hidden]
  );

  // Put back what was kept before the first paint, and follow the container's size.
  const useLayout = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;
  useLayout(() => {
    try {
      const kept = parseKept(window.localStorage.getItem(splitStorageKey(id)));
      if (kept.size != null) setSize(kept.size);
      setHidden(kept.hidden);
    } catch {
      /* nothing kept */
    }
  }, [id]);
  React.useEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => setTotal(vertical ? el.clientHeight : el.clientWidth);
    read();
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  }, [vertical]);

  const set = (n: number, persist = true) => {
    const v = clampSize(n, limits);
    setSize(v);
    if (persist) keep({ size: v });
  };

  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { at: vertical ? e.clientY : e.clientX, from: current };
    setDragging(true);
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    set(d.from + ((vertical ? e.clientY : e.clientX) - d.at), false);
  };
  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    keep({ size: current });
  };
  const key = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const n = stepSize(current, e.key, limits);
    if (n == null) return;
    e.preventDefault();
    set(n);
  };

  const pct = limits.max > limits.min ? Math.round(((current - limits.min) / (limits.max - limits.min)) * 100) : 0;
  const fold = (h: boolean) => {
    setHidden(h);
    keep({ hidden: h });
  };

  return (
    <div ref={box} className={`spl spl-${orientation}${dragging ? " spl-dragging" : ""}${hidden ? " spl-folded" : ""}`}>
      {hidden ? null : (
        <div className="spl-first" style={vertical ? { height: current } : { width: current }}>
          {first}
        </div>
      )}
      <div
        className="spl-bar"
        role="separator"
        aria-orientation={vertical ? "horizontal" : "vertical"}
        aria-label={`Resize the ${firstLabel}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={hidden ? 0 : pct}
        tabIndex={hidden ? -1 : 0}
        onPointerDown={hidden ? undefined : down}
        onPointerMove={hidden ? undefined : move}
        onPointerUp={hidden ? undefined : up}
        onPointerCancel={hidden ? undefined : up}
        onKeyDown={hidden ? undefined : key}
        onDoubleClick={hidden ? undefined : () => set(defaultSize)}
        title={hidden ? undefined : "Drag to resize. Double-click to reset."}>
        <span className="spl-grip" aria-hidden="true" />
        <span className="spl-tools" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          {hidden ? (
            <button type="button" className="tl-btn ghost sm" onClick={() => fold(false)}>
              Show {firstLabel}
            </button>
          ) : (
            <>
              <button type="button" className="tl-btn ghost sm" onClick={() => set(limits.max)} disabled={current >= limits.max}>
                Expand
              </button>
              <button type="button" className="tl-btn ghost sm" onClick={() => set(limits.min)} disabled={current <= limits.min}>
                Contract
              </button>
              <button type="button" className="tl-btn ghost sm" onClick={() => fold(true)}>
                Hide {firstLabel}
              </button>
            </>
          )}
          {tools}
        </span>
      </div>
      <div className="spl-second">{second}</div>
    </div>
  );
}
