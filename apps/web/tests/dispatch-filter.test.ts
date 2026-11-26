import { describe, expect, it } from "vitest";
import { filterParams, isFiltered, passes, readQueueFilter } from "../src/lib/dispatch-filter";

const row = (over: Partial<Parameters<typeof passes>[0]> = {}) => ({
  loadNumber: "DM-40002",
  poNumber: "PO-7781",
  bolNumber: null,
  rateConNumber: "RC-1",
  proNumber: null,
  brokerName: "Sample Freight Co",
  origin: "Atlanta, GA",
  destination: "Charlotte, NC",
  driverName: "Alex Rivera",
  equipment: "dry_van",
  pickupAt: new Date("2027-03-01T18:00:00Z"),
  scheduledDate: null,
  status: "draft",
  ...over
});
const now = new Date("2027-03-01T15:00:00Z").getTime();
const keyOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe("the Dispatch queue's filters", () => {
  it("reads only known values from the address", () => {
    expect(readQueueFilter({ q: "  po-77 ", day: "today", state: "declined", eq: "reefer" })).toEqual({ q: "po-77", day: "today", state: "declined", eq: "reefer" });
    expect(readQueueFilter({ day: "someday", state: "lost" })).toEqual({ q: "", day: null, state: null, eq: null });
    expect(isFiltered(readQueueFilter({}))).toBe(false);
    expect(filterParams(readQueueFilter({ q: "x", eq: "flatbed" }))).toEqual({ q: "x", eq: "flatbed" });
  });

  it("searches the load, its references, the customer, the cities and the driver", () => {
    const f = (q: string) => passes(row(), readQueueFilter({ q }), now, keyOf, "2027-03-01", "2027-03-02");
    for (const q of ["40002", "po-7781", "rc-1", "sample", "charlotte", "rivera"]) expect(f(q)).toBe(true);
    expect(f("memphis")).toBe(false);
  });

  it("narrows by pickup day on the carrier's clock, and overdue is a passed pickup not yet on the road", () => {
    const day = (d: string, r = row()) => passes(r, readQueueFilter({ day: d }), now, keyOf, "2027-03-01", "2027-03-02");
    expect(day("today")).toBe(true);
    expect(day("tomorrow")).toBe(false);
    const late = row({ pickupAt: new Date("2027-03-01T10:00:00Z") });
    expect(day("overdue", late)).toBe(true);
    expect(day("overdue", { ...late, status: "in_progress" })).toBe(false);
  });

  it("matches the equipment exactly", () => {
    expect(passes(row(), readQueueFilter({ eq: "reefer" }), now, keyOf, "", "")).toBe(false);
    expect(passes(row(), readQueueFilter({ eq: "dry_van" }), now, keyOf, "", "")).toBe(true);
  });
});
