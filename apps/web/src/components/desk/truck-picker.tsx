"use client";

import React from "react";

/**
 * Picks one truck by typing its name. A big fleet has far too many trucks for a list, so the choices come from /fleet/pick as you type (only trucks in service,
 * a dozen at most). Names are unique among the trucks in service, so an exact name is the choice. Leaving the box blank means no truck.
 * `onPick` gets the truck's id, "" for none, or "?" while the text matches no truck (the form then says to pick one from the list).
 */
export function TruckPicker({ id, name, onPick, invalid, disabled, readyOnly, label }: { id: string; name: string; onPick: (id: string, name: string) => void; invalid?: boolean; disabled?: boolean; readyOnly?: boolean; label?: string }) {
  const [text, setText] = React.useState(name);
  const [options, setOptions] = React.useState<Array<{ id: string; name: string; terminal?: string | null }>>([]);
  const list = React.useId();
  React.useEffect(() => setText(name), [name, id]);
  React.useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/fleet/pick?q=${encodeURIComponent(text.trim())}${readyOnly ? "&ready=1" : ""}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : { trucks: [] }))
        .then((j: { trucks: Array<{ id: string; name: string; terminal?: string | null }> }) => setOptions(j.trucks))
        .catch(() => undefined);
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [text, readyOnly]);
  return (
    <>
      <input
        value={text}
        list={list}
        placeholder="No set truck"
        autoComplete="off"
        disabled={disabled}
        aria-label={label}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          const hit = options.find((o) => o.name.toLowerCase() === v.trim().toLowerCase());
          onPick(v.trim() === "" ? "" : hit ? hit.id : "?", hit?.name ?? "");
        }}
      />
      <datalist id={list}>
        {options.map((o) => (
          <option key={o.id} value={o.name} label={o.terminal ? `${o.name} · ${o.terminal}` : undefined} />
        ))}
      </datalist>
    </>
  );
}
