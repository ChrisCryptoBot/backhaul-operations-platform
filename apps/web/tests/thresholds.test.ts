import { describe, expect, test } from "vitest";
import { THRESHOLD_DEFAULTS, THRESHOLD_FIELDS, validateThresholds } from "@/lib/thresholds";
import { CARD_LINES, LANE_DAYS, LANE_MIN_LOADS } from "@/lib/verdict";
import { THIN_MARGIN_PER_MILE } from "@/truelane/lib/domain/calculators";
import { computeMarketVerdict } from "@/truelane/lib/domain/marketVerdict";

const blank = Object.fromEntries(THRESHOLD_FIELDS.map((f) => [f.key, ""]));
const bandAt = (variancePct: number) => computeMarketVerdict({ belowFloor: false, thinMargin: false, variancePct }).band;

describe("the verdict card's thresholds", () => {
  test("default to the card as designed, so a workspace that sets nothing gets it", () => {
    expect(THRESHOLD_DEFAULTS.laneMinLoads).toBe(LANE_MIN_LOADS);
    expect(THRESHOLD_DEFAULTS.laneDays).toBe(LANE_DAYS);
    expect([LANE_MIN_LOADS, LANE_DAYS]).toEqual([3, 90]);
  });

  test("are checked like the others: whole numbers in range, and blank for the default", () => {
    const check = (over: Record<string, string>) => validateThresholds({ ...blank, ...over });
    expect(check({ laneMinLoads: "1" })).toMatchObject({ ok: false, errors: { laneMinLoads: expect.any(String) } });
    expect(check({ laneMinLoads: "26" })).toMatchObject({ ok: false });
    expect(check({ laneMinLoads: "2.5" })).toMatchObject({ ok: false });
    expect(check({ laneDays: "13" })).toMatchObject({ ok: false, errors: { laneDays: expect.any(String) } });
    expect(check({ laneDays: "366" })).toMatchObject({ ok: false });
    expect(check({ laneMinLoads: "2", laneDays: "14" })).toMatchObject({ ok: true, stored: { laneMinLoads: 2, laneDays: 14 } });
    expect(check({ laneMinLoads: "25", laneDays: "365" })).toMatchObject({ ok: true, stored: { laneMinLoads: 25, laneDays: 365 } });
    expect(check({})).toMatchObject({ ok: true, stored: { laneMinLoads: null, laneDays: null }, resolved: { laneMinLoads: 3, laneDays: 90 } });
  });
});

describe("the lines Settings shows beside them are the audited rules' own", () => {
  test("up to 10% under is at market; past 10% is Negotiate; past 20% is the strong-caution band the card rejects", () => {
    expect(bandAt(-CARD_LINES.atMarketPct / 100)).toBe("at_market");
    expect(bandAt(-CARD_LINES.atMarketPct / 100 - 0.001)).toBe("negotiate");
    expect(bandAt(-CARD_LINES.rejectPct / 100)).toBe("negotiate");
    expect(bandAt(-CARD_LINES.rejectPct / 100 - 0.001)).toBe("strong_caution");
  });

  test("thin is under five cents a mile over cost", () => {
    expect(CARD_LINES.thinCentsPerMile).toBe(Math.round(THIN_MARGIN_PER_MILE * 100));
  });
});
