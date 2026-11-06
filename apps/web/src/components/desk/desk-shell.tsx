"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import React from "react";
import { AuthSignOutButton } from "./auth-sign-out";
import { SleepGuard } from "./splash";
import { PinnedChrome } from "./pinned-chrome";
import { ToastProvider } from "./kit/toast";
import { DraftScope } from "./kit/use-draft";
import { TerminalNames } from "./terminal-names";
import { VIEW_PREFIX, rememberedQuery } from "@/lib/draft";
import { ZONE_COOKIE, activeTz } from "@/lib/tz";
import { GlobalSearch } from "./global-search";
import { TerminalScope } from "./terminal-scope";
import { TERMINAL_LIST_ID } from "@/lib/terminal";
import { useUnderlay } from "./underlay";
import { perMile, pct, usd } from "@/lib/desk-format";
import type { ShellData } from "@/server/tl/shell";
import { type Role } from "@/lib/roles";
import { DEMO_USERS } from "@/lib/demo-session";

/** What the demo calls each way of using the desk ("Billing" for the accounting role). */
const demoLabel = (role: Role) => DEMO_USERS.find((u) => u.role === role)?.label ?? role;


/** `code` is the two-letter mnemonic the rail leads with (and the panel header repeats): a list of places, not a list of icons. */
type Item = { href: string; label: string; code: string; pill?: (c: ShellData["counts"]) => { n: number; tone?: "alert" | "warn" } | null; /** Who the rail shows it to (src/lib/roles.ts); left out, everyone. The server refuses what a role may not do whether or not the link is shown. */ roles?: Role[] };

const NAV: Array<{ label: string; items: Item[] }> = [
  {
    label: "Dispatch",
    items: [
      { href: "/quote", label: "Quote a load", code: "QT", roles: ["admin", "dispatcher"] },
      { href: "/loads", label: "Loads", code: "LD" },
      { href: "/dispatch", label: "Dispatch queue", code: "DQ", pill: (c) => (c.needsDriver > 0 ? { n: c.needsDriver, tone: "warn" } : null), roles: ["admin", "dispatcher"] },
      { href: "/messages", label: "Messages", code: "MS", pill: (c) => (c.unreadMessages > 0 ? { n: c.unreadMessages, tone: "warn" } : null), roles: ["admin", "dispatcher", "driver_manager", "accounting"] },
      { href: "/planner", label: "Planner", code: "PL", roles: ["admin", "dispatcher", "driver_manager", "viewer"] },
      { href: "/alerts", label: "Alerts", code: "AL", pill: (c) => (c.alertsBlock > 0 ? { n: c.alertsBlock + c.alertsWarn, tone: "alert" } : c.alertsWarn > 0 ? { n: c.alertsWarn, tone: "warn" } : null) },
      { href: "/rate-cons", label: "Rate confirmations", code: "RC", roles: ["admin", "dispatcher"] }
    ]
  },
  {
    label: "Fleet",
    items: [
      { href: "/drivers", label: "Drivers", code: "DR" },
      { href: "/schedules", label: "Schedules", code: "SC", roles: ["admin", "dispatcher", "driver_manager", "viewer"] },
      { href: "/fleet/map", label: "Radar map", code: "MP", roles: ["admin", "dispatcher", "driver_manager", "viewer"] },
      { href: "/fleet", label: "Trucks", code: "TK", roles: ["admin", "dispatcher", "driver_manager", "viewer"] },
      { href: "/trailers", label: "Trailers", code: "TR", roles: ["admin", "dispatcher", "viewer"] }
    ]
  },
  {
    label: "Market",
    items: [
      { href: "/customers", label: "Customers", code: "CU" },
      { href: "/lanes", label: "Lanes", code: "LN", roles: ["admin", "dispatcher", "viewer"] }
    ]
  },
  {
    label: "Money",
    items: [
      { href: "/invoices", label: "Invoices", code: "IV", pill: (c) => (c.overdue > 0 ? { n: c.overdue, tone: "alert" } : c.readyToInvoice > 0 ? { n: c.readyToInvoice } : null) },
      { href: "/settlements", label: "Settlements", code: "ST", roles: ["admin", "accounting"] },
      { href: "/payroll", label: "Payroll", code: "PY", roles: ["admin", "accounting"] },
      { href: "/fuel", label: "Fuel", code: "FU", roles: ["admin", "dispatcher", "accounting"] },
      { href: "/ifta", label: "IFTA", code: "IF", roles: ["admin", "accounting"] },
      { href: "/leaks", label: "Leak ledger", code: "LK", roles: ["admin", "accounting"] },
      { href: "/kpi", label: "KPI dashboard", code: "KP" }
    ]
  },
  {
    label: "System",
    items: [
      { href: "/audit", label: "Audit log", code: "AU" },
      { href: "/settings", label: "Settings", code: "SE" }
    ]
  }
];

