import { afterEach, describe, expect, test, vi } from "vitest";
import { getRoadMiles } from "@/server/distance";

const origin = { originCity: "Pittsburgh", originState: "PA", destCity: "Carlisle", destState: "PA" };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("getRoadMiles", () => {
  test("returns unavailable when no API key is configured", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "");
    const result = await getRoadMiles(origin);
    expect(result).toEqual({ miles: null, source: "unavailable" });
  });

  test("parses a Google Distance Matrix response into miles", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
    vi.stubEnv("DISTANCE_PROVIDER", "google");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ status: "OK", rows: [{ elements: [{ status: "OK", distance: { value: 160934 } }] }] })
      }))
    );
    const result = await getRoadMiles(origin);
    expect(result.source).toBe("google");
    expect(result.miles).toBe(100); // 160934 m ≈ 100.0 mi
  });

  test("returns unavailable when the element status is not OK", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ status: "OK", rows: [{ elements: [{ status: "NOT_FOUND" }] }] }) }))
    );
    const result = await getRoadMiles(origin);
    expect(result).toEqual({ miles: null, source: "unavailable" });
  });
});
