import React from "react";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { DeskShell } from "@/components/desk/desk-shell";
import { UnderlayProvider } from "@/components/desk/underlay";
import { SLEEP_COOKIE, asSleepMinutes } from "@/lib/appearance";
import { requirePage } from "@/server/tl/access";
import { getShellData } from "@/server/tl/shell";
import "./desk.css";

export const metadata: Metadata = {
  title: "Dispatch · TrueLane",
  description: "A dispatcher's desk built on TrueLane's data model, with sample data."
};

// Everything here reads the database on each request: the board changes the moment a load is sent.
export const dynamic = "force-dynamic";

export default async function DeskLayout({ children, drawer }: { children: React.ReactNode; drawer: React.ReactNode }) {
  // With sign-in on, nothing here renders for anyone who is not a member of the desk (asked of the member table on every request).
  await requirePage("read");
  const data = await getShellData();
  const jar = cookies();
  const collapsed = jar.get("desk-sidebar")?.value === "1";
  const sleepMinutes = asSleepMinutes(jar.get(SLEEP_COOKIE)?.value);
  return (
    <UnderlayProvider>
      <DeskShell data={data} initialCollapsed={collapsed} sleepMinutes={sleepMinutes} drawer={drawer}>
        {children}
      </DeskShell>
    </UnderlayProvider>
  );
}
