import React from "react";
import { listTrucks } from "@/server/tl/queries";
import { PageHead } from "@/components/desk/ui";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { DataTableTools } from "@/components/desk/data-table-tools";
import { EmptyState } from "@/components/desk/kit/states";
import { miles, perMile } from "@/lib/desk-format";

const COLUMNS: Column[] = [
  { key: "truck", label: "Truck", group: "Truck", sticky: true, width: 190 },
  { key: "type", label: "Type", group: "Truck" },
  { key: "mpg", label: "MPG", group: "Truck", align: "num" },
  { key: "fuel", label: "Fuel price", group: "Truck", align: "num" },
  { key: "planned", label: "Planned miles / month", group: "Cost floor", accentBand: true, align: "num" },
  { key: "breakEven", label: "Break-even floor", group: "Cost floor", accentBand: true, align: "num" },
  { key: "survival", label: "Survival floor", group: "Cost floor", accentBand: true, align: "num" },
  { key: "loads", label: "Loads", group: "Work", align: "num" },
  { key: "open", label: "Open", group: "Work", align: "num" }
];

export default async function FleetPage() {
  const trucks = await listTrucks();
  const rows: Row[] = trucks.map((t) => ({
    id: t.id,
    search: [t.name, t.type].filter(Boolean).join(" "),
    cells: {
      truck: (
        <>
          <b>{t.name}</b>
          <span className="sub">{t.archetype?.replace("_", " ") ?? "no cost profile"}</span>
        </>
      ),
      type: t.type?.replace("_", " ") ?? "—",
      mpg: t.mpg ?? "—",
      fuel: t.fuelPrice != null ? `$${t.fuelPrice.toFixed(2)}` : "—",
      planned: miles(t.monthlyMiles),
      breakEven: perMile(t.breakEvenRpm),
      survival: perMile(t.survivalFloorRpm),
      loads: t.loads,
      open: t.open
    }
  }));

  return (
    <>
      <PageHead title="Trucks" sub="Each truck's break-even floor, from its own cost profile. Every verdict on the Loads screen is measured against it." />
      <DataTableTools tableId="trucks-table" total={rows.length} placeholder="Search trucks…" />
      <DataTable id="trucks-table" label="Trucks" columns={COLUMNS} rows={rows} empty={<EmptyState icon="trucks" title="No trucks yet">A truck and its cost profile set the floor every load is measured against.</EmptyState>} />
      <p className="tl-note" style={{ marginTop: 12 }}>
        The break-even floor is cost per mile before fuel (fixed costs spread over planned miles, plus maintenance and tires). The verdict adds fuel for the load&apos;s own miles.
      </p>
    </>
  );
}
