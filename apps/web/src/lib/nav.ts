import type { Role } from "./roles";

/**
 * The desk's modules, in rail order: one list, read by the rail (components/desk/desk-shell.tsx, in the browser) and by every page head (components/desk/ui.tsx, on the server). Data only, so both can read it.
 * `code` is the two-letter mnemonic the rail leads with and the page head repeats: a list of places, not a list of icons.
 */
export type RailCounts = { needsDriver: number; overdue: number; readyToInvoice: number; alertsBlock: number; unreadMessages: number; partnerIssues: number };
export type PillKey = "needsDriver" | "unread" | "alerts" | "invoices" | "partnerIssues";
export type Pill = { n: number; tone?: "alert" | "warn" };
export type NavItem = {
  href: string;
  label: string;
  code: string;
  pill?: PillKey;
  /** Who the rail shows it to (src/lib/roles.ts); left out, everyone. The server refuses what a role may not do whether or not the link is shown. */
  roles?: Role[];
  /** Shown only to someone who may see driver pay (billing_details), whatever their role: a dispatcher with the billing grant too. */
  billing?: boolean;
};

export const NAV: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Dispatch",
    items: [
      { href: "/quote", label: "Quote a load", code: "QT", roles: ["admin", "dispatcher"] },
      { href: "/loads", label: "Loads", code: "LD" },
      { href: "/dispatch", label: "Dispatch queue", code: "DQ", pill: "needsDriver", roles: ["admin", "dispatcher"] },
      { href: "/messages", label: "Messages", code: "MS", pill: "unread", roles: ["admin", "dispatcher", "driver_manager", "accounting"] },
      { href: "/planner", label: "Planner", code: "PL", roles: ["admin", "dispatcher", "driver_manager", "viewer"] },
      { href: "/alerts", label: "Alerts", code: "AL", pill: "alerts" },
      { href: "/signals", label: "Signals", code: "SG" },
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
      { href: "/invoices", label: "Invoices", code: "IV", pill: "invoices" },
      { href: "/settlements", label: "Settlements", code: "ST", billing: true },
      { href: "/payroll", label: "Payroll", code: "PY", billing: true },
      { href: "/fuel", label: "Fuel", code: "FU", roles: ["admin", "dispatcher", "accounting"] },
      { href: "/ifta", label: "IFTA", code: "IF", roles: ["admin", "accounting"] },
      { href: "/leaks", label: "Leak ledger", code: "LK", roles: ["admin", "accounting"] },
      { href: "/data-health", label: "Data health", code: "DH", roles: ["admin", "accounting"] },
      { href: "/kpi/moved", label: "Why it moved", code: "WM", roles: ["admin", "accounting"] },
      { href: "/kpi", label: "KPI dashboard", code: "KP" }
    ]
  },
  {
    label: "System",
    items: [
      { href: "/audit", label: "Audit log", code: "AU" },
      { href: "/partners/issues", label: "Partner issues", code: "PI", pill: "partnerIssues", roles: ["admin", "accounting"] },
      { href: "/settings", label: "Settings", code: "SE" }
    ]
  }
];

/** The code a page head wears, by the page's title. A page that is not a module (a driver, a truck) has none. */
export const MODULE_CODE: Record<string, string> = Object.fromEntries(NAV.flatMap((g) => g.items).map((i) => [i.label, i.code]));

/** The rail item a path belongs to: the longest href that is the path or a parent of it, so /fleet/map is the Radar map and not also Trucks. */
export function activeItem(path: string): NavItem | undefined {
  let best: NavItem | undefined;
  for (const i of NAV.flatMap((g) => g.items)) if ((path === i.href || path.startsWith(`${i.href}/`)) && (!best || i.href.length > best.href.length)) best = i;
  return best;
}

/**
 * The count beside a module. Every count is the count of a list the module shows: Alerts is its Block tab (every block rule fires on open loads only, which is all the shell reads; the warnings tab also
 * counts delivered loads, so a warnings total here would match nothing on that page).
 */
export function railPill(key: PillKey | undefined, c: RailCounts): Pill | null {
  switch (key) {
    case "needsDriver":
      return c.needsDriver > 0 ? { n: c.needsDriver, tone: "warn" } : null;
    case "unread":
      return c.unreadMessages > 0 ? { n: c.unreadMessages, tone: "warn" } : null;
    case "alerts":
      return c.alertsBlock > 0 ? { n: c.alertsBlock, tone: "alert" } : null;
    case "invoices":
      return c.overdue > 0 ? { n: c.overdue, tone: "alert" } : c.readyToInvoice > 0 ? { n: c.readyToInvoice } : null;
    case "partnerIssues":
      return c.partnerIssues > 0 ? { n: c.partnerIssues, tone: "warn" } : null;
    default:
      return null;
  }
}
