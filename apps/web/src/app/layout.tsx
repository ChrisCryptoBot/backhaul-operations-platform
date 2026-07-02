import "./globals.css";
import type { Metadata } from "next";
import React from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { getClerkPublishableKey, hasValidClerkPublishableKey } from "@/lib/auth/clerk-config";
import { ThemeProvider } from "@/components/shell/theme";

export const metadata: Metadata = {
  title: "Backhaul Phase 1",
  description: "NE operational flow bootstrap"
};

// The app ships one locked colour scheme: light mode + blue accent. Pin it before
// first paint and drop any legacy persisted choice so nothing flashes the old theme.
const THEME_BOOT_SCRIPT = `(function(){try{var d=document.documentElement;d.setAttribute('data-theme','light');d.setAttribute('data-accent','blue');localStorage.removeItem('db-theme');localStorage.removeItem('db-accent');}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const publishableKey = getClerkPublishableKey();
  const hasValidClerkKey = hasValidClerkPublishableKey(publishableKey);
  const isProduction = process.env.NODE_ENV === "production";
  const isCi = process.env.CI === "true";

  if (!hasValidClerkKey && isProduction && !isCi) {
    throw new Error("Missing or invalid Clerk publishable key in production.");
  }

  return (
    <html lang="en" data-theme="light" data-accent="blue">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          {hasValidClerkKey ? (
            <ClerkProvider publishableKey={publishableKey}>{children}</ClerkProvider>
          ) : (
            children
          )}
        </ThemeProvider>
      </body>
    </html>
  );
}
