import Link from "next/link";
import React from "react";

/** One entry door for adding a load (price an offer or upload a rate confirmation in Quote). */
export function NewLoad() {
  return (
    <Link href="/quote" className="tl-btn primary">
      New load
    </Link>
  );
}
