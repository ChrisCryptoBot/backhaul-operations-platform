"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { Icon } from "./icons";

/** The desk's one search box: a glass, the words, and a clear button while there is something to clear (the browser's own cross is hidden: it draws in its own colours). */
export function SearchBox({ value, onChange, placeholder, label, id }: { value: string; onChange: (v: string) => void; placeholder: string; label: string; id?: string }) {
  const box = React.useRef<HTMLInputElement>(null);
  return (
    <label className="dt-search">
      <Icon name="search" />
      <span className="db-sr-only">{label}</span>
      <input ref={box} id={id} type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} title={value === "" ? placeholder : undefined} autoComplete="off" />
      {value !== "" ? (
        <button
          type="button"
          className="dt-clear"
          aria-label="Clear the search"
          onClick={() => {
            onChange("");
            box.current?.focus();
          }}>
          ×
        </button>
      ) : null}
    </label>
  );
}

/**
 * A search that goes into the address as you type (a moment after you stop), keeping the filters given and starting again at the first page: there is no Find button to press. The page reads `q` and
 * narrows on the server.
 */
export function LiveSearch({ path, q, keep, placeholder, label, id, name = "q" }: { /** What the address calls it. */ name?: string; path: string; q: string; keep?: Record<string, string>; placeholder: string; label: string; id?: string }) {
  const router = useRouter();
  const [text, setText] = React.useState(q);
  const typed = React.useRef(false);
  React.useEffect(() => {
    if (!typed.current) return;
    const t = setTimeout(() => {
      const p = new URLSearchParams(keep ?? {});
      if (text.trim()) p.set(name, text.trim());
      const s = p.toString();
      router.replace(s ? `${path}?${s}` : path, { scroll: false });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  return (
    <SearchBox
      id={id}
      value={text}
      onChange={(v) => {
        typed.current = true;
        setText(v);
      }}
      placeholder={placeholder}
      label={label}
    />
  );
}
