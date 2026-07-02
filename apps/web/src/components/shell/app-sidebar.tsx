"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import React from "react";
import { BoardIcon, BuildingIcon, ChevronDownIcon, GearIcon, LoopIcon } from "@/components/icons";

export interface AppSidebarProps {
  viewerIsAdmin: boolean;
  viewerCanManageReference: boolean;
  regionCode: string;
  regionLabel?: string;
}

type IconComponent = React.ComponentType<{ size?: number }>;

interface NavItem {
  href: string;
  label: string;
  /** Match only the exact path (used for "/", which would otherwise match everything). */
  exact?: boolean;
}

interface NavGroup {
  id: string;
  label: string;
  Icon: IconComponent;
  items: NavItem[];
}

/**
 * The app's primary navigation sidebar — shared by the board and every other authed
 * screen. Navigation is organised into three collapsible groups (Operations, Reference,
 * System); only the group headers carry an icon, and each expands to reveal its modules.
 * Self-manages collapse state (persisted) so callers don't have to.
 */
export function AppSidebar({ viewerIsAdmin, viewerCanManageReference, regionCode, regionLabel }: AppSidebarProps) {
  const pathname = usePathname();
  const [isCollapsed, setIsCollapsed] = React.useState(false);
  React.useEffect(() => {
    if (window.localStorage.getItem("db-sidebar-collapsed") === "true") setIsCollapsed(true);
  }, []);
  React.useEffect(() => {
    window.localStorage.setItem("db-sidebar-collapsed", isCollapsed ? "true" : "false");
  }, [isCollapsed]);

  const groups: NavGroup[] = [
    {
      id: "operations",
      label: "Operations",
      Icon: BoardIcon,
      items: [
        { href: "/", label: "Daily Tracker", exact: true },
        { href: "/dashboard", label: "KPI Dashboard" }
      ]
    },
    ...(viewerCanManageReference
      ? [
          {
            id: "reference",
            label: "Reference",
            Icon: BuildingIcon,
            items: [
              { href: "/reference/booking-plan", label: "Booking plan" },
              { href: "/reference/lanes", label: "Lanes" },
              { href: "/reference/brokers", label: "Brokers" },
              { href: "/reference/drop-lots", label: "Drop lots" },
              { href: "/reference/drivers", label: "Drivers" },
              { href: "/reference/direct-customers", label: "Direct customers" }
            ]
          } satisfies NavGroup
        ]
      : []),
    ...(viewerIsAdmin
      ? [
          {
            id: "system",
            label: "System",
            Icon: GearIcon,
            items: [
              { href: "/audit", label: "Audit" },
              { href: "/settings", label: "Settings" }
            ]
          } satisfies NavGroup
        ]
      : [])
  ];

  const isItemActive = React.useCallback(
    (item: NavItem) => {
      if (!pathname) return false;
      return item.exact ? pathname === item.href : pathname.startsWith(item.href);
    },
    [pathname]
  );
  const activeGroupId = groups.find((group) => group.items.some(isItemActive))?.id ?? null;

  // Group open-state: the active group defaults open; explicit toggles win. Navigating
  // into a section always re-opens its group so the current page is never hidden.
  const [openGroups, setOpenGroups] = React.useState<Record<string, boolean>>({});
  React.useEffect(() => {
    if (activeGroupId) setOpenGroups((prev) => ({ ...prev, [activeGroupId]: true }));
  }, [activeGroupId]);
  const isGroupOpen = (id: string) => openGroups[id] ?? id === activeGroupId;

  function handleGroupClick(id: string) {
    if (isCollapsed) {
      setIsCollapsed(false);
      setOpenGroups((prev) => ({ ...prev, [id]: true }));
      return;
    }
    setOpenGroups((prev) => ({ ...prev, [id]: !(prev[id] ?? id === activeGroupId) }));
  }

  return (
    <aside className="db-sidebar" data-collapsed={isCollapsed ? "true" : "false"} aria-label="Primary navigation">
      <button
        type="button"
        className="db-side-brand"
        onClick={() => setIsCollapsed((prev) => !prev)}
        aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!isCollapsed}
        title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        <span className="db-side-mark" aria-hidden="true"><LoopIcon size={16} /></span>
        <span className="db-side-wordmark">
          <span className="db-side-name">Backhaul</span>
          <span className="db-side-sub">Co-Pilot</span>
        </span>
      </button>

      <nav className="db-side-nav" aria-label="Primary">
        {groups.map((group) => {
          const open = isGroupOpen(group.id);
          const groupActive = group.id === activeGroupId;
          return (
            <div
              key={group.id}
              className={`db-side-group${groupActive ? " has-active" : ""}`}
              data-open={open ? "true" : "false"}
            >
              <button
                type="button"
                className="db-side-grouphead"
                onClick={() => handleGroupClick(group.id)}
                aria-expanded={open}
                title={group.label}
              >
                <span className="db-side-ico" aria-hidden="true"><group.Icon size={18} /></span>
                <span className="db-side-label">{group.label}</span>
                <span className="db-side-chevron" aria-hidden="true"><ChevronDownIcon size={14} /></span>
              </button>
              <div className="db-side-sublist" role="group" aria-label={group.label}>
                <div className="db-side-sublist-inner">
                  {group.items.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`db-side-subitem${isItemActive(item) ? " active" : ""}`}
                      title={item.label}
                      tabIndex={open ? undefined : -1}
                    >
                      {item.label}
                    </Link>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </nav>

      <div className="db-side-foot">
        <div className="db-side-user" title={`${regionLabel ?? regionCode} · ${regionCode}`}>
          <span className="db-side-avatar" aria-hidden="true">{regionCode.slice(0, 2)}</span>
          <span className="db-side-userinfo">
            <span className="db-side-username">{regionLabel ?? regionCode}</span>
            <span className="db-side-userrole">{regionCode}</span>
          </span>
        </div>
      </div>
    </aside>
  );
}
