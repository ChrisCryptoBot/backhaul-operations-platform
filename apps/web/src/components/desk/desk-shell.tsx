"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import React from "react";
import { Icon, type IconName } from "./kit/icons";
import { ToastProvider } from "./kit/toast";
import { GlobalSearch } from "./global-search";
import { TerminalScope } from "./terminal-scope";
import { TERMINAL_LIST_ID } from "@/lib/terminal";
import { useUnderlay } from "./underlay";
import { perMile, pct, usd } from "@/lib/desk-format";
import type { ShellData } from "@/server/tl/shell";


type Item = { href: string; label: string; icon: IconName; pill?: (c: ShellData["counts"]) => { n: number; tone?: "alert" | "warn" } | null };

const NAV: Array<{ label: string; items: Item[] }> = [
  {
    label: "Dispatch",
    items: [
      { href: "/quote", label: "Quote a load", icon: "calculator" },
      { href: "/loads", label: "Loads", icon: "loads" },
      { href: "/dispatch", label: "Dispatch queue", icon: "dispatch", pill: (c) => (c.needsDriver > 0 ? { n: c.needsDriver, tone: "warn" } : null) },
      { href: "/planner", label: "Planner", icon: "calendar" },
      { href: "/alerts", label: "Alerts", icon: "bell", pill: (c) => (c.alertsBlock > 0 ? { n: c.alertsBlock + c.alertsWarn, tone: "alert" } : c.alertsWarn > 0 ? { n: c.alertsWarn, tone: "warn" } : null) },
      { href: "/rate-cons", label: "Rate confirmations", icon: "document" }
    ]
  },
  {
    label: "Fleet",
    items: [
      { href: "/drivers", label: "Drivers", icon: "drivers" },
      { href: "/fleet", label: "Trucks", icon: "trucks" },
      { href: "/trailers", label: "Trailers", icon: "trailers" }
    ]
  },
  {
    label: "Market",
    items: [
      { href: "/customers", label: "Customers", icon: "building" },
      { href: "/lanes", label: "Lanes", icon: "route" }
    ]
  },
  {
    label: "Money",
    items: [
      { href: "/invoices", label: "Invoices", icon: "invoices", pill: (c) => (c.overdue > 0 ? { n: c.overdue, tone: "alert" } : c.readyToInvoice > 0 ? { n: c.readyToInvoice } : null) },
      { href: "/settlements", label: "Settlements", icon: "wallet" },
      { href: "/payroll", label: "Payroll", icon: "invoices" },
      { href: "/kpi", label: "KPI dashboard", icon: "chart" }
    ]
  },
  {
    label: "System",
    items: [
      { href: "/audit", label: "Audit log", icon: "history" },
      { href: "/settings", label: "Settings", icon: "settings" }
    ]
  }
];

const SIDEBAR_COOKIE = "desk-sidebar";

export function DeskShell({ children, drawer, data, initialCollapsed }: { children: React.ReactNode; drawer?: React.ReactNode; data: ShellData; initialCollapsed: boolean }) {
  const underlay = useUnderlay();
  // With a load open in the drawer the URL is the load's, but the page you are on (and the sidebar item to light) is the one underneath.
  const here = usePathname() ?? "";
  const pathname = /^\/loads\/[^/]+$/.test(here) ? (underlay.current.split("?")[0] ?? "/loads") : here;
  const [collapsed, setCollapsed] = React.useState(initialCollapsed);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `${SIDEBAR_COOKIE}=${next ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
  };
  const t = data.totals;

  // The glass bubble behind the current item slides to it (the phone's tab bar does the same). Until it has measured, the item draws its own bubble (CSS), so the first paint is never bare.
  const navRef = React.useRef<HTMLElement>(null);
  const [bubble, setBubble] = React.useState<{ y: number; h: number } | null>(null);
  const [settled, setSettled] = React.useState(false);
  const measure = React.useCallback(() => {
    const el = navRef.current?.querySelector<HTMLElement>('a[aria-current="page"]');
    setBubble(el ? { y: el.offsetTop, h: el.offsetHeight } : null);
  }, []);
  React.useLayoutEffect(measure, [measure, pathname, collapsed]);
  React.useEffect(() => {
    const id = requestAnimationFrame(() => setSettled(true));
    const nav = navRef.current;
    const ro = typeof ResizeObserver === "undefined" || !nav ? null : new ResizeObserver(measure);
    if (nav) ro?.observe(nav);
    void document.fonts?.ready.then(measure);
    return () => {
      cancelAnimationFrame(id);
      ro?.disconnect();
    };
  }, [measure]);

  return (
    <ToastProvider>
      <div className="tl-app" data-collapsed={collapsed ? "true" : "false"}>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <aside className="tl-side" aria-label="Primary">
          <div className="tl-brand">
            <span className="tl-mark" aria-hidden="true" />
            <div className="tl-brand-text">
              <div className="tl-brand-name">TrueLane</div>
              <div className="tl-brand-sub">Dispatch desk</div>
            </div>
          </div>
          <nav className="tl-nav" aria-label="Sections" ref={navRef} data-bubble={bubble ? "on" : undefined}>
            {bubble ? <span className="tl-bubble" aria-hidden="true" data-settled={settled ? "true" : undefined} style={{ "--by": `${bubble.y}px`, "--bh": `${bubble.h}px` } as React.CSSProperties} /> : null}
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
            <div className="tl-side-note">Sample data only. Every name, customer and number here is invented.</div>
            <button type="button" className="tl-collapse" onClick={toggle} aria-expanded={!collapsed} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
              <Icon name={collapsed ? "expand" : "collapse"} />
              <span className="lbl">Collapse</span>
            </button>
          </div>
        </aside>
        <div className="tl-col">
          <header className="tl-header">
            <GlobalSearch />
            <TerminalScope terminals={data.terminals} terminal={data.terminal} />
            <div className="tl-totals" aria-label="Fleet totals">
              <div className="tl-total"><b>{t.open}</b><span>Open loads</span></div>
              <div className={`tl-total${t.needsDriver > 0 ? " alert" : ""}`}><b>{t.needsDriver}</b><span>Need a driver</span></div>
              <div className="tl-total"><b>{usd(t.gross)}</b><span>Gross, finished</span></div>
              <div className="tl-total"><b>{perMile(t.avgRpm)}</b><span>Avg per mile</span></div>
              <div className="tl-total"><b>{pct(t.emptyShare)}</b><span>Empty miles</span></div>
            </div>
          </header>
          <main className="tl-main" id="main" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
      {/* The terminals in use, offered by every Terminal box in the desk (a truck's, a driver's). */}
      <datalist id={TERMINAL_LIST_ID}>
        {data.terminals.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      {drawer}
    </ToastProvider>
  );
}
