import Link from "next/link";
import React from "react";
import { RateConIntake } from "@/components/desk/rate-con-intake";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { EmptyState } from "@/components/desk/kit/states";
import { PageHead, StatusChip } from "@/components/desk/ui";
import { perMile, shortDate, usd } from "@/lib/desk-format";
import { cityState } from "@/server/ratecon/map";
import { listRecentRateCons } from "@/server/ratecon/recent";
import { listTrucks } from "@/server/tl/queries";

const COLUMNS: Column[] = [
  { key: "load", label: "Load", group: "Load", sticky: true, width: 200 },
  { key: "lane", label: "Lane", group: "Load" },
  { key: "stops", label: "Stops", group: "Load", align: "num" },
  { key: "pickup", label: "First stop", group: "Load" },
  { key: "rate", label: "Agreed rate", group: "Money", accentBand: true, align: "num" },
  { key: "perMile", label: "Per printed mile", group: "Money", accentBand: true, align: "num" },
  { key: "status", label: "Now", group: "Where it stands" },
  { key: "read", label: "Read", group: "Where it stands" }
];

export default async function RateConsPage() {
  const [{ rows: recent, total }, trucks] = await Promise.all([listRecentRateCons(8), listTrucks()]);
  const rows: Row[] = recent.map((r) => ({
    id: r.id,
    href: `/loads/${r.id}`,
    search: [r.loadNumber, r.broker, r.from, r.to].filter(Boolean).join(" "),
    cells: {
      load: (
        <>
          <b>{r.loadNumber ?? "No number"}</b>
          <span className="sub">{r.broker ?? "No broker"}</span>
        </>
      ),
      lane: (
        <>
          {cityState(r.from) ?? "—"} to {cityState(r.to) ?? "—"}
        </>
      ),
      stops: r.stops,
      pickup: shortDate(r.pickup),
      rate: usd(r.rate, 0),
      perMile: r.perMile != null ? perMile(r.perMile) : <span className="dim">no miles</span>,
      status: <StatusChip status={r.status} />,
      read: shortDate(r.readAt)
    }
  }));

  return (
    <>
      <PageHead title="Rate confirmations" sub="A document in, a draft load out. Check and correct what was read before anything is saved. A rate confirmation shows no verdict: the load is already agreed." />
      <RateConIntake liveReading={Boolean(process.env.ANTHROPIC_API_KEY)} trucks={trucks.filter((t) => !t.archived).map((t) => ({ id: t.id, name: t.name }))} />

      <div className="rc-list-head">
        <h2 className="rc-eyebrow">Read so far</h2>
        <span className="tl-sub">{total === 0 ? "" : total > recent.length ? `The latest ${recent.length} of ${total}` : `${total} ${total === 1 ? "load" : "loads"}`}</span>
        <Link href="/loads" className="tl-btn sm ghost">
          All loads
        </Link>
      </div>
      <DataTable id="rate-cons-table" label="Loads made from rate confirmations" columns={COLUMNS} rows={rows} empty={<EmptyState icon="document" title="Nothing read yet">Every document you read and save shows up here, with where its load stands.</EmptyState>} />
    </>
  );
}
