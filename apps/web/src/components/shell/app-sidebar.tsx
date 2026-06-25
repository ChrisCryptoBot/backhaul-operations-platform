"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import React from "react";
import {
  BoardIcon,
  BuildingIcon,
  ChartIcon,
  ClipboardIcon,
  GearIcon,
  LoopIcon,
  PinIcon,
  RouteIcon
} from "@/components/icons";

export interface AppSidebarProps {
  viewerIsAdmin: boolean;
  viewerCanManageReference: boolean;
  regionCode: string;
  regionLabel?: string;
}

/**
 * The app's primary navigation sidebar — shared by the board and every other
 * authed screen so the chrome is consistent app-wide. Self-manages its collapse
 * state (persisted to localStorage) so callers don't have to.
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
        <div className="db-side-group-label">Operations</div>
        <Link href="/" className={`db-side-item${pathname === "/" ? " active" : ""}`} title="Daily Tracker">
          <span className="db-side-ico" aria-hidden="true"><BoardIcon size={18} /></span>
          <span className="db-side-label">Daily Tracker</span>
        </Link>
        <Link href="/dashboard" className={`db-side-item${pathname === "/dashboard" ? " active" : ""}`} title="KPI Dashboard">
          <span className="db-side-ico" aria-hidden="true"><ChartIcon size={18} /></span>
          <span className="db-side-label">KPI Dashboard</span>
        </Link>

        <div className="db-side-group-label">Reference</div>
        {viewerCanManageReference ? (
          <Link href="/reference/lanes" className={`db-side-item${pathname.startsWith("/reference/lanes") ? " active" : ""}`} title="Lanes">
            <span className="db-side-ico" aria-hidden="true"><RouteIcon size={18} /></span>
            <span className="db-side-label">Lanes</span>
          </Link>
        ) : null}
        {viewerCanManageReference ? (
          <Link href="/reference/brokers" className={`db-side-item${pathname.startsWith("/reference/brokers") ? " active" : ""}`} title="Brokers">
            <span className="db-side-ico" aria-hidden="true"><BuildingIcon size={18} /></span>
            <span className="db-side-label">Brokers</span>
          </Link>
        ) : null}
        {viewerCanManageReference ? (
          <Link href="/reference/drop-lots" className={`db-side-item${pathname.startsWith("/reference/drop-lots") ? " active" : ""}`} title="Drop lots">
            <span className="db-side-ico" aria-hidden="true"><PinIcon size={18} /></span>
            <span className="db-side-label">Drop lots</span>
          </Link>
        ) : null}

        <div className="db-side-group-label">System</div>
        {viewerIsAdmin ? (
          <Link href="/audit" className={`db-side-item${pathname.startsWith("/audit") ? " active" : ""}`} title="Audit">
            <span className="db-side-ico" aria-hidden="true"><ClipboardIcon size={18} /></span>
            <span className="db-side-label">Audit</span>
          </Link>
        ) : null}
        {viewerIsAdmin ? (
          <Link href="/settings" className={`db-side-item${pathname === "/settings" ? " active" : ""}`} title="Settings">
            <span className="db-side-ico" aria-hidden="true"><GearIcon size={18} /></span>
            <span className="db-side-label">Settings</span>
          </Link>
        ) : null}
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
