import Link from "next/link";
import { notFound } from "next/navigation";
import React from "react";
import { getTrailerDetail, valuesOf } from "@/server/tl/trailers";
import { listEntityAudit } from "@/server/tl/audit";
import { getThresholds } from "@/server/tl/thresholds";
import { Card, PageHead, StatusChip } from "@/components/desk/ui";
import { HookTrailer, TrailerForm, TrailerRowActions } from "@/components/desk/trailer-forms";
import { ACTION_LABEL } from "@/lib/audit-diff";
import { alertThresholds } from "@/lib/thresholds";
import { complianceState, statusLabel, trailerBlocker, trailerClearanceSoon } from "@/lib/trailer-clearance";
import { OWNERSHIPS } from "@/lib/trailer-forms";
import { trailerLabel } from "@/truelane/constants/trailerData";
import { dateTime, shortDate } from "@/lib/desk-format";
import { CanGate } from "@/components/desk/kit/can-gate";
import { DwellAdjust, DwellLine } from "@/components/desk/dwell";
import { dwell } from "@/lib/telematics";
import { numOrNull } from "@/server/tl/convert";

export const dynamic = "force-dynamic";

/** One trailer: whether it can go out, which tractor pulls it, what it is on now, its details, and every change to it (found by its id). */
export default async function TrailerPage({ params }: { params: { id: string } }) {
  const t = await getTrailerDetail(params.id);
  if (!t) notFound();
  const now = new Date();
  const company = await getThresholds();
  const days = alertThresholds(company).clearanceDays;
  // Dwell: how long it has sat since it was dropped and what that owes. The company's terms are the start; a typed figure for this stay always wins.
  const typed = { rate: numOrNull(t.dwellRateOverride), days: numOrNull(t.dwellDaysOverride), waived: t.dwellWaived, by: t.dwellOverrideBy, note: t.dwellOverrideNote };
  const stay = t.currentVehicleId ? null : dwell(t.unhookedAt, now.getTime(), { freeHours: company.dwellFreeHours, perDay: company.dwellPerDayRate }, t.loads.length > 0, { ratePerDay: typed.rate, billableDays: typed.days, waived: typed.waived });
  const blocker = trailerBlocker(t, now);
  const soon = trailerClearanceSoon(t, now, days);
  const state = complianceState(t, now, days);
  const history = await listEntityAudit(t.id, 12);
  const open = t.loads.length;
  const when = (d: Date | null) => (d ? shortDate(d) : "Not set");

  return (
    <>
      <PageHead title={t.number} sub={`${t.type ? trailerLabel(t.type) : "No type set"} · ${OWNERSHIPS.find((o) => o.key === t.ownership)?.label ?? t.ownership}${t.archivedAt ? " · archived" : ""} · ${open} open ${open === 1 ? "load" : "loads"}`}>
        <Link href="/trailers" className="tl-btn">All trailers</Link>
        <CanGate caps={["dispatch"]}>
          <TrailerRowActions hideOpen trailer={{ id: t.id, number: t.number, archived: t.archivedAt != null, open }} />
        </CanGate>
      </PageHead>

      <section className="tk-hero" aria-label="Can it go out">
        <div>
          <div className="tk-label">Can it go out?</div>
          <div className="qt-big">{t.archivedAt ? "Archived" : blocker ? "No" : soon ? "Yes, soon due" : "Yes"}</div>
          <p className="tl-sub" style={{ marginTop: 6 }}>
            {t.archivedAt ? "Restore it to put it on loads." : blocker ? `${blocker}. It is kept off loads until that changes.` : soon ? `Its ${soon.what} lapses in ${soon.inDays} ${soon.inDays === 1 ? "day" : "days"}.` : "Nothing lapsed or due."}
          </p>
        </div>
        <dl className="tk-facts">
          <div>
            <dt>Status</dt>
            <dd>{statusLabel(t.status)}</dd>
          </div>
          <div>
            <dt>Registration</dt>
            <dd className={t.registrationExpiry && t.registrationExpiry.getTime() < now.getTime() ? "tone-neg" : undefined}>{when(t.registrationExpiry)}</dd>
          </div>
          <div>
            <dt>Inspection</dt>
            <dd className={t.inspectionExpiry && t.inspectionExpiry.getTime() < now.getTime() ? "tone-neg" : undefined}>{when(t.inspectionExpiry)}</dd>
          </div>
          <div>
            <dt>Papers</dt>
            <dd>{state === "lapsed" ? "Lapsed" : state === "soon" ? "Due soon" : "Good"}</dd>
          </div>
        </dl>
      </section>

      {stay ? (
        <Card title="Dwell">
          <DwellLine d={stay} freeHours={company.dwellFreeHours} typed={typed} />
          <CanGate caps={["dispatch", "bill"]}>
            <DwellAdjust trailerId={t.id} number={t.number} d={stay} typed={typed} freeHours={company.dwellFreeHours} />
          </CanGate>
          <p className="tl-note" style={{ marginTop: 10 }}>A trailer dropped for longer than the free time with nothing booked for it is a dwell alert. The company sets the terms in Settings, Rules; a dispatcher or billing person can change the rate or the days, or waive the fee, for this stay.</p>
        </Card>
      ) : null}

      <Card title="Hooked to">
        {t.archivedAt ? <p className="tl-note">An archived trailer is not hooked to anything.</p> : <CanGate caps={["dispatch"]}><HookTrailer trailerId={t.id} tractor={t.currentVehicle} /></CanGate>}
        <p className="tl-note" style={{ marginTop: 10 }}>A tractor pulls one trailer at a time. Where it is: {t.location ?? "not set"}{t.terminal ? ` · ${t.terminal} terminal` : ""}.</p>
      </Card>

      <details className="qt-more" open={!t.type || undefined}>
        <summary>Details</summary>
        <CanGate caps={["dispatch"]} banner who="A dispatcher" what="this trailer">
          <TrailerForm inline trailer={{ id: t.id, ...valuesOf(t) }} />
        </CanGate>
      </details>

      <div className="tl-grid cols-2" style={{ marginTop: 14 }}>
        <Card title={`On this trailer now · ${open}`}>
          {open === 0 ? (
            <p className="tl-note">No open loads.</p>
          ) : (
            <table className="tl-table" aria-label="Open loads">
              <tbody>
                {t.loads.map((l) => (
                  <tr key={l.id}>
                    <td><Link href={`/loads/${l.id}`}>{l.loadNumber}</Link></td>
                    <td>{l.originAddress?.split(",")[0]} → {l.destinationAddress?.split(",")[0]}</td>
                    <td>{shortDate(l.scheduledDate)}</td>
                    <td><StatusChip status={l.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Changes">
          {history.length === 0 ? (
            <p className="tl-note">Nothing has been changed on this trailer yet.</p>
          ) : (
            <ul className="feed">
              {history.map((e) => (
                <li key={e.id}>
                  <div><b>{ACTION_LABEL[e.action] ?? e.action}</b> · {e.summary}</div>
                  <div className="t">{dateTime(e.createdAt)} · {e.actor}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
