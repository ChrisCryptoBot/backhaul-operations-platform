import Link from "next/link";
import React from "react";
import { Card, PageHead, Stat } from "@/components/desk/ui";
import { dayYear, usd } from "@/lib/desk-format";
import { defaultTaxYear, tinStatusLabel, tinTypeLabel } from "@/lib/form1099";
import { centralParts } from "@/lib/zoned";
import { requirePage } from "@/server/tl/access";
import { contractor1099 } from "@/server/tl/form1099";
import { currentTerminal } from "@/server/tl/terminal";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { workspaceTimezone } from "@/server/tl/zone";

export const metadata = { title: "1099 totals · TrueLane" };

export const dynamic = "force-dynamic";

/**
 * What each contractor was paid in a tax year, for their 1099-NEC: gross compensation (box 1, checked against the threshold) and net cash paid, from the statement rows. Contractors only,
 * paid in the year by the day in the carrier's zone. The legal name, TIN last four and address are billing details: the billing office sees this page.
 */
export default async function Contractor1099Page({ searchParams }: { searchParams?: { year?: string } }) {
  await requirePage("billing_details");
  const zone = await workspaceTimezone(currentWorkspaceId());
  const thisYear = centralParts(Date.now(), zone).y;
  const asked = Number.parseInt(searchParams?.year ?? "", 10);
  const year = Number.isFinite(asked) && asked >= 2000 && asked <= thisYear ? asked : defaultTaxYear(thisYear);
  const terminal = await currentTerminal();
  const r = await contractor1099(year, { terminal });
  const years = [thisYear, thisYear - 1, thisYear - 2, thisYear - 3];

  return (
    <>
      <PageHead title="1099 totals" sub={`What each contractor was paid in ${year}, from their finalized statements, by the day paid in ${r.zone}. W-2 employees are not here: payroll files theirs.`}>
        <Link href="/payroll" className="tl-btn">
          Payroll
        </Link>
        <a className="tl-btn" href={`/export/contractor-1099?year=${year}`}>
          Export CSV
        </a>
      </PageHead>

      <p className="tl-note f1099-note" role="note">
        <b>{r.note}</b> Gross compensation is the pay on the statements before fuel, deductions and advances: the 1099-NEC box 1 figure, and the one checked against the threshold. A negative
        adjustment is money taken off and does not lower it. Net paid is every line, what the statements came to. Only the last four digits of a TIN are kept here; the full number stays with
        the payroll company.
      </p>

      <nav className="tl-form-row f1099-years" aria-label="Tax year">
        {years.map((y) => (
          <Link key={y} href={`/payroll/1099?year=${y}`} className="tl-btn sm" aria-current={y === year ? "true" : undefined}>
            {y}
          </Link>
        ))}
      </nav>

      {terminal && r.hiddenByTerminal > 0 ? (
        <p className="tl-note f1099-note" role="note">
          {r.hiddenByTerminal} paid {r.hiddenByTerminal === 1 ? "statement" : "statements"} hidden by the terminal filter. A 1099 covers everything a contractor was paid: clear the filter before you file.
        </p>
      ) : null}

      <div className="tl-grid cols-4">
        <Stat label="Contractors paid" value={String(r.totals.contractors)} sub={`${r.totals.statements} paid ${r.totals.statements === 1 ? "statement" : "statements"}`} />
        <Stat label={`At or over $${r.threshold.toLocaleString("en-US")}`} value={String(r.totals.over)} sub="need a 1099-NEC" />
        <Stat label="Over, profile incomplete" value={String(r.totals.incompleteOver)} sub="legal name, TIN or address missing" tone={r.totals.incompleteOver > 0 ? "warn" : undefined} />
        <Stat label="Gross compensation" value={usd(r.totals.gross, 2)} sub={`${usd(r.totals.net, 2)} net paid`} />
      </div>

      <Card title={`Contractors · ${year}`} className="tl-card f1099-gap">
        {r.rows.length === 0 ? (
          <p className="tl-note">No contractor was paid on a finalized statement in {year}.</p>
        ) : (
          <table className="tl-table f1099-tbl" aria-label={`Contractor 1099 totals for ${year}`}>
            <thead>
              <tr>
                <th>Legal name</th>
                <th>TIN</th>
                <th>TIN status</th>
                <th>Mailing address</th>
                <th className="num">Statements</th>
                <th className="num">Gross compensation</th>
                <th className="num">Net paid</th>
                <th>1099</th>
              </tr>
            </thead>
            <tbody>
              {r.rows.map((x) => (
                <tr key={x.driverId}>
                  <td>
                    <Link href={`/drivers/${x.driverId}`}>{x.legalName}</Link>
                    {x.legalNameMissing ? <div className="f1099-flag">No legal name set: the desk name is shown</div> : null}
                  </td>
                  <td>{x.tinLast4 ? `${tinTypeLabel(x.tinType) ?? "TIN"} ···${x.tinLast4}` : <span className="dim">—</span>}</td>
                  <td>{tinStatusLabel(x.tinStatus)}</td>
                  <td>{x.address ?? <span className="dim">—</span>}</td>
                  <td className="num">{x.statements}</td>
                  <td className="num">{usd(x.gross, 2)}</td>
                  <td className="num">{usd(x.net, 2)}</td>
                  <td>
                    {x.overThreshold ? (
                      x.gaps.length > 0 ? (
                        <span className="tl-chip warn" title={`Missing: ${x.gaps.join(", ")}`}>
                          Needs one · missing {x.gaps.join(", ")}
                        </span>
                      ) : (
                        <span className="tl-chip ok">Needs one</span>
                      )
                    ) : (
                      <span className="dim">Under the threshold</span>
                    )}
                    {x.rowsDisagree ? <div className="f1099-flag">The statement lines do not add up to the statements&apos; totals. Tell support.</div> : null}
                    {x.unknownKinds.length > 0 ? <div className="f1099-flag">Lines of a kind the 1099 does not know ({x.unknownKinds.join(", ")}) are in net only.</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title={`Finalized, not paid yet · ${r.unpaid.count}`} className="tl-card f1099-gap">
        {r.unpaid.count === 0 ? (
          <p className="tl-note">Every contractor statement finalized by the end of {year} has been paid.</p>
        ) : (
          <>
            <p className="tl-note f1099-note">
              Not in the totals above: a 1099 counts pay when it is paid. {r.unpaid.count} {r.unpaid.count === 1 ? "statement" : "statements"} finalized by the end of {year}, {usd(r.unpaid.total, 2)} in
              all. Mark each paid on its statement (or let payroll pay it) and it counts in the year it was paid.
            </p>
            <table className="tl-table f1099-tbl" aria-label="Finalized statements not paid yet">
              <thead>
                <tr>
                  <th>Statement</th>
                  <th>Driver</th>
                  <th>Finalized</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {r.unpaid.rows.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <Link href={`/settlements/${u.id}`}>{u.number}</Link>
                    </td>
                    <td>
                      <Link href={`/drivers/${u.driverId}`}>{u.driverName}</Link>
                    </td>
                    <td>{dayYear(u.finalizedAt)}</td>
                    <td className="num">{usd(u.total, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>
    </>
  );
}
