import Link from "next/link";
import React from "react";
import { PageHead } from "@/components/desk/ui";
import { ImportPanel } from "@/components/desk/import-panel";
import { toLocate } from "@/server/tl/import";

export const dynamic = "force-dynamic";

/** Load a fleet's trucks from a spreadsheet saved as CSV. */
export default async function ImportTrucksPage() {
  return (
    <>
      <PageHead title="Import trucks" sub="Add many trucks at once from a CSV. Each row is checked like the Add truck form; a name already in service, or repeated in the file, is left out.">
        <Link href="/fleet" className="tl-btn">All trucks</Link>
      </PageHead>
      <ImportPanel kind="trucks" toLocate={await toLocate()} />
    </>
  );
}