const SIDEBAR_COOKIE = "desk-sidebar";

/** The desk's own clock decides how times read; a browser that has not been told it (a new device, a changed setting) is brought into line once, then the page is read again. */
function ZoneSync({ zone }: { zone: string }) {
  const router = useRouter();
  React.useEffect(() => {
    if (activeTz() === zone) return;
    document.cookie = `${ZONE_COOKIE}=${zone}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }, [zone, router]);
  return null;
}

/** The rail item a path belongs to: the longest href that is the path or a parent of it, so /fleet/map is the Radar map and not also Trucks. */
function activeItem(path: string): Item | undefined {
  let best: Item | undefined;
  for (const i of NAV.flatMap((g) => g.items)) if ((path === i.href || path.startsWith(`${i.href}/`)) && (!best || i.href.length > best.href.length)) best = i;
  return best;
}

export function DeskShell({ children, drawer, data, initialCollapsed, sleepMinutes = 15, demoLogin = false }: { children: React.ReactNode; drawer?: React.ReactNode; data: ShellData; initialCollapsed: boolean; sleepMinutes?: number; demoLogin?: boolean }) {
  const underlay = useUnderlay();
  // With a load open in the drawer the URL is the load's, but the page you are on (and the sidebar item to light) is the one underneath.
  const here = usePathname() ?? "";
  const pathname = /^\/loads\/[^/]+$/.test(here) ? (underlay.current.split("?")[0] ?? "/loads") : here;
  const [collapsed, setCollapsed] = React.useState(initialCollapsed);
  // Where each module was left (its search, filter and sort): the sidebar returns to it as it was, not as a blank list.
  const query = useSearchParams()?.toString() ?? "";
  const viewScope = `${data.workspaceName}:${data.account.name}`;
  const [views, setViews] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    try {
      const key = (href: string) => `${VIEW_PREFIX}${viewScope}:${href}`;
      const section = activeItem(here);
      if (section && here === section.href) {
        const q = rememberedQuery(query);
        if (q === "") window.localStorage.removeItem(key(section.href));
        else window.localStorage.setItem(key(section.href), q);
      }
      const next: Record<string, string> = {};
      for (const i of NAV.flatMap((g) => g.items)) next[i.href] = window.localStorage.getItem(key(i.href)) ?? "";
      setViews((v) => (JSON.stringify(v) === JSON.stringify(next) ? v : next));
    } catch {
      /* storage blocked: the links go to the plain module */
    }
  }, [here, query, viewScope]);
  const toggle = React.useCallback(() => {
    setCollapsed((was) => {
      const next = !was;
      document.cookie = `${SIDEBAR_COOKIE}=${next ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });
  }, []);
  const t = data.totals;

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

  const role = data.account.role;
  return (
    <ToastProvider>
    <DraftScope value={`${data.workspaceName}:${data.account.name}`}>
    <TerminalNames value={data.terminals}>
      <ZoneSync zone={data.timezone} />
      <div className="t-app" data-collapsed={collapsed ? "true" : "false"}>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <header className="t-cmd" aria-label="Command line">
          <Link href="/loads" className="t-brand" aria-label="TrueLane Dispatch, home">
            TRUELANE <i>▸ DESK</i>
          </Link>
          <GlobalSearch />
          <TerminalScope terminals={data.terminals} terminal={data.terminal} />
          <Link href="/enterprise" className="t-mid">Talk to a person</Link>
          {!data.account.on && demoLogin && data.account.role ? <span className="t-mid who" title={`Signed in to the demo as ${demoLabel(data.account.role as Role)}`}>{demoLabel(data.account.role as Role)}</span> : null}
          {data.account.on && data.account.name ? <span className="t-mid who" title={`${data.account.name}${role ? `, ${role}` : ""}`}>{data.account.name}{role ? ` · ${role}` : ""}</span> : null}
          {data.account.on ? <AuthSignOutButton className="t-mid t-linkbtn">Sign out</AuthSignOutButton> : demoLogin ? <a href="/auth/leave" className="t-mid">Sign out</a> : null}
        </header>
        <div className="t-tick" role="group" aria-label="Fleet totals">
          <div><span>Open loads</span><b>{t.open}</b></div>
          <div><span>Need a driver</span><b className={t.needsDriver > 0 ? "t-warn" : undefined}>{t.needsDriver}</b></div>
          <div><span>Gross, finished</span><b>{usd(t.gross)}</b></div>
          <div><span>Avg per mile</span><b>{perMile(t.avgRpm)}</b></div>
          <div><span>Empty miles</span><b>{pct(t.emptyShare)}</b></div>
        </div>
        <nav id="t-sections" className="t-rail" aria-label="Sections">
          {NAV.map((group) => ({ ...group, items: group.items.filter((i) => !role || !i.roles || i.roles.includes(role as Role)) }))
            .filter((group) => group.items.length > 0)
            .map((group) => (
            <React.Fragment key={group.label}>
              <h2>{group.label}</h2>
              {group.items.map((item) => {
                const active = activeItem(pathname)?.href === item.href;
                const pill = item.pill?.(data.counts) ?? null;
                return (
                  <Link key={item.href} href={`${item.href}${active ? "" : (views[item.href] ?? "")}`} aria-current={active ? "page" : undefined} title={collapsed ? item.label : undefined} aria-label={collapsed ? item.label : undefined}>
                    <i aria-hidden={collapsed ? "true" : undefined}>{item.code}</i>
                    <span className="lbl">{item.label}</span>
                    {pill ? <em data-tone={pill.tone === "alert" ? "bad" : pill.tone}>{pill.n}</em> : null}
                  </Link>
                );
              })}
            </React.Fragment>
          ))}
          <button type="button" className="t-collapse" onClick={toggle} aria-expanded={!collapsed} aria-controls="t-sections" aria-keyshortcuts="[" title={collapsed ? "Expand sidebar" : undefined}>
            <i>[</i>
            <span className="lbl">Collapse sidebar</span>
          </button>
        </nav>
        <PinnedChrome />
        <main className="t-main" id="main" tabIndex={-1}>
          {children}
        </main>
        <footer className="t-status">
          <span>{demoLogin ? "SAMPLE DATA ONLY. Every name, customer and number here is invented." : " "}</span>
          <span className="gap"><b>{data.workspaceName}</b></span>
          {role ? <span><b>{role.toUpperCase()}</b></span> : null}
        </footer>
      </div>
      {/* The terminals in use, offered by every Terminal box in the desk (a truck's, a driver's). */}
      <datalist id={TERMINAL_LIST_ID}>
        {data.terminals.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      {drawer}
      <SleepGuard minutes={sleepMinutes} />
    </TerminalNames>
    </DraftScope>
    </ToastProvider>
  );
}
