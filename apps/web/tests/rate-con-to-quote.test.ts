import { describe, expect, it } from "vitest";
import { readRateCon } from "@/server/ratecon/reader";
import { BLANK_QUOTE } from "@/lib/quote";
import { rateConDraftToQuote } from "@/lib/rate-con-to-quote";

describe("rateConDraftToQuote", () => {
  it("maps simple two-stop rate confirmation to QuoteValues", async () => {
    const out = await readRateCon({ fileName: "RC-AFB-482913_dallas-to-houston_cargo-van.pdf" }, {});
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // Convert draft dates to DTO strings
    const dto = {
      ...out.draft,
      stops: out.draft.stops.map((s) => ({
        ...s,
        timeWindowEarliest: s.timeWindowEarliest?.toISOString() ?? null,
        timeWindowLatest: s.timeWindowLatest?.toISOString() ?? null
      }))
    };

    const res = rateConDraftToQuote(dto, BLANK_QUOTE);
    expect(res.values.offer).toBe("800");
    expect(res.values.loadedMiles).toBe("242");
    expect(res.values.broker).toBe("Acme Freight Brokers");
    expect(res.values.loadNumber).toBe("AFB-482913");
    expect(res.values.poNumber).toBe("5521084");
    expect(res.values.payTermsDays).toBe("30");
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
