"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { assignDriver, dispatchLoad, DispatchError, recordDriverResponse } from "@/server/tl/dispatch";
import type { PayKind } from "@/server/tl/projector";
import { readRateCon } from "@/server/ratecon/reader";
import { saveReviewedDraft, type ReviewedDraft } from "@/server/ratecon/save";
import type { RateConLoadDraft } from "@/server/ratecon/map";

/**
 * Server actions for the desk. Each one runs the same functions the tests run, then sends the page back with a
 * short note (?note=...) or an error (?error=...) so the result is visible without client state.
 */
function back(loadId: string, key: "note" | "error", text: string): never {
  redirect(`/loads/${loadId}?${key}=${encodeURIComponent(text)}`);
}

async function attempt(loadId: string, fn: () => Promise<string>): Promise<never> {
  let note: string;
  try {
    note = await fn();
  } catch (e) {
    if (e instanceof DispatchError) return back(loadId, "error", e.message);
    throw e;
  }
  revalidatePath("/loads");
  revalidatePath("/dispatch");
  revalidatePath("/kpi");
  return back(loadId, "note", note);
}

export async function assignAction(formData: FormData) {
  const loadId = String(formData.get("loadId"));
  await attempt(loadId, async () => {
    const rate = Number(formData.get("rate"));
    await assignDriver({ loadId, driverId: String(formData.get("driverId")), pay: { kind: String(formData.get("payKind")) as PayKind, rate } });
    return "Driver assigned. Send it when you are ready.";
  });
}

export async function sendAction(formData: FormData) {
  const loadId = String(formData.get("loadId"));
  await attempt(loadId, async () => {
    await dispatchLoad(loadId);
    return "Sent to the driver.";
  });
}

export async function respondAction(formData: FormData) {
  const loadId = String(formData.get("loadId"));
  const response = formData.get("response") === "declined" ? "declined" : "accepted";
  await attempt(loadId, async () => {
    await recordDriverResponse(loadId, response);
    return response === "accepted" ? "Driver accepted." : "Driver declined. Pick another driver.";
  });
}

export async function invoiceAction(formData: FormData) {
  const id = String(formData.get("loadId"));
  const load = await prisma.load.findUniqueOrThrow({ where: { id } });
  if (load.status !== "completed" || load.paymentStatus) redirect("/invoices");
  const amount = load.actualRevenue ?? load.quotedRevenue;
  await prisma.load.update({
    where: { id },
    data: { paymentStatus: "invoiced", invoicedAt: new Date(), invoicedAmount: amount, invoiceNumber: `INV-${load.loadNumber ?? id.slice(-6)}`, payTermsDays: load.payTermsDays ?? 30 }
  });
  revalidatePath("/invoices");
  revalidatePath("/kpi");
  redirect("/invoices");
}

export async function markPaidAction(formData: FormData) {
  const id = String(formData.get("loadId"));
  const load = await prisma.load.findUniqueOrThrow({ where: { id } });
  if (load.paymentStatus !== "invoiced") redirect("/invoices");
  await prisma.load.update({ where: { id }, data: { paymentStatus: "paid", paidAt: new Date(), paidAmount: load.invoicedAmount ?? load.quotedRevenue } });
  revalidatePath("/invoices");
  revalidatePath("/kpi");
  redirect("/invoices");
}

// ── Rate confirmations ─────────────────────────────────────────────────────────────────────────

/** A draft with its dates as ISO strings, so it can cross the server-action boundary. */
export type DraftDto = Omit<RateConLoadDraft, "stops"> & {
  stops: Array<Omit<RateConLoadDraft["stops"][number], "timeWindowEarliest" | "timeWindowLatest"> & { timeWindowEarliest: string | null; timeWindowLatest: string | null }>;
};

function toDto(d: RateConLoadDraft): DraftDto {
  return { ...d, stops: d.stops.map((s) => ({ ...s, timeWindowEarliest: s.timeWindowEarliest?.toISOString() ?? null, timeWindowLatest: s.timeWindowLatest?.toISOString() ?? null })) };
}

export async function readSampleRateConAction(fileName: string): Promise<{ ok: true; source: "demo" | "live"; draft: DraftDto } | { ok: false; reason: string }> {
  const out = await readRateCon({ fileName });
  return out.ok ? { ok: true, source: out.source, draft: toDto(out.draft) } : { ok: false, reason: out.reason };
}

export async function saveRateConAction(dto: DraftDto, confirmed: boolean): Promise<{ ok: true; loadId: string } | { ok: false; error: string }> {
  try {
    const draft: ReviewedDraft = {
      ...dto,
      confirmed,
      stops: dto.stops.map((s) => ({ ...s, timeWindowEarliest: s.timeWindowEarliest ? new Date(s.timeWindowEarliest) : null, timeWindowLatest: s.timeWindowLatest ? new Date(s.timeWindowLatest) : null }))
    };
    const load = await saveReviewedDraft(draft);
    revalidatePath("/loads");
    revalidatePath("/dispatch");
    return { ok: true, loadId: load.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save." };
  }
}
