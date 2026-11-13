import Link from "next/link";
import React from "react";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { IftaCalcButton, IftaEldMilesButton } from "@/components/desk/data-actions";
import { CanGate } from "@/components/desk/kit/can-gate";
import { EmptyState } from "@/components/desk/kit/states";
import { PageHead, Stat } from "@/components/desk/ui";
import { dateTime, dayYear } from "@/lib/desk-format";
import { IftaFileButton, IftaReopenForm } from "@/components/desk/ifta-filing-panel";
import { daysUntil, RATE_STATE_LABEL, returnDrift, returnMoney, type Blocker, type DriftField } from "@/lib/ifta-return";
import { recentQuarters } from "@/lib/ifta-rates-csv";
import { partnerState, providerName } from "@/server/partners/call";
import { iftaFiling } from "@/server/partners/ifta-filing";
import { iftaQuarterMiles } from "@/server/partners/ifta-mileage";
import { iftaReturn } from "@/server/partners/ifta-return";
import { requirePage } from "@/server/tl/access";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { workspaceTimezone } from "@/server/tl/zone";

export const metadata = { title: "IFTA · TrueLane" };
export const dynamic = "force-dynamic";

const LINES: Column[] = [
  { key: "state", label: "Jurisdiction", group: "Where", sticky: true, width: 150 },
  { key: "miles", label: "Miles", group: "Miles and fuel", align: "num" },
  { key: "taxable", label: "Taxable gal", group: "Miles and fuel", align: "num" },
  { key: "paid", label: "Tax-paid gal", group: "Miles and fuel", align: "num" },
  { key: "net", label: "Net gal", group: "Miles and fuel", align: "num" },
  { key: "rate", label: "Rate", group: "Tax", align: "num" },
  { key: "tax", label: "Tax", group: "Tax", align: "num", accentBand: true },
  { key: "srate", label: "Surcharge rate", group: "Tax", align: "num", priority: 3 },
  { key: "surcharge", label: "Surcharge", group: "Tax", align: "num", accentBand: true },
  { key: "total", label: "Due", group: "Tax", align: "num", accentBand: true }
];

const TRUCKS: Column[] = [
  { key: "truck", label: "Truck", group: "Truck", sticky: true, width: 150 },
  { key: "source", label: "Miles from", group: "Truck" },
  { key: "miles", label: "Miles", group: "The quarter", align: "num" },
  { key: "gallons", label: "Road diesel gal", group: "The quarter", align: "num" },
  { key: "bulk", label: "Of it bulk", group: "The quarter", align: "num" },
  { key: "mpg", label: "Own MPG", group: "The quarter", align: "num" },
  { key: "purchases", label: "Purchases", group: "The quarter", align: "num" }
];

const DRIFT: Column[] = [
  { key: "where", label: "Where", group: "Changed", sticky: true, width: 110 },
  { key: "what", label: "Figure", group: "Changed" },
  { key: "filed", label: "Filed", group: "Numbers", align: "num" },
  { key: "now", label: "Now", group: "Numbers", align: "num" },
  { key: "change", label: "Change", group: "Numbers", align: "num", accentBand: true }
];

