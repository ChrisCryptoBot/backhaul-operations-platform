"use client";

import React from "react";
import { createPortal } from "react-dom";

/** What a tooltip says: a heading and label/value rows. Plain data in, so a server component can build it and hand it over. */
export type TipData = { title?: string; sub?: string; rows?: Array<[string, string]>; note?: string };

/** The body of a tooltip. Exported so a chart can also print the same figures in its expanded table. */
export function TipBody({ title, sub, rows, note }: TipData) {
  return (
    <>
      {title ? <div className="tip-t">{title}</div> : null}
      {sub ? <div className="tip-s">{sub}</div> : null}
      {rows && rows.length > 0 ? (
        <dl className="tip-rows">
          {rows.map(([k, v]) => (
            <div className="tip-r" key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {note ? <div className="tip-n">{note}</div> : null}
    </>
  );
}

/** The floating box itself: fixed in a portal beside `anchor`, above it when there is room and below it when there is not, never past the window's edge. */
export function TipPopup({ anchor, tip, id }: { anchor: DOMRect; tip: TipData; id?: string }) {
  const box = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gap = 10;
    const above = anchor.top - h - gap;
    const top = above >= 8 ? above : Math.min(window.innerHeight - h - 8, anchor.bottom + gap);
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, anchor.left + anchor.width / 2 - w / 2));
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
    el.style.visibility = "visible";
  }, [anchor, tip]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div ref={box} id={id} role="tooltip" className="tip" style={{ visibility: "hidden" }}>
      <TipBody {...tip} />
    </div>,
    document.body
  );
}

/**
 * A hover (and keyboard focus) tooltip. It never takes the pointer (you can move on across a chart without it getting in the way) and Escape closes it.
 */
export function Tip({ tip, children, className, as: As = "span", focusable = false, style }: { tip: TipData; children: React.ReactNode; className?: string; as?: "span" | "div" | "li"; focusable?: boolean; style?: React.CSSProperties }) {
  const id = React.useId();
  const [anchor, setAnchor] = React.useState<DOMRect | null>(null);
  const target = React.useRef<HTMLElement | null>(null);

  const show = () => {
    if (target.current) setAnchor(target.current.getBoundingClientRect());
  };
  const hide = () => setAnchor(null);

  React.useEffect(() => {
    if (!anchor) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
    };
  }, [anchor]);

  return (
    <>
      <As
        ref={target as React.Ref<never>}
        className={className}
        style={style}
        tabIndex={focusable ? 0 : undefined}
        aria-describedby={anchor ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}>
        {children}
      </As>
      {anchor ? <TipPopup anchor={anchor} tip={tip} id={id} /> : null}
    </>
  );
}
