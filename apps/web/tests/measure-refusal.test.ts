import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { measureQuote } from "@/server/geo/measure";

/** A lookup the desk did not make (switched off, over its allowance) is said to be that, not "could not find that place". */
describe("measuring a quote when lookups are off", () => {
  const saved = { token: process.env.MAPBOX_ACCESS_TOKEN, off: process.env.DESK_SERVICES_OFF };
  beforeEach(() => {
    process.env.MAPBOX_ACCESS_TOKEN = "test-token";
    process.env.DESK_SERVICES_OFF = "mapbox_geocode";
  });
  afterEach(() => {
    if (saved.token === undefined) delete process.env.MAPBOX_ACCESS_TOKEN;
    else process.env.MAPBOX_ACCESS_TOKEN = saved.token;
    if (saved.off === undefined) delete process.env.DESK_SERVICES_OFF;
    else process.env.DESK_SERVICES_OFF = saved.off;
  });

  test("says lookups are switched off, not that the place was not found", async () => {
    const out = await measureQuote({ stops: [{ address: "Dallas, TX", role: "pickup" }, { address: "Tulsa, OK", role: "delivery" }], homes: [] } as never);
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/switched off/) });
  });
});