const n1 = (s: string | null) => (s == null ? "—" : Number(s).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
const n0 = (s: string | null) => (s == null ? "—" : Number(s).toLocaleString("en-US", { maximumFractionDigits: 0 }));
const trucks = (n: number) => `${n} ${n === 1 ? "truck" : "trucks"}`;

/** Where each blocker is fixed. */
function fixFor(b: Blocker, quarter: string): { href: string; label: string } {
  switch (b.code) {
    case "missing_rate":
    case "sample_rates":
      return { href: `/ifta/rates?quarter=${quarter}`, label: "Tax rates" };
    case "open_flags":
      return { href: "/fuel?flagged=1&days=90", label: "Flagged fuel" };
    case "no_miles":
      return { href: "#ifta-miles", label: "Read or route miles" };
    default:
      return { href: "/fuel?days=90", label: "Fuel" };
  }
}

/**
 * IFTA: the quarter's return (money plan Wave 5 step 7), from one read (server/partners/ifta-return.ts) that the per-truck audit and both CSVs share. Each truck's miles are its ELD miles when the
 * ELD reported it, else its loads routed; fuel is settled road diesel, tax-paid fills credited where they were bought. What stands between this and a return that can be filed is listed at the top,
 * each with where to fix it.
 */
export default async function IftaPage({ searchParams }: { searchParams?: { quarter?: string } }) {
  await requirePage("read");
  const tz = await workspaceTimezone(currentWorkspaceId());
  const options = recentQuarters(new Date(), tz);
  const quarter = options.includes(searchParams?.quarter ?? "") ? searchParams!.quarter! : options[0]!;
  const [r, q, router, eld, filing] = await Promise.all([iftaReturn(quarter), iftaQuarterMiles(quarter), partnerState("ifta"), partnerState("eld"), iftaFiling(quarter)]);
  if (!r.ok) throw new Error(r.error);
  const filed = filing.filed;
  const drift = filed ? returnDrift(filed, r) : null;
  const reopened = filing.history.filter((h) => h.status === "reopened");
  const totalWords = (t: string | null) => (t == null ? "not worked out" : t.startsWith("-") ? `${returnMoney(t.slice(1))} credit` : `${returnMoney(t)} due`);
  const fileBlocked =
    r.blockers.length > 0
      ? "Clear what blocks the return first (listed below)."
      : r.flagsPartial
        ? "The fuel flags could only be read in part."
        : r.rateState === "none"
          ? "Import the quarter's rate table first."
          : r.rateState === "sample"
            ? "Sample rates are never filed."
            : r.total == null
              ? "The return is not fully worked out."
              : null;
  const signed = (d: string | null) => (d == null ? "—" : d.startsWith("-") ? d : `+${d}`);
  const driftRow = (f: DriftField, where: string): Row => ({ id: `${where}-${f.field}`, cells: { where: <b>{where}</b>, what: f.label, filed: f.filed ?? "—", now: f.now ?? "—", change: signed(f.delta) } });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const left = daysUntil(r.dueDate, today);
  const due = r.total == null ? null : Number(r.total);

  const lineRows: Row[] = r.lines.map((l) => ({
    id: l.jurisdiction,
    cells: {
      state: (
        <>
          <b>{l.jurisdiction}</b> <span className="dim">{l.name}</span>
        </>
      ),
      miles: n1(l.miles),
      taxable: n0(l.taxableGallons),
      paid: n0(l.taxPaidGallons),
      net: n0(l.netGallons),
      rate: l.rate ? `$${l.rate}` : <span className="t-st" data-tone="bad">No rate</span>,
      tax: returnMoney(l.tax),
      srate: l.surchargeRate && l.surchargeRate !== "0.0000" ? `$${l.surchargeRate}` : <span className="dim">—</span>,
      surcharge: returnMoney(l.surcharge),
      total: returnMoney(l.total)
    }
  }));
  const truckRows: Row[] = r.trucks.map((t) => ({
    id: t.vehicleId,
    href: `/ifta/trucks/${t.vehicleId}?quarter=${quarter}`,
    cells: {
      truck: <b>{t.name ?? "Unnamed truck"}</b>,
      source: t.method == null ? <span className="dim">No miles</span> : `${t.method === "eld" ? "ELD" : "Routed"} (${providerName(t.source ?? "")})`,
      miles: n1(t.miles),
      gallons: n1(t.gallons),
      bulk: Number(t.bulkGallons) > 0 ? n1(t.bulkGallons) : <span className="dim">—</span>,
      mpg: t.mpg ?? "—",
      purchases: String(t.purchases)
    }
  }));
  const sourceLine = (q?.sources ?? []).map((s) => (s.method === "eld" ? `ELD miles (${providerName(s.source)}) for ${trucks(s.trucks)}` : `routed (${providerName(s.source)}) for ${trucks(s.trucks)}`)).join(" · ");
  const hasEld = (q?.sources ?? []).some((s) => s.method === "eld");
  const hasRouted = (q?.sources ?? []).some((s) => s.method === "routed") || (q?.setAside ?? 0) > 0;
  const notCounted = [
    Number(r.notes.canadaGallons) > 0 ? `${n1(r.notes.canadaGallons)} gallons bought in Canada (gap 15)` : null,
    r.notes.notFuel > 0 ? `${r.notes.notFuel} settled ${r.notes.notFuel === 1 ? "purchase" : "purchases"} of reefer diesel, DEF or other fuel` : null,
    r.notes.notSettled > 0 ? `${r.notes.notSettled} pending, declined or void ${r.notes.notSettled === 1 ? "purchase" : "purchases"}` : null
  ].filter(Boolean);

  return (
    <>
      <PageHead title="IFTA" sub="The quarter's fuel-tax return: miles by state, fuel bought by state, and the tax due or credited in each.">
        <CanGate caps={["bill"]}>
          <a className="tl-btn" href={`/export/ifta?quarter=${quarter}`} aria-disabled={r.lines.length === 0}>Return CSV</a>
          <a className="tl-btn" href={`/export/ifta-audit?quarter=${quarter}`} aria-disabled={r.lines.length === 0}>Audit CSV</a>
          <Link className="tl-btn" href={`/ifta/rates?quarter=${quarter}`}>Tax rates</Link>
        </CanGate>
      </PageHead>
      <div className="tl-tabs ifta-tabs" role="tablist" aria-label="Quarter">
        {options.map((o) => (
          <Link key={o} href={`/ifta?quarter=${o}`} className="tl-tab" aria-current={o === quarter ? "true" : undefined}>
            {o}
          </Link>
        ))}
      </div>
      <div className="tl-grid cols-4">
        <Stat
          label={due != null && due < 0 ? "Credit" : "Due"}
          value={due == null ? "—" : returnMoney(due < 0 ? r.total!.slice(1) : r.total)}
          sub={r.tax != null ? `Tax ${returnMoney(r.tax)} · surcharge ${returnMoney(r.surcharge)}` : r.lines.length > 0 ? "Not worked out: see below" : "No miles or fuel yet"}
          tone={r.blockers.length > 0 ? "warn" : undefined}
        />
        <Stat label="Fleet MPG" value={r.mpg ?? "—"} sub={`${n1(r.miles)} mi ÷ ${n1(r.gallons)} gal road diesel`} />
        <Stat label="Filing due" value={dayYear(new Date(`${r.dueDate}T12:00:00Z`), "UTC")} sub={left < 0 ? `${-left} ${left === -1 ? "day" : "days"} past due` : left === 0 ? "Due today" : `In ${left} ${left === 1 ? "day" : "days"}`} tone={left < 0 ? "bad" : left <= 14 ? "warn" : undefined} />
        <Stat
          label="Tax rates"
          value={RATE_STATE_LABEL[r.rateState]}
          sub={r.rateCount > 0 ? `${r.rateFinal} final of ${r.rateCount}${r.rateSample > 0 ? ", sample, not for filing" : ""}` : "Import the quarter's rate table"}
          tone={r.rateState === "final" ? "ok" : r.rateState === "sample" || r.rateState === "none" ? "bad" : "warn"}
        />
      </div>

      {filed ? (
        <section className="tl-card ifta-filed" aria-label="Filed return">
          <h3>
            Filed {dayYear(filed.filedAt)} by {filed.filedBy}
            {filed.amends ? " (amended)" : ""}: {totalWords(filed.total)}
          </h3>
          <p className="tl-note">
            {filed.lines.length} {filed.lines.length === 1 ? "jurisdiction" : "jurisdictions"}, {n1(filed.miles)} miles, fleet MPG {filed.mpg ?? "—"}; rates {filed.rateState === "final" ? "final" : `${filed.rateState === "mixed" ? "partly final" : "provisional"} (confirmed when filed)`}. Miles, rates and fuel files for this quarter are locked while it is filed.
          </p>
          {drift?.changed ? (
            <>
              <p className="tl-note warn">
                <span className="t-st" data-tone="warn">
                  Changed since filed
                </span>{" "}
                Worked out now, the return is {totalWords(r.total)} against {totalWords(filed.total)} filed. If the change is real, reopen the return and file it again.
              </p>
              <DataTable
                id="ifta-drift"
                label={`What changed since ${quarter} was filed`}
                columns={DRIFT}
                rows={[
                  ...drift.header.map((f) => driftRow(f, "Return")),
                  ...drift.lines.flatMap((l) => (l.kind === "changed" ? l.fields.map((f) => driftRow(f, l.jurisdiction)) : [driftRow({ field: "line", label: l.kind === "added" ? "New since filed" : "Gone since filed", filed: l.kind === "removed" ? (l.fields.find((f) => f.field === "total")?.filed ?? null) : null, now: l.kind === "added" ? (l.fields.find((f) => f.field === "total")?.now ?? null) : null, delta: null }, l.jurisdiction)]))
                ]}
              />
            </>
          ) : (
            <p className="tl-note ok">Unchanged since filed: worked out now, every figure matches what was filed.</p>
          )}
          <div className="ifta-reopen-row">
            <CanGate caps={["bill"]}>
              <IftaReopenForm quarter={quarter} />
            </CanGate>
          </div>
        </section>
      ) : (
        <section className="ifta-tofile" aria-label="File this return">
          {reopened.length > 0 ? <p className="tl-note">Reopened {dayYear(reopened[0]!.reopenedAt!)} by {reopened[0]!.reopenedBy}: {reopened[0]!.reopenReason}. Filing again records an amendment.</p> : null}
          <CanGate caps={["bill"]}>
            <IftaFileButton quarter={quarter} blocked={fileBlocked} provisional={r.rateState === "provisional" || r.rateState === "mixed"} amount={totalWords(r.total)} />
          </CanGate>
        </section>
      )}

      {r.blockers.length > 0 ? (
        <section className="tl-card ifta-blockers" aria-label="Before this return can be filed">
          <h3>Before this return can be filed</h3>
          <ul>
            {r.blockers.map((b) => {
              const fix = fixFor(b, quarter);
              return (
                <li key={b.code}>
                  <span className="t-st" data-tone="bad" />
                  <span>{b.text}</span> <Link href={fix.href}>{fix.label}</Link>
                </li>
              );
            })}
          </ul>
          {r.flagsPartial ? <p className="tl-note">Fuel flags were read from the newest purchases only; there are more than one reading takes.</p> : null}
        </section>
      ) : !filed && r.lines.length > 0 ? (
        <p className="tl-note ok ifta-eld-line">Nothing stands in the way of this return.{r.rateState !== "final" ? " The rates are not all final yet." : ""}</p>
      ) : null}

      <DataTable
        id="ifta-return"
        label={`Return by jurisdiction, ${quarter}`}
        columns={LINES}
        rows={lineRows}
        empty={
          <EmptyState icon="chart" title={`${quarter} has no miles or fuel yet`}>
            Read ELD miles for the trucks your ELD reports and route the rest, below. Fuel comes from the card company or a fuel file on Fuel.
          </EmptyState>
        }
      />

      <section id="ifta-miles" className="ifta-miles">
        <h3>Miles</h3>
        <p className="tl-note">
          {sourceLine ? `${sourceLine}.` : "No miles kept for this quarter."} {q?.syncedAt ? `Last read ${dateTime(q.syncedAt)}.` : null} A truck the ELD reported counts its ELD miles only; any other truck counts its loads routed stop by stop, with the empty runs between them.
        </p>
        {q && q.setAside > 0 ? <p className="tl-note">{trucks(q.setAside)} also {q.setAside === 1 ? "has" : "have"} routed miles, set aside: the ELD reported {q.setAside === 1 ? "it" : "them"}.</p> : null}
        <CanGate caps={["bill"]}>
          <div className="ifta-actions">
            <IftaEldMilesButton quarter={quarter} reason={eld.reason} again={hasEld} />
            <IftaCalcButton quarter={quarter} reason={router.reason} again={hasRouted} />
          </div>
        </CanGate>
      </section>

      <DataTable id="ifta-trucks" label={`Trucks, ${quarter}`} columns={TRUCKS} rows={truckRows} empty={<EmptyState icon="trucks" title="No truck has miles or fuel this quarter" />} />

      <p className="tl-note ifta-eld-line">
        {notCounted.length > 0 ? `Not on the return: ${notCounted.join("; ")}. ` : null}Fleet MPG is all miles over all settled road diesel, bulk included; tax-paid fills are credited where they were bought. Rounded as one rule: MPG to two places, gallons whole, money to the cent per jurisdiction, then added. Confirm with an accountant before filing.
      </p>
    </>
  );
}
