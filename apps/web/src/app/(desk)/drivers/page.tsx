import Link from "next/link";
import React from "react";
import { listDrivers, listTrucks } from "@/server/tl/queries";
import { AssignmentChip, PageHead } from "@/components/desk/ui";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { DataTableTools } from "@/components/desk/data-table-tools";
import { AddDriver, DriverRowActions, type DriverRow } from "@/components/desk/fleet-forms";
import { EmptyState } from "@/components/desk/kit/states";
import { ymdOf } from "@/lib/fleet-forms";
import { payLabel, shortDate } from "@/lib/desk-format";

const COLUMNS: Column[] = [
  { key: "driver", label: "Driver", group: "Driver", sticky: true, width: 220 },
  { key: "truck", label: "Truck", group: "Driver" },
  { key: "pay", label: "Usual pay", group: "Driver" },
  { key: "cdl", label: "CDL", group: "Compliance" },
  { key: "medical", label: "Medical card", group: "Compliance" },
  { key: "clearance", label: "Clearance", group: "Compliance" },
  { key: "now", label: "On now", group: "Work" },
  { key: "delivered", label: "Delivered", group: "Work", align: "num" },
  { key: "act", label: "", group: "" }
];

export default async function DriversPage() {
  const [all, trucks] = await Promise.all([listDrivers(), listTrucks()]);
  const drivers = [...all].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  const options = trucks.filter((t) => !t.archived).map((t) => ({ id: t.id, name: t.name }));
  const rows: Row[] = drivers.map((d) => {
    const row: DriverRow = {
      id: d.id,
      name: d.name,
      phone: d.phone,
      email: d.email,
      cdlClass: d.cdlClass,
      cdlExpiry: ymdOf(d.cdlExpiry),
      medicalCardExpiry: ymdOf(d.medicalCardExpiry),
      truckId: d.truckId,
      payKind: d.payKind ?? "",
      payRate: d.payRate == null ? "" : String(d.payRate),
      active: d.active,
      onLoads: d.openLoadNumbers.length,
      onLoadNumbers: d.openLoadNumbers
    };
    return {
      id: d.id,
      flag: d.active && d.blocker ? "bad" : undefined,
      search: [d.name, d.phone, d.truck].filter(Boolean).join(" "),
      cells: {
        driver: (
          <>
            <b>{d.name}</b>
            {d.active ? <span className="sub">{d.phone}</span> : <span className="sub"><span className="tl-chip muted">Out of service</span></span>}
          </>
        ),
        truck: d.truck ?? "—",
        pay: payLabel(d.payKind, d.payRate),
        cdl: <>Class {d.cdlClass ?? "?"} · to {shortDate(d.cdlExpiry)}</>,
        medical: <>to {shortDate(d.medicalCardExpiry)}</>,
        clearance: !d.active ? <span className="dim">—</span> : d.blocker ? <span className="tl-chip bad">{d.blocker}</span> : <span className="tl-chip ok">Clear</span>,
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
        delivered: d.delivered,
        act: <DriverRowActions driver={row} trucks={options} />
      }
    };
  });

  return (
    <>
      <PageHead title="Drivers" sub="Who can take a load today. A lapsed CDL or medical card blocks the assignment. A driver on an open load cannot be taken out of service.">
        <AddDriver trucks={options} />
      </PageHead>
      <DataTableTools tableId="drivers-table" total={rows.length} placeholder="Search driver, phone, truck…" />
      <DataTable id="drivers-table" label="Drivers" columns={COLUMNS} rows={rows} empty={<EmptyState icon="drivers" title="No drivers yet">Add a driver and they show up here with their CDL and medical card dates.</EmptyState>} />
    </>
  );
}
