import Link from "next/link";
import React from "react";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { FuelSyncButton } from "@/components/desk/data-actions";
import { FuelFlagCell } from "@/components/desk/fuel-flag-cell";
import { CanGate } from "@/components/desk/kit/can-gate";
import { EmptyState } from "@/components/desk/kit/states";
import { Pager } from "@/components/desk/pager";
import { PageHead, Stat } from "@/components/desk/ui";
import { dayYear, gallons, perGallon, usd } from "@/lib/desk-format";
import { FLAG_CODES, FLAG_LABEL } from "@/lib/fuel-exceptions";
import { PRODUCT_LABEL, STATUS_LABEL } from "@/lib/fuel-normalize";
import { asPage } from "@/lib/paging";
import { partnerStatus } from "@/server/partners/connections";
import { FUEL_PAGE, listFuel } from "@/server/partners/fuel-store";
import { requirePage } from "@/server/tl/access";
import { currentTerminal } from "@/server/tl/terminal";

export const metadata = { title: "Fuel · TrueLane" };
export const dynamic = "force-dynamic";

const PERIODS = [30, 90] as const;
const COLUMNS: Column[] = [
  { key: "date", label: "Date" },
  { key: "truck", label: "Truck" },
  { key: "where", label: "Where", max: 220 },
  { key: "state", label: "State", priority: 2 },
  { key: "flags", label: "Flags", max: 140 },
  { key: "product", label: "Product", priority: 2 },
  { key: "gallons", label: "Gallons", align: "num" },
  { key: "ppg", label: "$/gal", align: "num" },
  { key: "disc", label: "Discount/gal", align: "num", priority: 2 },
  { key: "charged", label: "Charged", align: "num", accentBand: true },
  { key: "load", label: "Load" },
  { key: "statement", label: "Statement", priority: 2 }
];


/**
 * Fuel: what the fuel cards were charged for, as the card company reported it: each purchase with its gallons, its price and the card's discount a gallon, and the load and the driver
 * statement it is tied to. The purchases are read from the card when someone asks (a trip's fuel box, or the button here) and kept, so the same purchase is never counted twice. A purchase is
 * a record here: nothing is taken off any driver's statement because of it. Each purchase shows the state it was bought in and what was pumped; pending, declined and voided purchases are
 * listed but never counted in the totals. Each purchase carries its exception flags (lib/fuel-exceptions.ts); "Flagged" lists only those with one open, and a person clears one flag at a time.
 */
