import React from "react";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isAuthBypassed } from "@/lib/auth-mode";
import { resolvePhase1RegionId } from "@/lib/scope";
import { PolicyViolationError } from "@/lib/policy-error";
import { getRateConfirmationForReview } from "@/server/review";
import { AuthErrorState } from "@/components/auth/auth-error-state";
import { policyAdapter } from "@/domain/policy/policy-adapter";
import { ReviewPanel } from "./review-panel";

interface ReviewPageProps {
  searchParams?: {
    rateConfirmationId?: string;
    regionId?: string;
  };
}

export default async function ReviewPage({ searchParams }: ReviewPageProps) {
  const bypassAuth = isAuthBypassed();
  const { userId } = await auth();
  if (!bypassAuth && !userId) {
    redirect("/sign-in");
  }
  const actorUserId = userId ?? "dev-bypass-user";

  let regionId = "dev-region";
  try {
    const requestedRegionId =
      typeof searchParams?.regionId === "string" && searchParams.regionId.trim().length > 0
        ? searchParams.regionId.trim()
        : null;
    if (requestedRegionId) {
      regionId = requestedRegionId;
    } else if (!bypassAuth) {
      regionId = await resolvePhase1RegionId();
    } else {
      try {
        regionId = await resolvePhase1RegionId();
      } catch {
        regionId = "dev-region";
      }
    }
    if (!bypassAuth) {
      const access = await policyAdapter.requireRegionAccess(actorUserId, regionId);
      policyAdapter.assertPermission(access, { resource: "RATE_CONFIRMATION_REVIEW", action: "READ" });
    }
  } catch (error) {
    if (!bypassAuth && error instanceof PolicyViolationError) {
      return (
        <main className="db-root db-fallback-main">
          <AuthErrorState title="Review Queue" description="Forbidden" />
        </main>
      );
    }
  }

  const rateConfirmationId = searchParams?.rateConfirmationId ?? null;
  if (!rateConfirmationId) {
    return (
      <main className="db-root db-fallback-main">
        <AuthErrorState title="Review Queue" description="Select a ready item from the board footer to begin review." />
      </main>
    );
  }

  const payload = await getRateConfirmationForReview({
    regionId,
    rateConfirmationId
  });
  if (!payload) {
    return (
      <main className="db-root db-fallback-main">
        <AuthErrorState title="Review Queue" description="Rate confirmation not found." />
      </main>
    );
  }

  return <ReviewPanel initial={payload} regionId={regionId} />;
}
