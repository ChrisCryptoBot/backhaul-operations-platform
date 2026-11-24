import React from "react";
import { LEVEL_LABEL, RULES, topLevel, type Alert } from "@/lib/alerts";
import { RowLink } from "./ui";

/** A small coloured dot for a table row: the most serious alert on the load, with every message as its tooltip. */
export function AlertDot({ alerts }: { alerts: Alert[] | undefined }) {
  const level = topLevel(alerts);
  if (!level || !alerts) return null;
  const text = alerts.map((a) => a.message).join(" ");
  return <span className={`al-dot ${level}`} title={text} role="img" aria-label={`${LEVEL_LABEL[level]} alert: ${text}`} />;
}

/** The alerts one by one. With `withLoad` each names its load and the row opens it. */
export function AlertList({ alerts, withLoad }: { alerts: Alert[]; withLoad?: boolean }) {
  return (
    <div className="al-list">
      {alerts.map((a) => {
        const rule = RULES.find((r) => r.code === a.code)?.title ?? a.code;
        const inner = (
          <>
            <span className="lvl">{LEVEL_LABEL[a.level]}</span>
            <div>{a.message}</div>
          </>
        );
        return withLoad ? (
          <div key={a.key} className="al row-open" data-level={a.level}>
            <span className="lvl">{LEVEL_LABEL[a.level]}</span>
            <div>
              <RowLink href={`/loads/${a.loadId}`}>{a.message}</RowLink>
              <div className="who">{a.loadNumber ?? "Load"} · {rule}</div>
            </div>
            <i className="row-go" aria-hidden="true">›</i>
          </div>
        ) : (
          <div key={a.key} className="al" data-level={a.level}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}
