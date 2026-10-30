"use client";

import React from "react";

/**
 * Picks one driver by typing a name. A big fleet has far too many drivers for a list, so the choices come from /drivers/pick as you type (a dozen at most; a name
 * typed reaches every terminal). `includeInactive` also offers drivers who are out of service, for pay owed to someone who has left. Names are matched exactly, so a
 * name shared by two drivers is the first of them. `onPick` gets the driver's id, "" for none, or "?" while the text matches no driver.
 */
export function DriverPicker({ id, name, onPick, invalid, includeInactive, label, placeholder = "Type a driver's name" }: { id: string; name: string; onPick: (id: string, name: string) => void; invalid?: boolean; includeInactive?: boolean; label?: string; placeholder?: string }) {
  const [text, setText] = React.useState(name);
  const [options, setOptions] = React.useState<Array<{ id: string; name: string; terminal?: string | null }>>([]);
  const list = React.useId();
  React.useEffect(() => setText(name), [name, id]);
  React.useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/drivers/pick?q=${encodeURIComponent(text.trim())}${includeInactive ? "&inactive=1" : ""}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : { drivers: [] }))
        .then((j: { drivers: Array<{ id: string; name: string; terminal?: string | null }> }) => setOptions(j.drivers))
        .catch(() => undefined);
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [text, includeInactive]);
  return (
    <>
      <input
        value={text}
        list={list}
        placeholder={placeholder}
        autoComplete="off"
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
