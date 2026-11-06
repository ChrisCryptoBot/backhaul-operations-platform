"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { createPortal } from "react-dom";
import { SCOPE_COOKIE, choiceText, type ScopeChoice } from "@/lib/scope";
import type { ShellScope } from "@/server/tl/shell";

/**
 * The header's scope menu: what part of the fleet the desk is showing. "All terminals" (not offered to a person who is limited), a region (with its terminals), or any terminals ticked, each with the
 * trucks and drivers based there. The choice is kept in a cookie and applied by refreshing the page's data; a person who is limited sees only what they may see, and the server holds them to it
 * whatever the cookie says. An admin who has not chosen yet is shown a region, and this says so until they pick. The pop-over is drawn on the page body (the header clips and traps what is inside it).
 */
export function ScopeMenuButton({ scope }: { scope: ShellScope }) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const menu = scope.menu;
  const everyone = React.useMemo(() => [...menu.regions.flatMap((r) => r.terminals.map((t) => t.name)), ...menu.unassigned.map((t) => t.name)], [menu]);
  const [ticked, setTicked] = React.useState<string[]>(scope.names ?? everyone);
  const [open, setOpen] = React.useState(false);
  const [at, setAt] = React.useState<{ top: number; left: number } | null>(null);
  const button = React.useRef<HTMLButtonElement>(null);
  const pop = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => setTicked(scope.names ?? everyone), [scope.names, everyone]);

  // Close on Escape or a click anywhere else; put the pop-over under the button.
  React.useEffect(() => {
    if (!open) return;
    const r = button.current?.getBoundingClientRect();
    if (r) setAt({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 396)) });
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && (setOpen(false), button.current?.focus());
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  if (everyone.length === 0 && menu.regions.length === 0) return null;

  const apply = (c: ScopeChoice) => {
    document.cookie = `${SCOPE_COOKIE}=${encodeURIComponent(choiceText(c))}; path=/; max-age=31536000; samesite=lax`;
    setOpen(false);
    start(() => router.refresh());
  };
  const regionTicked = (names: string[]) => names.length > 0 && names.every((n) => ticked.includes(n));
  const toggle = (names: string[], on: boolean) => setTicked((cur) => (on ? [...new Set([...cur, ...names])] : cur.filter((n) => !names.includes(n))));
  const choiceNow = (): ScopeChoice => {
    if (ticked.length === 0) return { kind: "all" };
    const region = menu.regions.find((r) => r.terminals.length === ticked.length && r.terminals.every((t) => ticked.includes(t.name)));
    if (region) return { kind: "region", id: region.id };
    if (ticked.length === everyone.length && menu.canAll) return { kind: "all" };
    return { kind: "terminals", names: ticked };
  };
  const count = (t: { trucks: number; drivers: number }) => `${t.trucks} ${t.trucks === 1 ? "truck" : "trucks"} · ${t.drivers} ${t.drivers === 1 ? "driver" : "drivers"}`;

  const panel = (
    <div ref={pop} className="t-scope-pop" role="group" aria-label="What the desk shows" style={at ? { top: at.top, left: at.left } : undefined}>
      {!scope.chosen ? <p className="t-scope-hint">You are looking at {scope.label}. Pick a region or terminals, or all of them.</p> : null}
      {menu.canAll ? (
        <button type="button" className="t-scope-all" onClick={() => apply({ kind: "all" })}>
          <span>All terminals</span>
          <span className="t-dim">{count(menu.total)}</span>
        </button>
      ) : (
        <p className="t-scope-hint">You are limited to the regions and terminals below.</p>
      )}
      {menu.regions.map((r) => (
        <fieldset key={r.id} className="t-scope-region">
          <legend className="sr-only">{r.name}</legend>
          <label className="t-scope-row region">
            <input type="checkbox" checked={regionTicked(r.terminals.map((t) => t.name))} onChange={(e) => toggle(r.terminals.map((t) => t.name), e.target.checked)} />
            <b>{r.name}</b>
            <span className="t-dim">{count(r)}</span>
          </label>
          {r.terminals.map((t) => (
            <label key={t.name} className="t-scope-row">
              <input type="checkbox" checked={ticked.includes(t.name)} onChange={(e) => toggle([t.name], e.target.checked)} />
              <span>{t.name}</span>
              <span className="t-dim">{count(t)}</span>
            </label>
          ))}
        </fieldset>
      ))}
      {menu.unassigned.length > 0 ? (
        <fieldset className="t-scope-region">
          <legend className="sr-only">Not in a region</legend>
          <label className="t-scope-row region">
            <input type="checkbox" checked={regionTicked(menu.unassigned.map((t) => t.name))} onChange={(e) => toggle(menu.unassigned.map((t) => t.name), e.target.checked)} />
            <b>{menu.regions.length > 0 ? "Not in a region" : "Terminals"}</b>
            <span className="t-dim">{count({ trucks: menu.unassigned.reduce((s, t) => s + t.trucks, 0), drivers: menu.unassigned.reduce((s, t) => s + t.drivers, 0) })}</span>
          </label>
          {menu.unassigned.map((t) => (
            <label key={t.name} className="t-scope-row">
              <input type="checkbox" checked={ticked.includes(t.name)} onChange={(e) => toggle([t.name], e.target.checked)} />
              <span>{t.name}</span>
              <span className="t-dim">{count(t)}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="t-scope-foot">
        <button type="button" className="tl-btn primary sm" disabled={ticked.length === 0 && !menu.canAll} onClick={() => apply(choiceNow())}>
          Show these
        </button>
        <span className="t-dim">
          {ticked.length} of {everyone.length} terminals ticked
        </span>
      </div>
    </div>
  );

  return (
    <div className="t-scope-menu" data-active={scope.kind !== "all" ? "true" : undefined} aria-busy={pending || undefined}>
      <button ref={button} type="button" className="t-scope" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        <span className="t-dim">View</span>
        <b>{scope.label}</b>
        {!scope.chosen ? <i className="t-scope-note">pick one</i> : null}
      </button>
      {open && typeof document !== "undefined" ? createPortal(panel, document.body) : null}
    </div>
  );
}

/** The scope in words at the head of a page, so what is in view is never a guess. Reads the label the shell holds. */
export const ScopeContext = React.createContext<{ label: string; kind: "all" | "region" | "terminals" } | null>(null);

export function ScopeChip() {
  const s = React.useContext(ScopeContext);
  if (!s) return null;
  return (
    <span className="t-scope-chip" data-kind={s.kind} title="What this page is showing. Change it in the header.">
      {s.label}
    </span>
  );
}
