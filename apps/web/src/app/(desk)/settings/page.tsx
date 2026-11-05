import { cookies } from "next/headers";
import Link from "next/link";
import React from "react";
import { saveTimezoneAction, setAppearanceAction } from "../actions";
import { Card, PageHead } from "@/components/desk/ui";
import { SleepNowButton } from "@/components/desk/splash";
import { ThresholdsForm } from "@/components/desk/thresholds-form";
import {
  DENSITIES,
  DENSITY_COOKIE,
  DENSITY_LABEL,
  MAX_SLEEP_MINUTES,
  SLEEP_COOKIE,
  SLEEP_PRESETS,
  THEMES,
  THEME_COOKIE,
  THEME_LABEL,
  asDensity,
  asSleepMinutes,
  asTheme,
  sleepBlurb,
  sleepPresetLabel
} from "@/lib/appearance";
import { THRESHOLD_FIELDS, type Thresholds } from "@/lib/thresholds";
import { getDeskKpi } from "@/server/tl/kpi";
import { getStoredThresholds } from "@/server/tl/thresholds";
import { CompanyForm } from "@/components/desk/company-form";
import { toCompanyValues } from "@/lib/company";
import { getCompany } from "@/server/tl/company";
import { planSummary } from "@/server/tl/plan";
import { partnerStatus } from "@/server/partners/connections";
import { IntegrationsPanel } from "@/components/desk/integrations-panel";
import { allCredentialStatus, credentialsAvailable } from "@/server/partners/credentials";
import { sandboxAllowed } from "@/server/partners/adapters/sandbox";
import { webhookPaths } from "@/server/partners/connections";
import { headers } from "next/headers";
import { dateTime } from "@/lib/desk-format";
import { PLANS, priceText } from "@/lib/plans";
import { TeamCard } from "@/components/desk/team-card";
import { isPlatformAdmin, requirePage } from "@/server/tl/access";
import { listMembers } from "@/server/tl/members";
import { can } from "@/lib/roles";
import { CARRIER_ZONES, clockName } from "@/lib/tz";
import { workspaceTimezone } from "@/server/tl/zone";
import { currentWorkspaceId } from "@/server/tl/workspace";

export const metadata = { title: "Settings · TrueLane" };

