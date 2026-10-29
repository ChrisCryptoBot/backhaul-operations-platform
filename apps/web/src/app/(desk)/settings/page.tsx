import { cookies } from "next/headers";
import React from "react";
import { setAppearanceAction } from "../actions";
import { Card, PageHead } from "@/components/desk/ui";
import { DENSITIES, DENSITY_COOKIE, DENSITY_LABEL, THEMES, THEME_COOKIE, THEME_LABEL, asDensity, asTheme } from "@/lib/appearance";

/** Settings: appearance for now (theme and row density). Each choice is a button that saves straight away. */
export default function SettingsPage() {
  const jar = cookies();
  const theme = asTheme(jar.get(THEME_COOKIE)?.value);
  const density = asDensity(jar.get(DENSITY_COOKIE)?.value);

  return (
    <>
      <PageHead title="Settings" sub="How the desk looks. Saved in this browser and applied before the page paints." />

      <Card title="Theme">
        <form action={setAppearanceAction} className="st-choices">
          {THEMES.map((t) => (
            <button key={t} type="submit" name="theme" value={t} className="st-choice" aria-pressed={theme === t}>
              {/* The swatch carries its own data-theme so it previews that theme whichever one is active. */}
              <span className="st-swatch" data-theme={t} aria-hidden="true">
                <span className="r"><i /><i /><i /></span>
                <span className="m"><i /><i /><i /></span>
              </span>
              <b>{THEME_LABEL[t].label}</b>
              <span>{THEME_LABEL[t].blurb}</span>
            </button>
          ))}
        </form>
      </Card>

      <Card title="Row density" className="tl-card">
        <form action={setAppearanceAction} className="st-choices" style={{ marginTop: 0 }}>
          {DENSITIES.map((d) => (
            <button key={d} type="submit" name="density" value={d} className="st-choice" aria-pressed={density === d}>
              <span className="st-rows" aria-hidden="true" style={{ gap: d === "compact" ? 3 : 7 }}>
                {Array.from({ length: d === "compact" ? 8 : 5 }, (_, i) => <i key={i} />)}
              </span>
              <b>{DENSITY_LABEL[d].label}</b>
              <span>{DENSITY_LABEL[d].blurb}</span>
            </button>
          ))}
        </form>
      </Card>
    </>
  );
}
