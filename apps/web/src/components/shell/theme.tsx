"use client";

import React from "react";

export type ThemeMode = "light" | "dark";
export type AccentMode = "orange" | "blue";

interface ThemeContextValue {
  theme: ThemeMode;
  accent: AccentMode;
  /** Retained for API compatibility; always true (the scheme is fixed). */
  ready: boolean;
}

const LOCKED: ThemeContextValue = { theme: "light", accent: "blue", ready: true };

const ThemeContext = React.createContext<ThemeContextValue>(LOCKED);

/**
 * The app ships a single, locked colour scheme: light mode + blue accent. This
 * provider pins `<html data-theme="light" data-accent="blue">` and clears any legacy
 * persisted choice — there are deliberately no theme/accent toggles in the app.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  React.useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", "light");
    root.setAttribute("data-accent", "blue");
    try {
      window.localStorage.removeItem("db-theme");
      window.localStorage.removeItem("db-accent");
    } catch {
      /* storage unavailable — attributes are still applied for the session */
    }
  }, []);

  return <ThemeContext.Provider value={LOCKED}>{children}</ThemeContext.Provider>;
}

/** Access the (locked) colour scheme. Always light + blue. */
export function useTheme(): ThemeContextValue {
  return React.useContext(ThemeContext);
}
