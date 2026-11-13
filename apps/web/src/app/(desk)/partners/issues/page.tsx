import React from "react";
import Link from "next/link";
import { PageHead } from "@/components/desk/ui";
import { IssuesBoard } from "@/components/desk/issues-board";
import { dateTime } from "@/lib/desk-format";
import { can } from "@/lib/roles";
import { listIssues } from "@/server/partners/issues";
import { requirePage } from "@/server/tl/access";
import { currentWorkspaceId } from "@/server/tl/workspace";

export const metadata = { title: "Partner issues · TrueLane" };
export const dynamic = "force-dynamic";

/**
 * Partner issues (docs/MONEY_PLAN.md, Wave 7 step 4): what went wrong between the desk and a company, in one place. The billing office reads it; an admin runs things again and settles them
 * (D5). The rules for what is safe to run again are in server/partners/issues.ts.
 */
export default async function PartnerIssuesPage() {
  const me = await requirePage("bill");
  const canAct = can(me.role, me.grants, "admin");
  const issues = await listIssues(currentWorkspaceId());
  return (
    <>
      <PageHead
        title="Partner issues"
        sub="Company events the desk could not use, webhook deliveries that did not get through, connections that stopped, and sign-ins that are running out. Running something again is safe: an event already applied is never applied twice.">
        <Link href="/settings?tab=integrations" className="tl-btn">
          Integrations
        </Link>
      </PageHead>
      <IssuesBoard
        canAct={canAct}
        inbound={issues.inbound.map((e) => ({ ...e, receivedAt: dateTime(e.receivedAt), attemptedAt: e.attemptedAt ? dateTime(e.attemptedAt) : null }))}
        outbound={issues.outbound.map((d) => ({ ...d, nextAttemptAt: dateTime(d.nextAttemptAt), createdAt: dateTime(d.createdAt) }))}
        syncs={issues.syncs.map((s) => ({ ...s, lastSyncedAt: s.lastSyncedAt ? dateTime(s.lastSyncedAt) : null }))}
        signIns={issues.signIns.map((t) => ({ ...t, runsOutAt: t.runsOutAt ? dateTime(t.runsOutAt) : null }))}
      />
    </>
  );
}
