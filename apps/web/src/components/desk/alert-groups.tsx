import Link from "next/link";
import React from "react";
import { LEVEL_LABEL } from "@/lib/alerts";
import type { AlertGroup } from "@/lib/alert-groups";
import { RowLink } from "./ui";

/** Loads named on a line before "all 43". */
const NAMED = 8;
/** Loads with their own words shown before the rest are one press away. */
const SAID = 3;

/**
 * The to-do list: each problem once. On one load, the whole row opens it. On several that all say the same, the loads are named on the line. On several that each say their own, the first few are listed under it.
 */
export function AlertGroups({ groups, allHref }: { groups: AlertGroup[]; allHref: (g: AlertGroup) => string }) {
  return (
    <div className="al-list">
      {groups.map((g) => {
        const one = g.loads.length === 1 ? g.loads[0]! : null;
        const own = g.loads.some((l) => l.detail != null);
        if (one)
          return (
            <div key={g.key} className="al row-open" data-level={g.level}>
              <span className="lvl">{LEVEL_LABEL[g.level]}</span>
              <div>
                <RowLink href={`/loads/${one.loadId}`}>{one.detail ?? g.title}</RowLink>
                <div className="who">{one.loadNumber ?? "Load"}</div>
              </div>
              <i className="row-go" aria-hidden="true">›</i>
            </div>
          );
        return (
          <div key={g.key} className="al many" data-level={g.level}>
            <span className="lvl">{LEVEL_LABEL[g.level]}</span>
            <div>
              {g.title}
              {own ? (
                <ul className="al-own">
                  {g.loads.slice(0, SAID).map((l) => (
                    <li key={l.key}>
                      <Link href={`/loads/${l.loadId}`}>{l.loadNumber ?? "Load"}</Link> <span>{l.detail}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="who al-loads">
                  {g.loads.slice(0, NAMED).map((l) => (
                    <Link key={l.key} href={`/loads/${l.loadId}`}>
                      {l.loadNumber ?? "Load"}
                    </Link>
                  ))}
                </div>
              )}
            </div>
            {g.loads.length > (own ? SAID : NAMED) ? (
              <Link href={allHref(g)} className="tl-btn ghost sm">
                All {g.loads.length}
              </Link>
            ) : (
              <span className="al-n">{g.loads.length} loads</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
