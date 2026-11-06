"use client";

import React from "react";

/**
 * One KPI filter as a search box: type a few letters and the lane, customer, driver or truck names that match come from /kpi/choices (a few at a time, for the terminals in view); pick one and the
 * dashboard filters to it, clear the box and the filter is gone. The text typed on the way is not a filter: only a name that matches one of the offered choices (or an empty box) is sent, through a
 * hidden field the filter form reads, so the page does not reload on every letter.
 */
export function KpiChoice({ field, label, plural, value, period }: { field: "lane" | "broker" | "driver" | "truck"; label: string; plural: string; value: string; period: string }) {
  const [text, setText] = React.useState(value);
  const [chosen, setChosen] = React.useState(value);
  const [options, setOptions] = React.useState<string[]>([]);
  const hidden = React.useRef<HTMLInputElement>(null);
  const first = React.useRef(true);
  const list = React.useId();

  React.useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/kpi/choices?f=${field}&q=${encodeURIComponent(text.trim())}&period=${encodeURIComponent(period)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : { choices: [] }))
        .then((j: { choices: string[] }) => setOptions(j.choices))
        .catch(() => undefined);
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [text, field, period]);

  // The filter form applies when this says so (the same signal a date box gives), once the hidden value has moved.
  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    hidden.current?.dispatchEvent(new CustomEvent("desk-change", { bubbles: true }));
  }, [chosen]);

  return (
    <label className="tl-field">
      <span className="db-sr-only">{label}</span>
      <input
        type="text"
        value={text}
        list={list}
        autoComplete="off"
        placeholder={`All ${plural}`}
        aria-label={label}
        onChange={(e) => {
          // Typing is not a filter: keep the filter form from applying a half-typed name (the hidden field says when a name is chosen).
          e.stopPropagation();
          const v = e.target.value;
          setText(v);
          if (v.trim() === "") setChosen("");
          else {
            const hit = options.find((o) => o.toLowerCase() === v.trim().toLowerCase());
            if (hit) setChosen(hit);
          }
        }}
      />
      <datalist id={list}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      <input ref={hidden} type="hidden" name={field} value={chosen} readOnly />
    </label>
  );
}
