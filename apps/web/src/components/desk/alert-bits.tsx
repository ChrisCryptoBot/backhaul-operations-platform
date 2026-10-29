import Link from "next/link";
import React from "react";
import { LEVEL_LABEL, RULES, topLevel, type Alert } from "@/lib/alerts";

/** A small coloured dot for a table row: the most serious alert on the load, with every message as its tooltip. */
export function AlertDot({ alerts }: { alerts: Alert[] | undefined }) {
  const level = topLevel(alerts);
  if (!level || !alerts) return null;
  const text = alerts.map((a) => a.message).join(" ");
  return <span className={`al-dot ${level}`} title={text} role="img" aria-label={`${LEVEL_LABEL[level]} alert: ${text}`} />;
}

/** The alerts as a list. With `withLoad` each one names its load and links to it. */
export function AlertList({ alerts, withLoad }: { alerts: Alert[]; withLoad?: boolean }) {
  return (
    <div className="al-list">
      {alerts.map((a) => {
        const rule = RULES.find((r) => r.code === a.code)?.title ?? a.code;
        const inner = (
          <>
            <span className="lvl">{LEVEL_LABEL[a.level]}</span>
            <div>
              {a.message}
              {withLoad ? <div className="who">{a.loadNumber ?? "Load"} · {rule}</div> : null}
            </div>
          </>
        );
        return withLoad ? (
          <Link key={a.key} href={`/loads/${a.loadId}`} className="al" data-level={a.level}>
            {inner}
          </Link>
        ) : (
          <div key={a.key} className="al" data-level={a.level}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}
