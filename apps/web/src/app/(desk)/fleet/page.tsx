import React from "react";
import { listTrucks } from "@/server/tl/queries";
import { Empty, PageHead } from "@/components/desk/ui";
import { miles, perMile } from "@/lib/desk-format";

export default async function FleetPage() {
  const trucks = await listTrucks();
  return (
    <>
      <PageHead title="Trucks" sub="Each truck's break-even floor, from its own cost profile. Every verdict on the Loads screen is measured against it." />
      <div className="tl-card" style={{ padding: 0, overflowX: "auto" }}>
        {trucks.length === 0 ? (
          <Empty>No trucks yet.</Empty>
        ) : (
          <table className="tl-table">
            <thead>
              <tr>
                <th>Truck</th>
                <th>Type</th>
                <th className="num">MPG</th>
                <th className="num">Fuel price</th>
                <th className="num">Planned miles / month</th>
                <th className="num">Break-even floor</th>
                <th className="num">Survival floor</th>
                <th className="num">Loads</th>
                <th className="num">Open</th>
              </tr>
            </thead>
            <tbody>
              {trucks.map((t) => (
                <tr key={t.id}>
                  <td><b>{t.name}</b><div className="tl-sub">{t.archetype?.replace("_", " ") ?? "no cost profile"}</div></td>
                  <td>{t.type?.replace("_", " ") ?? "—"}</td>
                  <td className="num">{t.mpg ?? "—"}</td>
                  <td className="num">{t.fuelPrice != null ? `$${t.fuelPrice.toFixed(2)}` : "—"}</td>
                  <td className="num">{miles(t.monthlyMiles)}</td>
                  <td className="num">{perMile(t.breakEvenRpm)}</td>
                  <td className="num">{perMile(t.survivalFloorRpm)}</td>
                  <td className="num">{t.loads}</td>
                  <td className="num">{t.open}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="tl-note" style={{ marginTop: 12 }}>
        The break-even floor is cost per mile before fuel (fixed costs spread over planned miles, plus maintenance and tires). The verdict adds fuel for the load&apos;s own miles.
      </p>
    </>
  );
}
