import Link from "next/link";
import { notFound } from "next/navigation";
import React from "react";
import { getTruckDetail } from "@/server/tl/fleet";
import { listAudit } from "@/server/tl/audit";
import { Card, PageHead, StatusChip } from "@/components/desk/ui";
import { CostProfileForm, TruckForm, TruckRowActions } from "@/components/desk/fleet-forms";
import { ACTION_LABEL } from "@/lib/audit-diff";
import { dateTime, miles, perMile, shortDate } from "@/lib/desk-format";
import { num } from "@/server/tl/convert";

/** One truck: its details, its cost profile with the floor it produces, what is on it now, and what has been changed. */
export default async function TruckPage({ params }: { params: { id: string } }) {
  const d = await getTruckDetail(params.id);
  if (!d) notFound();
  const t = d.vehicle;
  const history = (await listAudit({ group: "fleet", q: t.name ?? "", pageSize: 8 })).rows;
  const open = t.loads.length;

  return (
    <>
      <PageHead title={t.name ?? "Truck"} sub={`${[t.make, t.model, t.year].filter(Boolean).join(" ") || (t.type?.replace("_", " ") ?? "No type set")}${t.archivedAt ? " · archived" : ""} · ${open} open ${open === 1 ? "load" : "loads"}`}>
        <Link href="/fleet" className="tl-btn">All trucks</Link>
        <TruckRowActions hideOpen truck={{ id: t.id, name: t.name, archived: t.archivedAt != null, open }} />
      </PageHead>

      <section className="tk-hero" aria-label="Break-even floor">
        <div>
          <div className="tk-label">Break-even floor</div>
          <div className="qt-big">{d.stored ? perMile(d.stored.breakEven) : "—"}</div>
          <p className="tl-sub" style={{ marginTop: 6 }}>{d.stored ? "Every load on this truck is measured against it." : "No cost profile yet. Fill it in below and the floor appears here."}</p>
        </div>
        <dl className="tk-facts">
          <div>
            <dt>Survival floor</dt>
            <dd>{d.stored?.survival != null ? perMile(d.stored.survival) : "—"}</dd>
          </div>
          <div>
            <dt>Planned miles a month</dt>
            <dd>{d.numbers.estimatedMonthlyMiles != null ? miles(d.numbers.estimatedMonthlyMiles) : "—"}</dd>
          </div>
          <div>
            <dt>Fuel price</dt>
            <dd>{d.numbers.lastFuelPricePerGallon != null ? `$${d.numbers.lastFuelPricePerGallon.toFixed(2)}` : "—"}</dd>
          </div>
        </dl>
      </section>

      <details className="qt-more" open={!t.type || t.mpg == null || undefined}>
        <summary>Details</summary>
        <TruckForm
          inline
          truck={{
            id: t.id,
            name: t.name,
            type: t.type,
            mpg: t.mpg == null ? null : num(t.mpg),
            fuelType: t.fuelType,
            homeBase: t.homeBaseAddress,
            make: t.make,
            model: t.model,
            year: t.year,
            payloadLbs: t.payloadLbs,
            maxLengthFt: t.maxLengthFt == null ? null : num(t.maxLengthFt),
            maxWidthFt: t.maxWidthFt == null ? null : num(t.maxWidthFt),
            maxHeightIn: t.maxHeightIn == null ? null : num(t.maxHeightIn),
            hasLiftgate: t.hasLiftgate,
            hasRamp: t.hasRamp,
            hasPalletJack: t.hasPalletJack
          }}
        />
      </details>

      <Card title="Cost profile" className="tl-card">
        <p className="tl-note" style={{ marginBottom: 14, maxWidth: "72ch" }}>
          What it costs to keep this truck running. The break-even floor is what every load on it is measured against; change a number and the floor on the right moves before you save.
        </p>
        <CostProfileForm vehicleId={t.id} vehicleType={t.type} mpg={t.mpg == null ? null : num(t.mpg)} numbers={d.numbers} choices={d.choices} base={d.base} stored={d.stored ? { breakEven: d.stored.breakEven, survival: d.stored.survival } : null} openLoads={open} fuelType={t.fuelType} homeBase={t.homeBaseAddress} />
      </Card>

      <div className="tl-grid cols-2" style={{ marginTop: 14 }}>
        <Card title={`On this truck now · ${open}`}>
          {open === 0 ? (
            <p className="tl-note">No open loads.</p>
          ) : (
            <table className="tl-table" aria-label="Recent loads">
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
          {t.drivers.length > 0 ? <p className="tl-note" style={{ marginTop: 10 }}>Driven by {t.drivers.map((x) => x.name).join(", ")}.</p> : null}
        </Card>
        <Card title="Changes">
          {history.length === 0 ? (
            <p className="tl-note">Nothing has been changed on this truck yet.</p>
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
          <p className="tl-note" style={{ marginTop: 10 }}><Link href={`/audit?group=fleet&q=${encodeURIComponent(t.name ?? "")}`}>Everything in the audit log</Link></p>
        </Card>
      </div>
    </>
  );
}
