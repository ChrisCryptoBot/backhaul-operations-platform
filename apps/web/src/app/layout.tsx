import "./terminal.css";
import "./globals.css";
import "./legacy-flat.css";
import type { Metadata } from "next";
import { Barlow, Barlow_Condensed, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { cookies } from "next/headers";
import { ClerkProvider } from "@clerk/nextjs";
import React from "react";
import { DENSITY_COOKIE, THEME_COOKIE, UI_COOKIE, asDensity, asTheme, asUi, effectiveTheme } from "@/lib/appearance";
import { authOn } from "@/server/tl/identity";

// Figures and labels are set in Plex Mono (tabular, so a column of money lines up to the digit); sentences in Plex Sans.
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-plex-mono", display: "swap" });
const plexSans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-sans", display: "swap" });
// The "TrueLane app" interface style uses the phone app's type: Barlow for text and figures, Barlow Condensed for headings and labels.
const barlow = Barlow({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-barlow", display: "swap" });
const barlowCondensed = Barlow_Condensed({ subsets: ["latin"], weight: ["400", "600"], variable: "--font-barlow-condensed", display: "swap" });

export const metadata: Metadata = {
  title: "Dispatch · TrueLane",
  description: "A dispatcher's desk built on TrueLane's data model."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const jar = cookies();
  const ui = asUi(jar.get(UI_COOKIE)?.value);
  const theme = effectiveTheme(ui, asTheme(jar.get(THEME_COOKIE)?.value));
  const density = asDensity(jar.get(DENSITY_COOKIE)?.value);
  const page = (
    <html lang="en" data-ui={ui} data-theme={theme} data-density={density} className={`${plexMono.variable} ${plexSans.variable} ${barlow.variable} ${barlowCondensed.variable}`}>
      <body>{children}</body>
    </html>
  );
  // The provider is mounted only when sign-in is on; with it off nothing of it runs.
  return authOn() ? <ClerkProvider publishableKey={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? process.env.CLERK_PUBLISHABLE_KEY}>{page}</ClerkProvider> : page;
}
