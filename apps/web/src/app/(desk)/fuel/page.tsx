import Link from "next/link";
import React from "react";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { FuelSyncButton } from "@/components/desk/data-actions";
import { CanGate } from "@/components/desk/kit/can-gate";
import { EmptyState } from "@/components/desk/kit/states";
import { Pager } from "@/components/desk/pager";
import { PageHead, Stat } from "@/components/desk/ui";
import { dayYear, gallons, perGallon, usd } from "@/lib/desk-format";
import { asPage } from "@/lib/paging";
import { partnerStatus } from "@/server/partners/connections";
import { FUEL_PAGE, listFuel } from "@/server/partners/fuel-store";
import { requirePage } from "@/server/tl/access";
import { currentTerminal } from "@/server/tl/terminal";

export const metadata = { title: "Fuel · TrueLane" };
export const dynamic = "force-dynamic";

const PERIODS = [30, 90] as const;
const COLUMNS: Column[] = [
  { key: "date", label: "Date", group: "Purchase" },
  { key: "truck", label: "Truck", group: "Purchase" },
  { key: "where", label: "Where", group: "Purchase" },
  { key: "gallons", label: "Gallons", group: "Fuel", align: "num" },
  { key: "ppg", label: "$/gal", group: "Fuel", align: "num" },
  { key: "disc", label: "Discount/gal", group: "Fuel", align: "num" },
  { key: "charged", label: "Charged", group: "Fuel", align: "num", accentBand: true },
  { key: "load", label: "Load", group: "Tied to" },
  { key: "statement", label: "Driver statement", group: "Tied to" }
];


/**
 * Fuel: what the fuel cards were charged for, as the card company reported it: each purchase with its gallons, its price and the card's discount a gallon, and the load and the driver
 * statement it is tied to. The purchases are read from the card when someone asks (a trip's fuel box, or the button here) and kept, so the same purchase is never counted twice. A purchase is
 * a record here: nothing is taken off any driver's statement because of it.
 */
export default async function FuelPage({ searchParams }: { searchParams?: { days?: string; page?: string } }) {
  await requirePage("read");
  const days = (PERIODS as readonly number[]).includes(Number.parseInt(searchParams?.days ?? "", 10)) ? Number.parseInt(searchParams!.days!, 10) : 30;
  const page = asPage(searchParams?.page);
  const terminal = await currentTerminal();
  const [data, companies] = await Promise.all([listFuel({ days, page, terminal }), partnerStatus()]);
  // Reading the cards needs a connected fuel card company; which one is whichever the fleet connected.
  const cardReason = companies.some((c) => c.capability === "fuel_card" && c.connected && c.configured) ? null : "No fuel card company is connected. An admin connects one under Settings, Integrations.";
  const href = (over: { days?: number; page?: number }) => {
    const u = new URLSearchParams();
    const d = over.days ?? days;
    if (d !== 30) u.set("days", String(d));
    if (over.page && over.page > 1) u.set("page", String(over.page));
    const q = u.toString();
    return q ? `/fuel?${q}` : "/fuel";
  };

  const rows: Row[] = data.rows.map((r) => ({
    id: r.id,
    cells: {
      date: dayYear(r.postedAt, "UTC"),
      truck: r.truckId ? <Link href={`/fleet/${r.truckId}`}>{r.truck ?? "Truck"}</Link> : <span className="dim">—</span>,
      where: r.location ?? <span className="dim">—</span>,
      gallons: gallons(r.gallons),
      ppg: perGallon(r.pricePerGallon),
      disc: r.discountPerGallon == null ? <span className="dim">—</span> : <span className="t-pos">{perGallon(r.discountPerGallon, 3)}</span>,
      charged: usd(r.amount, 2),
      load: r.loadId ? <Link href={`/loads/${r.loadId}`}>{r.loadNumber ?? "Load"}</Link> : <span className="dim">not tied</span>,
      statement: r.statementId ? (
        <>
          <Link href={`/settlements/${r.statementId}`}>{r.statementNumber}</Link> {r.deducted ? <span className="t-st" data-tone="ok">deducted</span> : <span className="dim">load is on it</span>}
        </>
      ) : (
        <span className="dim">{r.loadId ? "not deducted" : "—"}</span>
      )
    }
  }));
  const t = data.totals;

  return (
    <>
      <PageHead title="Fuel" sub="What the fuel cards were charged for: each purchase with its gallons, the card's discount, and the load and driver statement it belongs to.">
        <a className="tl-btn" href={`/export/fuel?days=${days}`}>Export CSV</a>
        <CanGate caps={["dispatch", "bill"]}>
          <FuelSyncButton days={days} reason={cardReason} />
        </CanGate>
      </PageHead>
      <div className="tl-tabs" role="tablist" aria-label="Period" style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {PERIODS.map((p) => (
          <Link key={p} href={href({ days: p })} className="tl-tab" aria-current={days === p ? "true" : undefined}>
            Last {p} days
          </Link>
        ))}
      </div>
      <div className="tl-grid cols-4">
        <Stat label="Purchases" value={String(t.purchases)} sub={`in the last ${days} days`} />
        <Stat label="Gallons" value={gallons(t.gallons)} />
        <Stat label="Charged" value={usd(t.charged, 2)} sub={t.netPerGallon != null ? `${perGallon(t.netPerGallon, 3)} a gallon after discount` : undefined} />
        <Stat label="Discount saved" value={usd(t.discount, 2)} tone={t.discount > 0 ? "ok" : undefined} />
      </div>
      <DataTable
        id="fuel-table"
        label="Fuel purchases"
        columns={COLUMNS}
        rows={rows}
        empty={
          <EmptyState icon="trucks" title="No fuel purchases yet">
            Give a truck its card on the truck&apos;s page, connect a fuel card company in Settings, then read the card purchases.
          </EmptyState>
        }
      />
      <Pager page={data.page} pageSize={FUEL_PAGE} total={data.total} hrefFor={(n) => href({ page: n })} newer="Newer" older="Older" />
    </>
  );
}
