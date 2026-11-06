import Link from "next/link";
import React from "react";
import { PageHead } from "@/components/desk/ui";
import { TrackerImportPanel } from "@/components/desk/tracker-import-panel";
import { CanGate } from "@/components/desk/kit/can-gate";
import { listHistoryImports } from "@/server/tl/tracker-import";

export const dynamic = "force-dynamic";
export const metadata = { title: "Import a weekly tracker · TrueLane" };

/** Load a carrier's own weekly tracker (one row per lane per week) as imported history: kept apart from loads, shown under its own heading on the KPI page. */
export default async function ImportWeeklyPage() {
  const recent = await listHistoryImports(10);
  return (
    <>
      <PageHead title="Import a weekly tracker" sub="A spreadsheet of lane-per-week totals is not a list of loads, so it is not turned into loads. Its rows are kept as imported history, shown beside the desk's own figures and never added to them.">
        <Link href="/loads/import" className="tl-btn">Finished loads instead</Link>
        <Link href="/kpi?period=all" className="tl-btn">KPI dashboard</Link>
      </PageHead>
      <CanGate caps={["dispatch"]} banner who="A dispatcher" what="this page">
        <TrackerImportPanel recent={recent} />
      </CanGate>
    </>
  );
}
