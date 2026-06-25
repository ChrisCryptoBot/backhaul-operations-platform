"use client";

import React from "react";
import { SunIcon, MoonIcon } from "@/components/icons";

export type ThemeMode = "light" | "dark";
export type AccentMode = "orange" | "blue";

const THEME_KEY = "db-theme";
const ACCENT_KEY = "db-accent";

interface ThemeContextValue {
  theme: ThemeMode;
  accent: AccentMode;
  /** False until the client has reconciled with localStorage on mount. */
  ready: boolean;
  toggleTheme: () => void;
  setTheme: (theme: ThemeMode) => void;
  toggleAccent: () => void;
  setAccent: (accent: AccentMode) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

function readTheme(): ThemeMode {
  if (typeof window === "undefined") return "dark";
  const saved = window.localStorage.getItem(THEME_KEY);
  return saved === "light" || saved === "dark" ? saved : "dark";
}

function readAccent(): AccentMode {
  if (typeof window === "undefined") return "orange";
  return window.localStorage.getItem(ACCENT_KEY) === "blue" ? "blue" : "orange";
}

function applyTheme(theme: ThemeMode) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* storage unavailable — attribute still applied for the session */
  }
}

function applyAccent(accent: AccentMode) {
  document.documentElement.setAttribute("data-accent", accent);
  try {
    window.localStorage.setItem(ACCENT_KEY, accent);
  } catch {
    /* storage unavailable */
  }
}

/**
 * Single source of truth for theme (dark-first) + accent (orange brand / blue alt),
 * applied to <html data-theme data-accent> and persisted to localStorage. The inline
 * boot script in the root layout's <head> applies the persisted choice before first
 * paint (no flash); this provider syncs React state to it and owns the toggles.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<ThemeMode>("dark");
  const [accent, setAccentState] = React.useState<AccentMode>("orange");
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    // Reconcile with the persisted choice. The boot script in <head> already applied
    // it before paint in the real app; re-applying here covers entry points without
    // that script (and keeps <html> in sync if it was server-rendered to the default).
    const nextTheme = readTheme();
    const nextAccent = readAccent();
    setThemeState(nextTheme);
    setAccentState(nextAccent);
    applyTheme(nextTheme);
    applyAccent(nextAccent);
    setReady(true);
  }, []);

  const setTheme = React.useCallback((next: ThemeMode) => {
    setThemeState(next);
    applyTheme(next);
  }, []);
  const setAccent = React.useCallback((next: AccentMode) => {
    setAccentState(next);
    applyAccent(next);
  }, []);
  const toggleTheme = React.useCallback(() => {
    setThemeState((prev) => {
      const next: ThemeMode = prev === "dark" ? "light" : "dark";
      applyTheme(next);
      return next;
    });
  }, []);
  const toggleAccent = React.useCallback(() => {
    setAccentState((prev) => {
      const next: AccentMode = prev === "orange" ? "blue" : "orange";
      applyAccent(next);
      return next;
    });
  }, []);

  const value = React.useMemo<ThemeContextValue>(
    () => ({ theme, accent, ready, toggleTheme, setTheme, toggleAccent, setAccent }),
    [theme, accent, ready, toggleTheme, setTheme, toggleAccent, setAccent]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Access the global theme/accent. Returns a safe dark/orange fallback when used
 * outside the provider (e.g. components rendered directly in unit tests).
 */
export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (ctx) return ctx;
  return {
    theme: "dark",
    accent: "orange",
    ready: false,
    toggleTheme: () => {},
    setTheme: () => {},
    toggleAccent: () => {},
    setAccent: () => {}
  };
}

/** Icon theme toggle (sun/moon) for slim headers. */
export function ThemeToggle({ className = "db-iconbtn" }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  return (
    <button
      type="button"
      className={className}
      onClick={toggleTheme}
      title={theme === "dark" ? "Light theme" : "Dark theme"}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
    >
      {theme === "dark" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
    </button>
  );
}

/** Accent swatch toggle (orange brand ↔ blue alternate) for slim headers. */
export function AccentToggle({ className = "db-iconbtn" }: { className?: string }) {
  const { accent, toggleAccent } = useTheme();
  return (
    <button
      type="button"
      className={className}
      onClick={toggleAccent}
      title={`Accent: ${accent === "orange" ? "orange (brand)" : "blue (alternate)"} — switch`}
      aria-label={`Switch accent to ${accent === "orange" ? "blue" : "orange"}`}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6" fill="var(--db-accent)" stroke="var(--db-accent-fg)" strokeWidth="1.5" />
      </svg>
    </button>
  );
}

/** Text theme toggle retained for the non-board app shell header. */
export function ThemeToggleButton() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button
      type="button"
      className="db-btn db-theme-toggle"
      onClick={toggleTheme}
      aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
    >
      {theme === "light" ? "Dark mode" : "Light mode"}
    </button>
  );
}
