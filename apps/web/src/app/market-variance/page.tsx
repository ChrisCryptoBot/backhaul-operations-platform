import React from "react";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isAuthBypassed } from "@/lib/auth-mode";
import { requireRegionAccess } from "@/lib/access";
import { resolvePhase1RegionId } from "@/lib/scope";
import { assertPermission, isPermissionAllowed } from "@/domain/policy/permissions";
import { PolicyViolationError } from "@/lib/policy-error";
import { AuthErrorState } from "@/components/auth/auth-error-state";
import { getPhase1RegionCode } from "@/lib/env";
import { AppShell } from "@/components/shell/app-shell";
import { getDatSettingsStatus } from "@/server/dat/settings";
import { listMarketVariance, syncLoadVariance } from "@/server/dat/variance-log";
import { MarketVarianceManager } from "./market-variance-manager";

export default async function MarketVariancePage() {
  const bypassAuth = isAuthBypassed();
  const { userId } = await auth();
  if (!bypassAuth && !userId) {
    redirect("/sign-in");
  }
  const actorUserId = userId ?? "dev-bypass-user";

  let regionId = "";
  let canWrite = bypassAuth;
  let viewerIsAdmin = bypassAuth;
  try {
    regionId = await resolvePhase1RegionId();
    if (!bypassAuth) {
      const access = await requireRegionAccess(actorUserId, regionId);
      assertPermission(access.role, { resource: "KPI_DASHBOARD", action: "READ" });
      canWrite = isPermissionAllowed(access.role, { resource: "KPI_DASHBOARD", action: "WRITE" });
      viewerIsAdmin = access.role === "ADMIN";
    }
  } catch (error) {
    const description =
      error instanceof PolicyViolationError
        ? "Forbidden — you don't have access to market analytics."
        : "Unable to load market variance right now.";
    return (
      <main className="db-root db-fallback-main">
        <AuthErrorState title="Market Variance" description={description} />
      </main>
    );
  }

  // Auto-log any newly-ingested loads into the tracker (idempotent, best-effort).
  try {
    await syncLoadVariance(regionId);
  } catch {
    /* never block the page on a sync hiccup */
  }
  const [log, datStatus] = await Promise.all([listMarketVariance(regionId), getDatSettingsStatus()]);

  return (
    <AppShell title="Market Variance" viewerIsAdmin={viewerIsAdmin} viewerCanManageReference={canWrite} regionCode={getPhase1RegionCode()}>
      <MarketVarianceManager initialLog={log} canWrite={canWrite} datLive={datStatus.hasKey && datStatus.isActive} />
    </AppShell>
  );
}
