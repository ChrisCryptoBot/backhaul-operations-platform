"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import React from "react";
import { Icon, type IconName } from "./kit/icons";
import { ToastProvider } from "./kit/toast";
import { perMile, pct, usd } from "@/lib/desk-format";
import type { ShellData } from "@/server/tl/shell";


type Item = { href: string; label: string; icon: IconName; pill?: (c: ShellData["counts"]) => { n: number; tone?: "alert" | "warn" } | null };

const NAV: Array<{ label: string; items: Item[] }> = [
  {
    label: "Dispatch",
    items: [
      { href: "/loads", label: "Loads", icon: "loads" },
      { href: "/dispatch", label: "Dispatch queue", icon: "dispatch", pill: (c) => (c.needsDriver > 0 ? { n: c.needsDriver, tone: "warn" } : null) },
      { href: "/rate-cons", label: "Rate confirmations", icon: "document" }
    ]
  },
  {
    label: "Fleet",
    items: [
      { href: "/drivers", label: "Drivers", icon: "drivers" },
      { href: "/fleet", label: "Trucks", icon: "trucks" }
    ]
  },
  {
    label: "Money",
    items: [
      { href: "/invoices", label: "Invoices", icon: "invoices", pill: (c) => (c.overdue > 0 ? { n: c.overdue, tone: "alert" } : c.readyToInvoice > 0 ? { n: c.readyToInvoice } : null) },
      { href: "/kpi", label: "KPI dashboard", icon: "chart" }
    ]
  },
  { label: "System", items: [{ href: "/settings", label: "Settings", icon: "settings" }] }
];

const TITLES: Array<[string, string]> = [
  ["/loads", "Loads"],
  ["/dispatch", "Dispatch queue"],
  ["/rate-cons", "Rate confirmations"],
  ["/drivers", "Drivers"],
  ["/fleet", "Trucks"],
  ["/invoices", "Invoices"],
  ["/kpi", "KPI dashboard"],
  ["/settings", "Settings"]
];

const SIDEBAR_COOKIE = "desk-sidebar";

export function DeskShell({ children, data, initialCollapsed }: { children: React.ReactNode; data: ShellData; initialCollapsed: boolean }) {
  const pathname = usePathname() ?? "";
  const [collapsed, setCollapsed] = React.useState(initialCollapsed);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `${SIDEBAR_COOKIE}=${next ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
  };
  const title = TITLES.find(([p]) => pathname === p || pathname.startsWith(`${p}/`))?.[1] ?? "Dispatch desk";
  const t = data.totals;

  return (
    <ToastProvider>
      <div className="tl-app" data-collapsed={collapsed ? "true" : "false"}>
        <aside className="tl-side" aria-label="Primary">
          <div className="tl-brand">
            <span className="tl-mark" aria-hidden="true" />
            <div className="tl-brand-text">
              <div className="tl-brand-name">TrueLane</div>
              <div className="tl-brand-sub">Dispatch desk</div>
            </div>
          </div>
          <nav className="tl-nav" aria-label="Sections">
            {NAV.map((group) => (
              <React.Fragment key={group.label}>
                <div className="tl-nav-label">{group.label}</div>
                {group.items.map((item) => {
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  const pill = item.pill?.(data.counts) ?? null;
                  return (
                    <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} title={collapsed ? item.label : undefined}>
                      <Icon name={item.icon} className="ico" />
                      <span className="lbl">{item.label}</span>
                      {pill ? <span className={`tl-pill-n${pill.tone ? ` ${pill.tone}` : ""}`}>{pill.n}</span> : null}
                    </Link>
                  );
                })}
              </React.Fragment>
            ))}
          </nav>
          <div className="tl-side-foot">
            <div className="tl-side-note">Sample data only. Every name, broker and number here is invented.</div>
            <button type="button" className="tl-collapse" onClick={toggle} aria-expanded={!collapsed} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
              <Icon name={collapsed ? "expand" : "collapse"} />
              <span className="lbl">Collapse</span>
            </button>
          </div>
        </aside>
        <div className="tl-col">
          <header className="tl-header">
            <div className="tl-crumb">
              {title} <span>/ TrueLane</span>
            </div>
            <div className="tl-totals" aria-label="Fleet totals">
              <div className="tl-total"><b>{t.open}</b><span>Open loads</span></div>
              <div className={`tl-total${t.needsDriver > 0 ? " alert" : ""}`}><b>{t.needsDriver}</b><span>Need a driver</span></div>
              <div className="tl-total"><b>{usd(t.gross)}</b><span>Gross, finished</span></div>
              <div className="tl-total"><b>{perMile(t.avgRpm)}</b><span>Avg per mile</span></div>
              <div className="tl-total"><b>{pct(t.emptyShare)}</b><span>Empty miles</span></div>
            </div>
          </header>
          <main className="tl-main" id="main">
            {children}
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
