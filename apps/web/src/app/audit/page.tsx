import React from "react";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isAuthBypassed } from "@/lib/auth-mode";
import { resolvePhase1RegionId } from "@/lib/scope";
import { policyAdapter } from "@/domain/policy/policy-adapter";
import { isPermissionAllowed } from "@/domain/policy/permissions";
import { PolicyViolationError } from "@/lib/policy-error";
import { AuthErrorState } from "@/components/auth/auth-error-state";
import { PermissionDenied } from "@/components/ui/permission-denied";
import { getPhase1RegionCode } from "@/lib/env";
import { AppShell } from "@/components/shell/app-shell";
import { getAuditFilterOptions, listAuditLog } from "@/server/audit-read";
import { AuditBrowser } from "./audit-browser";

/**
 * Audit trail browser. Admin-only in production (SYSTEM_SETTINGS:READ, same gate as Settings);
 * in dev (BYPASS_AUTH) it is open so the page is browsable without Clerk.
 */
export default async function AuditPage() {
  const bypassAuth = isAuthBypassed();
  const { userId } = await auth();
  if (!bypassAuth && !userId) {
    redirect("/sign-in");
  }
  const actorUserId = userId ?? "dev-bypass-user";

  let viewerIsAdmin = bypassAuth;
  let viewerCanManageReference = bypassAuth;
  try {
    const regionId = await resolvePhase1RegionId();
    if (!bypassAuth) {
      const access = await policyAdapter.requireRegionAccess(actorUserId, regionId);
      policyAdapter.assertPermission(access, { resource: "SYSTEM_SETTINGS", action: "READ" });
      viewerIsAdmin = access.role === "ADMIN";
      viewerCanManageReference = isPermissionAllowed(access.role, { resource: "REFERENCE_DATA", action: "WRITE" });
    }
  } catch (error) {
    if (error instanceof PolicyViolationError) {
      return (
        <AppShell title="Audit" viewerIsAdmin={false} viewerCanManageReference={false} regionCode={getPhase1RegionCode()}>
          <PermissionDenied resource="AUDIT" />
        </AppShell>
      );
    }
    return (
      <main className="db-root db-fallback-main">
        <AuthErrorState title="Audit" description="Unable to load the audit log right now." />
      </main>
    );
  }

  const [initialPage, filterOptions] = await Promise.all([listAuditLog({ limit: 50 }), getAuditFilterOptions()]);

  return (
    <AppShell title="Audit" viewerIsAdmin={viewerIsAdmin} viewerCanManageReference={viewerCanManageReference} regionCode={getPhase1RegionCode()}>
      <AuditBrowser initialPage={initialPage} filterOptions={filterOptions} />
    </AppShell>
  );
}
