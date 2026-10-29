import "./globals.css";
import type { Metadata } from "next";
import { Barlow, Barlow_Condensed } from "next/font/google";
import { cookies } from "next/headers";
import React from "react";
import { DENSITY_COOKIE, THEME_COOKIE, asDensity, asTheme } from "@/lib/appearance";

const barlow = Barlow({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-barlow", display: "swap" });
const barlowCondensed = Barlow_Condensed({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-barlow-cond", display: "swap" });

export const metadata: Metadata = {
  title: "Dispatch desk",
  description: "A dispatcher's desk built on TrueLane's data model, with sample data."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const jar = cookies();
  const theme = asTheme(jar.get(THEME_COOKIE)?.value);
  const density = asDensity(jar.get(DENSITY_COOKIE)?.value);
  return (
    <html lang="en" data-theme={theme} data-density={density} className={`${barlow.variable} ${barlowCondensed.variable}`}>
      <body>{children}</body>
    </html>
  );
}
