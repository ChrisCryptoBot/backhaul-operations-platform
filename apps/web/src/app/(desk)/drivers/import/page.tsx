import Link from "next/link";
import React from "react";
import { PageHead } from "@/components/desk/ui";
import { ImportPanel } from "@/components/desk/import-panel";

export const dynamic = "force-dynamic";

/** Load a roster of drivers from a spreadsheet saved as CSV. */
export default function ImportDriversPage() {
  return (
    <>
      <PageHead title="Import drivers" sub="Add many drivers at once from a CSV. Each row is checked like the Add driver form. The Truck column is a truck's name, so import the trucks first. The same name and phone as a driver already there is left out.">
        <Link href="/drivers" className="tl-btn">All drivers</Link>
      </PageHead>
      <ImportPanel kind="drivers" />
    </>
  );
}
