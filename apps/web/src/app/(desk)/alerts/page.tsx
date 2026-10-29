import Link from "next/link";
import React from "react";
import { getAlerts } from "@/server/tl/alerts";
import { LEVEL_LABEL, type AlertLevel } from "@/lib/alerts";
import { PageHead, Tabs } from "@/components/desk/ui";
import { AlertList } from "@/components/desk/alert-bits";
import { EmptyState } from "@/components/desk/kit/states";

const LEVELS: AlertLevel[] = ["block", "warn", "info"];
const HEADING: Record<AlertLevel, string> = { block: "Fix before it goes out", warn: "Look at these soon", info: "For your information" };

export default async function AlertsPage({ searchParams }: { searchParams?: { level?: string } }) {
  const { alerts, counts } = await getAlerts();
  const level = LEVELS.find((l) => l === searchParams?.level) ?? null;
  const shown = level ? alerts.filter((a) => a.level === level) : alerts;

  return (
    <>
      <PageHead title="Alerts" sub="What needs attention across the loads. Worked out from the loads each time you open this page; nothing is stored. Each one opens its load.">
        <Link href="/settings/rules" className="tl-btn">How these are decided</Link>
      </PageHead>
      <Tabs
        active={level ?? "all"}
        hrefFor={(k) => (k === "all" ? "/alerts" : `/alerts?level=${k}`)}
        items={[{ key: "all", label: "All", count: alerts.length }, ...LEVELS.map((l) => ({ key: l, label: LEVEL_LABEL[l], count: counts[l] }))]}
      />
      {shown.length === 0 ? (
        <EmptyState icon="check" title="Nothing needs attention">Every open load has a driver where it needs one, and nothing is late.</EmptyState>
      ) : (
        LEVELS.filter((l) => shown.some((a) => a.level === l)).map((l) => (
          <section key={l} style={{ marginBottom: 24, maxWidth: 820 }}>
            <h2 style={{ fontFamily: "var(--db-font-sans)", fontSize: "var(--db-text-xs)", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--db-fg-dim)", fontWeight: 700, margin: "0 0 10px" }}>
              {HEADING[l]} · {shown.filter((a) => a.level === l).length}
            </h2>
            <AlertList alerts={shown.filter((a) => a.level === l)} withLoad />
          </section>
        ))
      )}
    </>
  );
}
