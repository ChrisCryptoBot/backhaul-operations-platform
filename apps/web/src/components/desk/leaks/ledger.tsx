import Link from "next/link";
import React from "react";
import { deltaOf } from "@/lib/kpi-view";
import { windowLabel } from "@/lib/kpi-periods";
import { LEAKS, leakMeta, type DrillRow, type LeakGroup, type LeakLedger, type LedgerLine } from "@/lib/leaks";
import { shortDate, usd } from "@/lib/desk-format";
import { Card } from "../ui";
import { Tip, type TipData } from "../kit/tooltip";
import { DeltaChip } from "../kpi/parts";

/**
 * The Leak Ledger's screen, in pieces. Every number is the ledger's (lib/leaks.ts), shown with the basis it was worked out on; an item that could not be priced is said to be unpriced rather than given a
 * dollar figure, and the lens that overlaps another line is shown apart and never added to the total.
 */
const GROUPS: Array<{ key: LeakGroup; title: string; note: string }> = [
  { key: "billed_miss", title: "Owed and not billed", note: "Work the desk says is owed and no invoice carries." },
  { key: "choice", title: "Given up on purpose", note: "A person decided not to bill it; the reason is in the audit log." },
  { key: "cost", title: "Burned running empty", note: "Miles driven with nothing on: at the truck's own floor frozen on the load, or for an imported load at the cost a mile given at intake." },
  { key: "money", title: "Cost of money and partner records", note: "Fees for being paid early (a cost, never taken off gross), fuel bought with no card discount, IFTA filed high; chargebacks shown, not added." },
  { key: "lens", title: "Another way to see the same dollars", note: "Not added to the total: it already contains the empty miles above." }
];

const money = (n: number) => usd(n, 2);
const sub = (l: LedgerLine) => `${l.items} ${l.items === 1 ? "item" : "items"}${l.unpriced > 0 ? `, ${l.unpriced} not priced` : ""}`;

