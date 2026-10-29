import { beforeEach, describe, expect, it, vi } from "vitest";
import { decideFuelFill, EIA_SERIES, EIA_URL, eiaQuery, fuelKindOf, parseEiaPrice, weekOf } from "@/lib/eia";
import { clearEiaMemory, latestFuelPrice } from "@/server/fuel/eia";
import { resolveLaneEiaPadd } from "@/truelane/lib/eiaRegion";

const answer = (value: unknown, period = "2026-10-26") => ({ response: { data: [{ period, value }] } });
const ok = (body: unknown) => vi.fn(async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;

describe("the EIA request", () => {
  it("carries every parameter the phone sends, with the series for the region and fuel", () => {
    const q = eiaQuery(" the-key ", "diesel", "R30");
    expect(Object.fromEntries(q.entries())).toEqual({
      api_key: "the-key",
      frequency: "weekly",
      "data[0]": "value",
      "sort[0][column]": "period",
      "sort[0][direction]": "desc",
      length: "1",
      "facets[series][]": "EMD_EPD2D_PTE_R30_DPG"
    });
    expect(EIA_URL).toBe("https://api.eia.gov/v2/petroleum/pri/gnd/data/");
    expect(eiaQuery("k", "gasoline", "NUS").get("facets[series][]")).toBe("EMM_EPMR_PTE_NUS_DPG");
  });

  it("has a series for every region and fuel, none repeated", () => {
    const ids = [...Object.values(EIA_SERIES.diesel), ...Object.values(EIA_SERIES.gasoline)];
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
  });

  it("asks for diesel unless the truck says gasoline", () => {
    expect(fuelKindOf("gasoline")).toBe("gasoline");
    expect(fuelKindOf(" Gasoline ")).toBe("gasoline");
    expect(fuelKindOf("diesel")).toBe("diesel");
    expect(fuelKindOf(null)).toBe("diesel");
  });

  it("picks the region from the lane: where it starts, else where it ends, else the nation", () => {
    expect(resolveLaneEiaPadd("Houston, TX", "Atlanta, GA")).toMatchObject({ padd: "R30", source: "origin" });
    expect(resolveLaneEiaPadd("", "Atlanta, GA 30318")).toMatchObject({ padd: "R10", source: "destination" });
    expect(resolveLaneEiaPadd(null, null)).toMatchObject({ padd: "NUS", source: "national" });
  });
});

describe("reading an answer", () => {
  it("takes the latest weekly price with its region and week", () => {
    expect(parseEiaPrice(answer("6.352"), "diesel", "NUS")).toEqual({ pricePerGallon: 6.352, period: "2026-10-26", padd: "NUS", regionLabel: "U.S. National", fuel: "diesel" });
    expect(parseEiaPrice(answer(5.98), "diesel", "R30")?.regionLabel).toBe("Gulf Coast (PADD 3)");
  });

  it("is null for anything that is not a usable price", () => {
    for (const bad of [answer(0), answer(-1), answer("n/a"), answer(null), { response: { data: [] } }, { response: {} }, null, "x"]) expect(parseEiaPrice(bad, "diesel", "NUS")).toBeNull();
    expect(parseEiaPrice({ response: { data: [{ value: 5 }] } }, "diesel", "NUS")).toBeNull(); // no period
  });

  it("says the week in words", () => {
    expect(weekOf("2026-10-26")).toBe("week of Oct 26");
    expect(weekOf("garbage")).toBe("garbage");
  });
});

describe("what using today's price does to a box", () => {
  it("fills an empty one, leaves one that already matches, and asks about anything else", () => {
    expect(decideFuelFill("", 5.98)).toEqual({ action: "fill" });
    expect(decideFuelFill("   ", 5.98)).toEqual({ action: "fill" });
    expect(decideFuelFill("5.98", 5.98)).toEqual({ action: "same" });
    expect(decideFuelFill("$5.980", 5.98)).toEqual({ action: "same" });
    expect(decideFuelFill("3.90", 5.98)).toEqual({ action: "ask", typed: "3.90" }); // a typed number is never replaced silently
    expect(decideFuelFill("about four", 5.98)).toEqual({ action: "ask", typed: "about four" });
  });
});

describe("the EIA lookup", () => {
  beforeEach(() => clearEiaMemory());

  it("asks the documented endpoint with the region's series, and reads the price", async () => {
    const fetchImpl = ok(answer("5.987"));
    const out = await latestFuelPrice("diesel", "R30", fetchImpl, "test-key");
    expect(out).toMatchObject({ pricePerGallon: 5.987, padd: "R30", nationalFallback: false });
    const url = new URL((fetchImpl as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]!);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.eia.gov/v2/petroleum/pri/gnd/data/");
    expect(url.searchParams.get("facets[series][]")).toBe("EMD_EPD2D_PTE_R30_DPG");
    expect(url.searchParams.get("api_key")).toBe("test-key");
  });

  it("falls back to the national price, and says so, when the region has none", async () => {
    const fetchImpl = vi.fn(async (u: string) => ({ ok: true, status: 200, json: async () => (u.includes("R40") ? { response: { data: [] } } : answer("6.1")) })) as unknown as typeof fetch;
    expect(await latestFuelPrice("diesel", "R40", fetchImpl, "k")).toMatchObject({ padd: "NUS", pricePerGallon: 6.1, nationalFallback: true });
  });

  it("is null for a throw, a bad status, a missing key, and asks nothing without a key", async () => {
    const thrown = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await latestFuelPrice("diesel", "R10", thrown, "k")).toBeNull();
    clearEiaMemory();
    const bad = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await latestFuelPrice("diesel", "R10", bad, "k")).toBeNull();
    const never = vi.fn() as unknown as typeof fetch;
    expect(await latestFuelPrice("diesel", "R10", never, "")).toBeNull();
    expect(never).not.toHaveBeenCalled();
  });

  it("remembers a price for a while, per region and fuel, but not a failure", async () => {
    const fetchImpl = ok(answer("5.5"));
    await latestFuelPrice("diesel", "R20", fetchImpl, "k");
    await latestFuelPrice("diesel", "R20", fetchImpl, "k");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await latestFuelPrice("gasoline", "R20", fetchImpl, "k");
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const flaky = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ok: true, status: 200, json: async () => answer("5.7") }) as unknown as typeof fetch;
    // The national series has no other to fall back on, so a failure there is a plain null, and the next ask tries again.
    expect(await latestFuelPrice("diesel", "NUS", flaky, "k")).toBeNull();
    expect(await latestFuelPrice("diesel", "NUS", flaky, "k")).toMatchObject({ pricePerGallon: 5.7, nationalFallback: false });
  });
});
