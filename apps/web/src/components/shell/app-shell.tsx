"use client";

import React from "react";
import { usePathname } from "next/navigation";
import { AppSidebar, type AppSidebarProps } from "@/components/shell/app-sidebar";
import { TopbarSignOutButton } from "@/components/auth/sign-out-button";
import { CopilotPanel } from "@/components/copilot/copilot-panel";

export interface AppShellProps extends AppSidebarProps {
  /** Header title for this screen. */
  title: string;
  children: React.ReactNode;
}

/**
 * App chrome for non-board screens: the shared sidebar + a slim header, with the
 * page content in a scrolling area. The board renders its own richer shell but
 * reuses the same <AppSidebar>. Theme is inherited from <html> (set globally by
 * ThemeInit), so no per-shell data-theme is needed.
 */
export function AppShell({ title, children, ...sidebar }: AppShellProps) {
  const pathname = usePathname();
  return (
    <div className="db-root db-app">
      <AppSidebar {...sidebar} />
      <div className="db-shell">
        <header className="db-header">
          <div className="db-h-context">
            <span className="db-h-title">{title}</span>
          </div>
          <div className="db-h-spacer" />
          <div className="db-topbar-right">
            <TopbarSignOutButton />
          </div>
        </header>
        <div className="db-shell-scroll">
          {/* Keyed by pathname so the content eases in on each module switch. */}
          <div key={pathname} className="db-shell-pad db-page-in">
            {children}
          </div>
        </div>
      </div>
      <CopilotPanel />
    </div>
  );
}
