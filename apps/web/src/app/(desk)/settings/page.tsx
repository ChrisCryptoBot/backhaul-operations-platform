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
import { planSummary } from "@/server/tl/plan";
import { partnerStatus } from "@/server/partners/connections";
import { IntegrationsList } from "@/components/desk/partner-actions";
import { PLANS, priceText } from "@/lib/plans";

/** Settings: appearance (theme, row density) and the thresholds the desk judges by. Appearance buttons save straight away. */
export default async function SettingsPage() {
  const jar = cookies();
  const theme = asTheme(jar.get(THEME_COOKIE)?.value);
  const density = asDensity(jar.get(DENSITY_COOKIE)?.value);
  const [row, kpi, company, plan, partners] = await Promise.all([getStoredThresholds(), getDeskKpi({ period: "4w", compare: false }), getCompany(), planSummary(), partnerStatus()]);
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

      <Card title="Plan" className="tl-card">
        <p style={{ margin: "0 0 6px" }}>
          <b>{plan.label}</b> · {plan.price} · {plan.trucks} {plan.trucks === 1 ? "truck" : "trucks"} in service · <b>{plan.monthly} a month</b> <span className="tl-sub">({plan.parts})</span>
        </p>
        <p className="tl-note" style={{ marginBottom: 10, maxWidth: "72ch" }}>
          {plan.chosen ? `This fleet is on the ${plan.label} plan, which holds ${plan.limit == null ? "any number of trucks" : `${plan.limit} trucks`}; adding past it is refused.` : "No plan has been chosen, so nothing is limited: the price follows the fleet's size. Nothing is charged by the desk yet."}
        </p>
        <table className="tl-table" aria-label="Plans">
          <tbody>
            {PLANS.map((p) => (
              <tr key={p.key} aria-current={p.key === plan.key ? "true" : undefined}>
                <td><b>{p.label}</b></td>
                <td>{p.max == null ? `${p.min} trucks and up` : `${p.min} to ${p.max} trucks`}</td>
                <td>{priceText(p.key)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Integrations" className="tl-card">
        <p className="tl-note" style={{ marginBottom: 14, maxWidth: "72ch" }}>
          Companies TrueLane can work with for the freight, trucks, fuel, insurance and pay of this fleet. A company can be connected once its keys are set on the server; until then its buttons elsewhere in the desk say so. Nothing is sent to a company that is not connected.
        </p>
        <IntegrationsList rows={partners.map((r) => ({ capability: r.capability, label: r.label, provider: r.provider, name: r.name, configured: r.configured, connected: r.connected, accountLabel: r.accountLabel }))} />
      </Card>

      <Card title="Appearance" className="tl-card">
        <div className="st-row">
          <span className="th-label" id="st-theme">Theme</span>
          <form action={setAppearanceAction} className="cp-seg" role="group" aria-labelledby="st-theme">
            {THEMES.map((t) => (
              <button key={t} type="submit" name="theme" value={t} aria-pressed={theme === t}>
                {THEME_LABEL[t].label}
              </button>
            ))}
          </form>
          <span className="tl-sub">{THEME_LABEL[theme].blurb}</span>
        </div>
        <div className="st-row">
          <span className="th-label" id="st-density">Row density</span>
          <form action={setAppearanceAction} className="cp-seg" role="group" aria-labelledby="st-density">
            {DENSITIES.map((d) => (
              <button key={d} type="submit" name="density" value={d} aria-pressed={density === d}>
                {DENSITY_LABEL[d].label}
              </button>
            ))}
          </form>
          <span className="tl-sub">{DENSITY_LABEL[density].blurb}</span>
        </div>
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
