import { describe, expect, it } from "vitest";
import { readRateCon } from "@/server/ratecon/reader";
import { BLANK_QUOTE, validateQuote } from "@/lib/quote";
import { rateConDraftToQuote } from "@/lib/rate-con-to-quote";

describe("rateConDraftToQuote", () => {
  it("maps simple two-stop rate confirmation to QuoteValues", async () => {
    const out = await readRateCon({ fileName: "RC-AFB-482913_dallas-to-houston_cargo-van.pdf" }, {});
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const dto = {
      ...out.draft,
      stops: out.draft.stops.map((s) => ({
        ...s,
        timeWindowEarliest: s.timeWindowEarliest?.toISOString() ?? null,
        timeWindowLatest: s.timeWindowLatest?.toISOString() ?? null
      }))
    };

    const res = rateConDraftToQuote(dto, BLANK_QUOTE, { fileName: "RC-AFB-482913.pdf" });
    expect(res.values.offer).toBe("800");
    expect(res.values.loadedMiles).toBe("242");
    expect(res.values.broker).toBe("Acme Freight Brokers");
    expect(res.values.loadNumber).toBe("AFB-482913");
    expect(res.values.rateConNumber).toBe("AFB-482913");
    expect(res.values.poNumber).toBe("5521084");
    expect(res.values.payTermsDays).toBe("30");
    expect(res.values.rateConPath).toBe("RC-AFB-482913.pdf");
    expect(res.values.stops).toHaveLength(2);
    expect(res.values.stops[0]?.address).toContain("Dallas, TX");
    expect(res.values.stops[0]?.role).toBe("pickup");
    expect(res.values.stops[1]?.address).toContain("Houston, TX");
    expect(res.values.stops[1]?.role).toBe("delivery");
    expect(res.filledCount).toBeGreaterThanOrEqual(6);
  });

  it("maps multi-stop rate confirmation preserving stop order and appointments", async () => {
    const out = await readRateCon({ fileName: "RC-RDL-77315_fort-worth-waco-austin_box-truck.pdf" }, {});
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const dto = {
      ...out.draft,
      stops: out.draft.stops.map((s) => ({
        ...s,
        timeWindowEarliest: s.timeWindowEarliest?.toISOString() ?? null,
        timeWindowLatest: s.timeWindowLatest?.toISOString() ?? null
      }))
    };

    const res = rateConDraftToQuote(dto, BLANK_QUOTE);
    expect(res.values.offer).toBe("640");
    expect(res.values.stops).toHaveLength(3);
    expect(res.values.stops.map((s) => s.role)).toEqual(["pickup", "delivery", "delivery"]);
    expect(res.values.payTermsDays).toBe("21");
  });

  it("preserves full freight, reefer, hazmat, references, dock/detention terms, and stop metadata with zero drift", () => {
    const mapped = rateConDraftToQuote(
      {
        load: {
          brokerName: "Polar Cold Logistics",
          brokerMcNumber: "987654",
          loadNumber: "TMS-55",
          rateConNumber: "RC-POLAR-55",
          proNumber: "PRO-77",
          bolNumber: "BOL-88",
          poNumber: "PO-99",
          trailerType: "reefer",
          commodity: "Fresh produce",
          pieceCount: 320,
          palletCount: 20,
          reeferSetTempF: 34,
          reeferMinF: 32,
          reeferMaxF: 36,
          reeferMode: "continuous",
          hazmatClass: "3",
          hazmatUnNumber: "UN1203",
          hazmatPackingGroup: "II",
          hazmatEmergencyPhone: "800-424-9300",
          quotedRevenue: 2400,
          loadedMiles: 600,
          payTermsDays: 30,
          paymentTerms: "Net 30 EFS"
        },
        stops: [
          {
            stopRole: "pickup",
            addressString: "Dallas, TX",
            facilityName: "Sysco Cold Dock",
            timeWindowEarliest: "2027-03-01T14:00:00Z",
            timeWindowLatest: "2027-03-01T16:00:00Z",
            referenceNumbers: ["PU-100", "REL-2"],
            contactPhone: "214-555-0100",
            stopNotes: "Check in gate 3"
          },
          {
            stopRole: "delivery",
            addressString: "Houston, TX",
            facilityName: "HEB Depot",
            timeWindowEarliest: "2027-03-01T21:00:00Z",
            timeWindowLatest: "2027-03-01T23:00:00Z",
            referenceNumbers: ["DEL-200"],
            contactPhone: "713-555-0200",
            stopNotes: "Lumper receipt required"
          }
        ],
        printed: {
          weightLbs: 38000,
          dockTerms: "2 hrs free then $75/hr",
          detentionFreeMinutes: 120,
          detentionHourlyRate: 75,
          notes: "Keep sealed"
        }
      },
      BLANK_QUOTE,
      { fileName: "polar-rc.pdf" }
    );

    expect(mapped.values).toMatchObject({
      loadNumber: "TMS-55",
      rateConNumber: "RC-POLAR-55",
      proNumber: "PRO-77",
      bolNumber: "BOL-88",
      poNumber: "PO-99",
      commodity: "Fresh produce",
      pieceCount: "320",
      palletCount: "20",
      weightLbs: "38000",
      reeferSetTempF: "34",
      reeferMinF: "32",
      reeferMaxF: "36",
      reeferMode: "continuous",
      hazmatClass: "3",
      hazmatUnNumber: "UN1203",
      hazmatPackingGroup: "II",
      hazmatEmergencyPhone: "800-424-9300",
      paymentTerms: "Net 30 EFS",
      detentionFreeMinutes: "120",
      detentionHourlyRate: "75",
      rateConPath: "polar-rc.pdf",
      notes: "Keep sealed\nDock terms: 2 hrs free then $75/hr"
    });
    expect(mapped.values.stops[0]).toMatchObject({
      facility: "Sysco Cold Dock",
      contactPhone: "214-555-0100",
      refs: "PU-100, REL-2",
      notes: "Check in gate 3"
    });
    expect(mapped.values.stops[0]?.appointmentEnd).toBeTruthy();

    const checked = validateQuote(mapped.values);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.input).toMatchObject({
      bolNumber: "BOL-88",
      pieceCount: 320,
      palletCount: 20,
      reeferSetTempF: 34,
      reeferMode: "continuous",
      hazmatUnNumber: "UN1203",
      hazmatPackingGroup: "II",
      detentionFreeMinutes: 120,
      detentionHourlyRate: 75,
      rateConPath: "polar-rc.pdf"
    });
    expect(checked.input.stops[0]?.refs).toEqual(["PU-100", "REL-2"]);
    expect(checked.input.stops[0]?.appointmentEnd).toBeGreaterThan(checked.input.stops[0]!.appointment!);
  });

  it("handles empty draft safely without modifying blank values", () => {
    const emptyDto = {
      load: {
        brokerName: null,
        brokerMcNumber: null,
        loadNumber: null,
        poNumber: null,
        originAddress: null,
        destinationAddress: null,
        trailerType: null,
        quotedRevenue: null,
        loadedMiles: null,
        payTermsDays: null,
        paymentTerms: null,
        stopsCount: 0,
        pickupNumbers: [],
        deliveryNumbers: [],
        channel: "rate_con" as const,
        status: "draft" as const
      },
      stops: [],
      printed: {
        commodity: null,
        weightLbs: null,
        fuelSurchargeIncluded: null,
        dockTerms: null
      }
    };

    const res = rateConDraftToQuote(emptyDto, BLANK_QUOTE);
    expect(res.filledCount).toBe(0);
    expect(res.values.offer).toBe("");
    expect(res.values.stops).toEqual(BLANK_QUOTE.stops);
  });
});
