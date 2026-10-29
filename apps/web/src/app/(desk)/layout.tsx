import React from "react";
import type { Metadata } from "next";
import { DeskShell } from "@/components/desk/desk-shell";
import "./desk.css";

export const metadata: Metadata = {
  title: "Dispatch desk",
  description: "A dispatcher's desk built on TrueLane's data model, with sample data."
};

// Everything here reads the database on each request: the board changes the moment a load is sent.
export const dynamic = "force-dynamic";

export default function DeskLayout({ children }: { children: React.ReactNode }) {
  return <DeskShell>{children}</DeskShell>;
}
