import Link from "next/link";
import React from "react";
import { EmptyState } from "@/components/desk/kit/states";

export default function DeskNotFound() {
  return (
    <EmptyState
      icon="search"
      title="That page does not exist"
      action={
        <Link href="/loads" className="tl-btn primary">
          Back to loads
        </Link>
      }>
      The link may be old, or the load was removed.
    </EmptyState>
  );
}
