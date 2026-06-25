"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/reference/lanes", label: "Lanes" },
  { href: "/reference/brokers", label: "Brokers" },
  { href: "/reference/drop-lots", label: "Drop lots" }
] as const;

/** Sub-tab navigation across the reference management screens (KPI-TRACKER-4). */
export function ReferenceTabs() {
  const pathname = usePathname();
  return (
    <nav className="db-ref-sub" aria-label="Reference sections">
      {TABS.map((tab) => {
        const active = pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`db-ref-tab${active ? " active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
