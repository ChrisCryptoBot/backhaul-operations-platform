import Link from "next/link";
import React from "react";
import { notFound } from "next/navigation";
import { Card, PageHead, Tabs } from "@/components/desk/ui";
import { EmptyState } from "@/components/desk/kit/states";
import { VerdictTag } from "@/components/desk/verdict-card";
import { asKpiPeriod, KPI_PERIODS } from "@/lib/kpi-periods";
import { VERDICT_WORD } from "@/lib/verdict";
import { shortDate, usd, perMile } from "@/lib/desk-format";
import { requirePage } from "@/server/tl/access";
import { getQuoteReport, reportScope, REPORT_LIMIT } from "@/server/tl/quote-report";
import type { Count, VerdictKey } from "@/lib/quote-report";

export const metadata = { title: "Quote decisions · TrueLane" };

const pct = (f: number | null, digits = 0) => (f == null ? "—" : `${(f * 100).toFixed(digits)}%`);
const signed = (n: number | null) => (n == null ? "—" : `${n < 0 ? "−" : ""}${usd(n < 0 ? -n : n, 0)}`);
const marginText = (n: number | null) => (n == null ? "—" : `${n < 0 ? "−" : "+"}${perMile(n < 0 ? -n : n)}`);
const VERDICTS: VerdictKey[] = ["take", "think", "reject", "unjudged"];

/**
 * What was decided on every quote, by whom, on what, and how the negotiating went: a view for an admin of everyone's decisions, for a dispatcher of their own. Read from the decision
 * records (the verdict, what it was read against, the margin, the first offer, who decided and why); decisions from before those were kept count in the totals only.
 */
