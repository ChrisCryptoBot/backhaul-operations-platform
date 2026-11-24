import React from "react";
import { LoadView } from "@/components/desk/load-view";

/** A load reached from inside the desk opens over the page you were on. */
export default function LoadDrawer({ params }: { params: { id: string } }) {
  return <LoadView id={params.id} />;
}
