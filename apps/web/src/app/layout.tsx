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

// Applies the persisted theme/accent to <html> before first paint so there's no
// light-then-dark flash. Defaults: dark-first, brand orange.
const THEME_BOOT_SCRIPT = `(function(){try{var d=document.documentElement;var t=localStorage.getItem('db-theme');var a=localStorage.getItem('db-accent');d.setAttribute('data-theme',t==='light'||t==='dark'?t:'dark');d.setAttribute('data-accent',a==='blue'?'blue':'orange');}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const publishableKey = getClerkPublishableKey();
  const hasValidClerkKey = hasValidClerkPublishableKey(publishableKey);
  const isProduction = process.env.NODE_ENV === "production";
  const isCi = process.env.CI === "true";

  if (!hasValidClerkKey && isProduction && !isCi) {
    throw new Error("Missing or invalid Clerk publishable key in production.");
  }

  return (
    <html lang="en" data-theme="dark" data-accent="orange">
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
