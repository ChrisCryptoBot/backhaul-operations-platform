import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolvePhase1RegionId } from "@/lib/scope";
import { POLICY_FORBIDDEN_MESSAGE, PolicyViolationError } from "@/lib/policy-error";
import { isAuthBypassed } from "@/lib/auth-mode";
import { policyAdapter } from "@/domain/policy/policy-adapter";
import { bookingPlanMutationSchema } from "@/contracts/reference";
import {
  bookBookingPlanEntry,
  createBookingPlanEntry,
  listBookingPlanEntries,
  softDeleteBookingPlanEntry,
  updateBookingPlanEntry
} from "@/server/reference";

const planDateQuerySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

async function resolveReferenceRegion(input: {
  requestedRegionId: string | null | undefined;
  bypassAuth: boolean;
}): Promise<string> {
  if (input.requestedRegionId && input.requestedRegionId.trim().length > 0) {
    return input.requestedRegionId.trim();
  }
  if (input.bypassAuth) {
    try {
      return await resolvePhase1RegionId();
    } catch {
      return "dev-region";
    }
  }
  return resolvePhase1RegionId();
}

export async function GET(request: Request) {
  try {
    const { userId } = await auth();
    const bypassAuth = isAuthBypassed();
    if (!bypassAuth && !userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const actorUserId = userId ?? "dev-bypass-user";

    const { searchParams } = new URL(request.url);
    const requestedRegionId = searchParams.get("regionId");
    const planDateParam = searchParams.get("planDate");
    const planDate = planDateParam == null ? undefined : planDateQuerySchema.parse(planDateParam);

    const regionId = await resolveReferenceRegion({ requestedRegionId, bypassAuth });
    if (!bypassAuth) {
      const access = await policyAdapter.requireRegionAccess(actorUserId, regionId);
      policyAdapter.assertPermission(access, { resource: "REFERENCE_DATA", action: "READ" });
    }

    const entries = await listBookingPlanEntries({ regionId, planDate });
    return NextResponse.json({ regionId, entries }, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid query params", details: error.issues }, { status: 400 });
    }
    if (error instanceof PolicyViolationError) {
      return NextResponse.json({ error: POLICY_FORBIDDEN_MESSAGE }, { status: 403 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { userId } = await auth();
    const bypassAuth = isAuthBypassed();
    if (!bypassAuth && !userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const actorUserId = userId ?? "dev-bypass-user";
    const body = bookingPlanMutationSchema.parse(await request.json());

    const regionId = await resolveReferenceRegion({ requestedRegionId: body.regionId, bypassAuth });
    if (!bypassAuth) {
      const access = await policyAdapter.requireRegionAccess(actorUserId, regionId);
      policyAdapter.assertPermission(access, { resource: "REFERENCE_DATA", action: "WRITE" });
    }

    let bookedLoadId: string | null = null;
    if (body.action === "create_booking_plan_entry") {
      await createBookingPlanEntry({
        regionId,
        actorId: actorUserId,
        fields: {
          planDate: body.entry.planDate,
          driverId: body.entry.driverId,
          expectedEmptyAt: body.entry.expectedEmptyAt ?? null,
          emptyCity: body.entry.emptyCity ?? null,
          emptyState: body.entry.emptyState ?? null,
          emptyCityAlt: body.entry.emptyCityAlt ?? null,
          backhaulNote: body.entry.backhaulNote ?? null,
          status: body.entry.status ?? "NEEDS_BACKHAUL",
          brokerId: body.entry.brokerId ?? null,
          bookedAmount: body.entry.bookedAmount ?? null,
          puCityDh: body.entry.puCityDh ?? null,
          puTimes: body.entry.puTimes ?? null,
          delCityDh: body.entry.delCityDh ?? null,
          delTimes: body.entry.delTimes ?? null
        }
      });
    } else if (body.action === "update_booking_plan_entry") {
      await updateBookingPlanEntry({ regionId, actorId: actorUserId, entryId: body.entryId, fields: body.fields });
    } else if (body.action === "delete_booking_plan_entry") {
      await softDeleteBookingPlanEntry({ regionId, actorId: actorUserId, entryId: body.entryId, reason: body.reason });
    } else if (body.action === "book_booking_plan_entry") {
      const result = await bookBookingPlanEntry({ regionId, actorId: actorUserId, entryId: body.entryId });
      bookedLoadId = result.loadId;
    }

    const entries = await listBookingPlanEntries({ regionId });
    return NextResponse.json({ regionId, entries, bookedLoadId }, { status: 200 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request payload", details: error.issues }, { status: 400 });
    }
    if (error instanceof PolicyViolationError) {
      return NextResponse.json({ error: POLICY_FORBIDDEN_MESSAGE }, { status: 403 });
    }
    if (
      error instanceof Error &&
      (error.message.includes("in use") || error.message.includes("already exists") || error.message.includes("already booked"))
    ) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof Error && error.message.includes("not found")) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
