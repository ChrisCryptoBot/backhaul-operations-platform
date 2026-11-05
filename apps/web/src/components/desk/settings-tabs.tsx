"use client";

import React from "react";

export type SettingsTab = { key: string; label: string; panel: React.ReactNode; /** A word after the label, such as a count. */ note?: string };

const STORE = "tl_settings_tab";

/**
 * Settings as tabs, the way the load drawer has them: a row of square tabs, the open one inverted, the number keys 1 to 6 to move between them, the open tab kept in the address
 * (`?tab=`) so a link lands on it, and a `#plan`-style link to a section opens the tab that holds it. Every panel is rendered once and the others are hidden, so what is typed into a form
 * on one tab is still there when you come back from another. The panels arrive already built by the server: this only decides which one shows.
 */
export function SettingsTabs({ tabs, initial, anchors = {} }: { tabs: SettingsTab[]; initial?: string; /** Section ids inside the panels, by the tab that holds them. */ anchors?: Record<string, string> }) {
  const keys = tabs.map((t) => t.key);
  const [active, setActive] = React.useState<string>(initial && keys.includes(initial) ? initial : keys[0]!);

  const open = React.useCallback(
    (key: string, push = true) => {
      if (!keys.includes(key)) return;
      setActive(key);
      try {
        window.sessionStorage?.setItem(STORE, key);
        if (push) {
          const url = new URL(window.location.href);
          url.searchParams.set("tab", key);
          window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
        }
      } catch {
        /* storage or history blocked: the tab still opens */
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keys.join("|")]
  );

  // A link with a section id (#plan) opens the tab that holds it; with no word in the address, the tab last used.
  React.useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    const byHash = hash ? anchors[hash] : undefined;
    if (byHash && keys.includes(byHash)) {
      open(byHash, false);
      window.requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView({ block: "start" }));
      return;
    }
    if (initial) return;
    try {
      const saved = window.sessionStorage?.getItem(STORE);
      if (saved && keys.includes(saved)) setActive(saved);
    } catch {
      /* storage blocked */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector(".k-scrim")) return; // a dialog is open
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const n = Number.parseInt(e.key, 10);
      if (Number.isInteger(n) && n >= 1 && n <= keys.length) {
        e.preventDefault();
        open(keys[n - 1]!);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [keys, open]);

  return (
    <div className="st-tabs">
      <nav className="st-tablist" role="tablist" aria-label="Settings">
        {tabs.map((t, i) => (
          <button key={t.key} type="button" role="tab" id={`st-tab-${t.key}`} aria-controls={`st-panel-${t.key}`} aria-selected={active === t.key} tabIndex={active === t.key ? 0 : -1} className="st-tab" onClick={() => open(t.key)}>
            <span>
              {t.label}
              {t.note ? ` ${t.note}` : ""}
            </span>
            <span className="st-kbd">{i + 1}</span>
          </button>
        ))}
      </nav>
      {tabs.map((t) => (
        <div key={t.key} role="tabpanel" id={`st-panel-${t.key}`} aria-labelledby={`st-tab-${t.key}`} className="st-panel" hidden={active !== t.key}>
          {t.panel}
        </div>
      ))}
    </div>
  );
}
