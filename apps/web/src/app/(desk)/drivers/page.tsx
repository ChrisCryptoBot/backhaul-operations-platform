import Link from "next/link";
import React from "react";
import { listDrivers } from "@/server/tl/queries";
import { AssignmentChip, PageHead } from "@/components/desk/ui";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { DataTableTools } from "@/components/desk/data-table-tools";
import { EmptyState } from "@/components/desk/kit/states";
import { shortDate } from "@/lib/desk-format";

const COLUMNS: Column[] = [
  { key: "driver", label: "Driver", group: "Driver", sticky: true, width: 200 },
  { key: "truck", label: "Truck", group: "Driver" },
  { key: "cdl", label: "CDL", group: "Compliance" },
  { key: "medical", label: "Medical card", group: "Compliance" },
  { key: "clearance", label: "Clearance", group: "Compliance" },
  { key: "now", label: "On now", group: "Work" },
  { key: "delivered", label: "Delivered", group: "Work", align: "num" }
];

export default async function DriversPage() {
  const drivers = await listDrivers();
  const rows: Row[] = drivers.map((d) => ({
    id: d.id,
    flag: d.blocker ? "bad" : undefined,
    search: [d.name, d.phone, d.truck].filter(Boolean).join(" "),
    cells: {
      driver: (
        <>
          <b>{d.name}</b>
          <span className="sub">{d.phone}</span>
        </>
      ),
      truck: d.truck ?? "—",
      cdl: <>Class {d.cdlClass ?? "?"} · to {shortDate(d.cdlExpiry)}</>,
      medical: <>to {shortDate(d.medicalCardExpiry)}</>,
      clearance: d.blocker ? <span className="tl-chip bad">{d.blocker}</span> : <span className="tl-chip ok">Clear</span>,
      now:
        d.current.length === 0 ? (
          <span className="dim">—</span>
        ) : (
          d.current.map((c) => (
            <div key={c.loadId}>
              <Link href={`/loads/${c.loadId}`}>{c.loadNumber}</Link> <AssignmentChip status={c.status} />
            </div>
          ))
        ),
      delivered: d.delivered
    }
  }));

  return (
    <>
      <PageHead title="Drivers" sub="Who can take a load today. A lapsed CDL or medical card blocks the assignment." />
      <DataTableTools tableId="drivers-table" total={rows.length} placeholder="Search driver, phone, truck…" />
      <DataTable id="drivers-table" label="Drivers" columns={COLUMNS} rows={rows} empty={<EmptyState icon="drivers" title="No drivers yet">Drivers you add show up here with their CDL and medical card dates.</EmptyState>} />
    </>
  );
}
