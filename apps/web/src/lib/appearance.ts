/** The desk's appearance and idle-sleep settings. They live in cookies so the server can read them before first paint. */
export const THEMES = ["night", "day"] as const;
export const DENSITIES = ["comfortable", "compact"] as const;
export type Theme = (typeof THEMES)[number];
export type Density = (typeof DENSITIES)[number];

export const THEME_COOKIE = "desk-theme";
export const DENSITY_COOKIE = "desk-density";
export const SLEEP_COOKIE = "desk-sleep";

export const DEFAULT_SLEEP_MINUTES = 15;
export const MAX_SLEEP_MINUTES = 240;
export const SLEEP_PRESETS = [0, 1, 5, 15, 30, 60] as const;

export const THEME_LABEL: Record<Theme, { label: string; blurb: string }> = {
  night: { label: "Night", blurb: "TrueLane charcoal, gold and dark glass. The default." },
  day: { label: "Day", blurb: "Warm paper and frosted glass, easy on a bright office." }
};
export const DENSITY_LABEL: Record<Density, { label: string; blurb: string }> = {
  comfortable: { label: "Comfortable", blurb: "40px rows." },
  compact: { label: "Compact", blurb: "32px rows, about a quarter more on screen." }
};

export const asTheme = (v: string | null | undefined): Theme => (THEMES as readonly string[]).includes(v ?? "") ? (v as Theme) : "night";
export const asDensity = (v: string | null | undefined): Density => (DENSITIES as readonly string[]).includes(v ?? "") ? (v as Density) : "comfortable";

/** Minutes of inactivity before the TrueLane curtain covers the desk (0 = Off, 1..240 = minutes). */
export function asSleepMinutes(v: string | number | null | undefined): number {
  if (v == null) return DEFAULT_SLEEP_MINUTES;
  const raw = String(v).trim().toLowerCase();
  if (raw === "") return DEFAULT_SLEEP_MINUTES;
  if (raw === "off" || raw === "0") return 0;
  if (!/^\d+$/.test(raw)) return DEFAULT_SLEEP_MINUTES;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_SLEEP_MINUTES, n);
}

export function sleepPresetLabel(minutes: number): string {
  return minutes === 0 ? "Off" : `${minutes}m`;
}

export function sleepBlurb(minutes: number): string {
  if (minutes <= 0) return "Off. The desk stays open when unattended.";
  if (minutes === 1) return "Drops the TrueLane curtain after 1 minute of no motion or input.";
  return `Drops the TrueLane curtain after ${minutes} minutes of no motion or input.`;
}
