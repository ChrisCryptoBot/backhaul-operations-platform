import React from "react";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isAuthBypassed } from "@/lib/auth-mode";
import { resolvePhase1RegionId } from "@/lib/scope";
import { PolicyViolationError } from "@/lib/policy-error";
import { policyAdapter } from "@/domain/policy/policy-adapter";
import { isPermissionAllowed } from "@/domain/policy/permissions";
import { getKpiDashboard } from "@/server/kpi-dashboard";
import { weekIsoFromPickup } from "@/lib/week";
import { KpiDashboard } from "@/components/kpi/kpi-dashboard";
import { listAccessibleRegions } from "@/server/kpi-governance";
import { AuthErrorState } from "@/components/auth/auth-error-state";
import type { KpiDashboardFilters } from "@/server/kpi-dashboard";

function previousWeekIso(): string {
  const previousWeek = new Date();
  previousWeek.setDate(previousWeek.getDate() - 7);
  return weekIsoFromPickup(previousWeek);
}

interface DashboardPageProps {
  searchParams?: {
    weekIso?: string | string[];
    comparisonMode?: string | string[];
    weeks?: string | string[];
    lane?: string | string[];
    broker?: string | string[];
    lot?: string | string[];
    severity?: string | string[];
    regionId?: string | string[];
  };
}

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const bypassAuth = isAuthBypassed();
  const { userId } = await auth();
  if (!bypassAuth && !userId) {
    redirect("/sign-in");
  }
  const actorUserId = userId ?? "dev-bypass-user";

  let regionId = "dev-region";
  let viewerIsAdmin = bypassAuth;
  let viewerCanManageReference = bypassAuth;
  try {
    regionId = await resolvePhase1RegionId();
    if (!bypassAuth) {
      const access = await policyAdapter.requireRegionAccess(actorUserId, regionId);
      viewerIsAdmin = access.role === "ADMIN";
      viewerCanManageReference = isPermissionAllowed(access.role, { resource: "REFERENCE_DATA", action: "WRITE" });
    }
  } catch (error) {
    if (error instanceof PolicyViolationError) {
      return (
        <main className="db-root db-fallback-main">
          <AuthErrorState title="KPI Dashboard" description="Forbidden" />
        </main>
      );
    }
    return (
      <main className="db-root db-fallback-main">
        <AuthErrorState title="KPI Dashboard" description="Unable to load KPI dashboard right now." />
      </main>
    );
  }

  const weekIsoParam = searchParams?.weekIso;
  const weekIso = typeof weekIsoParam === "string" ? weekIsoParam : previousWeekIso();
  const comparisonModeParam = typeof searchParams?.comparisonMode === "string" ? searchParams.comparisonMode : undefined;
  const comparisonMode = comparisonModeParam === "rolling4" || comparisonModeParam === "qtd" ? comparisonModeParam : "wow";
  const weeksParam = typeof searchParams?.weeks === "string" ? Number(searchParams.weeks) : undefined;
  const weeks = Number.isFinite(weeksParam) ? Math.max(4, Math.min(52, Number(weeksParam))) : 12;
  const requestedRegionId = typeof searchParams?.regionId === "string" ? searchParams.regionId : undefined;
  const regionFilter = requestedRegionId && bypassAuth ? requestedRegionId : regionId;
  let data;
  try {
    const filters: KpiDashboardFilters = {
      lane: typeof searchParams?.lane === "string" ? searchParams.lane : undefined,
      broker: typeof searchParams?.broker === "string" ? searchParams.broker : undefined,
      lot: typeof searchParams?.lot === "string" ? searchParams.lot : undefined,
      severity:
        typeof searchParams?.severity === "string" &&
        (searchParams.severity === "INFO" || searchParams.severity === "WARN" || searchParams.severity === "ACTION_REQUIRED")
          ? searchParams.severity
          : undefined
    };
    data = await getKpiDashboard({
      regionId: regionFilter,
      weekIso,
      comparisonMode,
      weeks,
      filters
    });
    (data as { regions?: Array<{ id: string; code: string; name: string }>; activeRegionId?: string }).regions =
      await listAccessibleRegions(userId ?? null);
    (data as { regions?: Array<{ id: string; code: string; name: string }>; activeRegionId?: string }).activeRegionId =
      regionFilter;
  } catch {
    return (
      <main className="db-root db-fallback-main">
        <AuthErrorState title="KPI Dashboard" description="Unable to load KPI dashboard right now." />
      </main>
    );
  }
  return (
    <KpiDashboard
      initialData={data}
      viewerIsAdmin={viewerIsAdmin}
      viewerCanManageReference={viewerCanManageReference}
    />
  );
}
