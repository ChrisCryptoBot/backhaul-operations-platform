import React from "react";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { resolvePhase1RegionId } from "@/lib/scope";
import { PolicyViolationError } from "@/lib/policy-error";
import { getBoardResponse } from "@/server/board";
import { isAuthBypassed } from "@/lib/auth-mode";
import { isIsoDay, todayIsoInTimeZone } from "@/lib/board-date";
import { mapBoardResponseToView } from "@/lib/ui/board-mappers";
import { AuthErrorState } from "@/components/auth/auth-error-state";
import { BoardShell } from "@/components/board/board-shell";
import { policyAdapter } from "@/domain/policy/policy-adapter";
import { isPermissionAllowed } from "@/domain/policy/permissions";
import { featureFlags } from "@/lib/feature-flags";
import { evaluateBoardBehavioralContract } from "@/lib/ui/behavioral-contracts";
import { listAccessibleRegions } from "@/server/kpi-governance";

interface HomePageProps {
  // Next.js 14 passes an object; newer versions may pass a Promise.
  searchParams?:
    | { [key: string]: string | string[] | undefined }
    | Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const publishableKey =
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? process.env.CLERK_PUBLISHABLE_KEY;
  const bypassAuth = isAuthBypassed();
  const allowMissingClerk = bypassAuth || process.env.NODE_ENV === "test";
  if (!publishableKey && !allowMissingClerk) {
    return (
      <main className="db-root db-fallback-main">
        <AuthErrorState
          title="Daily Load Tracker"
          description="Authentication is not configured in this environment."
          hint="Set Clerk publishable key env vars to enable sign-in and board access."
        />
      </main>
    );
  }

  const { userId } = await auth();
  if (!bypassAuth && !userId) {
    redirect("/sign-in");
  }
  const actorUserId = userId ?? "dev-bypass-user";

  let regionId = "";
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
          <AuthErrorState title="Daily Load Tracker" description="Forbidden" />
        </main>
      );
    }
    return (
      <main className="db-root db-fallback-main">
        <AuthErrorState title="Daily Load Tracker" description="Unable to load board data right now." />
      </main>
    );
  }
  const resolvedSearchParams = searchParams instanceof Promise ? await searchParams : searchParams;
  const queryDate = resolvedSearchParams?.date;
  const dateCandidate = Array.isArray(queryDate) ? queryDate[0] : queryDate;
  const date = isIsoDay(dateCandidate) ? dateCandidate : todayIsoInTimeZone();
  const queryRegion = resolvedSearchParams?.regionId;
  const regionCandidate = Array.isArray(queryRegion) ? queryRegion[0] : queryRegion;
  const queryLoad = resolvedSearchParams?.loadId;
  const loadCandidate = Array.isArray(queryLoad) ? queryLoad[0] : queryLoad;

  let boardResponse = null;
  let boardError: string | null = null;
  try {
    const availableRegions = await listAccessibleRegions(userId ?? null);
    const selectedRegionId =
      regionCandidate && availableRegions.some((region) => region.id === regionCandidate)
        ? regionCandidate
        : regionId;
    if (!bypassAuth && selectedRegionId !== regionId) {
      await policyAdapter.requireRegionAccess(actorUserId, selectedRegionId);
    }
    boardResponse = await getBoardResponse({ regionId: selectedRegionId, date });
    boardResponse.availableRegions = availableRegions;
    boardResponse.activeRegionId = selectedRegionId;
  } catch {
    boardError = "Unable to load board data right now.";
  }

  if (!boardResponse) {
    return (
      <main className="db-root db-fallback-main">
        <AuthErrorState title="Daily Load Tracker" description={boardError ?? "Unable to load board data right now."} />
      </main>
    );
  }
  if (featureFlags.enableBehavioralUxContracts) {
    const behavioral = evaluateBoardBehavioralContract(boardResponse);
    if (!behavioral.ok) {
      return (
        <main className="db-root db-fallback-main">
          <AuthErrorState title="Daily Load Tracker" description={`Behavioral contract violation: ${behavioral.violations.join("; ")}`} />
        </main>
      );
    }
  }

  const board = mapBoardResponseToView(boardResponse);
  return (
    <BoardShell
      board={board}
      boardError={boardError}
      initialHighlightLoadId={loadCandidate ?? null}
      viewerIsAdmin={viewerIsAdmin}
      viewerCanManageReference={viewerCanManageReference}
    />
  );
}
