"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { Icon } from "./kit/icons";
import type { SearchHit } from "@/server/tl/search";

const GROUPS: Array<{ kind: SearchHit["kind"]; label: string }> = [
  { kind: "load", label: "Loads" },
  { kind: "driver", label: "Drivers" },
  { kind: "broker", label: "Customers" },
  { kind: "city", label: "Cities" }
];

/** The header search. "/" focuses it from anywhere; arrows move, Enter opens, Esc closes. Results come from /search. */
export function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = React.useState("");
  const [hits, setHits] = React.useState<SearchHit[]>([]);
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const [done, setDone] = React.useState(false);
  const input = React.useRef<HTMLInputElement>(null);
  const box = React.useRef<HTMLDivElement>(null);
  const listId = React.useId();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable='true']")) return;
      e.preventDefault();
      input.current?.focus();
    };
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, []);

  React.useEffect(() => {
    const text = q.trim();
    if (text.length < 2) {
      setHits([]);
      setDone(false);
      return;
    }
    const ctrl = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/search?q=${encodeURIComponent(text)}`, { signal: ctrl.signal });
        const json = (await res.json()) as { hits: SearchHit[] };
        setHits(json.hits);
        setActive(0);
        setDone(true);
      } catch {
        /* aborted by a newer keystroke */
      }
    }, 160);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [q]);

  // Hits in display order (grouped), each with its flat index for the keyboard.
  const ordered = GROUPS.flatMap((g) => hits.filter((h) => h.kind === g.kind));
  const go = (h: SearchHit) => {
    setOpen(false);
    setQ("");
    input.current?.blur();
    router.push(h.href);
  };

  let flat = -1;
  return (
    <div className="gs" ref={box}>
      <div className="gs-input">
        <Icon name="search" size={16} />
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-expanded={open && q.trim().length >= 2}
          aria-controls={listId}
          aria-activedescendant={ordered[active] ? `${listId}-${active}` : undefined}
          aria-label="Search loads, drivers, customers and cities"
          placeholder="Search the desk"
          autoComplete="off"
          value={q}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, Math.max(ordered.length - 1, 0)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter" && ordered[active]) {
              e.preventDefault();
              go(ordered[active]!);
            } else if (e.key === "Escape") {
              setOpen(false);
              input.current?.blur();
            }
          }}
        />
        <kbd aria-hidden="true">/</kbd>
      </div>
      {open && q.trim().length >= 2 ? (
        <div className="gs-pop" id={listId} role="listbox">
          {done && ordered.length === 0 ? <div className="gs-empty">Nothing matches “{q.trim()}”.</div> : null}
          {GROUPS.map((g) => {
            const list = hits.filter((h) => h.kind === g.kind);
            if (list.length === 0) return null;
            return (
              <div key={g.kind}>
                <div className="gs-group">{g.label}</div>
                {list.map((h) => {
                  flat += 1;
                  const i = flat;
                  return (
                    <div key={`${h.kind}-${h.label}-${h.href}`} id={`${listId}-${i}`} role="option" aria-selected={i === active} className="gs-hit" onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); go(h); }}>
                      <b>{h.label}</b>
                      <span>{h.sub}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
