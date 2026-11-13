import React from "react";
import Link from "next/link";
import { PageHead } from "@/components/desk/ui";
import { ShowcaseBoard } from "@/components/desk/showcase-board";
import { EmptyState } from "@/components/desk/kit/states";
import { showcaseAllowed, showcaseSnapshot } from "@/server/partners/showcase";
import { requirePage } from "@/server/tl/access";

export const metadata = { title: "Partner showcase · TrueLane" };
export const dynamic = "force-dynamic";

/**
 * The partner showcase (docs/MONEY_PLAN.md, Wave 7 step 5): one load's life through every built-in simulator, the signed webhooks and the read API, in a fleet of its own. Admins only, and
 * only where the simulator is allowed; on a live desk it says so and does nothing.
 */
export default async function PartnerShowcasePage() {
  await requirePage("admin");
  if (!showcaseAllowed()) {
    return (
      <>
        <PageHead title="Partner showcase" />
        <EmptyState icon="alert" title="Not on a live desk">
          The showcase runs only where the built-in simulator is allowed (the demo desk). On a desk with sign-in on it never runs, so no real fleet&apos;s data or keys are ever near it.
        </EmptyState>
      </>
    );
  }
  const cards = await showcaseSnapshot();
  return (
    <>
      <PageHead
        title="Partner showcase"
        sub="One load from the road to the books, through each of the desk's simulators, then out through a signed webhook and back in through the read API. Every figure is what the desk itself recorded.">
        <Link href="/settings?tab=integrations" className="tl-btn">
          Integrations
        </Link>
      </PageHead>
      <ShowcaseBoard initial={cards} />
    </>
  );
}
