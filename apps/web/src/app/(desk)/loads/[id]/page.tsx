import { notFound } from "next/navigation";
import React from "react";
import { getLoadDetail } from "@/server/tl/queries";
import LoadsPage from "../page";

export const metadata = { title: "Load · TrueLane" };

/** There is no load page: an address like /loads/abc is the Loads board with that load's drawer open over it (@drawer/loads/[id]). An id that is not a load of this desk, or not one this person may see, is not found. */
export default async function LoadAddress({ params }: { params: { id: string } }) {
  if (!(await getLoadDetail(params.id))) notFound();
  return <LoadsPage />;
}
