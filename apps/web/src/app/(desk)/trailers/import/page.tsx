import Link from "next/link";
import React from "react";
import { PageHead } from "@/components/desk/ui";
import { ImportPanel } from "@/components/desk/import-panel";

export const dynamic = "force-dynamic";

/** Load a yard of trailers from a spreadsheet saved as CSV. */
export default function ImportTrailersPage() {
  return (
    <>
      <PageHead title="Import trailers" sub="Add many trailers at once from a CSV. Each row is checked like the Add trailer form; a number already in service, or repeated in the file, is left out. Hooking trailers to tractors is done on each trailer's page.">
        <Link href="/trailers" className="tl-btn">All trailers</Link>
      </PageHead>
      <ImportPanel kind="trailers" />
    </>
  );
}
