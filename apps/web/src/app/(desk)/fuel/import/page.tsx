import Link from "next/link";
import React from "react";
import { FuelImportPanel } from "@/components/desk/fuel-import-panel";
import { CanGate } from "@/components/desk/kit/can-gate";
import { PageHead } from "@/components/desk/ui";
import { listFuelImports } from "@/server/partners/fuel-import";
import { requirePage } from "@/server/tl/access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Import fuel purchases · TrueLane" };

/** Fuel purchases from a CSV, for a fleet or a card the desk does not read by API (docs/MONEY_PLAN.md, Wave 5 step 2). Read exactly like a card company's purchases, kept once, removable as a file. */
export default async function ImportFuelPage() {
  await requirePage("read");
  const recent = await listFuelImports(10);
  return (
    <>
      <PageHead title="Import fuel purchases" sub="A card company's transaction export or your own fuel log, read like the cards the desk reads: the state each purchase was bought in, what was pumped, and whether it settled.">
        <Link href="/fuel" className="tl-btn">Back to Fuel</Link>
      </PageHead>
      <CanGate caps={["dispatch", "bill"]} banner who="A dispatcher or the billing office" what="this page">
        <FuelImportPanel recent={recent} />
      </CanGate>
    </>
  );
}
