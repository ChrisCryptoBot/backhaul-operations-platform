import React from "react";
import { LoadView } from "@/components/desk/load-view";

/** A load opened by its address (a link in a message, a bookmark, a reload): the same drawer, over the Loads board (app/(desk)/loads/[id]). */
export default function LoadDrawerByAddress({ params }: { params: { id: string } }) {
  return <LoadView id={params.id} />;
}
