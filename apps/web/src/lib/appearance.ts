/** The desk's two appearance settings. They live in cookies so the server can write them onto <html> before first paint. */
export const THEMES = ["night", "day"] as const;
export const DENSITIES = ["comfortable", "compact"] as const;
export type Theme = (typeof THEMES)[number];
export type Density = (typeof DENSITIES)[number];

export const THEME_COOKIE = "desk-theme";
export const DENSITY_COOKIE = "desk-density";

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
