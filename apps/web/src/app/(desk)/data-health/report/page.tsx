import { termList, scopeWords } from "@/lib/scope";
import Link from "next/link";
import React from "react";
import { DocHead } from "@/components/desk/doc-head";
import { PrintButton } from "@/components/desk/kpi/print-button";
import { EXAMPLES, gradeOf } from "@/lib/data-health";
import { demoLoginOn } from "@/lib/demo-session";
import { dateTime, pct, usd } from "@/lib/desk-format";
import { kpiHref, parseKpiParams } from "@/lib/kpi-params";
import { windowLabel } from "@/lib/kpi-periods";
import { requirePage } from "@/server/tl/access";
import { getCompany } from "@/server/tl/company";
import { getDataHealth } from "@/server/tl/data-health";
import { currentTerminal } from "@/server/tl/terminal";

export const metadata = { title: "Data readiness report · TrueLane" };
export const dynamic = "force-dynamic";

const PERIOD_NAME = { "4w": "Last four weeks", month: "This month", ytd: "Year to date", all: "All time" } as const;
const share = (n: number | null) => (n == null ? "—" : pct(n, 0));
const money = (n: number) => usd(n, 2);

/**
 * The Data readiness report: one sheet an owner or a consultant can read, print or save as a PDF. Headline score and what it means, the score by module, the ten things most worth fixing, and the three cross-source
 * checks, each with what it compared. It is the Data health read on paper: the same numbers, nothing added.
 */
