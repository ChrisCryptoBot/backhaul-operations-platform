import { describe, expect, test } from "vitest";
import { deriveLoadChecklist, stageExitObligations, type ChecklistLoadInput } from "@/lib/ui/load-checklist";

/** A clean load: every checklist item satisfied. Override per test. */
function makeLoad(o: Partial<ChecklistLoadInput> = {}): ChecklistLoadInput {
  return {
    status: "BOOKED",
    mgStatusTask: "DONE",
    tmwStatusTask: "DONE",
    scaleBeforeTask: "DONE",
    scaleAfterTask: "DONE",
    bolMatchTask: "DONE",
    pickupEtaAdvised: "DONE",
    pickupArrivalAdvised: "DONE",
    deliveryEtaAdvised: "DONE",
    deliveryArrivalAdvised: "DONE",
    podStatus: "SENT_TO_BROKER",
    rateConfirmationId: "rc-1",
    pickupNumber: "PU-1",
    pickupNumbers: [],
    pickupDriverAssigned: "J. Doe",
    deliveryDriver: null,
    legs: [],
    ...o
  };
}

function itemState(load: ChecklistLoadInput, key: string): string | undefined {
  return deriveLoadChecklist(load)
    .groups.flatMap((g) => g.items)
    .find((i) => i.key === key)?.state;
}

describe("deriveLoadChecklist", () => {
  test("a clean load is fully done with no open items", () => {
    const c = deriveLoadChecklist(makeLoad());
    expect(c.summary.openHard).toBe(0);
    expect(c.summary.openSoft).toBe(0);
    expect(c.summary.done).toBe(c.summary.total);
    expect(c.summary.total).toBeGreaterThan(0);
  });

  test("no driver → coverage is the one blocked (hard) item", () => {
    const c = deriveLoadChecklist(makeLoad({ pickupDriverAssigned: null, deliveryDriver: null, legs: [] }));
    expect(c.summary.openHard).toBe(1);
    expect(itemState(makeLoad({ pickupDriverAssigned: null, deliveryDriver: null }), "COVERAGE_GAP")).toBe("blocked");
  });

  test("a leg driver satisfies coverage", () => {
    expect(
      itemState(makeLoad({ pickupDriverAssigned: null, deliveryDriver: null, legs: [{ driverName: "K. Tran" }] }), "COVERAGE_GAP")
    ).toBe("done");
  });

  test("an open soft obligation shows as open, not blocked", () => {
    expect(itemState(makeLoad({ bolMatchTask: "NOT_DONE" }), "BOL_MATCH")).toBe("open");
    expect(deriveLoadChecklist(makeLoad({ bolMatchTask: "NOT_DONE" })).summary.openSoft).toBe(1);
  });

  test("POD requested is done for REQUESTED/UPLOADED/SENT, open otherwise", () => {
    expect(itemState(makeLoad({ podStatus: "REQUESTED" }), "POD_REQUESTED")).toBe("done");
    expect(itemState(makeLoad({ podStatus: "NOT_REQUESTED" }), "POD_REQUESTED")).toBe("open");
    expect(itemState(makeLoad({ podStatus: null }), "POD_SEND_OBLIGATION")).toBe("open");
  });

  test("terminal loads carry no checklist", () => {
    for (const status of ["CANCELED", "FAILED", "COMPLETED"]) {
      const c = deriveLoadChecklist(makeLoad({ status }));
      expect(c.summary.total).toBe(0);
      expect(c.groups).toEqual([]);
    }
  });
});

describe("stageExitObligations", () => {
  test("coverage is a HARD exit obligation of BOOKED", () => {
    const { hardOpen, softOpen } = stageExitObligations(
      makeLoad({ pickupDriverAssigned: null, deliveryDriver: null, legs: [] }),
      "BOOKED"
    );
    expect(hardOpen.map((i) => i.key)).toContain("COVERAGE_GAP");
    expect(softOpen.map((i) => i.key)).not.toContain("COVERAGE_GAP");
  });

  test("open DISPATCHED obligations are soft (advise PU ETA); BOL is not yet due", () => {
    const { hardOpen, softOpen } = stageExitObligations(makeLoad({ bolMatchTask: "NOT_DONE", pickupEtaAdvised: "NOT_DONE" }), "DISPATCHED");
    expect(hardOpen).toEqual([]);
    expect(softOpen.map((i) => i.key)).toContain("ADVISE_PU_ETA");
    expect(softOpen.map((i) => i.key)).not.toContain("BOL_MATCH");
  });

  test("BOL-match is a PICKED_UP obligation (driver has the paperwork once loaded)", () => {
    const { softOpen } = stageExitObligations(makeLoad({ bolMatchTask: "NOT_DONE" }), "PICKED_UP");
    expect(softOpen.map((i) => i.key)).toContain("BOL_MATCH");
  });

  test("a fully-satisfied stage has no exit obligations", () => {
    const both = stageExitObligations(makeLoad(), "DISPATCHED");
    expect(both.hardOpen).toEqual([]);
    expect(both.softOpen).toEqual([]);
  });
});

