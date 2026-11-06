import Link from "next/link";
import React from "react";
import { PageHead } from "@/components/desk/ui";
import { LoadImportPanel } from "@/components/desk/load-import-panel";
import { CanGate } from "@/components/desk/kit/can-gate";
import { listLoadImports } from "@/server/tl/load-import";

export const dynamic = "force-dynamic";
export const metadata = { title: "Import loads · TrueLane" };

/** Load a carrier's finished loads from a spreadsheet or a TMS export saved as CSV, with the columns matched and every row checked first. */
export default async function ImportLoadsPage() {
  const recent = await listLoadImports(10);
  return (
    <>
      <PageHead title="Import loads" sub="Bring in a carrier's history: one finished load per row, with the columns matched to the desk's fields and every row checked before anything is written. A load already on the desk (the same number from the same customer) is left out.">
        <Link href="/loads/import/weekly" className="tl-btn">Weekly tracker instead</Link>
        <Link href="/loads" className="tl-btn">Loads</Link>
      </PageHead>
      <CanGate caps={["dispatch"]} banner who="A dispatcher" what="this page">
        <LoadImportPanel recent={recent} />
      </CanGate>
    </>
  );
}