export default async function QuoteDecisionsPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  await requirePage("quote");
  const scope = reportScope();
  if (scope == null) notFound();
  const period = asKpiPeriod(Array.isArray(searchParams?.period) ? searchParams?.period[0] : searchParams?.period);
  const { report: r, rows, capped } = await getQuoteReport({ period, by: scope === "all" ? null : scope });
  const href = (key: string) => `/kpi/quotes?period=${key}`;

  return (
    <>
      <PageHead title="Quote decisions" sub={scope === "all" ? "What was decided on every quote, on what, and how the negotiating went." : "Your decisions on quotes, what they rested on, and how the negotiating went."}>
        <Link href="/kpi" className="tl-btn">KPI dashboard</Link>
        <a href={`/export/quote-decisions?period=${period}`} className="tl-btn">Export CSV</a>
      </PageHead>
      <div className="kbar">
        <Tabs active={period} hrefFor={href} items={KPI_PERIODS} />
      </div>
      {capped ? <p className="tl-note warn">This period has more than {REPORT_LIMIT.toLocaleString("en-US")} decisions. The latest {REPORT_LIMIT.toLocaleString("en-US")} are counted.</p> : null}

      {r.total === 0 ? (
        <EmptyState title="No quote decisions in this period">A quote booked or passed on from Quote a load shows here, with the verdict it was decided on.</EmptyState>
      ) : (
        <div className="qd">
          <Card title="At a glance">
            <dl className="rc-facts">
              <div>
                <dt>Decisions</dt>
                <dd>{r.total}</dd>
              </div>
              <div>
                <dt>Booked</dt>
                <dd>{r.booked}</dd>
              </div>
              <div>
                <dt>Passed on</dt>
                <dd>{r.passed}</dd>
              </div>
              <div>
                <dt>Booked with an override</dt>
                <dd>{r.overridden}</dd>
              </div>
              <div>
                <dt>Booked, of those decided</dt>
                <dd>{pct(r.acceptanceRate)}</dd>
              </div>
            </dl>
            {r.withoutDetails > 0 ? <p className="tl-note">{`${r.withoutDetails} of these were decided before the verdict was kept with them, so they count here and are left out of the figures that need it.`}</p> : null}
          </Card>

          <Card title="Negotiation grade">
            {r.grade ? (
              <div className="qd-grade">
                <span className="qd-letter" data-grade={r.grade.letter} aria-label={`Grade ${r.grade.letter}`}>
                  {r.grade.letter}
                </span>
                <span className="tl-sub">{`${r.grade.score.toFixed(0)} of 100, the average of the measures below`}</span>
              </div>
            ) : (
              <p className="tl-note">Not graded yet. It needs at least five decisions with something to measure.</p>
            )}
            <table className="tl-table" aria-label="Grade measures">
              <thead>
                <tr>
                  <th>Measure</th>
                  <th className="num">Now</th>
                  <th className="num">Target</th>
                  <th className="num">Of</th>
                </tr>
              </thead>
              <tbody>
                {r.measures.map((m) => (
                  <tr key={m.key}>
                    <td>
                      <b>{m.label}</b>
                      <span className="sub">{m.text}</span>
                    </td>
                    <td className="num">{pct(m.value)}</td>
                    <td className="num">{pct(m.target)}</td>
                    <td className="num">{m.of}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="By verdict">
            <table className="tl-table" aria-label="Decisions by verdict">
              <thead>
                <tr>
                  <th>The verdict when decided</th>
                  <th className="num">Booked</th>
                  <th className="num">Passed on</th>
                  <th className="num">Booked with an override</th>
                </tr>
              </thead>
              <tbody>
                {VERDICTS.map((v) => {
                  const c: Count = r.byVerdict[v];
                  return (
                    <tr key={v}>
                      <td>
                        <VerdictTag state={v} word={VERDICT_WORD[v]} />
                      </td>
                      <td className="num">{c.booked}</td>
                      <td className="num">{c.passed}</td>
                      <td className="num">{c.overridden}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="tl-note">A Reject or Caution that was booked is the decision to look at: the reason is in the next card.</p>
          </Card>

          <Card title="Overrides">
            {r.overrides.reasons.length === 0 ? (
              <p className="tl-note">No load was booked with an override in this period.</p>
            ) : (
              <>
                <table className="tl-table" aria-label="Overrides by reason">
                  <thead>
                    <tr>
                      <th>Reason given</th>
                      <th className="num">Loads</th>
                      <th className="num">Left over on the losing ones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.overrides.reasons.map((x) => (
                      <tr key={x.reason}>
                        <td>{x.reason}</td>
                        <td className="num">{x.count}</td>
                        <td className={`num ${x.leftOver < 0 ? "neg" : ""}`}>{signed(x.leftOver)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="tl-note">{`Booked loads that were priced under their cost: ${r.overrides.belowFloor}. Money left on those: ${signed(r.overrides.moneyLeftOnOverrides)}.`}</p>
              </>
            )}
          </Card>

          <Card title="Negotiation">
            <dl className="rc-facts">
              <div>
                <dt>Booked quotes raised above the first offer</dt>
                <dd>{r.negotiation.ofWithFirst === 0 ? "—" : `${r.negotiation.raised} of ${r.negotiation.ofWithFirst}`}</dd>
              </div>
              <div>
                <dt>Average raise when raised</dt>
                <dd>{r.negotiation.avgRaise == null ? "—" : `${usd(r.negotiation.avgRaise, 0)} (${pct(r.negotiation.avgRaisePct, 1)})`}</dd>
              </div>
              <div>
                <dt>Passed on for the rate</dt>
                <dd>{r.negotiation.passedOnRate}</dd>
              </div>
              <div>
                <dt>Those were, against what they were read against</dt>
                <dd>{r.negotiation.passedUnderMarketPct == null ? "—" : `${r.negotiation.passedUnderMarketPct < 0 ? "−" : "+"}${pct(r.negotiation.passedUnderMarketPct < 0 ? -r.negotiation.passedUnderMarketPct : r.negotiation.passedUnderMarketPct, 1)}`}</dd>
              </div>
            </dl>
            <p className="tl-note">The first offer is the amount the quote had when it was first saved. A quote typed and booked in one go has no first offer, so it is left out of the raise.</p>
          </Card>

          <Card title="Fuel the verdicts were priced on">
            <dl className="rc-facts">
              <div>
                <dt>This week&apos;s regional price</dt>
                <dd>{r.fuel.regional}</dd>
              </div>
              <div>
                <dt>A price somebody typed</dt>
                <dd>{r.fuel.typed}</dd>
              </div>
              <div>
                <dt>Each truck&apos;s own price</dt>
                <dd>{r.fuel.truckOwn}</dd>
              </div>
            </dl>
          </Card>

          {scope === "all" ? (
            <Card title="By person">
              <table className="tl-table" aria-label="Decisions by person">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th className="num">Decisions</th>
                    <th className="num">Booked</th>
                    <th className="num">Passed on</th>
                    <th className="num">Override rate</th>
                    <th className="num">Average left over a mile</th>
                  </tr>
                </thead>
                <tbody>
                  {r.people.map((p) => (
                    <tr key={p.name}>
                      <td>{p.name}</td>
                      <td className="num">{p.decisions}</td>
                      <td className="num">{p.booked}</td>
                      <td className="num">{p.passed}</td>
                      <td className="num">{pct(p.overrideRate)}</td>
                      <td className={`num ${p.avgMargin != null && p.avgMargin < 0 ? "neg" : ""}`}>{marginText(p.avgMargin)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ) : null}

          <Card title="By customer">
            <table className="tl-table" aria-label="Decisions by customer">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th className="num">Booked</th>
                  <th className="num">Passed on</th>
                  <th className="num">Overrides</th>
                  <th className="num">Average left over a mile</th>
                </tr>
              </thead>
              <tbody>
                {r.customers.map((c) => (
                  <tr key={c.name}>
                    <td>{c.name}</td>
                    <td className="num">{c.booked}</td>
                    <td className="num">{c.passed}</td>
                    <td className="num">{c.overridden}</td>
                    <td className={`num ${c.avgMargin != null && c.avgMargin < 0 ? "neg" : ""}`}>{marginText(c.avgMargin)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Week by week">
            <table className="tl-table" aria-label="Decisions by week">
              <thead>
                <tr>
                  <th>Week of</th>
                  <th className="num">Booked</th>
                  <th className="num">Passed on</th>
                  <th className="num">Overrides</th>
                </tr>
              </thead>
              <tbody>
                {r.weeks.map((w) => (
                  <tr key={w.start.toISOString()}>
                    <td>{shortDate(w.start)}</td>
                    <td className="num">{w.booked}</td>
                    <td className="num">{w.passed}</td>
                    <td className="num">{w.overridden}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title={`The ${Math.min(rows.length, 15)} latest decisions`}>
            <div className="dt-wrap qt-scroll">
              <table className="tl-table" aria-label="Latest decisions">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Decision</th>
                    <th>Lane</th>
                    <th>Customer</th>
                    <th className="num">Offer</th>
                    <th>Verdict</th>
                    <th>By</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 15).map((d) => (
                    <tr key={d.id}>
                      <td>{shortDate(d.at)}</td>
                      <td>{d.kind === "passed" ? "Passed on" : d.kind === "overridden" ? "Booked, override" : "Booked"}</td>
                      <td>{d.lane}</td>
                      <td>{d.customer ?? "—"}</td>
                      <td className="num">{usd(d.offer, 0)}</td>
                      <td>{d.verdict ? <VerdictTag state={d.verdict} word={VERDICT_WORD[d.verdict]} /> : <span className="dim">Not kept</span>}</td>
                      <td>{d.by}</td>
                      <td>{[d.reason, d.notes].filter(Boolean).join(": ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
