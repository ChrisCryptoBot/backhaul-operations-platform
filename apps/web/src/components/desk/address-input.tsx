"use client";

import React from "react";
import { createPortal } from "react-dom";
import { addressReady, type Place } from "@/lib/geo";

/**
 * An address or city box that suggests places as you type ("dal" offers Dallas, TX). Picking one writes its label into the box; typing
 * anything else is always allowed, so a place the map does not know is still typed in full. Suggestions come from the desk's own
 * /geo/suggest (the token stays on the server); a request that a newer keystroke has overtaken is cancelled, and nothing is asked
 * until there is enough to look up. With no key or no answer the box is a plain input.
 */
export function AddressInput({ value, onChange, placeholder, label, invalid, disabled, autoFocus }: { value: string; onChange: (text: string) => void; placeholder?: string; label: string; invalid?: boolean; disabled?: boolean; autoFocus?: boolean }) {
  const id = React.useId();
  const [places, setPlaces] = React.useState<Place[]>([]);
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  // After a pick (or Escape) the box stays quiet until the next keystroke, so the list does not reopen over what was just chosen.
  const quiet = React.useRef(false);
  const focused = React.useRef(false);
  const field = React.useRef<HTMLInputElement>(null);
  // The list is drawn on the page itself, not inside the form, so a dialog or a card can never clip it; it opens upward when the box is near the bottom.
  const [place, setPlace] = React.useState<React.CSSProperties | null>(null);

  React.useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = field.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const up = below < 180 && above > below;
      setPlace({ left: r.left, width: r.width, maxHeight: Math.max(96, Math.min(260, up ? above : below)), ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, places.length]);

  React.useEffect(() => {
    if (quiet.current || !focused.current || disabled || !addressReady(value)) {
      setPlaces([]);
      setOpen(false);
      return;
    }
    const ctl = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/geo/suggest?q=${encodeURIComponent(value.trim())}`, { signal: ctl.signal });
        if (!res.ok) return;
        const body = (await res.json()) as { places?: Place[] };
        const next = (body.places ?? []).filter((p) => p.label.toLowerCase() !== value.trim().toLowerCase());
        setPlaces(next);
        setActive(-1);
        setOpen(next.length > 0);
      } catch {
        /* cancelled or offline: the box stays a plain input */
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      ctl.abort();
    };
  }, [value, disabled]);

  const pick = (p: Place) => {
    quiet.current = true;
    onChange(p.label);
    setOpen(false);
    setPlaces([]);
  };

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || places.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % places.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a <= 0 ? places.length - 1 : a - 1));
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      pick(places[active]!);
    } else if (e.key === "Escape") {
      e.preventDefault();
      quiet.current = true;
      setOpen(false);
    }
  }

  return (
    <span className="ai">
      <input
        ref={field}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
        aria-invalid={invalid ? true : undefined}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          quiet.current = false;
          onChange(e.target.value);
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          window.setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={onKeyDown}
      />
      {open && place
        ? createPortal(
            <ul id={`${id}-list`} role="listbox" aria-label={`${label}: suggestions`} className="ai-list" style={place}>
              {places.map((p, i) => (
                <li key={p.label} id={`${id}-${i}`} role="option" aria-selected={i === active} className="ai-opt" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)} onMouseEnter={() => setActive(i)}>
                  {p.label}
                </li>
              ))}
            </ul>,
            document.body
          )
        : null}
      <span className="db-sr-only" role="status">
        {open ? `${places.length} suggestions` : ""}
      </span>
    </span>
  );
}
