import { cookies } from "next/headers";
import Link from "next/link";
import React from "react";
import { setAppearanceAction } from "../actions";
import { Card, PageHead } from "@/components/desk/ui";
import { ThresholdsForm } from "@/components/desk/thresholds-form";
import { DENSITIES, DENSITY_COOKIE, DENSITY_LABEL, THEMES, THEME_COOKIE, THEME_LABEL, asDensity, asTheme } from "@/lib/appearance";
import { THRESHOLD_FIELDS, type Thresholds } from "@/lib/thresholds";
import { getDeskKpi } from "@/server/tl/kpi";
import { getStoredThresholds } from "@/server/tl/thresholds";
import { CompanyForm } from "@/components/desk/company-form";
import { toCompanyValues } from "@/lib/company";
import { getCompany } from "@/server/tl/company";

/** Settings: appearance (theme, row density) and the thresholds the desk judges by. Appearance buttons save straight away. */
export default async function SettingsPage() {
  const jar = cookies();
  const theme = asTheme(jar.get(THEME_COOKIE)?.value);
  const density = asDensity(jar.get(DENSITY_COOKIE)?.value);
  const [row, kpi, company] = await Promise.all([getStoredThresholds(), getDeskKpi({ period: "4w", compare: false }), getCompany()]);
  const stored = Object.fromEntries(THRESHOLD_FIELDS.map((f) => [f.key, row[f.key] ?? null])) as Record<keyof Thresholds, number | null>;

  return (
    <>
      <PageHead title="Settings" sub="Your company on the paperwork, how the desk looks, and the numbers it judges by." />

      <Card title="Company" className="tl-card">
        <p className="tl-note" style={{ marginBottom: 14, maxWidth: "72ch" }}>
          Printed at the top of every invoice and driver statement, with where a customer should send the payment. Only the name is required; a sheet prints just what is filled in.
        </p>
        <CompanyForm stored={toCompanyValues(company)} />
      </Card>

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

      <Card title="Thresholds" className="tl-card">
        <p className="tl-note" style={{ marginBottom: 14, maxWidth: "72ch" }}>
          The lines the dashboard, the alerts and the invoices judge by. They are shared by everyone using this desk, and each change is recorded in the audit log.
        </p>
        <ThresholdsForm stored={stored} fleetEmptyShare={kpi.current.emptyShare} />
      </Card>

      <Card title="Alert rules" className="tl-card">
        <p className="tl-note" style={{ marginBottom: 10 }}>What raises a block, warn or info alert on a load, with the timings above.</p>
        <Link href="/settings/rules" className="tl-btn">See the rules</Link>
      </Card>
    </>
  );
}
