import "./terminal.css";
import "./globals.css";
import "./legacy-flat.css";
import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { cookies } from "next/headers";
import { ClerkProvider } from "@clerk/nextjs";
import React from "react";
import { DENSITY_COOKIE, THEME_COOKIE, asDensity, asTheme } from "@/lib/appearance";
import { authOn } from "@/server/tl/identity";

// Figures and labels are set in Plex Mono (tabular, so a column of money lines up to the digit); sentences in Plex Sans.
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-plex-mono", display: "swap" });
const plexSans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-sans", display: "swap" });

export const metadata: Metadata = {
  title: "Dispatch · TrueLane",
  description: "A dispatcher's desk built on TrueLane's data model, with sample data."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const jar = cookies();
  const theme = asTheme(jar.get(THEME_COOKIE)?.value);
  const density = asDensity(jar.get(DENSITY_COOKIE)?.value);
  const page = (
    <html lang="en" data-theme={theme} data-density={density} className={`${plexMono.variable} ${plexSans.variable}`}>
      <body>{children}</body>
    </html>
  );
  // The provider is mounted only when sign-in is on; with it off nothing of it runs.
  return authOn() ? <ClerkProvider publishableKey={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? process.env.CLERK_PUBLISHABLE_KEY}>{page}</ClerkProvider> : page;
}
