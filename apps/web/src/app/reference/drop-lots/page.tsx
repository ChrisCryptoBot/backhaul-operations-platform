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
import { listDropLots } from "@/server/reference";
import { DropLotsManager } from "./drop-lots-manager";

export default async function DropLotsPage() {
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
        <AuthErrorState title="Drop lots" description={description} />
      </main>
    );
  }

  const dropLots = await listDropLots({ regionId });

  return (
    <AppShell title="Drop lots" viewerIsAdmin={viewerIsAdmin} viewerCanManageReference={canWrite} regionCode={getPhase1RegionCode()}>
      <DropLotsManager initialDropLots={dropLots} canWrite={canWrite} />
    </AppShell>
  );
}
