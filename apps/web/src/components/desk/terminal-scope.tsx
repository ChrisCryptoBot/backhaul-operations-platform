"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { TERMINAL_COOKIE } from "@/lib/terminal";

/**
 * The header's terminal scope: "All terminals", or one. Fleet, Drivers, the Planner, the Quote's fits and the pickers show that terminal's trucks and drivers;
 * a search still reaches the rest. Held in a cookie (like the sidebar) and applied by refreshing the page's data. Not offered until a truck or driver has a terminal.
 */
export function TerminalScope({ terminals, terminal }: { terminals: string[]; terminal: string | null }) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  if (terminals.length === 0 && !terminal) return null;
  return (
    <label className="tl-scope" data-active={terminal ? "true" : undefined}>
      <span>Terminal</span>
      <select
        value={terminal ?? ""}
        aria-busy={pending || undefined}
        onChange={(e) => {
          const v = e.target.value;
          document.cookie = v ? `${TERMINAL_COOKIE}=${encodeURIComponent(v)}; path=/; max-age=31536000; samesite=lax` : `${TERMINAL_COOKIE}=; path=/; max-age=0; samesite=lax`;
          start(() => router.refresh());
        }}>
        <option value="">All terminals</option>
        {terminals.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
        {terminal && !terminals.includes(terminal) ? <option value={terminal}>{terminal}</option> : null}
      </select>
    </label>
  );
}
