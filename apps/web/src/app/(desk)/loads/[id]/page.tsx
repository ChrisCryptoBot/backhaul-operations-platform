import React from "react";
import { LoadView } from "@/components/desk/load-view";

/** The load as a page: what you get on a direct link or a reload. From the board it opens as a drawer instead (see @drawer). */
export default function LoadPage({ params }: { params: { id: string } }) {
  return <LoadView id={params.id} variant="page" />;
}