describe("relay dimension (per-leg + per-handoff)", () => {
  type Leg = ChecklistLoadInput["legs"][number];
  const leg = (i: number, o: Partial<Leg> = {}): Leg => ({
    driverName: "Driver",
    id: `leg-${i}`,
    legIndex: i,
    legType: "PTP",
    etaAtIso: "2026-06-21T10:00:00Z",
    arrivalAtIso: "2026-06-21T12:00:00Z",
    ...o
  });

  function relayGroup(load: ChecklistLoadInput) {
    return deriveLoadChecklist(load).groups.find((g) => g.stage === "RELAY");
  }
  function keys(load: ChecklistLoadInput): string[] {
    return relayGroup(load)?.items.map((i) => i.key) ?? [];
  }

  test("no legs → no relay group, no relay items", () => {
    expect(relayGroup(makeLoad({ legs: [] }))).toBeUndefined();
  });

  test("a 1-leg (direct) load yields per-leg items but zero handoffs", () => {
    const k = keys(makeLoad({ legs: [leg(0)] }));
    expect(k).toEqual(["LEG_0_DRIVER", "LEG_0_ETA", "LEG_0_ARRIVAL"]);
    expect(k.some((key) => key.startsWith("HANDOFF_"))).toBe(false);
  });

  test("a 3-leg full relay yields 2 handoffs in chain order", () => {
    const k = keys(makeLoad({ legs: [leg(0), leg(1), leg(2)] }));
    const handoffs = k.filter((key) => key.endsWith("_DEPART"));
    expect(handoffs).toEqual(["HANDOFF_0_1_DEPART", "HANDOFF_1_2_DEPART"]);
  });

  test("relay items are always soft — a driverless leg never adds a hard gate", () => {
    const c = deriveLoadChecklist(makeLoad({ legs: [leg(0, { driverName: null }), leg(1)] }));
    expect(c.summary.openHard).toBe(0);
    expect(itemState(makeLoad({ legs: [leg(0, { driverName: null }), leg(1)] }), "LEG_0_DRIVER")).toBe("open");
  });

  test("handoff is done only when the prior leg arrived AND the next leg has a driver", () => {
    // prior arrived + next has driver → baton confirmed
    expect(itemState(makeLoad({ legs: [leg(0), leg(1)] }), "HANDOFF_0_1_DEPART")).toBe("done");
    // prior not yet arrived → open
    expect(
      itemState(makeLoad({ legs: [leg(0, { arrivalAtIso: null }), leg(1)] }), "HANDOFF_0_1_DEPART")
    ).toBe("open");
    // next leg driverless → open (would stall)
    expect(
      itemState(makeLoad({ legs: [leg(0), leg(1, { driverName: null })] }), "HANDOFF_0_1_DEPART")
    ).toBe("open");
  });

  test("relay items count toward the summary as soft", () => {
    const c = deriveLoadChecklist(makeLoad({ legs: [leg(0), leg(1)] }));
    // 2 legs × 3 per-leg items + 1 baton + 1 trailer = 8 relay items, all done here.
    expect(c.summary.total).toBeGreaterThanOrEqual(8);
    expect(c.summary.openHard).toBe(0);
  });

  test("handoff trailer continuity: matching done, mismatch open, hook-confirmed done", () => {
    expect(itemState(makeLoad({ legs: [leg(0, { trailer: "T100" }), leg(1, { trailer: "T100" })] }), "HANDOFF_0_1_TRAILER")).toBe("done");
    expect(itemState(makeLoad({ legs: [leg(0, { trailer: "T100" }), leg(1, { trailer: "T200" })] }), "HANDOFF_0_1_TRAILER")).toBe("open");
    expect(
      itemState(
        makeLoad({ legs: [leg(0, { trailer: "T100" }), leg(1, { trailer: "T200", trailerHookConfirmed: "DONE" })] }),
        "HANDOFF_0_1_TRAILER"
      )
    ).toBe("done");
  });

  test("a 1-leg load has no trailer-continuity item", () => {
    expect(keys(makeLoad({ legs: [leg(0, { trailer: "T1" })] })).some((k) => k.endsWith("_TRAILER"))).toBe(false);
  });
});
