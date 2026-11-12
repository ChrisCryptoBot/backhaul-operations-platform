import { describe, expect, test } from "vitest";
import { REGIONS } from "../src/lib/radar-regions";

/**
 * MapLibre refuses every sideways pan once zoomed in when the camera box's west edge is exactly -180 (measured on the Alaska view: east pan blocked with -180, free with -179.9).
 * No region's camera box may start on the 180th meridian, and every fit box must sit inside its camera box.
 */
describe("the radar's camera boxes", () => {
  test("no box starts or ends exactly on the antimeridian", () => {
    for (const [key, r] of Object.entries(REGIONS)) {
      expect(r.clamp[0], key).toBeGreaterThan(-180);
      expect(r.clamp[2], key).toBeLessThan(180);
    }
  });

  test("each region's first view fits inside its camera box", () => {
    for (const [key, r] of Object.entries(REGIONS)) {
      expect(r.fit[0], key).toBeGreaterThanOrEqual(r.clamp[0]);
      expect(r.fit[1], key).toBeGreaterThanOrEqual(r.clamp[1]);
      expect(r.fit[2], key).toBeLessThanOrEqual(r.clamp[2]);
      expect(r.fit[3], key).toBeLessThanOrEqual(r.clamp[3]);
    }
  });
});
