import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { BLANK_QUOTE } from "@/lib/quote";
import { rateConDraftToQuote } from "@/lib/rate-con-to-quote";
import { readRateCon } from "@/server/ratecon/reader";
import { bookQuote, getQuoteLike } from "@/server/tl/quote";

/**
 * Verifies unified Quote + Rate confirmation ingestion end-to-end against `demo_gate` (RUN_DB_INTEGRATION=true).
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "rc-qt-w";
const NOW = new Date("2027-03-10T18:00:00Z");

describe.skipIf(!run)("unified Quote rate-con ingestion & zero-drift persistence", () => {
  let vehicleId = "";

  async function wipe() {
    await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
    await prisma.driverLedgerEntry.deleteMany({ where: { workspaceId: W } });
    await prisma.settlement.deleteMany({ where: { workspaceId: W } });
    await prisma.assignment.deleteMany({ where: { load: { workspaceId: W } } });
    await prisma.workspace.deleteMany({ where: { id: W } });
  }

  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: "Unified Quote Fleet", plan: "enterprise", timezone: "America/Chicago" } });
    const v = await prisma.vehicle.create({
      data: {
        workspaceId: W,
        name: "UQ-TRUCK",
        type: "cargo_van",
        terminal: "Dallas",
        mpg: 14,
        fuelType: "diesel",
        payloadLbs: 4000,
        costProfile: { create: { estimatedMonthlyMiles: 8000, breakEvenRpm: 1.25, detentionHourlyRate: 50, freeGraceMinutes: 120 } }
      }
    });
    vehicleId = v.id;
  });

  afterAll(async () => {
    await wipe();
  });

  test("readRateCon -> rateConDraftToQuote -> bookQuote persists full refs, freight, stop details, dock terms, detention, and channel=rate_con", async () => {
    const read = await readRateCon({ fileName: "RC-AFB-482913_dallas-to-houston_cargo-van.pdf" }, {});
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    const mapped = rateConDraftToQuote(
      {
        ...read.draft,
        load: {
          ...read.draft.load,
          rateConNumber: "RC-AFB-482913",
          proNumber: "PRO-AFB-9",
          bolNumber: "BOL-AFB-2",
          commodity: "Medical parts",
          pieceCount: 40,
          palletCount: 2
        },
        stops: read.draft.stops.map((s, idx) => ({
          ...s,
          facilityName: idx === 0 ? "Acme North Dock" : "Houston Med Hub",
          referenceNumbers: idx === 0 ? ["PU-77"] : ["DEL-88"],
          contactPhone: idx === 0 ? "214-555-0100" : "713-555-0200",
          stopNotes: idx === 0 ? "Gate B" : "Call receiver"
        })),
        printed: {
          ...read.draft.printed,
          dockTerms: "2h free then $75/hr",
          detentionFreeMinutes: 90,
          detentionHourlyRate: 75,
          notes: "Keep dry"
        }
      },
      { ...BLANK_QUOTE, fuelPrice: "3.50", marketRate: "800" },
      { fileName: "RC-AFB-482913_dallas-to-houston_cargo-van.pdf" }
    );

    // The sample rate confirmation is dated in the past: booking it says so on purpose (pastOk), as a person would in the dialog.
    const booked = await bookQuote(mapped.values, { vehicleId, driverId: null }, null, null, W, NOW, { pastOk: true });
    expect(booked).toMatchObject({ ok: true });
    if (!booked.ok) return;

    const load = await prisma.load.findUniqueOrThrow({
      where: { id: booked.loadId },
      include: { stops: { orderBy: { stopSequence: "asc" } }, customer: true }
    });
    expect(load).toMatchObject({
      channel: "rate_con",
      rateConPath: "RC-AFB-482913_dallas-to-houston_cargo-van.pdf",
      rateConNumber: "RC-AFB-482913",
      proNumber: "PRO-AFB-9",
      bolNumber: "BOL-AFB-2",
      commodity: "Medical parts",
      pieceCount: 40,
      palletCount: 2,
      snapshotFreeGraceMinutes: 90,
      pickupNumbers: ["PU-77"],
      deliveryNumbers: ["DEL-88"]
    });
    expect(load.snapshotDetentionRate?.toNumber()).toBe(75);
    expect(load.notes).toContain("Keep dry");
    expect(load.notes).toContain("Dock terms: 2h free then $75/hr");
    expect(load.customer?.name).toBe("Acme Freight Brokers");
    expect(load.stops[0]).toMatchObject({
      facilityName: "Acme North Dock",
      referenceNumbers: ["PU-77"],
      contactPhone: "214-555-0100",
      stopNotes: "Gate B"
    });
    expect(load.stops[1]).toMatchObject({
      facilityName: "Houston Med Hub",
      referenceNumbers: ["DEL-88"],
      contactPhone: "713-555-0200",
      stopNotes: "Call receiver"
    });

    // Book again preserves commodity, facility, contact, notes while clearing dates, refs, and rateConPath.
    const like = await getQuoteLike(load.id, W);
    expect(like).not.toBeNull();
    expect(like!.loadNumber).toBe("");
    expect(like!.rateConNumber).toBe("");
    expect(like!.proNumber).toBe("");
    expect(like!.bolNumber).toBe("");
    expect(like!.rateConPath).toBe("");
    expect(like!.commodity).toBe("Medical parts");
    expect(like!.stops[0]).toMatchObject({ facility: "Acme North Dock", appointment: "", refs: "", notes: "Gate B" });
  });
});
