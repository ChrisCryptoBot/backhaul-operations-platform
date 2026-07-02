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
import { getOpenDeliveries } from "@/server/board";
import { mapBoardRowToView } from "@/lib/ui/board-mappers";
import { DeliveriesView } from "@/components/deliveries/deliveries-view";

/**
 * Global delivery watchlist — day-independent, unlike the Daily Tracker. Every open
 * delivery (not yet POD-received/completed) rolls forward here so an overdue one never
 * disappears when the coordinator moves to a new day.
 */
export default async function DeliveriesPage() {
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
      assertPermission(access.role, { resource: "BOARD", action: "READ" });
      canWrite = isPermissionAllowed(access.role, { resource: "REFERENCE_DATA", action: "WRITE" });
      viewerIsAdmin = access.role === "ADMIN";
    }
  } catch (error) {
    const description =
      error instanceof PolicyViolationError
        ? "Forbidden — you don't have access to the board."
        : "Unable to load deliveries right now.";
    return (
      <main className="db-root db-fallback-main">
        <AuthErrorState title="Deliveries" description={description} />
      </main>
    );
  }

  const { deliveries, asOf } = await getOpenDeliveries({ regionId });
  const rows = deliveries.map(mapBoardRowToView);

  return (
    <AppShell title="Deliveries" viewerIsAdmin={viewerIsAdmin} viewerCanManageReference={canWrite} regionCode={getPhase1RegionCode()}>
      <DeliveriesView deliveries={rows} asOf={asOf} />
    </AppShell>
  );
}
