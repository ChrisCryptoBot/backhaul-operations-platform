import React from "react";
import { LoadView } from "@/components/desk/load-view";

/** Intercepts /loads/[id] when it is reached from inside the desk, so the load opens over the page you were on. */
export default function LoadDrawer({ params }: { params: { id: string } }) {
  return <LoadView id={params.id} variant="drawer" />;
}