export function LeakHero({ ledger }: { ledger: LeakLedger }) {
  const c = ledger.current;
  const p = ledger.prior;
  const groupSum = (g: LeakGroup) => c.lines.filter((l) => l.group === g && l.counted).reduce((s, l) => s + l.dollars, 0);
  const groupItems = (g: LeakGroup) => c.lines.filter((l) => l.group === g && l.counted).reduce((s, l) => s + l.items, 0);
  const emptyUnpriced = c.lines.filter((l) => l.group === "cost").reduce((s, l) => s + l.unpriced, 0);
  const tipOf = (title: string, rows: Array<[string, string]>, note?: string): TipData => ({ title, sub: windowLabel(ledger.window), rows, note });
  const delta = deltaOf(c.total, p?.total, { kind: "pct", lowerIsBetter: true });
  const cells: Array<{ label: string; value: string; sub: string; tip: TipData }> = [
    { label: "Owed and not billed", value: money(groupSum("billed_miss")), sub: `${groupItems("billed_miss")} items`, tip: tipOf("Owed and not billed", c.lines.filter((l) => l.group === "billed_miss").map((l): [string, string] => [l.label, money(l.dollars)])) },
    { label: "Given up on purpose", value: money(groupSum("choice")), sub: `${groupItems("choice")} items`, tip: tipOf("Given up on purpose", c.lines.filter((l) => l.group === "choice").map((l): [string, string] => [l.label, money(l.dollars)])) },
    {
      label: "Burned running empty",
      value: money(groupSum("cost")),
      sub: `${groupItems("cost")} loads${emptyUnpriced > 0 ? `, ${emptyUnpriced} not priced` : ""}`,
      tip: tipOf("Burned running empty", c.lines.filter((l) => l.group === "cost" && (!l.intake || l.items > 0)).map((l): [string, string] => [l.label, money(l.dollars)]), "Before fuel. At the floor frozen on each load when it was accepted, or for an imported load at the cost a mile given at intake.")
    },
    { label: "Sitting right now", value: money(ledger.openDwell.dollars), sub: `${ledger.openDwell.trailers} ${ledger.openDwell.trailers === 1 ? "trailer" : "trailers"} past free time`, tip: tipOf("Sitting right now", ledger.openDwell.rows.slice(0, 5).map((r): [string, string] => [r.number, money(r.owed)]), "Trailer dwell owed today. Not in the weeks: it has no date until it is billed or given up.") }
  ];
  return (
    <section aria-label="Headline numbers">
      <Tip as="div" focusable className="km-hero" tip={tipOf("Leaked in the period", c.lines.filter((l) => l.counted).map((l): [string, string] => [l.label, money(l.dollars)]), "The counted lines added together. The below-floor lens and factor chargebacks are not in it.")}>
        <div className="km-label">Leaked this period</div>
        <div className="km-herorow">
          <span className="km-big">{usd(c.total)}</span>
          <DeltaChip delta={delta} title={p ? `Against ${windowLabel(ledger.previous)}: ${money(p.total)}` : undefined} />
        </div>
        <div className="km-sub">
          {c.items} {c.items === 1 ? "item" : "items"} in {c.lines.filter((l) => l.counted && (!l.intake || l.items > 0)).length} lines{c.unpriced > 0 ? `, ${c.unpriced} that could not be priced and are not in the dollars` : ""}
          {p ? ` · ${money(p.total)} in the period before` : ""}
        </div>
        {c.money.items > 0 ? (
          <div className="km-sub" data-testid="money-share">
            {money(c.money.dollars)} of it is cost of money and partner records ({c.money.items} {c.money.items === 1 ? "item" : "items"}
            {c.money.unpriced > 0 ? `, ${c.money.unpriced} not priced` : ""}).
          </div>
        ) : null}
        {c.intake.items > 0 ? (
          <div className="km-sub" data-testid="intake-share">
            {money(c.intake.dollars)} of it is priced from the intake you gave, <b>not frozen at booking</b> ({c.intake.items} {c.intake.items === 1 ? "item" : "items"}
            {c.intake.unpriced > 0 ? `, ${c.intake.unpriced} not priced` : ""}). The rest rests on figures frozen on each load or recorded on it.
          </div>
        ) : null}
      </Tip>
      <div className="km km-4">
        {cells.map((cell) => (
          <Tip as="div" focusable className="km-cell" key={cell.label} tip={cell.tip}>
            <div className="km-label">{cell.label}</div>
            <div className="km-value">{cell.value}</div>
            <div className="km-foot">
              <span className="km-sub">{cell.sub}</span>
            </div>
          </Tip>
        ))}
      </div>
    </section>
  );
}

