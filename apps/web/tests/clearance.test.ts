import { describe, expect, it } from "vitest";
import { clearanceSoon, driverBlocker } from "../src/lib/clearance";

const at = (iso: string) => new Date(iso);
const now = at("2027-03-01T12:00:00Z");
const base = { cdlExpiry: at("2031-01-01T00:00:00Z"), medicalCardExpiry: at("2031-01-01T00:00:00Z") };

describe("a driver is cleared for the whole trip, not just today", () => {
  it("blocks what has already lapsed, whatever the trip", () => {
    expect(driverBlocker({ ...base, cdlExpiry: at("2027-02-01T00:00:00Z") }, now)).toBe("CDL expired");
    expect(driverBlocker({ ...base, medicalCardExpiry: at("2027-02-01T00:00:00Z") }, now)).toBe("Medical card expired");
    expect(driverBlocker({ ...base, coiExpiresAt: at("2027-02-01T00:00:00Z") }, now)).toBe("Insurance certificate expired");
    expect(driverBlocker(base, now)).toBeNull();
  });

  it("blocks a card that lapses before the trip ends, and says both dates", () => {
    const tomorrow = at("2027-03-02T12:00:00Z");
    const threeDayTrip = at("2027-03-04T15:00:00Z");
    const why = driverBlocker({ ...base, medicalCardExpiry: tomorrow }, now, threeDayTrip);
    expect(why).toMatch(/^Medical card lapses .*Mar 2.*, before the trip ends .*Mar 4/);
    // The same driver on a trip that is over before the card lapses is fine.
    expect(driverBlocker({ ...base, medicalCardExpiry: tomorrow }, now, at("2027-03-01T22:00:00Z"))).toBeNull();
    // An insurance certificate counts the same way.
    expect(driverBlocker({ ...base, coiExpiresAt: tomorrow }, now, threeDayTrip)).toMatch(/^Insurance certificate lapses/);
  });

  it("blocks a failed carrier check and an authority that is not active, but not a driver nobody checked", () => {
    expect(driverBlocker({ ...base, vetStatus: "failed" }, now)).toBe("Failed the carrier check");
    expect(driverBlocker({ ...base, vetAuthorityActive: false }, now)).toBe("Operating authority is not active");
    expect(driverBlocker({ ...base, vetStatus: "review", vetAuthorityActive: true }, now)).toBeNull();
    expect(driverBlocker({ ...base, vetStatus: "unchecked", vetAuthorityActive: null, coiExpiresAt: null }, now)).toBeNull();
  });

  it("warns ahead of time about the insurance certificate too", () => {
    expect(clearanceSoon({ ...base, coiExpiresAt: at("2027-03-10T00:00:00Z") }, now, 30)).toMatchObject({ what: "Insurance certificate", inDays: 9 });
  });
});
