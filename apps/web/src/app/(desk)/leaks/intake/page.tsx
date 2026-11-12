import Link from "next/link";
import React from "react";
import { PageHead } from "@/components/desk/ui";
import { LeakIntakeForm } from "@/components/desk/leaks/intake-form";
import { intakeIsEmpty } from "@/lib/leak-intake";
import { requirePage } from "@/server/tl/access";
import { getIntakeRoster, getLeakIntake } from "@/server/tl/leak-intake";

export const metadata = { title: "Leak Read intake · TrueLane" };
export const dynamic = "force-dynamic";

const n = (v: number) => v.toLocaleString("en-US");

/**
 * The Leak Read intake: what a mile costs the carrier and the detention terms they bill at. Imported history carries no floor frozen at booking and no frozen terms, so the Leak ledger prices it from these figures
 * and labels every such line. For the billing office (the `bill` capability), like the ledger itself.
 */
export default async function LeakIntakePage() {
  await requirePage("bill");
  const [intake, roster] = await Promise.all([getLeakIntake(), getIntakeRoster()]);
  const blind = roster.importedLoads - roster.withStopTimes;
  return (
    <>
      <PageHead title="Leak Read intake" sub="The few numbers an imported file cannot carry. The Leak ledger prices imported loads from them and says so on every line; nothing is taken from a market rate.">
        <Link href="/leaks?period=all" className="tl-btn">Leak ledger</Link>
        <Link href="/loads/import" className="tl-btn">Import loads</Link>
      </PageHead>
      <section className="tl-card">
        <h2>What this is for</h2>
        <p style={{ marginTop: 0, maxWidth: "78ch" }}>
          A load booked on the desk carries the floor and the detention terms frozen on it when it was accepted. A load imported from your TMS export carries neither, and today&apos;s cost profile is not what the truck cost on that day. So you say it once, here: what a mile costs
          you, and what you bill for waiting. The ledger then prices the empty miles, the shortfall under the floor and the detention on imported loads from these figures, as separate lines marked <b>intake, not frozen at booking</b>. It never mixes them with
          figures frozen on a load, and a load these figures cannot price is counted and left out of the dollars.
        </p>
        <p className="tl-sub" style={{ marginBottom: 0 }}>
          {roster.importedLoads === 0
            ? "No loads have been imported on this desk yet."
            : `${n(roster.importedLoads)} imported ${roster.importedLoads === 1 ? "load" : "loads"} on the desk; ${n(roster.withStopTimes)} ${roster.withStopTimes === 1 ? "carries" : "carry"} a wait at a stop, so detention can be priced on ${roster.withStopTimes === 1 ? "it" : "them"}${blind > 0 ? `; ${n(blind)} ${blind === 1 ? "has" : "have"} no stop times and ${blind === 1 ? "is" : "are"} counted, not priced.` : "."}`}
          {intakeIsEmpty(intake) ? " Nothing is filled in yet, so every imported load is counted and none is priced." : ""}
        </p>
      </section>
      <section className="tl-card">
        <LeakIntakeForm stored={intake} roster={roster} />
      </section>
    </>
  );
}
