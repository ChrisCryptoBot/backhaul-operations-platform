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
import { ScopeContext, ScopeMenuButton } from "./scope-menu";
import { TERMINAL_LIST_ID } from "@/lib/terminal";
import { useUnderlay } from "./underlay";
import { perMile, pct, usd } from "@/lib/desk-format";
import type { ShellData } from "@/server/tl/shell";
import { type Role } from "@/lib/roles";
import { NAV, activeItem, railPill } from "@/lib/nav";
import { DEMO_USERS } from "@/lib/demo-session";

/** What the demo calls each way of using the desk ("Billing" for the accounting role). */
const demoLabel = (role: Role) => DEMO_USERS.find((u) => u.role === role)?.label ?? role;

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
    <ScopeContext.Provider value={{ label: data.scope.label, kind: data.scope.kind }}>
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
          <ScopeMenuButton scope={data.scope} />
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
          {NAV.map((group) => ({ ...group, items: group.items.filter((i) => (!role || !i.roles || i.roles.includes(role as Role)) && (!i.billing || data.account.billing)) }))
            .filter((group) => group.items.length > 0)
            .map((group) => (
            <React.Fragment key={group.label}>
              <h2>{group.label}</h2>
              {group.items.map((item) => {
                const active = activeItem(pathname)?.href === item.href;
                const pill = railPill(item.pill, data.counts);
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
    </ScopeContext.Provider>
    </TerminalNames>
    </DraftScope>
    </ToastProvider>
  );
}
