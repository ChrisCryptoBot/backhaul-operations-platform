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
  { key: "cost", title: "Burned running empty", note: "Miles driven with nothing on, at the truck's own floor." },
  { key: "lens", title: "Another way to see the same dollars", note: "Not added to the total: it already contains the empty miles above." }
];

const money = (n: number) => usd(n, 2);
const sub = (l: LedgerLine) => `${l.items} ${l.items === 1 ? "item" : "items"}${l.unpriced > 0 ? `, ${l.unpriced} not priced` : ""}`;

export function LeakHero({ ledger }: { ledger: LeakLedger }) {
  const c = ledger.current;
  const p = ledger.prior;
  const groupSum = (g: LeakGroup) => c.lines.filter((l) => l.group === g && l.counted).reduce((s, l) => s + l.dollars, 0);
  const groupItems = (g: LeakGroup) => c.lines.filter((l) => l.group === g && l.counted).reduce((s, l) => s + l.items, 0);
  const tipOf = (title: string, rows: Array<[string, string]>, note?: string): TipData => ({ title, sub: windowLabel(ledger.window), rows, note });
  const delta = deltaOf(c.total, p?.total, { kind: "pct", lowerIsBetter: true });
  const cells: Array<{ label: string; value: string; sub: string; tip: TipData }> = [
    { label: "Owed and not billed", value: money(groupSum("billed_miss")), sub: `${groupItems("billed_miss")} items`, tip: tipOf("Owed and not billed", c.lines.filter((l) => l.group === "billed_miss").map((l): [string, string] => [l.label, money(l.dollars)])) },
    { label: "Given up on purpose", value: money(groupSum("choice")), sub: `${groupItems("choice")} items`, tip: tipOf("Given up on purpose", c.lines.filter((l) => l.group === "choice").map((l): [string, string] => [l.label, money(l.dollars)])) },
    { label: "Burned running empty", value: money(groupSum("cost")), sub: `${groupItems("cost")} loads${c.lines.find((l) => l.key === "empty_miles")!.unpriced > 0 ? `, ${c.lines.find((l) => l.key === "empty_miles")!.unpriced} not priced` : ""}`, tip: tipOf("Burned running empty", [["Empty-mile cost", money(groupSum("cost"))]], "At the floor frozen on each load when it was accepted, before fuel.") },
    { label: "Sitting right now", value: money(ledger.openDwell.dollars), sub: `${ledger.openDwell.trailers} ${ledger.openDwell.trailers === 1 ? "trailer" : "trailers"} past free time`, tip: tipOf("Sitting right now", ledger.openDwell.rows.slice(0, 5).map((r): [string, string] => [r.number, money(r.owed)]), "Trailer dwell owed today. Not in the weeks: it has no date until it is billed or given up.") }
  ];
  return (
    <section aria-label="Headline numbers">
      <Tip as="div" focusable className="km-hero" tip={tipOf("Leaked in the period", c.lines.filter((l) => l.counted).map((l): [string, string] => [l.label, money(l.dollars)]), "The counted lines added together. The below-floor lens is not in it.")}>
        <div className="km-label">Leaked this period</div>
        <div className="km-herorow">
          <span className="km-big">{usd(c.total)}</span>
          <DeltaChip delta={delta} title={p ? `Against ${windowLabel(ledger.previous)}: ${money(p.total)}` : undefined} />
        </div>
        <div className="km-sub">
          {c.items} {c.items === 1 ? "item" : "items"} in five lines{c.unpriced > 0 ? `, ${c.unpriced} that could not be priced and are not in the dollars` : ""}
          {p ? ` · ${money(p.total)} in the period before` : ""}
        </div>
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
          const lines = ledger.current.lines.filter((l) => l.group === g.key);
          return (
            <tbody key={g.key}>
              <tr>
                <th colSpan={5} scope="colgroup" style={{ textAlign: "left", paddingTop: 14 }}>
                  {g.title} <span className="tl-sub" style={{ fontWeight: 400 }}>· {g.note}</span>
                </th>
              </tr>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td>
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
        </tfoot>
      </table>
    </Card>
  );
}

/** Twelve trailing weeks, one column per counted line. */
export function LeakWeeks({ ledger }: { ledger: LeakLedger }) {
  const cols = LEAKS.filter((l) => l.counted);
  const max = Math.max(0, ...ledger.weeks.map((w) => w.total));
  return (
    <Card title="Twelve weeks">
      <table className="tl-table" aria-label="Leaks by week">
        <thead>
          <tr>
            <th>Week ending</th>
            {cols.map((c) => (
              <th key={c.key} className="num">{c.label}</th>
            ))}
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
              <th className="num">Items</th>
              <th className="num">Not priced</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td>{hrefOf ? <Link href={hrefOf(r.name)}>{r.name}</Link> : r.name}</td>
                <td className="num">{money(r.dollars)}</td>
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
              <th className="num">Dollars</th>
            </tr>
          </thead>
          <tbody>
            {ledger.top.map((t, i) => (
              <tr key={`${t.key}:${t.loadId ?? t.label}:${i}`}>
                <td>{shortDate(new Date(t.at))}</td>
                <td>{leakMeta(t.key).label}</td>
                <td>{t.loadId ? <Link href={`/loads/${t.loadId}`}>{t.label}</Link> : t.label}</td>
                <td>{t.lane ?? <span className="dim">—</span>}</td>
                <td>{t.customer ?? <span className="dim">—</span>}</td>
                <td>{t.truck ?? <span className="dim">—</span>}</td>
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
