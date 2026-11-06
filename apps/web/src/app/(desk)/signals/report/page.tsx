import Link from "next/link";
import { notFound } from "next/navigation";
import React from "react";
import { DocHead } from "@/components/desk/doc-head";
import { PrintButton } from "@/components/desk/kpi/print-button";
import { dateTime, pct, usd } from "@/lib/desk-format";
import { reportWhen } from "@/lib/signal-settings";
import { requirePage } from "@/server/tl/access";
import { getCompany } from "@/server/tl/company";
import { currentAllowed } from "@/server/tl/scope";
import { getSignalSettings } from "@/server/tl/signals";
import { buildWeeklyReport } from "@/server/tl/weekly-report";

export const metadata = { title: "Weekly report · TrueLane" };
export const dynamic = "force-dynamic";

const money = (n: number) => usd(n, 2);

/**
 * The weekly report on paper: the same figures the message carries (the last four weeks' headline, the Leak Ledger, Data health) and the signals' counts, as one sheet to read, print or save as a PDF. It is
 * the whole desk by nature, so a person limited to some terminals does not get it; it adds no sum of its own.
 */
export default async function WeeklyReportPage() {
  await requirePage("bill");
  if ((await currentAllowed()) != null) notFound();
  const now = new Date();
  const [r, company, settings] = await Promise.all([buildWeeklyReport(now), getCompany(), getSignalSettings()]);
  const open = r.signals.open.block + r.signals.open.warn + r.signals.open.info;

  return (
    <>
      <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <Link href="/signals" className="tl-btn">Back to signals</Link>
        <PrintButton />
      </div>
      <article className="rp">
        <DocHead kicker={`${r.windowLabel} · week ${r.weekKey}`} number="Weekly report" company={company} heroLabel="Open signals" hero={String(open)} sub={`${money(r.leaks.total)} leaked in the period · ${r.signals.newThisWeek} new and ${r.signals.clearedThisWeek} cleared this week`} />
        <p className="rp-meta">
          Whole desk · Prepared {dateTime(now)} · {settings.reportEnabled ? `Sent ${reportWhen(settings)}` : "The weekly message is off"}
        </p>

        <h2>The period</h2>
        <table aria-label="The period">
          <thead>
            <tr>
              <th>Finished loads</th>
              <th className="num">Gross</th>
              <th className="num">Per mile</th>
              <th className="num">Empty miles</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{r.headline.loads.toLocaleString("en-US")}</td>
              <td className="num">{money(r.headline.gross)}</td>
              <td className="num">{r.headline.rpm == null ? "—" : money(r.headline.rpm)}</td>
              <td className="num">{r.headline.emptyShare == null ? "—" : pct(r.headline.emptyShare, 1)}</td>
            </tr>
          </tbody>
        </table>

        <h2>Where money leaked</h2>
        {r.leaks.items === 0 ? (
          <p>Nothing leaked in the period.</p>
        ) : (
          <table aria-label="The Leak Ledger">
            <thead>
              <tr>
                <th>Leak</th>
                <th className="num">Items</th>
                <th className="num">Dollars</th>
              </tr>
            </thead>
            <tbody>
              {r.leaks.lines.map((l) => (
                <tr key={l.label}>
                  <td>{l.label}</td>
                  <td className="num">{l.items.toLocaleString("en-US")}</td>
                  <td className="num">{money(l.dollars)}</td>
                </tr>
              ))}
              <tr>
                <td>
                  <b>Total</b>
                  {r.leaks.unpriced > 0 ? ` (${r.leaks.unpriced.toLocaleString("en-US")} more with no price yet)` : ""}
                </td>
                <td className="num">{r.leaks.items.toLocaleString("en-US")}</td>
                <td className="num">
                  <b>{money(r.leaks.total)}</b>
                </td>
              </tr>
            </tbody>
          </table>
        )}
        {r.leaks.openDwellTrailers > 0 ? (
          <p>
            Right now {r.leaks.openDwellTrailers.toLocaleString("en-US")} {r.leaks.openDwellTrailers === 1 ? "trailer is" : "trailers are"} waiting past the free time: {money(r.leaks.openDwellDollars)} owed and not billed.
          </p>
        ) : null}

        <h2>What the data is missing</h2>
        <p>{r.health.score == null ? "Nothing was checked yet." : `Data health is ${Math.round(r.health.score)} out of 100.`}</p>
        {r.health.gaps.length > 0 ? (
          <table aria-label="What is missing">
            <thead>
              <tr>
                <th>Check</th>
                <th className="num">Missing</th>
              </tr>
            </thead>
            <tbody>
              {r.health.gaps.slice(0, 8).map((g) => (
                <tr key={g.label}>
                  <td>{g.label}</td>
                  <td className="num">{g.gaps.toLocaleString("en-US")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        <h2>Signals</h2>
        <table aria-label="Signals">
          <thead>
            <tr>
              <th>Block</th>
              <th>Warn</th>
              <th>Info</th>
              <th>Acknowledged</th>
              <th>New this week</th>
              <th>Cleared this week</th>
              <th>Oldest open</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{r.signals.open.block}</td>
              <td>{r.signals.open.warn}</td>
              <td>{r.signals.open.info}</td>
              <td>{r.signals.acknowledged}</td>
              <td>{r.signals.newThisWeek}</td>
              <td>{r.signals.clearedThisWeek}</td>
              <td>{r.signals.oldestOpenDays == null ? "—" : `${r.signals.oldestOpenDays} ${r.signals.oldestOpenDays === 1 ? "day" : "days"}`}</td>
            </tr>
          </tbody>
        </table>
      </article>
    </>
  );
}