/** Each leak with its dollars, how many items stand behind it, and the basis it is worked out on. */
export function LeakLines({ ledger }: { ledger: LeakLedger }) {
  const prior = new Map(ledger.prior?.lines.map((l) => [l.key, l]) ?? []);
  return (
    <Card title="By leak">
      <table className="tl-table" aria-label="Leaks by line">
        <thead>
          <tr>
            <th>Leak</th>
            <th className="num">Dollars</th>
            <th>Against the period before</th>
            <th className="num">Items</th>
            <th className="num">Not priced</th>
          </tr>
        </thead>
        {GROUPS.map((g) => {
          // An intake line with nothing behind it is left off the screen (a desk with no imported loads never sees it); it is in the files, with its basis, either way.
          const lines = ledger.current.lines.filter((l) => l.group === g.key && (!l.intake || l.items > 0));
          return (
            <tbody key={g.key}>
              <tr>
                <th colSpan={5} scope="colgroup" style={{ textAlign: "left", paddingTop: 14 }}>
                  {g.title} <span className="tl-sub" style={{ fontWeight: 400 }}>· {g.note}</span>
                </th>
              </tr>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td data-intake={l.intake ? "true" : undefined}>
                    <div>{l.label}</div>
                    <div className="tl-sub" style={{ maxWidth: "70ch" }}>{l.basis}</div>
                  </td>
                  <td className="num">{l.counted ? money(l.dollars) : <span title="Not added to the total">{money(l.dollars)}</span>}</td>
                  <td>{ledger.prior ? <DeltaChip delta={deltaOf(l.dollars, prior.get(l.key)?.dollars, { kind: "pct", lowerIsBetter: true })} title={`Before: ${money(prior.get(l.key)?.dollars ?? 0)}`} /> : <span className="dim">—</span>}</td>
                  <td className="num">{l.items}</td>
                  <td className="num">
                    {l.unpriced > 0 ? (
                      <span title={leakMeta(l.key).unpricedWhy}>
                        {l.unpriced}
                        {l.unpricedMiles > 0 ? ` (${Math.round(l.unpricedMiles).toLocaleString("en-US")} mi)` : ""}
                      </span>
                    ) : (
                      <span className="dim">0</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          );
        })}
        <tfoot>
          <tr>
            <th scope="row">Total counted</th>
            <td className="num">
              <b>{money(ledger.current.total)}</b>
            </td>
            <td />
            <td className="num">{ledger.current.items}</td>
            <td className="num">{ledger.current.unpriced}</td>
          </tr>
          {ledger.current.intake.items > 0 ? (
            <tr>
              <th scope="row" className="tl-sub" style={{ fontWeight: 400 }}>of which priced from the intake, not frozen at booking</th>
              <td className="num tl-sub">{money(ledger.current.intake.dollars)}</td>
              <td />
              <td className="num tl-sub">{ledger.current.intake.items}</td>
              <td className="num tl-sub">{ledger.current.intake.unpriced}</td>
            </tr>
          ) : null}
        </tfoot>
      </table>
      {ledger.fleetOnly.items > 0 ? (
        <p className="tl-sub" data-testid="fleet-only">
          {ledger.fleetOnly.items} partner {ledger.fleetOnly.items === 1 ? "record" : "records"} in this period belong to the whole fleet, not to the terminals in view (an invoice whose loads span terminals or that has none, fuel on no truck or on a truck with no terminal,
          an IFTA return), so {ledger.fleetOnly.items === 1 ? "it is" : "they are"} left out of these figures. Choose all terminals to see {ledger.fleetOnly.items === 1 ? "it" : "them"}.
        </p>
      ) : null}
    </Card>
  );
}

/** Twelve trailing weeks, one column per counted line. */
export function LeakWeeks({ ledger }: { ledger: LeakLedger }) {
  // The intake's columns appear only when a week has dollars in them, so a desk with no imported loads sees the same table as before.
  // The partner lines share one column (the files keep a column each), shown when a week has any.
  const cols = LEAKS.filter((l) => l.counted && l.group !== "money" && (!l.intake || ledger.weeks.some((w) => w.byKey[l.key] > 0)));
  const moneyCol = ledger.weeks.some((w) => w.money > 0);
  const max = Math.max(0, ...ledger.weeks.map((w) => w.total));
  return (
    <Card title="Twelve weeks">
      <table className="tl-table" aria-label="Leaks by week">
        <thead>
          <tr>
            <th>Week ending</th>
            {cols.map((c) => (
              <th key={c.key} className="num" title={c.label}>
                {c.intake ? c.label.replace(/ \(.*\)$/, "") : c.label}
                {c.intake ? <span className="tl-sub" style={{ display: "block", fontWeight: 400 }}>at the intake</span> : null}
              </th>
            ))}
            {moneyCol ? (
              <th className="num" title="Factoring fees, quick-pay and factor fees taken short, and IFTA filed high, added together">
                Cost of money
              </th>
            ) : null}
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {[...ledger.weeks].reverse().map((w) => (
            <tr key={w.end}>
              <td>{w.label}</td>
              {cols.map((c) => (
                <td key={c.key} className="num">{w.byKey[c.key] > 0 ? money(w.byKey[c.key]) : <span className="dim">—</span>}</td>
              ))}
              {moneyCol ? <td className="num">{w.money > 0 ? money(w.money) : <span className="dim">—</span>}</td> : null}
              <td className="num">
                <b>{w.total > 0 ? money(w.total) : "—"}</b>
                {max > 0 ? <span className="lk-bar" aria-hidden="true" style={{ display: "inline-block", marginLeft: 8, width: `${Math.round((w.total / max) * 48)}px`, height: 6, background: "var(--label)" }} /> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="tl-note" style={{ marginTop: 10 }}>
        Each week is seven days ending on its date. Detention and TONU are shown as of now: once one is billed it leaves the ledger, so older weeks shrink as the desk gets paid. Dwell waived or lowered counts from the day the audit log began recording it.
      </p>
    </Card>
  );
}

function DrillTable({ title, rows, label, hrefOf }: { title: string; rows: DrillRow[]; label: string; hrefOf?: (name: string) => string }) {
  // A column for the part priced from the intake appears only when some row has one, so a lane's dollars are never read as all resting on frozen figures.
  const anyIntake = rows.some((r) => r.intake > 0);
  return (
    <Card title={title}>
      {rows.length === 0 ? (
        <p className="tl-note">Nothing in this period.</p>
      ) : (
        <table className="tl-table" aria-label={title}>
          <thead>
            <tr>
              <th>{label}</th>
              <th className="num">Dollars</th>
              {anyIntake ? <th className="num" title="The part of the dollars priced from the intake, not frozen at booking">At the intake</th> : null}
              <th className="num">Items</th>
              <th className="num">Not priced</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td>{hrefOf ? <Link href={hrefOf(r.name)}>{r.name}</Link> : r.name}</td>
                <td className="num">{money(r.dollars)}</td>
                {anyIntake ? <td className="num">{r.intake > 0 ? money(r.intake) : <span className="dim">—</span>}</td> : null}
                <td className="num">{r.items}</td>
                <td className="num">{r.unpriced > 0 ? r.unpriced : <span className="dim">0</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export function LeakDrills({ ledger }: { ledger: LeakLedger }) {
  return (
    <>
      <div className="tl-grid cols-2">
        <DrillTable title="Lanes" label="Lane" rows={ledger.byLane} hrefOf={(n) => `/lanes/detail?lane=${encodeURIComponent(n)}`} />
        <DrillTable title="Customers" label="Customer" rows={ledger.byCustomer} />
      </div>
      <DrillTable title="Trucks" label="Truck" rows={ledger.byTruck} />
    </>
  );
}

/** The biggest single items, each a load to open. */
export function LeakTop({ ledger }: { ledger: LeakLedger }) {
  return (
    <Card title="The biggest items">
      {ledger.top.length === 0 ? (
        <p className="tl-note">Nothing priced in this period.</p>
      ) : (
        <table className="tl-table" aria-label="Biggest leaks">
          <thead>
            <tr>
              <th>When</th>
              <th>Leak</th>
              <th>Load or trailer</th>
              <th>Lane</th>
              <th>Customer</th>
              <th>Truck</th>
              <th>Priced at</th>
              <th className="num">Dollars</th>
            </tr>
          </thead>
          <tbody>
            {ledger.top.map((t, i) => (
              <tr key={`${t.key}:${t.loadId ?? t.label}:${i}`}>
                <td>{shortDate(new Date(t.at))}</td>
                <td>{leakMeta(t.key).label}</td>
                <td>{t.href ? <Link href={t.href}>{t.label}</Link> : t.loadId ? <Link href={`/loads/${t.loadId}`}>{t.label}</Link> : t.label}</td>
                <td>{t.lane ?? <span className="dim">—</span>}</td>
                <td>{t.customer ?? <span className="dim">—</span>}</td>
                <td>{t.truck ?? <span className="dim">—</span>}</td>
                <td className="tl-sub" style={{ maxWidth: "34ch" }}>{t.basisNote ?? <span className="dim">{t.intake ? "intake" : t.partner ? "partner record" : "frozen on the load, or recorded"}</span>}</td>
                <td className="num">{money(t.dollars)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/** Trailers past their free time right now: owed today, not yet a dated leak. */
export function LeakOpenDwell({ ledger }: { ledger: LeakLedger }) {
  const o = ledger.openDwell;
  return (
    <Card title="Sitting right now">
      {o.trailers === 0 ? (
        <p className="tl-note">No dropped trailer is past its free time with a fee owing.</p>
      ) : (
        <>
          <table className="tl-table" aria-label="Trailers owing dwell">
            <thead>
              <tr>
                <th>Trailer</th>
                <th>Dropped</th>
                <th className="num">Owed today</th>
              </tr>
            </thead>
            <tbody>
              {o.rows.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/trailers/${r.id}`}>{r.number}</Link></td>
                  <td>{shortDate(new Date(r.sinceMs))}</td>
                  <td className="num">{money(r.owed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="tl-note" style={{ marginTop: 10 }}>
            {o.trailers > o.rows.length ? `The ${o.rows.length} largest of ${o.trailers} trailers, ` : `${o.trailers} ${o.trailers === 1 ? "trailer" : "trailers"}, `}
            {money(o.dollars)} owed at the company&apos;s terms or the figure a person set. This grows each day until it is billed or given up, so it is shown apart from the weeks.
          </p>
        </>
      )}
    </Card>
  );
}

/**
 * What the ledger counted and could not price, apart from the dollars: items whose figure was missing (a truck with no frozen floor and no intake cost a mile, a wait with no rate), and imported loads
 * whose file carried no stop times, which cannot be checked for detention at all. Nothing here is estimated.
 */
export function LeakUnpriced({ ledger }: { ledger: LeakLedger }) {
  const lines = ledger.current.lines.filter((l) => l.counted && l.unpriced > 0);
  const cov = ledger.coverage;
  if (lines.length === 0 && cov.noStopTimes.loads === 0) return null;
  return (
    <Card title="Counted, not priced">
      <table className="tl-table" aria-label="Counted and not priced">
        <thead>
          <tr>
            <th>What</th>
            <th className="num">Count</th>
            <th>Why it has no dollars</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.key}>
              <td>{l.label}</td>
              <td className="num">
                {l.unpriced}
                {l.unpricedMiles > 0 ? ` (${Math.round(l.unpricedMiles).toLocaleString("en-US")} mi)` : ""}
              </td>
              <td className="tl-sub">
                {leakMeta(l.key).unpricedWhy}
                {l.intake ? (
                  <>
                    {" "}
                    · <Link href="/leaks/intake">Set the intake</Link>
                  </>
                ) : null}
              </td>
            </tr>
          ))}
          {cov.noStopTimes.loads > 0 ? (
            <tr>
              <td>Imported loads that could not be checked for detention</td>
              <td className="num">
                {cov.noStopTimes.loads} of {cov.importedLoads}
              </td>
              <td className="tl-sub">
                Their file carried no arrival and departure at a stop, so there is no wait to price and none is estimated. Import the file again with the stop-time columns matched to price them.{" "}
                {cov.noStopTimes.sample.map((s, i) => (
                  <React.Fragment key={s.loadId}>
                    {i > 0 ? ", " : ""}
                    <Link href={`/loads/${s.loadId}`}>{s.label}</Link>
                  </React.Fragment>
                ))}
                {cov.noStopTimes.loads > cov.noStopTimes.sample.length ? `, and ${cov.noStopTimes.loads - cov.noStopTimes.sample.length} more` : ""}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </Card>
  );
}
