import Link from "next/link";
import { notFound } from "next/navigation";
import React from "react";
import { getTruckDetail } from "@/server/tl/fleet";
import { listAudit } from "@/server/tl/audit";
import { Card, PageHead, StatusChip } from "@/components/desk/ui";
import { CostProfileForm, TruckForm, TruckRowActions } from "@/components/desk/fleet-forms";
import { ACTION_LABEL } from "@/lib/audit-diff";
import { dateTime, miles, perGallon, perMile, shortDate } from "@/lib/desk-format";
import { num } from "@/server/tl/convert";
import { FuelCardForm } from "@/components/desk/partner-actions";
import { CanGate } from "@/components/desk/kit/can-gate";
import { UnitTabs } from "@/components/desk/unit-tabs";
import { UnitWherePanel } from "@/components/desk/unit-where";
import { UnitHistoryPanel } from "@/components/desk/unit-history";
import { historyDays } from "@/lib/asset-history";
import { zoneAbbr } from "@/lib/tz";
import { getTruckHistory } from "@/server/tl/asset-history";
import { workspaceTimezone } from "@/server/tl/zone";
import { getTruckWhere } from "@/server/tl/whereabouts";
import { currentTerminal } from "@/server/tl/terminal";
import { currentWorkspaceId } from "@/server/tl/workspace";

const TABS = [
  { key: "where", label: "Where it is" },
  { key: "history", label: "History" },
  { key: "cost", label: "Cost & floor" },
  { key: "loads", label: "Loads" },
  { key: "details", label: "Details & changes" }
] as const;

/**
 * One truck, in tabs: where it is (the default), its cost profile with the floor it produces, what is on it now, and its details with what has been changed. The address says which tab is
 * open (`?tab=cost`), and only that tab's data is read.
 */
export default async function TruckPage({ params, searchParams }: { params: { id: string }; searchParams?: { tab?: string; days?: string } }) {
  const d = await getTruckDetail(params.id);
  if (!d) notFound();
  const t = d.vehicle;
  const tab = TABS.find((x) => x.key === searchParams?.tab)?.key ?? "where";
  const history = tab === "details" ? (await listAudit({ group: "fleet", q: t.name ?? "", pageSize: 8 })).rows : [];
  const here = tab === "where" ? (await getTruckWhere([t.id], currentWorkspaceId(), await currentTerminal())).get(t.id) : undefined;
  const days = historyDays(searchParams?.days);
  const past = tab === "history" ? await getTruckHistory(t.id, days) : null;
  const open = t.loads.length;

  return (
    <>
      <PageHead title={t.name ?? "Truck"} sub={`${[t.make, t.model, t.year].filter(Boolean).join(" ") || (t.type?.replace("_", " ") ?? "No type set")}${t.archivedAt ? " · archived" : ""} · ${open} open ${open === 1 ? "load" : "loads"}`}>
        <Link href="/fleet" className="tl-btn">All trucks</Link>
        <CanGate caps={["dispatch"]}>
          <TruckRowActions hideOpen truck={{ id: t.id, name: t.name, archived: t.archivedAt != null, open }} />
        </CanGate>
      </PageHead>

      <UnitTabs tabs={TABS} active={tab} label="Truck" />

      {tab === "where" ? (
        here ? <UnitWherePanel u={here} /> : <p className="tl-note">Could not read where this truck is.</p>
      ) : null}

      {tab === "history" && past ? <UnitHistoryPanel unit={{ kind: "truck", id: t.id, name: t.name ?? "Truck" }} entries={past.entries} days={days} openLoads={past.openLoads} clock={zoneAbbr(await workspaceTimezone(currentWorkspaceId()))} basePath={`/fleet/${t.id}`} /> : null}

      {tab === "cost" ? (
        <div id="panel-cost" role="tabpanel" aria-labelledby="tab-cost">
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
            <dd>{perGallon(d.numbers.lastFuelPricePerGallon)}</dd>
          </div>
        </dl>
      </section>


      <CanGate caps={["dispatch"]} banner who="A dispatcher" what="this truck">
      <Card title="Cost profile" className="tl-card">
        <p className="tl-note" style={{ marginBottom: 14, maxWidth: "72ch" }}>
          What it costs to keep this truck running. The break-even floor is what every load on it is measured against; change a number and the floor on the right moves before you save.
        </p>
        <CostProfileForm vehicleId={t.id} vehicleType={t.type} mpg={t.mpg == null ? null : num(t.mpg)} numbers={d.numbers} choices={d.choices} base={d.base} stored={d.stored ? { breakEven: d.stored.breakEven, survival: d.stored.survival } : null} openLoads={open} fuelType={t.fuelType} homeBase={t.homeBaseAddress} />
      </Card>
      </CanGate>


      {d.vehicle.costProfile ? (
        <Card title="Fuel card" className="tl-card">
          <p className="tl-note" style={{ marginBottom: 10, maxWidth: "72ch" }}>The card this truck buys fuel on. When a card company is connected, a trip&apos;s fuel can be filled in from the card&apos;s purchases (it only fills an empty box).</p>
          <CanGate caps={["dispatch"]}>
            <FuelCardForm vehicleId={t.id} provider={d.vehicle.costProfile.fuelCardProvider} accountId={d.vehicle.costProfile.fuelCardAccountId} />
          </CanGate>
        </Card>
      ) : null}

        </div>
      ) : null}

      {tab === "loads" ? (
        <div id="panel-loads" role="tabpanel" aria-labelledby="tab-loads">
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
        </div>
      ) : null}

      {tab === "details" ? (
        <div id="panel-details" role="tabpanel" aria-labelledby="tab-details">
      <CanGate caps={["dispatch"]} banner who="A dispatcher" what="this truck">
      <details className="qt-more" open>
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
            terminal: t.terminal,
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

      </CanGate>
      <div style={{ marginTop: 14 }}>
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
        </div>
      ) : null}
    </>
  );
}