export default async function FuelPage({ searchParams }: { searchParams?: { days?: string; page?: string; flagged?: string } }) {
  await requirePage("read");
  const days = (PERIODS as readonly number[]).includes(Number.parseInt(searchParams?.days ?? "", 10)) ? Number.parseInt(searchParams!.days!, 10) : 30;
  const page = asPage(searchParams?.page);
  const flagged = searchParams?.flagged === "1";
  const terminal = await currentTerminal();
  const [data, companies] = await Promise.all([listFuel({ days, page, terminal, flagged }), partnerStatus()]);
  // Reading the cards needs a connected fuel card company; which one is whichever the fleet connected.
  const cardReason = companies.some((c) => c.capability === "fuel_card" && c.connected && c.configured) ? null : "No fuel card company is connected. An admin connects one under Settings, Integrations.";
  const href = (over: { days?: number; page?: number; flagged?: boolean }) => {
    const u = new URLSearchParams();
    const d = over.days ?? days;
    if (d !== 30) u.set("days", String(d));
    if (over.flagged ?? flagged) u.set("flagged", "1");
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
      state: r.state ?? <span className="t-st" data-tone="warn">not said</span>,
      product: r.product === "road_diesel" ? PRODUCT_LABEL.road_diesel : <span className="t-st" data-tone={r.product === "unknown" || r.product === "gasoline" || r.product === "other" ? "warn" : "info"}>{PRODUCT_LABEL[r.product]}</span>,
      gallons: gallons(r.gallons),
      ppg: perGallon(r.pricePerGallon),
      disc: r.discountPerGallon == null ? <span className="dim">—</span> : <span className={r.discountPerGallon > 0 ? "t-pos" : "dim"}>{perGallon(r.discountPerGallon, 3)}</span>,
      charged:
        r.status === "settled" ? (
          usd(r.amount, 2)
        ) : (
          <>
            <span className="t-st" data-tone={r.status === "pending" ? "warn" : "bad"}>{STATUS_LABEL[r.status]}</span> <span className="dim">{usd(r.amount, 2)}</span>
          </>
        ),
      load: r.loadId ? <Link href={`/loads/${r.loadId}`}>{r.loadNumber ?? "Load"}</Link> : <span className="dim">not tied</span>,
      statement: r.statementId ? (
        <>
          <Link href={`/settlements/${r.statementId}`}>{r.statementNumber}</Link> {r.deducted ? <span className="t-st" data-tone="ok">deducted</span> : <span className="dim">load is on it</span>}
        </>
      ) : (
        <span className="dim">{r.loadId ? "not deducted" : "—"}</span>
      ),
      flags:
        r.flags.open.length === 0 && r.flags.cleared.length === 0 ? (
          <span className="dim">—</span>
        ) : (
          <CanGate caps={["dispatch", "bill"]}>
            <FuelFlagCell id={r.id} open={r.flags.open} cleared={r.flags.cleared} />
          </CanGate>
        )
    }
  }));
  const t = data.totals;
  // The gallons split by what was pumped, so reefer and DEF are seen apart from the tractor's road diesel.
  const split = (["road_diesel", "reefer_diesel", "gasoline", "other", "unknown"] as const)
    .filter((p) => (t.byProduct[p] ?? 0) > 0)
    .map((p) => `${gallons(t.byProduct[p])} ${PRODUCT_LABEL[p].toLowerCase()}`);
  const def = t.byProduct.def ?? 0;
  const f = data.flags;
  const flagWords = FLAG_CODES.filter((c) => (f.byCode[c] ?? 0) > 0).map((c) => `${f.byCode[c]} ${FLAG_LABEL[c].toLowerCase()}`);

  return (
    <>
      <PageHead title="Fuel" sub="What the fuel cards were charged for: each purchase with its gallons, the card's discount, and the load and driver statement it belongs to.">
        <a className="tl-btn" href={`/export/fuel?days=${days}`}>Export CSV</a>
        <CanGate caps={["dispatch", "bill"]}>
          <Link className="tl-btn" href="/fuel/import">
            Import a file
          </Link>
          <FuelSyncButton days={days} reason={cardReason} />
        </CanGate>
      </PageHead>
      <div className="tl-tabs" role="tablist" aria-label="Period">
        {PERIODS.map((p) => (
          <Link key={p} href={href({ days: p, flagged: false })} className="tl-tab" aria-current={!flagged && days === p ? "true" : undefined}>
            Last {p} days
          </Link>
        ))}
        <Link href={href({ flagged: true })} className="tl-tab" aria-current={flagged ? "true" : undefined}>
          Flagged ({f.purchases})
        </Link>
      </div>
      {cardReason ? <p className="tl-note t-lede">{cardReason}</p> : null}
      <div className="tl-grid cols-4">
        <Stat label="Purchases" value={String(t.purchases)} sub={`settled, last ${days} days${t.notCounted > 0 ? `; ${t.notCounted} not settled, not counted` : ""}`} />
        <Stat label="Gallons" value={gallons(t.gallons)} sub={[split.length > 1 ? split.join(" · ") : null, def > 0 ? `DEF ${gallons(def)} gal kept apart` : null].filter(Boolean).join("; ") || undefined} />
        <Stat label="Charged" value={usd(t.charged, 2)} sub={t.netPerGallon != null ? `${perGallon(t.netPerGallon, 3)} a gallon after discount` : undefined} />
        <Stat label="Discount saved" value={usd(t.discount, 2)} tone={t.discount > 0 ? "ok" : undefined} />
      </div>
      {f.purchases > 0 || f.tankUnknown > 0 || f.partial ? (
        <p className={f.purchases > 0 ? "tl-note warn fuel-flagnote" : "tl-note fuel-flagnote"}>
          {f.purchases > 0 ? (
            <>
              {f.purchases} {f.purchases === 1 ? "purchase has" : "purchases have"} an open flag in the last {days} days: {flagWords.join(" · ")}.{" "}
              {flagged ? null : <Link href={href({ flagged: true, page: 1 })}>Show only those</Link>}
              {f.cleared > 0 ? ` ${f.cleared} cleared by a person.` : ""}{" "}
            </>
          ) : null}
          {f.tankUnknown > 0 ? `${f.tankUnknown} diesel ${f.tankUnknown === 1 ? "fill is" : "fills are"} on trucks with no tank size, so ${f.tankUnknown === 1 ? "it is" : "they are"} not checked for over-filling: type it on the truck's page. ` : null}
          {f.partial ? "Flags are read from the newest 20,000 purchases." : null}
        </p>
      ) : null}
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
