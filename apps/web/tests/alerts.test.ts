import { describe, expect, test } from "vitest";
import { alertsByLoad, countAlerts, deriveAlerts, RULES, topLevel, type AlertLoad } from "../src/lib/alerts";

const NOW = new Date("2026-10-28T15:00:00Z");
const H = 3_600_000;
const D = 86_400_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

const driver = (over: Partial<{ id: string; name: string; cdlExpiry: Date | null; medicalCardExpiry: Date | null }> = {}) => ({
  id: "d1",
  name: "Alex Rivera",
  cdlExpiry: at(200 * D),
  medicalCardExpiry: at(200 * D),
  ...over
});

function load(over: Partial<AlertLoad> = {}): AlertLoad {
  return {
    id: "l1",
    loadNumber: "DM-1",
    status: "draft",
    paymentStatus: null,
    invoiceNumber: null,
    invoicedAt: null,
    payTermsDays: 30,
    verdict: "accept",
    stops: [
      { timeWindowEarliest: at(3 * D), timeWindowLatest: at(3 * D + 3 * H), referenceNumbers: ["PU-1"] },
      { timeWindowEarliest: at(4 * D), timeWindowLatest: at(4 * D + 3 * H), referenceNumbers: ["DEL-1"] }
    ],
    assignment: null,
    ...over
  };
}

const codes = (loads: AlertLoad[]) => deriveAlerts(loads, NOW).map((a) => a.code);