export default async function DataReadinessReport({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  await requirePage("bill");
  const params = parseKpiParams(searchParams);
  const now = new Date();
  const terminal = await currentTerminal();
  const [h, company] = await Promise.all([getDataHealth({ period: params.period, terminals: termList(terminal) }, now), getCompany()]);
  const grade = gradeOf(h.completeness.score);
  const gaps = h.completeness.checks
    .filter((c) => c.gaps > 0)
    .sort((a, b) => b.gaps / Math.max(1, b.checked) - a.gaps / Math.max(1, a.checked) || b.gaps - a.gaps)
    .slice(0, 10);
  const f = h.fuel;
  const r = h.rateCon;
  const p = h.pings;

  return (
    <>
      <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <Link href={kpiHref("/data-health", params)} className="tl-btn">Back to data health</Link>
        <PrintButton />
      </div>
      <article className="rp">
        <DocHead
          kicker={`${PERIOD_NAME[params.period]} · ${windowLabel(h.window)}`}
          number="Data readiness report"
          company={company}
          heroLabel="Data health"
          hero={share(h.completeness.score)}
          sub={`${h.counts.loads.toLocaleString("en-US")} finished loads · ${h.counts.trucks.toLocaleString("en-US")} trucks · ${h.counts.drivers.toLocaleString("en-US")} drivers · ${h.counts.trailers.toLocaleString("en-US")} trailers`}
          stamp={{ text: grade.word, tone: grade.tone === "ok" ? "good" : grade.tone === "bad" ? "bad" : "plain" }}
        />
        <p className="rp-meta">
          {scopeWords(terminal) ?? "All terminals"} · Prepared {dateTime(now)}
          {h.truncated ? " · Only the newest loads were read" : ""}
        </p>

        <h2>What this says</h2>
        <p>
          {h.completeness.score == null
            ? "Nothing was checked: there are no finished loads or units in this window."
            : `${share(h.completeness.score)} of the fields this report checks are filled in. ${
                grade.tone === "ok"
                  ? "The records are complete enough for a read of the numbers to be trusted."
                  : grade.tone === "warn"
                    ? "Most of what a read needs is there; the gaps below are worth closing first."
                    : "Too much is missing for the figures built on it to be relied on yet. Close the gaps below first."
              }`}
        </p>

        <h2>Score by module</h2>
        <table aria-label="Score by module">
          <thead>
            <tr>
              <th>Module</th>
              <th className="num">Fields checked</th>
              <th className="num">Filled in</th>
              <th className="num">Score</th>
            </tr>
          </thead>
          <tbody>
            {h.completeness.modules.map((m) => (
              <tr key={m.key}>
                <td>{m.label}</td>
                <td className="num">{m.checked.toLocaleString("en-US")}</td>
                <td className="num">{m.passed.toLocaleString("en-US")}</td>
                <td className="num">{share(m.score)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2>The ten things most worth fixing</h2>
        {gaps.length === 0 ? (
          <p>Nothing is missing from what was checked.</p>
        ) : (
          <table aria-label="What is missing">
            <thead>
              <tr>
                <th>Check</th>
                <th className="num">Missing</th>
                <th className="num">Of</th>
                <th>Why it matters</th>
                <th>For example</th>
              </tr>
            </thead>
            <tbody>
              {gaps.map((c) => (
                <tr key={c.key}>
                  <td>{c.label}</td>
                  <td className="num">{c.gaps.toLocaleString("en-US")}</td>
                  <td className="num">{c.checked.toLocaleString("en-US")}</td>
                  <td>{c.why}</td>
                  <td>
                    {c.examples.slice(0, 4).map((e) => e.label).join(", ")}
                    {c.gaps > Math.min(4, EXAMPLES) ? ` and ${(c.gaps - Math.min(4, c.examples.length)).toLocaleString("en-US")} more` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h2>Where two sources should agree</h2>
        <table aria-label="Cross-source checks">
          <thead>
            <tr>
              <th>Check</th>
              <th>Compared on</th>
              <th>Found</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Fuel card and the load&apos;s own fuel</td>
              <td>The card purchases tied to a finished load against the fuel recorded on it; apart when the gap is over the larger of $25 and a tenth.</td>
              <td>
                {!f.hasCardData
                  ? "No fuel card purchases are on the desk, so nothing was compared."
                  : `${f.withCard.toLocaleString("en-US")} loads with a card purchase: ${f.matched.toLocaleString("en-US")} match, ${f.off.toLocaleString("en-US")} apart (${money(f.offDollars)}), ${f.cardOnly.toLocaleString("en-US")} with no fuel recorded (${money(f.cardOnlyDollars)}).`}
              </td>
            </tr>
            <tr>
              <td>Rate confirmation and the invoice</td>
              <td>The line haul and fuel surcharge on the invoice against the rate confirmation&apos;s rate and surcharge. Detention, lumper and layover lines are extras and left out.</td>
              <td>
                {r.invoiced === 0
                  ? "No finished load was invoiced in this window."
                  : `${r.checkable.toLocaleString("en-US")} of ${r.invoiced.toLocaleString("en-US")} invoiced loads have a rate confirmation: ${r.matched.toLocaleString("en-US")} match, ${r.under.toLocaleString("en-US")} billed under (${money(r.underDollars)}), ${r.over.toLocaleString("en-US")} billed over (${money(r.overDollars)}).`}
              </td>
            </tr>
            <tr>
              <td>Truck positions and billed miles</td>
              <td>A straight line between position pings, first arrival to last, against the billed loaded miles; apart when under 70% or over 130%. The desk keeps pings for {h.pingDays} days and stores no odometer, so only loads finished in the last {h.pingDays} days are checked.</td>
              <td>
                {p.trips === 0
                  ? `No load finished in the last ${h.pingDays} days with a truck on it.`
                  : p.measured === 0
                    ? `${p.trips.toLocaleString("en-US")} recent loads, none with enough pings to measure.`
                    : `${p.measured.toLocaleString("en-US")} trips measured: ${p.agreed.toLocaleString("en-US")} agree, ${p.apart.toLocaleString("en-US")} apart.`}
              </td>
            </tr>
          </tbody>
        </table>

        <p className="rp-meta" style={{ marginTop: 16 }}>
          How this is worked out: a field counts as filled in when the desk holds a real value for it. Each check is counted over the items it applies to. A module&apos;s score is the share of its checked fields that are filled in; the headline weights Loads 40% and Stops, Trucks, Drivers and
          Trailers 15% each, over the modules that have anything to check. Nothing is estimated, and a field the desk cannot tell is never counted as filled in.
        </p>
        {demoLoginOn(process.env) ? <p className="rp-foot">Sample data only. Every name, customer and number here is invented.</p> : null}
      </article>
    </>
  );
}