/** Settings: appearance (theme, row density, idle sleep mode) and the thresholds the desk judges by. Appearance buttons save straight away. */
export default async function SettingsPage() {
  const jar = cookies();
  const theme = asTheme(jar.get(THEME_COOKIE)?.value);
  const density = asDensity(jar.get(DENSITY_COOKIE)?.value);
  const sleepMinutes = asSleepMinutes(jar.get(SLEEP_COOKIE)?.value);
  const isCustomSleep = !(SLEEP_PRESETS as readonly number[]).includes(sleepMinutes);
  const me = await requirePage("read");
  const zone = await workspaceTimezone(currentWorkspaceId());
  const [keyStatus, hooks] = await Promise.all([allCredentialStatus(), webhookPaths()]);
  const host = headers().get("x-forwarded-host") ?? headers().get("host") ?? "";
  const integrationsOrigin = host ? `${headers().get("x-forwarded-proto") ?? "https"}://${host}` : "";
  const [row, kpi, company, plan, partners, members] = await Promise.all([getStoredThresholds(), getDeskKpi({ period: "4w", compare: false }), getCompany(), planSummary(), partnerStatus(), listMembers()]);
  const seats = plan.units.find((u) => u.kind === "member")!;
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

      <div id="plan">
      <Card title="Plan" className="tl-card">
        <p style={{ margin: "0 0 6px" }}>
          <b>{plan.label}</b> · {plan.price} · {plan.trucks} {plan.trucks === 1 ? "truck" : "trucks"} in service · <b>{plan.monthly} a month</b> <span className="tl-sub">({plan.parts})</span>
        </p>
        <p className="tl-note" style={{ marginBottom: 10, maxWidth: "72ch" }}>
          {plan.chosen ? `This fleet is on the ${plan.label} plan.` : `No plan is set for this fleet, so it is held to the ${plan.label} plan.`} A plan holds its trucks and twice as many drivers and trailers; the desk stops at a limit and says which plan comes next. Talk to a person to change the plan. Nothing is charged by the desk yet.
        </p>
        <table className="tl-table" aria-label="What this plan holds">
          <tbody>
            {plan.units.map((u) => (
              <tr key={u.kind} aria-current={u.full ? "true" : undefined}>
                <td><b>{u.word.charAt(0).toUpperCase() + u.word.slice(1)}</b></td>
                <td>{u.used} of {u.limit ?? "no automatic limit"} in service</td>
                <td style={{ width: "40%" }}>
                  {u.limit != null ? (
                    <div role="img" aria-label={`${u.used} of ${u.limit} ${u.word}`} style={{ height: 8, background: "color-mix(in srgb, currentColor 14%, transparent)" }}>
                      <div style={{ height: "100%", width: `${Math.min(100, (u.used / u.limit) * 100)}%`, background: u.full ? "var(--neg, #c24d4d)" : "var(--accent, #e8a020)" }} />
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ margin: "14px 0 6px" }}><b>The plans</b></p>
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
      </div>

      <Card title="Team" className="tl-card">
        <TeamCard rows={members.map((m) => ({ id: m.id, email: m.email, name: m.name, role: m.role, grants: m.grants, signedIn: m.signedIn, you: m.email === me.email }))} canEdit={can(me.role, me.grants, "admin")} seats={{ used: seats.used, limit: seats.limit }} />
      </Card>

      <Card title="Integrations" className="tl-card">
        <p className="tl-note" style={{ marginBottom: 14, maxWidth: "72ch" }}>
          Companies TrueLane can work with for the freight, trucks, fuel, insurance and pay of this fleet. Each takes this fleet&apos;s own keys (kept sealed on the server; only the last four characters are ever shown) or the server&apos;s. Nothing is sent to a company that is not connected.
          {credentialsAvailable() ? "" : " This server cannot keep a fleet's own keys yet: whoever runs it needs to set a credential key."}
        </p>
        <IntegrationsPanel
          canKeep={credentialsAvailable() && can(me.role, me.grants, "admin")}
          sandboxOn={sandboxAllowed()}
          whyNot={credentialsAvailable() ? "An admin sets the keys." : "This server cannot keep a fleet's own keys yet. Whoever runs it sets the credential key first."}
          origin={integrationsOrigin}
          items={partners.map((r) => ({
            capability: r.capability,
            label: r.label,
            provider: r.provider,
            name: r.name,
            configured: r.configured,
            status: r.status,
            lastError: r.lastError,
            failures: r.failures,
            lastSyncedAt: r.lastSyncedAt ? dateTime(r.lastSyncedAt) : null,
            rhythm: r.rhythm,
            overdue: r.overdue,
            sandbox: r.sandbox,
            fields: keyStatus.get(r.provider) ?? [],
            webhookPath: hooks.get(`${r.capability}:${r.provider}`) ?? null
          }))}
        />
      </Card>

      <Card title="Time zone" className="tl-card">
        <p className="tl-note" style={{ marginBottom: 14, maxWidth: "72ch" }}>
          The carrier&apos;s own clock. It decides where a billing day ends, how an invoice ages, which week a driver&apos;s statement covers and what &ldquo;this month&rdquo; means, and every time on the desk is
          shown on it. A stop keeps its own clock: an appointment at a dock in another zone is shown where the dock is, with your time beside it.
        </p>
        <div className="st-row">
          <span className="th-label" id="st-zone">Your clock</span>
          {can(me.role, me.grants, "admin") ? (
            <form action={saveTimezoneAction} className="t-seg" role="group" aria-labelledby="st-zone">
              {CARRIER_ZONES.map((z) => (
                <button key={z.id} type="submit" name="timezone" value={z.id} aria-pressed={zone === z.id} title={z.name}>
                  {z.abbr}
                </button>
              ))}
            </form>
          ) : (
            <span>{CARRIER_ZONES.find((z) => z.id === zone)?.name ?? zone}</span>
          )}
          <span className="tl-sub">{clockName(zone)}. {can(me.role, me.grants, "admin") ? "Saves straight away." : "An admin can change it."}</span>
        </div>
      </Card>

      <Card title="Appearance" className="tl-card">
        <div className="st-row">
          <span className="th-label" id="st-theme">Theme</span>
          <form action={setAppearanceAction} className="t-seg" role="group" aria-labelledby="st-theme">
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
          <form action={setAppearanceAction} className="t-seg" role="group" aria-labelledby="st-density">
            {DENSITIES.map((d) => (
              <button key={d} type="submit" name="density" value={d} aria-pressed={density === d}>
                {DENSITY_LABEL[d].label}
              </button>
            ))}
          </form>
          <span className="tl-sub">{DENSITY_LABEL[density].blurb}</span>
        </div>
        <div className="st-row">
          <span className="th-label" id="st-sleep">Sleep mode</span>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <form action={setAppearanceAction} className="t-seg" role="group" aria-labelledby="st-sleep">
              {SLEEP_PRESETS.map((m) => (
                <button key={m} type="submit" name="sleep" value={String(m)} aria-pressed={sleepMinutes === m}>
                  {sleepPresetLabel(m)}
                </button>
              ))}
            </form>
            <form action={setAppearanceAction} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <label className="tl-field" style={{ flexDirection: "row", alignItems: "center", gap: 6, margin: 0 }}>
                <input
                  type="number"
                  name="sleep"
                  min={1}
                  max={MAX_SLEEP_MINUTES}
                  defaultValue={sleepMinutes > 0 ? sleepMinutes : 15}
                  aria-label="Custom sleep timeout in minutes"
                  style={{ width: 68, minHeight: 34, fontVariantNumeric: "tabular-nums" }}
                />
                <span>min</span>
              </label>
              <button type="submit" className="tl-btn sm" aria-pressed={isCustomSleep ? "true" : undefined}>
                Set
              </button>
            </form>
            <SleepNowButton />
          </div>
          <span className="tl-sub">{sleepBlurb(sleepMinutes)}</span>
        </div>
      </Card>

      <Card title="Thresholds" className="tl-card">
        <p className="tl-note" style={{ marginBottom: 14, maxWidth: "72ch" }}>
          The lines the dashboard, the alerts, the invoices and the verdict card judge by. They are shared by everyone using this desk, and each change is recorded in the audit log.
        </p>
        <ThresholdsForm stored={stored} fleetEmptyShare={kpi.current.emptyShare} />
      </Card>

      <Card title="Alert rules" className="tl-card">
        <p className="tl-note" style={{ marginBottom: 10 }}>What raises a block, warn or info alert on a load, with the timings above.</p>
        <Link href="/settings/rules" className="tl-btn">See the rules</Link>
      </Card>

      {isPlatformAdmin(me) ? (
        <Card title="Sign-up requests" className="tl-card">
          <p className="tl-note" style={{ marginBottom: 10 }}>Who has asked for an account, and which large fleets are waiting for a person to set them up.</p>
          <Link href="/settings/requests" className="tl-btn">See the requests</Link>
        </Card>
      ) : null}
    </>
  );
}