describe("deriveAlerts", () => {
  test("a clean load far from pickup raises nothing", () => {
    expect(codes([load()])).toEqual([]);
  });

  test("pickup inside 24 hours with no driver sent blocks; further out does not; past pickup says so", () => {
    const soon = load({ stops: [{ timeWindowEarliest: at(5 * H), timeWindowLatest: at(8 * H), referenceNumbers: ["x"] }] });
    const [a] = deriveAlerts([soon], NOW);
    expect(a).toMatchObject({ code: "PICKUP_NO_DRIVER", level: "block" });
    expect(a!.message).toBe("Pickup is in 5 h and no driver has been sent.");

    const past = load({ stops: [{ timeWindowEarliest: at(-2 * H), timeWindowLatest: at(H), referenceNumbers: ["x"] }] });
    expect(deriveAlerts([past], NOW)[0]!.message).toBe("The pickup time has passed and no driver has been sent.");

    const sent = load({ stops: soon.stops, assignment: { status: "dispatched", dispatchedAt: at(-H), driver: driver() } });
    expect(codes([sent])).not.toContain("PICKUP_NO_DRIVER");
  });

  test("a lapsed card blocks and a card lapsing within 30 days warns; a declined driver is ignored", () => {
    const lapsed = load({ assignment: { status: "draft", dispatchedAt: null, driver: driver({ cdlExpiry: at(-D) }) } });
    expect(deriveAlerts([lapsed], NOW)[0]).toMatchObject({ code: "DRIVER_CLEARANCE", level: "block", message: "Alex Rivera: CDL expired." });

    const soon = load({ assignment: { status: "draft", dispatchedAt: null, driver: driver({ medicalCardExpiry: at(12 * D) }) } });
    expect(deriveAlerts([soon], NOW)[0]).toMatchObject({ code: "CLEARANCE_SOON", level: "warn" });
    expect(deriveAlerts([soon], NOW)[0]!.message).toContain("Medical card lapses in 12 days");

    const declined = load({ assignment: { status: "declined", dispatchedAt: null, driver: driver({ cdlExpiry: at(-D) }) } });
    expect(codes([declined])).not.toContain("DRIVER_CLEARANCE");
  });

  test("sent with no answer warns only after the wait", () => {
    const early = load({ assignment: { status: "dispatched", dispatchedAt: at(-3 * H), driver: driver() } });
    expect(codes([early])).not.toContain("SENT_NO_ANSWER");
    const late = load({ assignment: { status: "dispatched", dispatchedAt: at(-9 * H), driver: driver() } });
    const a = deriveAlerts([late], NOW).find((x) => x.code === "SENT_NO_ANSWER")!;
    expect(a.level).toBe("warn");
    expect(a.message).toBe("Sent to Alex Rivera 9 h ago and no answer yet.");
  });

  test("a below-cost load with no driver sent warns; with a driver sent it does not", () => {
    expect(codes([load({ verdict: "reject" })])).toEqual(["BELOW_COST_UNASSIGNED"]);
    const sent = load({ verdict: "reject", assignment: { status: "dispatched", dispatchedAt: at(-H), driver: driver() } });
    expect(codes([sent])).not.toContain("BELOW_COST_UNASSIGNED");
  });

  test("one driver on two overlapping open loads is double-booked on both, back to back is fine", () => {
    const a = load({ id: "a", loadNumber: "DM-A", status: "accepted", assignment: { status: "accepted", dispatchedAt: at(-D), driver: driver() } });
    const b = load({
      id: "b",
      loadNumber: "DM-B",
      status: "accepted",
      stops: [{ timeWindowEarliest: at(3 * D + H), timeWindowLatest: at(5 * D), referenceNumbers: ["x"] }],
      assignment: { status: "accepted", dispatchedAt: at(-D), driver: driver() }
    });
    const result = deriveAlerts([a, b], NOW).filter((x) => x.code === "DOUBLE_BOOKED");
    expect(result.map((x) => x.loadId).sort()).toEqual(["a", "b"]);
    expect(result.find((x) => x.loadId === "a")!.message).toBe("Alex Rivera is also booked on DM-B at the same time.");

    const c = load({
      id: "c",
      loadNumber: "DM-C",
      status: "accepted",
      stops: [{ timeWindowEarliest: at(4 * D + 3 * H), timeWindowLatest: at(5 * D), referenceNumbers: ["x"] }],
      assignment: { status: "accepted", dispatchedAt: at(-D), driver: driver() }
    });
    expect(deriveAlerts([a, c], NOW).filter((x) => x.code === "DOUBLE_BOOKED")).toEqual([]);

    const other = load({ id: "o", loadNumber: "DM-O", status: "accepted", assignment: { status: "accepted", dispatchedAt: at(-D), driver: driver({ id: "d2", name: "Sam Okafor" }) } });
    expect(deriveAlerts([a, other], NOW).filter((x) => x.code === "DOUBLE_BOOKED")).toEqual([]);
  });

  test("money alerts: overdue invoice warns, delivered and not invoiced informs", () => {
    const overdue = load({ status: "completed", paymentStatus: "invoiced", invoiceNumber: "INV-7", invoicedAt: at(-40 * D), payTermsDays: 30 });
    expect(deriveAlerts([overdue], NOW)[0]).toMatchObject({ code: "INVOICE_OVERDUE", level: "warn", message: "INV-7 is 10 days past its terms." });
    const fresh = load({ status: "completed", paymentStatus: "invoiced", invoiceNumber: "INV-8", invoicedAt: at(-5 * D) });
    expect(codes([fresh])).toEqual([]);
    expect(codes([load({ status: "completed" })])).toEqual(["READY_TO_INVOICE"]);
  });

  test("a stop with no reference number is an info on an assigned load", () => {
    const l = load({
      stops: [{ timeWindowEarliest: at(3 * D), timeWindowLatest: at(3 * D + H), referenceNumbers: [] }],
      assignment: { status: "draft", dispatchedAt: null, driver: driver() }
    });
    expect(deriveAlerts([l], NOW)[0]).toMatchObject({ code: "MISSING_REFERENCE", level: "info" });
  });

  test("results are ordered block, warn, info; counts and per-load grouping agree", () => {
    const blocked = load({ id: "x", loadNumber: "DM-X", stops: [{ timeWindowEarliest: at(2 * H), timeWindowLatest: at(4 * H), referenceNumbers: ["x"] }], verdict: "reject" });
    const info = load({ id: "y", loadNumber: "DM-Y", status: "completed" });
    const alerts = deriveAlerts([info, blocked], NOW);
    expect(alerts.map((a) => a.level)).toEqual(["block", "warn", "info"]);
    expect(countAlerts(alerts)).toEqual({ block: 1, warn: 1, info: 1 });
    expect(alertsByLoad(alerts).get("x")).toHaveLength(2);
    expect(topLevel(alertsByLoad(alerts).get("x"))).toBe("block");
    expect(topLevel(undefined)).toBeNull();
  });

  test("every rule code the engine can raise is in the catalogue, with plain wording", () => {
    const raised = new Set<string>();
    const cases: AlertLoad[] = [
      load({ stops: [{ timeWindowEarliest: at(H), timeWindowLatest: at(2 * H), referenceNumbers: [] }], verdict: "reject" }),
      load({ assignment: { status: "dispatched", dispatchedAt: at(-9 * H), driver: driver({ cdlExpiry: at(-D) }) } }),
      load({ assignment: { status: "draft", dispatchedAt: null, driver: driver({ cdlExpiry: at(10 * D) }) } }),
      load({ status: "completed", paymentStatus: "invoiced", invoicedAt: at(-90 * D), invoiceNumber: "I" }),
      load({ status: "completed" })
    ];
    for (const l of cases) for (const a of deriveAlerts([l], NOW)) raised.add(a.code);
    for (const c of raised) expect(RULES.map((r) => r.code)).toContain(c);
    for (const r of RULES) expect(r.trigger({ pickupHours: 24, sentNoAnswerHours: 4, clearanceDays: 30 })).toMatch(/\.$/);
  });
});
