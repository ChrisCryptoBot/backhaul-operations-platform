import Link from "next/link";
import React from "react";

/** Newer / Older links under a list that is read a page at a time (the Audit log, History, the fleet lists). `hrefFor` builds the address of another page. */
export function Pager({ page, pageSize, total, hrefFor, newer = "Newer", older = "Older" }: { page: number; pageSize: number; total: number; hrefFor: (page: number) => string; newer?: string; older?: string }) {
  if (total <= pageSize) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  return (
    <nav className="pager" aria-label="Pages">
      {page > 1 ? (
        <Link className="tl-btn sm" href={hrefFor(page - 1)}>
          {newer}
        </Link>
      ) : null}
      <span>
        {first}–{last} of {total}
      </span>
      {last < total ? (
        <Link className="tl-btn sm" href={hrefFor(page + 1)}>
          {older}
        </Link>
      ) : null}
    </nav>
  );
}
