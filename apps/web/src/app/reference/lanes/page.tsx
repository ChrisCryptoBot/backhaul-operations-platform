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
import { listLanes } from "@/server/reference";
import { LanesManager } from "./lanes-manager";

export default async function LanesPage() {
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
      assertPermission(access.role, { resource: "REFERENCE_DATA", action: "READ" });
      canWrite = isPermissionAllowed(access.role, { resource: "REFERENCE_DATA", action: "WRITE" });
      viewerIsAdmin = access.role === "ADMIN";
    }
  } catch (error) {
    const description =
      error instanceof PolicyViolationError
        ? "Forbidden — you don't have access to reference data."
        : "Unable to load reference data right now.";
    return (
      <main className="db-root db-fallback-main">
        <AuthErrorState title="Lanes" description={description} />
      </main>
    );
  }

  const lanes = await listLanes({ regionId });

  return (
    <AppShell title="Lanes" viewerIsAdmin={viewerIsAdmin} viewerCanManageReference={canWrite} regionCode={getPhase1RegionCode()}>
      <LanesManager initialLanes={lanes} canWrite={canWrite} />
    </AppShell>
  );
}
