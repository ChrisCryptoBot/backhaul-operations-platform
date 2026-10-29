"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { DENSITY_COOKIE, THEME_COOKIE, asDensity, asTheme } from "@/lib/appearance";
import { redirect, RedirectType } from "next/navigation";
import { prisma } from "@/lib/db";
import { assignDriver, dispatchLoad, DispatchError, recordDriverResponse, unassignLoad } from "@/server/tl/dispatch";
import { invoiceLoad, markLoadPaid } from "@/server/tl/invoicing";
import type { PayKind } from "@/server/tl/projector";
import { readRateCon } from "@/server/ratecon/reader";
import { saveReviewedDraft, type ReviewedDraft } from "@/server/ratecon/save";
import type { RateConLoadDraft } from "@/server/ratecon/map";

/**
 * Server actions for the desk. Each one runs the same functions the tests run, then sends the page back with a
 * short note (?note=...) or an error (?error=...) so the result is visible without client state.
 */
function back(loadId: string, key: "note" | "error", text: string): never {
  // Replace, not push: the load may be open in the drawer, and closing it must land on the page beneath, not on the same load again.
  redirect(`/loads/${loadId}?${key}=${encodeURIComponent(text)}`, RedirectType.replace);
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
  revalidatePath("/alerts");
  revalidatePath("/audit");
  revalidatePath("/kpi");
  return back(loadId, "note", note);
}

export async function assignAction(formData: FormData) {
  const loadId = String(formData.get("loadId"));
  await attempt(loadId, async () => {
    const rate = Number(formData.get("rate"));
    await assignDriver({
      loadId,
      driverId: String(formData.get("driverId")),
      pay: { kind: String(formData.get("payKind")) as PayKind, rate },
      overrideReason: String(formData.get("overrideReason") ?? "")
    });
    return "Driver assigned. Send it when you are ready.";
  });
}

export async function unassignAction(formData: FormData) {
  const loadId = String(formData.get("loadId"));
  await attempt(loadId, async () => {
    await unassignLoad(loadId, String(formData.get("reason") ?? ""));
    return "Driver removed. The load is back on the board.";
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
  await invoiceLoad(String(formData.get("loadId")));
  revalidatePath("/invoices");
  revalidatePath("/audit");
  revalidatePath("/alerts");
  revalidatePath("/kpi");
  redirect("/invoices");
}

export async function markPaidAction(formData: FormData) {
  await markLoadPaid(String(formData.get("loadId")));
  revalidatePath("/invoices");
  revalidatePath("/audit");
  revalidatePath("/alerts");
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

// ── Appearance (Settings) ──────────────────────────────────────────────────────────────────────

/** Saves the theme and/or density in cookies (read by the root layout) and returns to Settings with a note. */
export async function setAppearanceAction(formData: FormData) {
  const jar = cookies();
  const theme = formData.get("theme");
  const density = formData.get("density");
  const year = 60 * 60 * 24 * 365;
  if (typeof theme === "string") jar.set(THEME_COOKIE, asTheme(theme), { path: "/", maxAge: year, sameSite: "lax" });
  if (typeof density === "string") jar.set(DENSITY_COOKIE, asDensity(density), { path: "/", maxAge: year, sameSite: "lax" });
  revalidatePath("/", "layout");
  redirect("/settings?note=" + encodeURIComponent("Appearance saved."));
}
