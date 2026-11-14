import { afterEach, describe, expect, it } from "vitest";
import { NWS_ALERTS_URL, NWS_USER_AGENT, WEATHER_TIMEOUT_MS, WEATHER_TTL_MS, forgetWeather, radarWeather, readAlerts } from "@/server/tl/radar-weather";

/**
 * The radar's weather (src/server/tl/radar-weather.ts): the NWS's active alerts, cut to severe and extreme ones with a drawn area and to the five fields the tooltip shows; cached five minutes;
 * three seconds at most; any failure is an empty layer, never an error. The fetch is stubbed: nothing leaves the machine.
 */
const square: number[][][] = [[[-97, 32], [-96, 32], [-96, 33], [-97, 33], [-97, 32]]];
const alert = (over: Record<string, unknown>) => ({
  type: "Feature",
  id: "https://api.weather.gov/alerts/x",
  geometry: { type: "Polygon", coordinates: square },
  properties: { id: "urn:1", event: "Tornado Warning", severity: "Extreme", headline: "Tornado Warning issued", expires: "2026-11-13T23:00:00-06:00", description: "LONG TEXT", instruction: "TAKE COVER", areaDesc: "Dallas", senderName: "NWS Fort Worth", ...over }
});
const body = {
  features: [
    alert({}),
    alert({ id: "urn:2", event: "Severe Thunderstorm Warning", severity: "Severe" }),
    { ...alert({ id: "urn:3", event: "Flood Warning", severity: "Severe" }), geometry: { type: "MultiPolygon", coordinates: [square, square] } },
    { ...alert({ id: "urn:4", event: "Winter Storm Warning", severity: "Severe" }), geometry: null },
    alert({ id: "urn:5", event: "Wind Advisory", severity: "Moderate" }),
    alert({ id: "urn:6", event: "Special Weather Statement", severity: "Minor" }),
    { ...alert({ id: "urn:7", event: "Odd", severity: "Severe" }), geometry: { type: "Point", coordinates: [-97, 32] } }
  ]
};
const ok = (json: unknown) => (async () => ({ ok: true, json: async () => json })) as unknown as typeof fetch;

afterEach(() => forgetWeather());

describe("which alerts are drawn", () => {
  it("keeps severe and extreme alerts with a Polygon or MultiPolygon, and counts the zone-only ones", () => {
    const { features, skippedNoShape } = readAlerts(body);
    expect(features.map((f) => f.properties.id)).toEqual(["urn:1", "urn:2", "urn:3"]);
    expect(features.map((f) => f.geometry.type)).toEqual(["Polygon", "Polygon", "MultiPolygon"]);
    expect(skippedNoShape).toBe(1); // the winter storm with no geometry; moderate, minor and the point are not counted
  });

  it("sends the browser only the five fields the tooltip shows, none of NOAA's other text", () => {
    const f = readAlerts(body).features[0]!;
    expect(Object.keys(f.properties).sort()).toEqual(["event", "expires", "headline", "id", "severity"]);
    expect(JSON.stringify(f)).not.toMatch(/LONG TEXT|TAKE COVER|NWS Fort Worth|areaDesc/);
  });

  it("reads nothing from a body that is not a feature collection", () => {
    for (const bad of [null, "", 7, {}, { features: "no" }]) expect(readAlerts(bad)).toEqual({ features: [], skippedNoShape: 0 });
  });
});

describe("asking the National Weather Service", () => {
  it("asks the one alerts address, names itself with no person's address, and keeps the answer five minutes", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => body };
    }) as unknown as typeof fetch;
    let t = 1_000_000;
    const first = await radarWeather({ fetch: f, now: () => t });
    expect(first).toMatchObject({ mode: "weather", ok: true, skippedNoShape: 1 });
    expect(first.features).toHaveLength(3);
    expect(calls[0]!.url).toBe(NWS_ALERTS_URL);
    expect(NWS_ALERTS_URL).toBe("https://api.weather.gov/alerts/active?status=actual&message_type=alert");
    expect((calls[0]!.init?.headers as Record<string, string>)["User-Agent"]).toBe(NWS_USER_AGENT);
    expect(NWS_USER_AGENT).not.toContain("@");
    t += WEATHER_TTL_MS - 1;
    await radarWeather({ fetch: f, now: () => t });
    expect(calls).toHaveLength(1);
    t += 2;
    await radarWeather({ fetch: f, now: () => t });
    expect(calls).toHaveLength(2);
  });

  it("fails soft: an error status, a network failure or a body it cannot read is an empty layer, and a failure is not kept", async () => {
    const empty = { mode: "weather", ok: false, features: [], skippedNoShape: 0, asOf: null };
    expect(await radarWeather({ fetch: (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch })).toEqual(empty);
    expect(await radarWeather({ fetch: (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch })).toEqual(empty);
    expect(await radarWeather({ fetch: (async () => ({ ok: true, json: async () => Promise.reject(new SyntaxError("bad")) })) as unknown as typeof fetch })).toEqual(empty);
    expect((await radarWeather({ fetch: ok(body) })).ok).toBe(true);
  });

  it("gives up after three seconds: the request is aborted", async () => {
    expect(WEATHER_TIMEOUT_MS).toBe(3_000);
    let aborted = false;
    const slow = ((_: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      })) as unknown as typeof fetch;
    const started = Date.now();
    const out = await radarWeather({ fetch: slow });
    expect(out.ok).toBe(false);
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(WEATHER_TIMEOUT_MS + 1_500);
  });
});
