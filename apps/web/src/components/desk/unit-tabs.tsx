"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import React from "react";

/**
 * The tab strip on a truck's or a trailer's page. Each tab is a link to `?tab=`, so the address says which tab is open and the page renders only that tab on the server. Keys 1 to 4 switch
 * tabs, the same keys the load drawer uses; they do nothing while a person is typing.
 */
export function UnitTabs({ tabs, active, label }: { tabs: ReadonlyArray<{ key: string; label: string }>; active: string; label: string }) {
  const path = usePathname();
  const router = useRouter();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return;
      const tab = tabs[Number.parseInt(e.key, 10) - 1];
      if (tab && tab.key !== active) {
        e.preventDefault();
        router.replace(`${path}?tab=${tab.key}`, { scroll: false });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [tabs, active, path, router]);

  return (
    <nav className="eq-tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <Link key={t.key} href={`${path}?tab=${t.key}`} replace scroll={false} role="tab" id={`tab-${t.key}`} aria-controls={`panel-${t.key}`} aria-selected={t.key === active} className="eq-tab">
          <span>{t.label}</span>
          <span className="eq-key" aria-hidden="true">{i + 1}</span>
        </Link>
      ))}
    </nav>
  );
}
