import Link from "next/link";
import React from "react";
import { PageHead, Tabs } from "@/components/desk/ui";
import { EmptyState } from "@/components/desk/kit/states";
import { LeakDrills, LeakHero, LeakLines, LeakOpenDwell, LeakTop, LeakWeeks } from "@/components/desk/leaks/ledger";
import { kpiHref, parseKpiParams } from "@/lib/kpi-params";
import { KPI_PERIODS, windowLabel } from "@/lib/kpi-periods";
import { requirePage } from "@/server/tl/access";
import { getLeakLedger } from "@/server/tl/leaks";
import { currentTerminal } from "@/server/tl/terminal";

export const metadata = { title: "Leak ledger · TrueLane" };
export const dynamic = "force-dynamic";

/**
 * The Leak Ledger: what the freight leaked, in dollars, by week and by line, with the loads behind each. For the billing office (the `bill` capability: an admin, accounting, or a dispatcher an admin
 * has allowed to bill), because it prices mistakes and choices in money. It reads the terminal in view, so the page says which it is.
 */
export default async function LeaksPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  await requirePage("bill");
  const params = parseKpiParams(searchParams);
  const terminal = await currentTerminal();
  const ledger = await getLeakLedger({ period: params.period, compare: params.compare, terminals: terminal ? [terminal] : null });
  const href = (over: Partial<typeof params>) => kpiHref("/leaks", params, over);
  const csv = (kind: string) => kpiHref(`/export/${kind}`, params);
  const empty = ledger.current.items === 0 && ledger.openDwell.trailers === 0;

  return (
    <>
      <PageHead title="Leak ledger" sub="What the freight leaked, in dollars, from the loads themselves. Every figure says what it is worked out on; a load that cannot be priced is counted and left out of the dollars.">
        <details className="menu">
          <summary className="tl-btn">Export CSV</summary>
          <div className="menu-pop">
            <a href={csv("leaks")}>By leak</a>
            <a href={csv("leaks-weeks")}>Twelve weeks</a>
            <a href={csv("leaks-items")}>The biggest items</a>
          </div>
        </details>
        <Link href="/kpi" className="tl-btn">KPI dashboard</Link>
      </PageHead>

      <div className="kbar">
        <Tabs active={params.period} hrefFor={(key) => href({ period: key as typeof params.period })} items={KPI_PERIODS} />
        {params.period !== "all" ? (
          <Link href={href({ compare: !params.compare })} className="tl-tab" aria-current={params.compare ? "true" : undefined} title="Show how each number moved against the period before">
            Compare with the period before
          </Link>
        ) : null}
      </div>
      <p className="tl-sub" style={{ margin: "0 0 14px" }}>
        {windowLabel(ledger.window)}
        {ledger.previous ? ` · compared with ${windowLabel(ledger.previous)}` : ""} · {terminal ? `${terminal} terminal` : "all terminals"}
      </p>

      {empty ? (
        <EmptyState icon="chart" title="No leaks found here">
          Nothing in this period was left unbilled, given up or run empty at a priced floor{terminal ? ` in the ${terminal} terminal` : ""}. Try All time{terminal ? ", or all terminals" : ""}.
        </EmptyState>
      ) : (
        <div className="kstack">
          <LeakHero ledger={ledger} />
          <LeakLines ledger={ledger} />
          <LeakWeeks ledger={ledger} />
          <LeakDrills ledger={ledger} />
          <LeakTop ledger={ledger} />
          <LeakOpenDwell ledger={ledger} />
          <details className="kc-how">
            <summary>How this is worked out</summary>
            <p>
              Empty miles are the miles driven before pickup and after delivery, priced at the break-even floor frozen on each load when it was accepted (before fuel); a load with no frozen floor is counted and not priced.
              Detention is the wait past the free time at the truck&apos;s detention rate, less what the invoice already carried. A TONU fee counts until it is on an invoice. Waived detention and lowered or waived trailer dwell are
              what a person chose to give up, read from the audit log with their reasons. Paid under the floor is what a load earned after its own fuel, tolls and costs, short of the floor times its miles driven; it already contains
              the empty miles, so it is shown but not added to the total. Nothing here is estimated from a market rate or a guess.
            </p>
          </details>
        </div>
      )}
    </>
  );
}
