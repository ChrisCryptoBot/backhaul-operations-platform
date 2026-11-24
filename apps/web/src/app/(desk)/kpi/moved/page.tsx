import { termList, scopeWords } from "@/lib/scope";
import Link from "next/link";
import React from "react";
import { PageHead, Tabs } from "@/components/desk/ui";
import { EmptyState } from "@/components/desk/kit/states";
import { DeskBridge, MoveList, MovesHero, MovesHow } from "@/components/desk/moves/moves";
import { requirePage } from "@/server/tl/access";
import { MAX_AGO, getMoves } from "@/server/tl/moves";
import { getCashMoves } from "@/server/tl/cash";
import { CashMovesCard } from "@/components/desk/moves/cash";
import { currentTerminal } from "@/server/tl/terminal";

export const metadata = { title: "Why it moved · TrueLane" };
export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Why it moved: what the desk made this week against the week before, and which lane or customer moved it and why (rate, loaded miles, empty miles, what a mile cost, the fuel surcharge, TONU and layover pay,
 * detention). For the billing office, like the Leak Ledger, because it sets results against costs. It reads the terminal in view, so the page says which it is.
 */
export default async function MovedPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  await requirePage("bill");
  const by = one(searchParams?.by) === "customer" ? "customer" : "lane";
  const asked = Number.parseInt(one(searchParams?.ago) ?? "0", 10);
  const ago = Number.isInteger(asked) && asked >= 0 && asked <= MAX_AGO ? asked : 0;
  const terminal = await currentTerminal();
  const [m, cash] = await Promise.all([getMoves({ ago, by, terminals: termList(terminal) }), getCashMoves({ ago, by, terminals: termList(terminal) })]);
  const href = (over: { by?: string; ago?: number }) => {
    const p = new URLSearchParams();
    const b = over.by ?? by;
    const a = over.ago ?? ago;
    if (b !== "lane") p.set("by", b);
    if (a > 0) p.set("ago", String(a));
    const q = p.toString();
    return q ? `/kpi/moved?${q}` : "/kpi/moved";
  };
  const empty = m.desk.before.loads === 0 && m.desk.after.loads === 0;

  return (
    <>
      <PageHead title="Why it moved" sub={`The week ending ${m.after.label} against the week ending ${m.before.label}, and what moved it. The effects add back to the change to the cent.`}>
        {ago < MAX_AGO ? (
          <Link href={href({ ago: ago + 1 })} className="tl-btn">
            Earlier week
          </Link>
        ) : null}
        {ago > 0 ? (
          <Link href={href({ ago: ago - 1 })} className="tl-btn">
            Later week
          </Link>
        ) : null}
        <Link href="/kpi" className="tl-btn">
          KPI dashboard
        </Link>
      </PageHead>
      <div className="kbar">
        <Tabs label="Broken down by" active={by} hrefFor={(b) => href({ by: b })} items={[{ key: "lane", label: "By lane" }, { key: "customer", label: "By customer" }]} />
      </div>
      <div className="kstack">
      {empty ? (
        <EmptyState icon="inbox" title="No finished loads in either week">
          There is nothing to compare for the weeks ending {m.after.label} and {m.before.label}. Try an earlier week.
        </EmptyState>
      ) : (
        <>
          <MovesHero m={m} />
          <DeskBridge m={m} />
          <MoveList m={m} />
          <MovesHow m={m} />
        </>
      )}
      <CashMovesCard c={cash} before={m.before.label} after={m.after.label} by={by} />
      </div>
    </>
  );
}
