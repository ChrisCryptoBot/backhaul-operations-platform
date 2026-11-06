import Link from "next/link";
import React from "react";
import { gradeOf, EXAMPLES, type CheckResult, type ModuleKey } from "@/lib/data-health";
import { usd, pct } from "@/lib/desk-format";
import type { HealthRead } from "@/server/tl/data-health";
import { Card } from "../ui";

/**
 * The Data Health screen, in pieces (lib/data-health.ts has the rules). Every figure says what it was counted on; a check that could not be done says so, and nothing here is an estimate.
 */
const HREF: Record<ModuleKey, (id: string) => string> = {
  loads: (id) => `/loads/${id}`,
  stops: (id) => `/loads/${id}`,
  trucks: (id) => `/fleet/${id}`,
  drivers: (id) => `/drivers/${id}`,
  trailers: (id) => `/trailers/${id}`
};

const share = (n: number | null) => (n == null ? "—" : pct(n, 0));

export function HealthHero({ h }: { h: HealthRead }) {
  const g = gradeOf(h.completeness.score);
  return (
    <section aria-label="Headline">
      <div className="km-hero">
        <div className="km-label">Data health</div>
        <div className="km-herorow">
          <span className="km-big">{share(h.completeness.score)}</span>
          <span className={`tl-chip ${g.tone === "muted" ? "muted" : g.tone === "ok" ? "ok" : "bad"}`}>{g.word}</span>
        </div>
        <div className="km-sub">
          The share of checked fields that are filled in, across {h.counts.loads.toLocaleString("en-US")} finished {h.counts.loads === 1 ? "load" : "loads"}, {h.counts.trucks.toLocaleString("en-US")} {h.counts.trucks === 1 ? "truck" : "trucks"},{" "}
          {h.counts.drivers.toLocaleString("en-US")} {h.counts.drivers === 1 ? "driver" : "drivers"} and {h.counts.trailers.toLocaleString("en-US")} {h.counts.trailers === 1 ? "trailer" : "trailers"}.
          {h.truncated ? " Only the newest loads were read." : ""}
        </div>
      </div>
      <div className="km km-5">
        {h.completeness.modules.map((m) => (
          <div className="km-cell" key={m.key}>
            <div className="km-label">{m.label}</div>
            <div className="km-value">{share(m.score)}</div>
            <div className="km-foot">
              <span className="km-sub">{m.checked === 0 ? "nothing to check" : `${m.passed.toLocaleString("en-US")} of ${m.checked.toLocaleString("en-US")} filled in`}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** One row per check that has a gap, the worst first, with the items behind it. */
export function GapList({ checks, limit }: { checks: CheckResult[]; limit?: number }) {
  const gaps = checks.filter((c) => c.gaps > 0).sort((a, b) => b.gaps / Math.max(1, b.checked) - a.gaps / Math.max(1, a.checked) || b.gaps - a.gaps);
  const shown = limit ? gaps.slice(0, limit) : gaps;
  return (
    <Card title="What is missing">
      {gaps.length === 0 ? (
        <p className="tl-sub">Nothing is missing from what was checked.</p>
      ) : (
        <table className="tl-table" aria-label="Missing fields">
          <thead>
            <tr>
              <th scope="col">Check</th>
              <th scope="col" className="num">Missing</th>
              <th scope="col" className="num">Of</th>
              <th scope="col">Why it matters</th>
              <th scope="col">Examples</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <tr key={c.key}>
                <td>
                  <b>{c.label}</b>
                  <span className="sub">{c.module}</span>
                </td>
                <td className="num">{c.gaps.toLocaleString("en-US")}</td>
                <td className="num">{c.checked.toLocaleString("en-US")}</td>
                <td>{c.why}</td>
                <td>
                  {c.examples.map((e, i) => (
                    <React.Fragment key={e.id}>
                      {i > 0 ? ", " : ""}
                      <Link href={HREF[c.module](e.id)}>{e.label}</Link>
                    </React.Fragment>
                  ))}
                  {c.gaps > EXAMPLES ? <span className="dim"> and {(c.gaps - EXAMPLES).toLocaleString("en-US")} more</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

const money = (n: number) => usd(n, 2);

/** The three checks that need two sources: each says what it compares, what it found, and what it could not check. */
export function CrossChecks({ h }: { h: HealthRead }) {
  const f = h.fuel;
  const r = h.rateCon;
  const p = h.pings;
  return (
    <Card title="Where two sources should agree">
      <div className="tl-grid cols-3">
        <section aria-label="Fuel card against the load's fuel">
          <h3>Fuel card and the load&apos;s own fuel</h3>
          {!f.hasCardData ? (
            <p className="tl-sub">No fuel card purchases are on the desk, so there is nothing to compare. Connect a fuel card, or import purchases, and this check runs.</p>
          ) : (
            <>
              <p>
                <b>{f.withCard.toLocaleString("en-US")}</b> finished {f.withCard === 1 ? "load has" : "loads have"} a card purchase tied to {f.withCard === 1 ? "it" : "them"}: <b>{f.matched.toLocaleString("en-US")}</b> match the fuel recorded on the load,{" "}
                <b>{f.off.toLocaleString("en-US")}</b> are apart by more than the larger of $25 and a tenth ({money(f.offDollars)} in all), and <b>{f.cardOnly.toLocaleString("en-US")}</b> have a purchase and no fuel recorded ({money(f.cardOnlyDollars)}).
              </p>
              {f.loadOnly > 0 ? <p className="tl-sub">{f.loadOnly.toLocaleString("en-US")} loads record fuel with no card purchase tied to them.</p> : null}
              {f.worst.length > 0 ? (
                <ul className="tl-list">
                  {f.worst.slice(0, 5).map((w) => (
                    <li key={w.id}>
                      <Link href={`/loads/${w.id}`}>{w.label}</Link>: card {money(w.card)}, load {money(w.load)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
          <p className="tl-sub">The card purchase is tied to a load by the truck and the load&apos;s stop times (a day either side), so a purchase near a load&apos;s edge can be tied to the wrong one.</p>
        </section>

        <section aria-label="Rate confirmation against the invoice">
          <h3>Rate confirmation and the invoice</h3>
          {r.invoiced === 0 ? (
            <p className="tl-sub">No finished load has been invoiced in this window.</p>
          ) : (
            <>
              <p>
                <b>{r.checkable.toLocaleString("en-US")}</b> of {r.invoiced.toLocaleString("en-US")} invoiced {r.invoiced === 1 ? "load has" : "loads have"} a rate confirmation on file. <b>{r.matched.toLocaleString("en-US")}</b> were billed what it promised, to the dollar;{" "}
                <b>{r.under.toLocaleString("en-US")}</b> were billed under it ({money(r.underDollars)} in all); <b>{r.over.toLocaleString("en-US")}</b> were billed over the rate and surcharge ({money(r.overDollars)}).
              </p>
              {r.unchecked > 0 ? <p className="tl-sub">{r.unchecked.toLocaleString("en-US")} invoiced loads have no rate confirmation on file, so they cannot be checked.</p> : null}
              {r.worst.length > 0 ? (
                <ul className="tl-list">
                  {r.worst.slice(0, 5).map((w) => (
                    <li key={w.id}>
                      <Link href={`/loads/${w.id}`}>{w.label}</Link>: promised {money(w.promised)}, billed {money(w.billed)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
          <p className="tl-sub">Compared on the line haul and the fuel surcharge. A detention, lumper or layover line is an extra and is left out of the comparison.</p>
        </section>

        <section aria-label="Position pings against billed miles">
          <h3>Truck positions and billed miles</h3>
          {p.trips === 0 ? (
            <p className="tl-sub">No load finished in the last {h.pingDays} days with a truck on it, so there is nothing to measure.</p>
          ) : p.measured === 0 ? (
            <p className="tl-sub">{p.trips.toLocaleString("en-US")} loads finished in the last {h.pingDays} days, none with enough position pings between their first and last arrival to measure.</p>
          ) : (
            <>
              <p>
                Of {p.measured.toLocaleString("en-US")} trips with enough pings, <b>{p.agreed.toLocaleString("en-US")}</b> agree with the billed loaded miles and <b>{p.apart.toLocaleString("en-US")}</b> are apart by more than 30%.
              </p>
              {p.worst.length > 0 ? (
                <ul className="tl-list">
                  {p.worst.slice(0, 5).map((w) => (
                    <li key={w.id}>
                      <Link href={`/loads/${w.id}`}>{w.label}</Link>: billed {Math.round(w.billed).toLocaleString("en-US")} mi, pings {Math.round(w.pings).toLocaleString("en-US")} mi
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
          <p className="tl-sub">
            The desk stores no odometer or ELD mileage, and keeps position pings for {h.pingDays} days, so this is a straight line between pings on loads finished in the last {h.pingDays} days: it can fall short of the road but not run past it. Older loads are not checked.
          </p>
        </section>
      </div>
    </Card>
  );
}

export function HowItWorks() {
  return (
    <details className="kc-how">
      <summary>How this is worked out</summary>
      <p>
        A field counts as filled in when the desk holds a real value for it (miles over zero, a named customer, a typed date). Each check is counted over the items it applies to: a TONU needs no miles, a load with no driver needs no pay figure, a stop is
        checked only on a finished load. A module&apos;s score is the share of its checked fields that are filled in; the headline weights Loads 40%, and Stops, Trucks, Drivers and Trailers 15% each, over the modules that have anything to check. Nothing is
        estimated, and a field the desk cannot tell is never counted as filled in.
      </p>
    </details>
  );
}
