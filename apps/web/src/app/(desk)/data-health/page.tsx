import { termList, scopeWords } from "@/lib/scope";
import Link from "next/link";
import React from "react";
import { PageHead, Tabs } from "@/components/desk/ui";
import { EmptyState } from "@/components/desk/kit/states";
import { CrossChecks, GapList, HealthHero, HowItWorks } from "@/components/desk/data-health/parts";
import { kpiHref, parseKpiParams } from "@/lib/kpi-params";
import { KPI_PERIODS, windowLabel } from "@/lib/kpi-periods";
import { requirePage } from "@/server/tl/access";
import { getDataHealth } from "@/server/tl/data-health";
import { currentTerminal } from "@/server/tl/terminal";

export const metadata = { title: "Data health · TrueLane" };
export const dynamic = "force-dynamic";

/**
 * Data health: how complete the desk's own records are, and where two sources that should agree do not. For the billing office, like the Leak ledger (a read of money and what it is built on). It reads the
 * terminals in view, so the page says which. The printable report is the same read on one sheet.
 */
export default async function DataHealthPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  await requirePage("bill");
  const params = parseKpiParams(searchParams);
  const terminal = await currentTerminal();
  const h = await getDataHealth({ period: params.period, terminals: termList(terminal) });
  const href = (over: Partial<typeof params>) => kpiHref("/data-health", params, over);
  const csv = (kind: string) => kpiHref(`/export/${kind}`, params);
  const nothing = h.counts.loads + h.counts.trucks + h.counts.drivers + h.counts.trailers === 0;

  return (
    <>
      <PageHead title="Data health" sub="How complete the desk's records are, and where two sources that should agree do not. Every figure says what it was counted on; a check that cannot be done says so.">
        <details className="menu">
          <summary className="tl-btn">Export CSV</summary>
          <div className="menu-pop">
            <a href={csv("data-health")}>What is missing</a>
            <a href={csv("data-health-checks")}>Cross-source checks</a>
          </div>
        </details>
        <Link href={kpiHref("/data-health/report", params)} className="tl-btn">Readiness report</Link>
      </PageHead>

      <div className="kbar">
        <Tabs active={params.period} hrefFor={(key) => href({ period: key as typeof params.period })} items={KPI_PERIODS} />
      </div>
      <p className="tl-sub" style={{ margin: "0 0 14px" }}>
        {windowLabel(h.window)} · {scopeWords(terminal) ?? "all terminals"}
      </p>

      {nothing ? (
        <EmptyState icon="chart" title="Nothing to check here">
          No finished loads, trucks, drivers or trailers{terminal != null ? ` in ${scopeWords(terminal)}` : ""} in this window. Try All time{terminal ? ", or all terminals" : ""}.
        </EmptyState>
      ) : (
        <div className="kstack">
          <HealthHero h={h} />
          <GapList checks={h.completeness.checks} />
          <CrossChecks h={h} />
          <HowItWorks />
        </div>
      )}
    </>
  );
}
