"use client";

import { useRouter } from "next/navigation";
import React from "react";

/**
 * A filter form with no Apply button: a select or a date applies the moment it changes, and typing in a search box applies a moment after you stop.
 * It builds the query from the fields (blank ones left out) and swaps the URL, so the page filters on the server and the box you are typing in keeps
 * its focus. Enter still works. Page numbers are not fields, so changing a filter starts again at the first page.
 */
export function LiveForm({ path, children, className, label, delayMs = 300 }: { path: string; children: React.ReactNode; className?: string; label: string; delayMs?: number }) {
  const router = useRouter();
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const apply = (form: HTMLFormElement) => {
    const q = new URLSearchParams();
    new FormData(form).forEach((v, k) => {
      if (typeof v === "string" && v.trim() !== "") q.set(k, v.trim());
    });
    const qs = q.toString();
    router.replace(qs ? `${path}?${qs}` : path, { scroll: false });
  };

  return (
    <form
      className={className}
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        if (timer.current) clearTimeout(timer.current);
        apply(e.currentTarget);
      }}
      onChange={(e) => {
        const form = e.currentTarget;
        const t = e.target as HTMLElement;
        const typing = t instanceof HTMLInputElement && (t.type === "search" || t.type === "text");
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => apply(form), typing ? delayMs : 0);
      }}>
      {children}
    </form>
  );
}
