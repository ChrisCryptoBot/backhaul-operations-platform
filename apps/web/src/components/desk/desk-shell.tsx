"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import React from "react";
import { BrandMark } from "./kit/brand-mark";
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
      { href: "/messages", label: "Messages", icon: "message", pill: (c) => (c.unreadMessages > 0 ? { n: c.unreadMessages, tone: "warn" } : null) },
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
      { href: "/payroll", label: "Payroll", icon: "payroll" },
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
  const router = useRouter();
  // With a load open in the drawer the URL is the load's, but the page you are on (and the sidebar item to light) is the one underneath.
  const here = usePathname() ?? "";
  const pathname = /^\/loads\/[^/]+$/.test(here) ? (underlay.current.split("?")[0] ?? "/loads") : here;
  const [collapsed, setCollapsed] = React.useState(initialCollapsed);
  const toggle = React.useCallback(() => {
    setTip(null);
    setCollapsed((was) => {
      const next = !was;
      document.cookie = `${SIDEBAR_COOKIE}=${next ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });
  }, []);
  const t = data.totals;

  // Signing out ends the session and goes to the sign-in page. This build has no accounts, so there is nothing to end but the launch screen's "seen" mark, which is
  // cleared so the next visit starts at the front door again. When sign-in is switched on, the provider's sign-out is called here first.
  const signOut = () => {
    setTip(null);
    try {
      window.sessionStorage.removeItem("desk-splash-seen");
    } catch {
      /* storage blocked: nothing to clear */
    }
    router.push("/sign-in");
  };

  // "[" folds the rail, like most desks. Not while typing, and never with a modifier held.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "[" || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  // The desk's drop-down menus (Export and the like) are plain <details>. Escape closes an open one and hands focus back to its button; a click anywhere else closes it too.
  React.useEffect(() => {
    const open = () => Array.from(document.querySelectorAll<HTMLDetailsElement>("details.menu[open]"));
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const menus = open();
      if (menus.length === 0) return;
      for (const m of menus) {
        m.open = false;
        m.querySelector<HTMLElement>("summary")?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      for (const m of open()) if (!m.contains(e.target as Node)) m.open = false;
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, []);

  // A folded rail names its icons in a tooltip beside the pointer or the focused item. It is fixed-positioned, because the rail itself clips whatever leaves it.
  const [tip, setTip] = React.useState<{ text: string; x: number; y: number } | null>(null);
  const showTip = (e: React.SyntheticEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]");
    if (!el || !el.dataset.tip) return setTip(null);
    const r = el.getBoundingClientRect();
    setTip({ text: el.dataset.tip, x: r.right + 10, y: r.top + r.height / 2 });
  };
  const hideTip = () => setTip(null);

  // The glass bubble behind the current item slides to it (the phone's tab bar does the same). Until it has measured, the item draws its own bubble (CSS), so the first paint is never bare.
  const navRef = React.useRef<HTMLElement>(null);
  const [bubble, setBubble] = React.useState<{ y: number; h: number } | null>(null);
  const [settled, setSettled] = React.useState(false);
  // When the rail is shorter than its list (a short window), a soft fade at the foot says there is more below instead of cutting an item off.
  const [more, setMore] = React.useState(false);
  const checkMore = React.useCallback(() => {
    const n = navRef.current;
    if (n) setMore(n.scrollHeight - n.scrollTop - n.clientHeight > 4);
  }, []);
  const measure = React.useCallback(() => {
    const el = navRef.current?.querySelector<HTMLElement>('a[aria-current="page"]');
    setBubble(el ? { y: el.offsetTop, h: el.offsetHeight } : null);
    checkMore();
  }, [checkMore]);
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
        <aside className="tl-side" aria-label="Primary" onMouseOver={collapsed ? showTip : undefined} onMouseLeave={hideTip} onFocus={collapsed ? showTip : undefined} onBlur={hideTip}>
          <Link href="/loads" className="tl-brand" aria-label="TrueLane Dispatch, home" data-tip={collapsed ? "TrueLane Dispatch" : undefined}>
            <span className="tl-tile" aria-hidden="true"><BrandMark size={20} className="tl-mark" /></span>
            <span className="tl-brand-text">
              <span className="tl-brand-name">TrueLane</span>
              <span className="tl-brand-sub">Dispatch</span>
            </span>
          </Link>
          <nav id="tl-sections" className="tl-nav" aria-label="Sections" ref={navRef} onScroll={checkMore} data-more={more ? "true" : undefined} data-bubble={bubble ? "on" : undefined}>
            {bubble ? <span className="tl-bubble" aria-hidden="true" data-settled={settled ? "true" : undefined} style={{ "--by": `${bubble.y}px`, "--bh": `${bubble.h}px` } as React.CSSProperties} /> : null}
            {NAV.map((group) => (
              <React.Fragment key={group.label}>
                <div className="tl-nav-label">{group.label}</div>
                {group.items.map((item) => {
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  const pill = item.pill?.(data.counts) ?? null;
                  return (
                    <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} data-tip={collapsed ? item.label : undefined}>
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
            <div className="tl-account" aria-label="Account">
              {data.workspaceName ? <div className="tl-ws" title={data.workspaceName}>{data.workspaceName}</div> : null}
              <Link href="/enterprise" className="tl-acc" data-tip={collapsed ? "Talk to a person" : undefined}>
                <Icon name="message" />
                <span className="lbl">Talk to a person</span>
              </Link>
              <button type="button" className="tl-acc" onClick={signOut} data-tip={collapsed ? "Sign out" : undefined}>
                <Icon name="signout" />
                <span className="lbl">Sign out</span>
              </button>
            </div>
            <button type="button" className="tl-collapse" onClick={toggle} aria-expanded={!collapsed} aria-controls="tl-sections" aria-keyshortcuts="[" data-tip={collapsed ? "Expand sidebar" : undefined}>
              <Icon name={collapsed ? "expand" : "collapse"} />
              <span className="lbl">Collapse sidebar</span>
              <kbd className="tl-kbd" aria-hidden="true">[</kbd>
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
      {collapsed && tip ? (
        <div className="tl-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      ) : null}
      {drawer}
    </ToastProvider>
  );
}
