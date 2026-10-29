import Link from "next/link";
import React from "react";
import { listTrucks } from "@/server/tl/queries";
import { PageHead } from "@/components/desk/ui";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { DataTableTools } from "@/components/desk/data-table-tools";
import { AddTruck, TruckRowActions } from "@/components/desk/fleet-forms";
import { EmptyState } from "@/components/desk/kit/states";
import { miles, perMile } from "@/lib/desk-format";

const COLUMNS: Column[] = [
  { key: "truck", label: "Truck", group: "Truck", sticky: true, width: 200 },
  { key: "type", label: "Type", group: "Truck" },
  { key: "mpg", label: "MPG", group: "Truck", align: "num" },
  { key: "fuel", label: "Fuel price", group: "Truck", align: "num" },
  { key: "planned", label: "Planned miles / month", group: "Cost floor", accentBand: true, align: "num" },
  { key: "breakEven", label: "Break-even floor", group: "Cost floor", accentBand: true, align: "num" },
  { key: "survival", label: "Survival floor", group: "Cost floor", accentBand: true, align: "num" },
  { key: "detention", label: "Detention rate", group: "Dock", align: "num" },
  { key: "loads", label: "Loads", group: "Work", align: "num" },
  { key: "open", label: "Open", group: "Work", align: "num" },
  { key: "act", label: "", group: "" }
];

export default async function FleetPage() {
  const all = await listTrucks();
  const trucks = [...all].sort((a, b) => Number(a.archived) - Number(b.archived) || (a.name ?? "").localeCompare(b.name ?? ""));
  const rows: Row[] = trucks.map((t) => ({
    id: t.id,
    search: [t.name, t.type, t.make, t.model].filter(Boolean).join(" "),
    cells: {
      truck: (
        <>
          <Link href={`/fleet/${t.id}`}><b>{t.name}</b></Link>
          <span className="sub">
            {[t.make, t.model, t.year].filter(Boolean).join(" ")}
            {t.make || t.model ? " · " : ""}
            {t.archived ? <span className="tl-chip muted">Archived</span> : (t.archetype?.replace("_", " ") ?? "no cost profile")}
          </span>
        </>
      ),
      type: t.type?.replace("_", " ") ?? "—",
      mpg: t.mpg ?? "—",
      fuel: t.fuelPrice != null ? `$${t.fuelPrice.toFixed(2)}` : "—",
      planned: miles(t.monthlyMiles),
      breakEven: perMile(t.breakEvenRpm),
      survival: perMile(t.survivalFloorRpm),
      detention: t.detentionRate != null ? `$${t.detentionRate.toFixed(0)}/h` : <span className="dim">none</span>,
      loads: t.loads,
      open: t.open,
      act: <TruckRowActions truck={{ id: t.id, name: t.name, archived: t.archived, open: t.open }} />
    }
  }));

  return (
    <>
      <PageHead title="Trucks" sub="Each truck's break-even floor, from its own cost profile. Every verdict on the Loads screen is measured against it. Open a truck to change its costs and see the floor move.">
        <AddTruck />
      </PageHead>
      <DataTableTools tableId="trucks-table" total={rows.length} placeholder="Search trucks…" />
      <DataTable id="trucks-table" label="Trucks" columns={COLUMNS} rows={rows} empty={<EmptyState icon="trucks" title="No trucks yet">A truck and its cost profile set the floor every load is measured against.</EmptyState>} />
      <p className="tl-note" style={{ marginTop: 12 }}>
        The break-even floor is cost per mile before fuel (fixed costs spread over planned miles, plus maintenance and tires). The verdict adds fuel for the load&apos;s own miles.
      </p>
    </>
  );
}
