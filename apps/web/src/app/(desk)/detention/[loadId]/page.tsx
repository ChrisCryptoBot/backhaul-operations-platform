import Link from "next/link";
import { notFound } from "next/navigation";
import React from "react";
import { DocHead } from "@/components/desk/doc-head";
import { EvidenceDecide } from "@/components/desk/detention/evidence-decide";
import { CanGate } from "@/components/desk/kit/can-gate";
import { PrintButton } from "@/components/desk/kpi/print-button";
import { dateTime, usd } from "@/lib/desk-format";
import { EVIDENCE_RADIUS_MILES, QUALITY_WORDS, type KeptFix } from "@/lib/detention-evidence";
import { requirePage } from "@/server/tl/access";
import { getCompany } from "@/server/tl/company";
import { getEvidencePack, type PackStop } from "@/server/tl/detention-evidence";

export const metadata = { title: "Detention evidence · TrueLane" };
export const dynamic = "force-dynamic";

const money = (n: number) => usd(n, 2);
const waitText = (m: number | null) => (m == null ? "—" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);
const ROLE: Record<string, string> = { pickup: "Pickup", delivery: "Delivery" };
const sentence = (t: string) => {
  const s = t.trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** The fixes worth printing: every one inside the radius and two either side, so the arrival and the departure can be read off the page. The rest are kept (and counted). */
function shownFixes(fixes: readonly KeptFix[], radius: number): { rows: KeptFix[]; more: number } {
  const keep = new Set<number>();
  fixes.forEach((f, i) => {
    if (f.miles <= radius) for (const j of [i - 2, i - 1, i, i + 1, i + 2]) if (j >= 0 && j < fixes.length) keep.add(j);
  });
  const rows = fixes.filter((_, i) => keep.has(i));
  return { rows, more: fixes.length - rows.length };
}

/**
 * The detention evidence pack for one load, on a sheet that prints cleanly or saves as a PDF: for each stop what the truck's own track showed (first seen at the facility, last seen, the fixes behind both), the
 * appointment, what the wait is worth past the free time, and what a person decided. The evidence was frozen when the load was delivered, so it stands after the position fixes are deleted; the hash at the foot says
 * whether it has been touched since. A proposal changes nothing on the load until a person confirms it.
 */
export default async function DetentionEvidencePage({ params }: { params: { loadId: string } }) {
  await requirePage("dispatch", "bill", "figures");
  const [pack, company] = await Promise.all([getEvidencePack(params.loadId), getCompany()]);
  if (!pack) notFound();
  const withEvidence = pack.stops.filter((s) => s.evidence);
  const live = withEvidence.filter((s) => s.evidence!.state !== "dismissed");
  const worth = live.reduce((sum, s) => sum + Math.round((s.evidence!.worth?.amount ?? 0) * 100), 0) / 100;
  const pending = withEvidence.filter((s) => s.evidence!.state === "proposed").length;
  const tz = pack.tz;
  const rate = pack.terms.ratePerHour;

  return (
    <>
      <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <Link href={`/loads/${pack.load.id}`} className="tl-btn">Back to the load</Link>
        <PrintButton documentTitle={`Detention evidence ${pack.load.loadNumber ?? ""}`} />
      </div>
      <article className="rp">
        <DocHead
          kicker="Detention evidence"
          number={pack.load.loadNumber ?? "A load"}
          company={company}
          heroLabel="What the track supports"
          hero={rate == null ? "—" : money(worth)}
          sub={`${pack.load.customer ?? "No customer"} · ${pack.load.truck ?? "No truck"} · delivered ${pack.load.completedAt ? dateTime(pack.load.completedAt, tz) : "—"}`}
          stamp={withEvidence.length === 0 ? undefined : pending > 0 ? { text: `${pending} to confirm`, tone: "plain" } : { text: "Decided", tone: "good" }}
        />
        <p className="rp-meta">
          {rate == null ? "This truck has no detention rate, so no amount is worked out." : `Detention terms: ${money(rate)} an hour after ${pack.terms.freeMinutes} min free at each stop.`} A stop counts as at the facility within {EVIDENCE_RADIUS_MILES} mile. Times are the carrier&apos;s clock.
        </p>

        {withEvidence.length === 0 ? <p>No evidence was frozen for this load: the truck had no position fixes in the days around the delivery, or its stops are not placed on the map.</p> : null}

        {pack.stops.map((s) => (
          <StopSection key={s.stopId} s={s} tz={tz} rate={rate} free={pack.terms.freeMinutes} invoiced={pack.load.invoiced} />
        ))}

        <p className="rp-meta">The positions come from the truck&apos;s ELD. A proposal never claims more than the fixes show: arrival is the first fix inside, departure the last, and the truck may have come earlier and left later. Whatever a person confirmed, and why, is recorded in the audit log.</p>
      </article>
    </>
  );
}

function StopSection({ s, tz, rate, free, invoiced }: { s: PackStop; tz: string; rate: number | null; free: number; invoiced: boolean }) {
  const e = s.evidence;
  const heading = `Stop ${s.sequence} · ${ROLE[s.role] ?? s.role} · ${s.label}`;
  if (!e) {
    return (
      <section className="ev-stop">
        <h2>{heading}</h2>
        <p>{s.placed ? "No evidence was frozen for this stop." : "This stop is not placed on the map, so the truck's track cannot be read against it."}</p>
      </section>
    );
  }
  const fixes = shownFixes(e.fixes, e.radiusMiles);
  const entered = s.arrivedAt != null || s.waitMinutes != null;
  return (
    <section className="ev-stop">
      <h2>{heading}</h2>
      <p className="rp-meta">
        {s.address}
        {s.windowStart || s.windowEnd ? ` · appointment ${s.windowStart ? dateTime(s.windowStart, tz) : "—"} to ${s.windowEnd ? dateTime(s.windowEnd, tz) : "—"}` : ""}
      </p>
      <p>
        <b>{QUALITY_WORDS[e.quality].split(":")[0]}.</b> {sentence(QUALITY_WORDS[e.quality].split(":").slice(1).join(":"))}
      </p>
      <table aria-label={`Stop ${s.sequence}: what the track showed`}>
        <tbody>
          <tr>
            <td>First fix inside</td>
            <td>{e.proposedArrivalAt ? dateTime(e.proposedArrivalAt, tz) : "The truck was not seen at the facility"}</td>
          </tr>
          <tr>
            <td>Last fix inside</td>
            <td>{e.stillInside ? "Still there at the last fix kept" : e.proposedDepartureAt ? dateTime(e.proposedDepartureAt, tz) : "—"}</td>
          </tr>
          <tr>
            <td>Wait counted from</td>
            <td>{e.waitFrom ? dateTime(e.waitFrom, tz) : "—"}</td>
          </tr>
          <tr>
            <td>Wait the track supports</td>
            <td>
              <b>{waitText(e.proposedWaitMinutes)}</b>
              {e.worth ? ` · ${e.worth.billableMinutes} min past the ${free} min free = ${money(e.worth.amount)}${rate != null ? ` at ${money(rate)} an hour` : ""}` : ""}
            </td>
          </tr>
          <tr>
            <td>On the stop now</td>
            <td>{entered ? `${s.arrivedAt ? `arrived ${dateTime(s.arrivedAt, tz)}` : "no arrival"}, ${s.waitMinutes != null ? `waited ${s.waitMinutes} min` : "no wait entered"}` : "Nothing entered"}</td>
          </tr>
        </tbody>
      </table>
      {e.notes.length > 0 ? (
        <ul className="ev-notes">
          {e.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}

      {fixes.rows.length > 0 ? (
        <table aria-label={`Stop ${s.sequence}: the fixes`} className="ev-fixes">
          <thead>
            <tr>
              <th>Fix time</th>
              <th className="num">From the stop</th>
              <th>Inside {e.radiusMiles} mi</th>
            </tr>
          </thead>
          <tbody>
            {fixes.rows.map((f) => (
              <tr key={f.at}>
                <td>{dateTime(new Date(f.at), tz)}</td>
                <td className="num">{f.miles.toFixed(2)} mi</td>
                <td>{f.miles <= e.radiusMiles ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {fixes.more > 0 ? <p className="rp-meta">{fixes.more} more {fixes.more === 1 ? "fix" : "fixes"}, between {e.radiusMiles} and 2 miles, are kept with this evidence.</p> : null}

      {e.state === "confirmed" ? (
        <p className="ev-decision">
          <b>Confirmed</b> by {e.decidedBy ?? "someone"} {e.decidedAt ? dateTime(e.decidedAt, tz) : ""}: {waitText(e.confirmedWaitMinutes)}
          {e.edited ? " (differs from the track)" : ""}
          {e.wroteToStop ? ", recorded on the stop" : ", kept as proof only: the stop was not changed"}.{e.note ? ` “${e.note}”` : ""}
        </p>
      ) : e.state === "dismissed" ? (
        <p className="ev-decision">
          <b>Dismissed</b> by {e.decidedBy ?? "someone"} {e.decidedAt ? dateTime(e.decidedAt, tz) : ""}.{e.note ? ` “${e.note}”` : ""}
        </p>
      ) : (
        <CanGate caps={["figures"]} what="decide on detention evidence" who="a billing or dispatch role with figures">
          <EvidenceDecide evidenceId={e.id} proposedWait={e.proposedWaitMinutes} invoiced={invoiced} />
        </CanGate>
      )}

      <p className="rp-meta ev-hash">
        Frozen {dateTime(e.frozenAt, tz)} · evidence {e.sha256.slice(0, 16)}… {e.intact ? "matches what was frozen" : "DOES NOT MATCH what was frozen: it has been changed since"}
      </p>
    </section>
  );
}
