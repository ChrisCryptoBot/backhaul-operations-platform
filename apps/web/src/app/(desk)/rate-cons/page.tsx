import Link from "next/link";
import React from "react";
import { RateConIntake } from "@/components/desk/rate-con-intake";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { EmptyState } from "@/components/desk/kit/states";
import { PageHead, StatusChip } from "@/components/desk/ui";
import { perMile, shortDate, usd } from "@/lib/desk-format";
import { cityState } from "@/lib/city-state";
import { listRecentRateCons } from "@/server/ratecon/recent";
import { CanGate } from "@/components/desk/kit/can-gate";

export const metadata = { title: "Rate confirmations · TrueLane" };

const COLUMNS: Column[] = [
  { key: "load", label: "Load", sticky: true, width: 180, max: 200 },
  { key: "lane", label: "Lane", max: 260 },
  { key: "stops", label: "Stops", align: "num", priority: 2 },
  { key: "pickup", label: "First stop" },
  { key: "rate", label: "Agreed rate", align: "num" },
  { key: "perMile", label: "Per printed mile", align: "num" },
  { key: "status", label: "Now" },
  { key: "read", label: "Read", priority: 2 }
];

export default async function RateConsPage() {
  const { rows: recent, total } = await listRecentRateCons(8);
  const rows: Row[] = recent.map((r) => ({
    id: r.id,
    href: `/loads/${r.id}`,
    search: [r.loadNumber, r.broker, r.from, r.to].filter(Boolean).join(" "),
    cells: {
      load: (
        <>
          <b>{r.loadNumber ?? "No number"}</b>
          <span className="sub">{r.broker ?? "No customer"}</span>
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
      <PageHead title="Rate confirmations" sub="A document in, a draft load out. Check what was read before anything is saved." />
      <CanGate caps={["dispatch"]} banner who="A dispatcher" what="this page">
        <RateConIntake liveReading={Boolean(process.env.ANTHROPIC_API_KEY)} />
      </CanGate>

      {/* What was read before: only while there is no document on the table (terminal.css hides it beside the check, so one load's figures are never read as another's). */}
      <section className="rc-history">
      <div className="rc-list-head">
        <h2 className="t-sec">Read so far</h2>
        <span className="tl-sub">{total === 0 ? "" : total > recent.length ? `The latest ${recent.length} of ${total}` : `${total} ${total === 1 ? "load" : "loads"}`}</span>
        <Link href="/loads" className="tl-btn sm ghost">
          All loads
        </Link>
      </div>
      <DataTable id="rate-cons-table" label="Loads made from rate confirmations" columns={COLUMNS} rows={rows} empty={<EmptyState icon="document" title="Nothing read yet">Every document you read and save shows up here, with where its load stands.</EmptyState>} />
      </section>
    </>
  );
}
