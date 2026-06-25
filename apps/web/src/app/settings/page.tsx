import React from "react";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isAuthBypassed } from "@/lib/auth-mode";
import { requireRegionAccess } from "@/lib/access";
import { resolvePhase1RegionId } from "@/lib/scope";
import { assertPermission } from "@/domain/policy/permissions";
import { PolicyViolationError } from "@/lib/policy-error";
import { AuthErrorState } from "@/components/auth/auth-error-state";
import { PermissionDenied } from "@/components/ui/permission-denied";
import { getPhase1RegionCode } from "@/lib/env";
import { AppShell } from "@/components/shell/app-shell";
import { getLlmSettingsStatus } from "@/server/llm/settings";
import { SUPPORTED_PROVIDERS } from "@/server/llm/registry";
import { getRegionConfig } from "@/server/region-config";
import { SettingsForm } from "./settings-form";

export default async function SettingsPage() {
  const bypassAuth = isAuthBypassed();
  const { userId } = await auth();
  if (!bypassAuth && !userId) {
    redirect("/sign-in");
  }
  const actorUserId = userId ?? "dev-bypass-user";

  try {
    if (!bypassAuth) {
      const regionId = await resolvePhase1RegionId();
      const access = await requireRegionAccess(actorUserId, regionId);
      assertPermission(access.role, { resource: "SYSTEM_SETTINGS", action: "READ" });
    }
  } catch (error) {
    if (error instanceof PolicyViolationError) {
      return (
        <AppShell title="Settings" viewerIsAdmin={false} viewerCanManageReference={false} regionCode={getPhase1RegionCode()}>
          <PermissionDenied resource="SYSTEM_SETTINGS" />
        </AppShell>
      );
    }
    return (
      <main className="db-root db-fallback-main">
        <AuthErrorState title="Settings" description="Unable to load settings right now." />
      </main>
    );
  }

  const status = await getLlmSettingsStatus();
  const thresholds = await getRegionConfig(await resolvePhase1RegionId());

  return (
    <AppShell title="Settings" viewerIsAdmin viewerCanManageReference regionCode={getPhase1RegionCode()}>
      <SettingsForm initialStatus={status} supportedProviders={SUPPORTED_PROVIDERS} initialThresholds={thresholds} />
    </AppShell>
  );
}
