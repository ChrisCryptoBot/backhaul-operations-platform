"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import React from "react";

const NAV: Array<{ label: string; items: Array<{ href: string; label: string }> }> = [
  {
    label: "Dispatch",
    items: [
      { href: "/loads", label: "Loads" },
      { href: "/dispatch", label: "Dispatch queue" },
      { href: "/rate-cons", label: "Rate confirmations" }
    ]
  },
  {
    label: "Fleet",
    items: [
      { href: "/drivers", label: "Drivers" },
      { href: "/fleet", label: "Trucks" }
    ]
  },
  {
    label: "Money",
    items: [
      { href: "/invoices", label: "Invoices" },
      { href: "/kpi", label: "KPI dashboard" }
    ]
  }
];

export function DeskShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  return (
    <div className="tl-app">
      <aside className="tl-side" aria-label="Primary navigation">
        <div className="tl-brand">
          <span className="tl-mark" aria-hidden="true">T</span>
          <span>
            <div className="tl-brand-name">Dispatch desk</div>
            <div className="tl-brand-sub">TrueLane-shaped demo</div>
          </span>
        </div>
        <nav className="tl-nav">
          {NAV.map((group) => (
            <React.Fragment key={group.label}>
              <div className="tl-nav-label">{group.label}</div>
              {group.items.map((item) => (
                <Link key={item.href} href={item.href} aria-current={pathname === item.href || pathname.startsWith(`${item.href}/`) ? "page" : undefined}>
                  {item.label}
                </Link>
              ))}
            </React.Fragment>
          ))}
        </nav>
        <div className="tl-side-foot">Sample data only. Every name, broker and number here is invented.</div>
      </aside>
      <main className="tl-main">{children}</main>
    </div>
  );
}
