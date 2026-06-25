"use client";

import React from "react";
import { AppSidebar, type AppSidebarProps } from "@/components/shell/app-sidebar";
import { ThemeToggleButton, AccentToggle } from "@/components/shell/theme";
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
            <AccentToggle />
            <ThemeToggleButton />
            <TopbarSignOutButton />
          </div>
        </header>
        <div className="db-shell-scroll">
          <div className="db-shell-pad">{children}</div>
        </div>
      </div>
      <CopilotPanel />
    </div>
  );
}
