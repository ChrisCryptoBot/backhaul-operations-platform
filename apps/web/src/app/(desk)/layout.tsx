import React from "react";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { DeskShell } from "@/components/desk/desk-shell";
import { UnderlayProvider } from "@/components/desk/underlay";
import { getShellData } from "@/server/tl/shell";
import "./desk.css";

export const metadata: Metadata = {
  title: "Dispatch · TrueLane",
  description: "A dispatcher's desk built on TrueLane's data model, with sample data."
};

// Everything here reads the database on each request: the board changes the moment a load is sent.
export const dynamic = "force-dynamic";

export default async function DeskLayout({ children, drawer }: { children: React.ReactNode; drawer: React.ReactNode }) {
  const data = await getShellData();
  const collapsed = cookies().get("desk-sidebar")?.value === "1";
  return (
    <UnderlayProvider>
      <DeskShell data={data} initialCollapsed={collapsed} drawer={drawer}>
        {children}
      </DeskShell>
    </UnderlayProvider>
  );
}
