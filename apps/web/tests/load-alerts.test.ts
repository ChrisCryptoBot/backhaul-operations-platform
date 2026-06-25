import { describe, expect, test } from "vitest";
import type { ViewBoardLoadRow, ViewBoardResponse } from "@/lib/ui/board-mappers";
import {
  collectBoardAlertRollups,
  deriveLoadAlerts,
  diffNewUrgentKeys,
  rollupLoadAlerts,
  scoreRollup,
  type LoadAlertContext
} from "@/lib/ui/load-alerts";

const CTX: LoadAlertContext = { emptyPctAmber: 15, emptyPctRed: 25 };

/** A "clean" load that produces zero alerts; override per test. */
function makeRow(overrides: Partial<ViewBoardLoadRow> = {}): ViewBoardLoadRow {
  return {
    id: "load-1",
    rateConfirmationId: "rc-1",
    ref: "3P-1",
    status: "PICKED_UP",
    shipper: "Shipper",
    receiver: "Receiver",
    lineHaul: 1000,
    loadedMi: 500,
    puDh: 20,
    delDh: 20,
    totalMi: 540,
    negMi: 500,
    loadedRpm: 2,
    nby: 2,
    emptyPct: 0.05,
    routeId: "RT-1",
    loadNumber: "L1",
    pickupNumber: "PU-1",
    pickupNumbers: [],
    lateCancelFailedNote: null,
    attentionSeverity: "INFO",
    scaleBeforeTask: "DONE",
    scaleAfterTask: "DONE",
    bolMatchTask: "DONE",
    pickupEtaAdvised: "DONE",
    pickupArrivalAdvised: "DONE",
    deliveryEtaAdvised: "DONE",
    deliveryArrivalAdvised: "DONE",
    deliveryExceptionState: "NONE",
    rescheduleDriverConfirmed: "DONE",
    brokerName: "Broker",
    brokerRepName: null,
    mgStatusTask: "DONE",
    tmwStatusTask: "DONE",
    pickupDriverAssigned: "J. Doe",
    deliveryDriver: null,
    tractorTrailer1: null,
    tractorTrailer2: null,
    commodity: null,
    equipmentNeeds: null,
    equipmentType: null,
    equipmentAccessory: null,
    equipmentOtherText: null,
    puStatusPreset: "OTHER",
    puStatusCustom: null,
    deliveryDate: null,
    deliveryApptType: null,
    deliveryWindowStartIso: null,
    deliveryWindowEndIso: null,
    delStatusPreset: "OTHER",
    delStatusCustom: null,
    podStatus: "SENT_TO_BROKER",
    fscAmount: 0,
    tonuAmount: 0,
    allInRevenue: 1000,
    coordinatorNotes: null,
    driverType: null,
    pickupCityState: null,
    pickupWindow: null,
    deliveryCityState: null,
    deliveryWindow: null,
    dropLotName: null,
    legs: [],
    ...overrides
  };
}

function kinds(row: ViewBoardLoadRow, ctx: LoadAlertContext = CTX): string[] {
  return deriveLoadAlerts(row, ctx).map((a) => a.kind);
}

type Leg = ViewBoardLoadRow["legs"][number];
function makeLeg(i: number, o: Partial<Leg> = {}): Leg {
  return {
    id: `leg-${i}`,
    legIndex: i,
    legType: "PTP",
    driverName: "Driver",
    startCity: null,
    startState: null,
    endCity: null,
    endState: null,
    legMiles: null,
    notes: null,
    etaAtIso: null,
    arrivalAtIso: null,
    trailer: null,
    trailerHookConfirmed: "NOT_DONE",
    ...o
  };
}

describe("deriveLoadAlerts — baseline & terminal", () => {
  test("a clean load produces no alerts", () => {
    expect(deriveLoadAlerts(makeRow(), CTX)).toEqual([]);
  });

  test("CANCELED with no TONU is silent", () => {
    expect(deriveLoadAlerts(makeRow({ status: "CANCELED" }), CTX)).toEqual([]);
  });

  test("CANCELED with a TONU keeps the bill-broker reminder", () => {
    const alerts = deriveLoadAlerts(makeRow({ status: "CANCELED", tonuAmount: 250 }), CTX);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "TONU_UNBILLED", severity: "INFO", isObligation: true });
  });

  test("COMPLETED is silent even with open task flags", () => {
    expect(deriveLoadAlerts(makeRow({ status: "COMPLETED", mgStatusTask: "NOT_DONE" }), CTX)).toEqual([]);
  });

  test("FAILED is terminal — silent even with open obligations", () => {
    expect(
      deriveLoadAlerts(
        makeRow({
          status: "FAILED",
          mgStatusTask: "NOT_DONE",
          bolMatchTask: "NOT_DONE",
          podStatus: "NEEDS_ATTENTION",
          deliveryExceptionState: "WORK_IN_REQUESTED",
          rescheduleDriverConfirmed: "NOT_DONE"
        }),
        CTX
      )
    ).toEqual([]);
  });
});

describe("deriveLoadAlerts — manual flag", () => {
  test("WARN severity surfaces with the attention note as label", () => {
    const alerts = deriveLoadAlerts(makeRow({ attentionSeverity: "WARN", lateCancelFailedNote: "Detention risk" }), CTX);
    expect(alerts[0]).toMatchObject({ kind: "MANUAL_FLAG", severity: "WARN", label: "Detention risk", isObligation: false });
  });

  test("URGENT severity surfaces; INFO does not", () => {
    expect(kinds(makeRow({ attentionSeverity: "URGENT" }))).toContain("MANUAL_FLAG");
    expect(kinds(makeRow({ attentionSeverity: "INFO" }))).not.toContain("MANUAL_FLAG");
  });
});

describe("deriveLoadAlerts — POD obligations", () => {
  test("NEEDS_ATTENTION → urgent obligation", () => {
    const a = deriveLoadAlerts(makeRow({ podStatus: "NEEDS_ATTENTION" }), CTX).find((x) => x.kind === "POD_NEEDS_ATTENTION");
    expect(a).toMatchObject({ severity: "URGENT", isObligation: true });
  });

  test("REQUESTED → warn obligation", () => {
    expect(kinds(makeRow({ podStatus: "REQUESTED" }))).toContain("POD_REQUESTED");
  });

  test("UPLOADED → send-to-broker obligation", () => {
    const a = deriveLoadAlerts(makeRow({ podStatus: "UPLOADED" }), CTX).find((x) => x.kind === "POD_SEND_OBLIGATION");
    expect(a).toMatchObject({ severity: "WARN", isObligation: true, label: "Send POD to broker" });
  });

  test("SENT_TO_BROKER and NOT_REQUESTED are silent", () => {
    expect(kinds(makeRow({ podStatus: "SENT_TO_BROKER" }))).not.toContain("POD_REQUESTED");
    expect(kinds(makeRow({ podStatus: "NOT_REQUESTED" })).filter((k) => k.startsWith("POD_"))).toEqual([]);
  });
});

describe("deriveLoadAlerts — tasks gated to active statuses", () => {
  test("active load surfaces each open task", () => {
    const row = makeRow({
      status: "DISPATCHED",
      mgStatusTask: "NOT_DONE",
      tmwStatusTask: "NOT_DONE",
      scaleBeforeTask: "NOT_DONE",
      scaleAfterTask: "NOT_DONE",
      pickupDriverAssigned: "J. Doe" // keep coverage-gap out of this assertion
    });
    expect(kinds(row)).toEqual(expect.arrayContaining(["TASK_MG", "TASK_TMW", "TASK_SCALE_BEFORE", "TASK_SCALE_AFTER"]));
  });

  test("FAILED (non-active) does not nag tasks", () => {
    expect(kinds(makeRow({ status: "FAILED", mgStatusTask: "NOT_DONE" }))).not.toContain("TASK_MG");
  });
});

describe("deriveLoadAlerts — coverage gap (flagship)", () => {
  test("pre-pickup with no driver anywhere → urgent", () => {
    const a = deriveLoadAlerts(
      makeRow({ status: "BOOKED", pickupDriverAssigned: null, deliveryDriver: null, legs: [] }),
      CTX
    ).find((x) => x.kind === "COVERAGE_GAP");
    expect(a).toMatchObject({ severity: "URGENT", isObligation: true });
  });

  test("pre-pickup with a driver but an uncovered leg → warn", () => {
    const row = makeRow({
      status: "BOOKED",
      pickupDriverAssigned: null,
      legs: [
        { id: "l1", legIndex: 0, legType: "PTP", driverName: "A", startCity: null, startState: null, endCity: null, endState: null, legMiles: null, notes: null, etaAtIso: null, arrivalAtIso: null, trailer: null, trailerHookConfirmed: "NOT_DONE" },
        { id: "l2", legIndex: 1, legType: "DELIVERY", driverName: null, startCity: null, startState: null, endCity: null, endState: null, legMiles: null, notes: null, etaAtIso: null, arrivalAtIso: null, trailer: null, trailerHookConfirmed: "NOT_DONE" }
      ]
    });
    const a = deriveLoadAlerts(row, CTX).find((x) => x.kind === "COVERAGE_GAP");
    expect(a).toMatchObject({ severity: "WARN" });
  });

  test("already picked up → no coverage gap even without a driver field", () => {
    expect(kinds(makeRow({ status: "PICKED_UP", pickupDriverAssigned: null }))).not.toContain("COVERAGE_GAP");
  });
});

describe("deriveLoadAlerts — missing data", () => {
  test("no rate confirmation", () => {
    expect(kinds(makeRow({ rateConfirmationId: null }))).toContain("MISSING_RATECON");
  });

  test("missing pickup number only pre-pickup", () => {
    expect(kinds(makeRow({ status: "BOOKED", pickupNumber: null, pickupNumbers: [] }))).toContain("MISSING_PICKUP_NUMBER");
    expect(kinds(makeRow({ status: "BOOKED", pickupNumber: null, pickupNumbers: ["PU-x"] }))).not.toContain("MISSING_PICKUP_NUMBER");
    expect(kinds(makeRow({ status: "PICKED_UP", pickupNumber: null, pickupNumbers: [] }))).not.toContain("MISSING_PICKUP_NUMBER");
  });

  test("missing loaded miles", () => {
    expect(kinds(makeRow({ loadedMi: null }))).toContain("MISSING_MILES");
    expect(kinds(makeRow({ loadedMi: 0 }))).toContain("MISSING_MILES");
  });
});

describe("deriveLoadAlerts — empty% thresholds (ratio × 100)", () => {
  test("below amber is silent", () => {
    expect(kinds(makeRow({ emptyPct: 0.14 }))).not.toContain("EMPTY_PCT_OVER");
  });

  test("at the amber boundary → warn", () => {
    const a = deriveLoadAlerts(makeRow({ emptyPct: 0.15 }), CTX).find((x) => x.kind === "EMPTY_PCT_OVER");
    expect(a?.severity).toBe("WARN");
  });

  test("at/over the red boundary → urgent", () => {
    const a = deriveLoadAlerts(makeRow({ emptyPct: 0.25 }), CTX).find((x) => x.kind === "EMPTY_PCT_OVER");
    expect(a?.severity).toBe("URGENT");
  });
});

describe("deriveLoadAlerts — status-stale", () => {
  test("delivered without a POD process → request POD", () => {
    expect(kinds(makeRow({ status: "DELIVERED", podStatus: null }))).toContain("STATUS_STALE");
  });

  test("booked past its delivery date (with now) → warn", () => {
    const now = Date.parse("2026-06-21T12:00:00Z");
    const a = deriveLoadAlerts(makeRow({ status: "BOOKED", deliveryDate: "2026-06-19", pickupDriverAssigned: "J" }), { ...CTX, now })
      .find((x) => x.kind === "STATUS_STALE");
    expect(a?.severity).toBe("WARN");
  });

  test("no `now` skips the date heuristic", () => {
    expect(kinds(makeRow({ status: "BOOKED", deliveryDate: "2020-01-01", pickupDriverAssigned: "J" }))).not.toContain("STATUS_STALE");
  });
});

describe("deriveLoadAlerts — firm delivery appointment escalation", () => {
  const now = Date.parse("2026-06-21T12:00:00Z");

  test("firm appt approaching (within 2h) and not delivered → urgent", () => {
    const appt = new Date(now + 60 * 60 * 1000).toISOString(); // 1h out
    const alerts = deriveLoadAlerts(
      makeRow({ status: "PICKED_UP", deliveryApptType: "FIRM_APPT", deliveryWindowEndIso: appt }),
      { ...CTX, now }
    );
    const a = alerts.find((x) => x.kind === "APPT_APPROACHING");
    expect(a).toMatchObject({ severity: "URGENT", isObligation: true });
  });

  test("firm appt passed and not delivered → missed (urgent)", () => {
    const appt = new Date(now - 60 * 60 * 1000).toISOString(); // 1h ago
    const a = deriveLoadAlerts(
      makeRow({ status: "PICKED_UP", deliveryApptType: "FIRM_APPT", deliveryWindowEndIso: appt }),
      { ...CTX, now }
    ).find((x) => x.kind === "APPT_MISSED");
    expect(a?.severity).toBe("URGENT");
  });

  test("delivered loads don't escalate the appt", () => {
    const appt = new Date(now - 60 * 60 * 1000).toISOString();
    expect(
      kinds(makeRow({ status: "DELIVERED", deliveryApptType: "FIRM_APPT", deliveryWindowEndIso: appt }), { ...CTX, now })
    ).not.toContain("APPT_MISSED");
  });

  test("OPEN_WINDOW appts don't escalate", () => {
    const appt = new Date(now + 30 * 60 * 1000).toISOString();
    expect(
      kinds(makeRow({ status: "PICKED_UP", deliveryApptType: "OPEN_WINDOW", deliveryWindowEndIso: appt }), { ...CTX, now })
    ).not.toContain("APPT_APPROACHING");
  });

  test("a far-off firm appt doesn't fire yet", () => {
    const appt = new Date(now + 6 * 60 * 60 * 1000).toISOString(); // 6h out
    expect(
      kinds(makeRow({ status: "PICKED_UP", deliveryApptType: "FIRM_APPT", deliveryWindowEndIso: appt }), { ...CTX, now })
    ).not.toEqual(expect.arrayContaining(["APPT_APPROACHING", "APPT_MISSED"]));
  });
});

describe("deriveLoadAlerts — missed-appt resolution workflow (Phase 3b)", () => {
  const now = Date.parse("2026-06-21T12:00:00Z");
  const pastAppt = new Date(now - 60 * 60 * 1000).toISOString(); // 1h ago
  const futureAppt = new Date(now + 90 * 60 * 1000).toISOString(); // 90m out

  test("logging work-in suppresses APPT_MISSED and shows WORK_IN_PENDING", () => {
    const k = kinds(
      makeRow({
        status: "PICKED_UP",
        deliveryApptType: "FIRM_APPT",
        deliveryWindowEndIso: pastAppt,
        deliveryExceptionState: "WORK_IN_REQUESTED"
      }),
      { ...CTX, now }
    );
    expect(k).not.toContain("APPT_MISSED");
    expect(k).toContain("WORK_IN_PENDING");
  });

  test("WORK_IN_PENDING is a warn obligation and clears on delivery", () => {
    const a = deriveLoadAlerts(
      makeRow({ status: "PICKED_UP", deliveryExceptionState: "WORK_IN_REQUESTED" }),
      { ...CTX, now }
    ).find((x) => x.kind === "WORK_IN_PENDING");
    expect(a).toMatchObject({ severity: "WARN", isObligation: true });
    expect(kinds(makeRow({ status: "DELIVERED", deliveryExceptionState: "WORK_IN_REQUESTED" }), { ...CTX, now })).not.toContain(
      "WORK_IN_PENDING"
    );
  });

  test("rescheduled with no confirmed driver → urgent next-day-driver nudge; clears when confirmed", () => {
    const a = deriveLoadAlerts(
      makeRow({
        status: "PICKED_UP",
        deliveryExceptionState: "RESCHEDULED",
        rescheduleDriverConfirmed: "NOT_DONE",
        deliveryApptType: "FIRM_APPT",
        deliveryWindowEndIso: futureAppt
      }),
      { ...CTX, now }
    ).find((x) => x.kind === "RESCHEDULE_NEEDS_DRIVER");
    expect(a).toMatchObject({ severity: "URGENT", isObligation: true });
    expect(
      kinds(
        makeRow({
          status: "PICKED_UP",
          deliveryExceptionState: "RESCHEDULED",
          rescheduleDriverConfirmed: "DONE",
          deliveryApptType: "FIRM_APPT",
          deliveryWindowEndIso: futureAppt
        }),
        { ...CTX, now }
      )
    ).not.toContain("RESCHEDULE_NEEDS_DRIVER");
  });

  test("rescheduled to a future window does not re-fire APPT_MISSED or the re-enter nudge", () => {
    const k = kinds(
      makeRow({
        status: "PICKED_UP",
        deliveryExceptionState: "RESCHEDULED",
        rescheduleDriverConfirmed: "DONE",
        deliveryApptType: "FIRM_APPT",
        deliveryWindowEndIso: futureAppt
      }),
      { ...CTX, now }
    );
    expect(k).not.toContain("APPT_MISSED");
    expect(k).not.toContain("DELIVERY_RESCHEDULE_WINDOW");
  });

  test("rescheduled but the new window already re-passed → DELIVERY_RESCHEDULE_WINDOW", () => {
    expect(
      kinds(
        makeRow({
          status: "PICKED_UP",
          deliveryExceptionState: "RESCHEDULED",
          rescheduleDriverConfirmed: "DONE",
          deliveryApptType: "FIRM_APPT",
          deliveryWindowEndIso: pastAppt
        }),
        { ...CTX, now }
      )
    ).toContain("DELIVERY_RESCHEDULE_WINDOW");
  });

  test("delivered loads carry no exception nudges", () => {
    const k = kinds(
      makeRow({ status: "DELIVERED", deliveryExceptionState: "RESCHEDULED", rescheduleDriverConfirmed: "NOT_DONE" }),
      { ...CTX, now }
    );
    expect(k).not.toContain("RESCHEDULE_NEEDS_DRIVER");
    expect(k).not.toContain("WORK_IN_PENDING");
  });
});

describe("deriveLoadAlerts — workflow obligations (Phase 3)", () => {
  test("BOL match is an all-stop gate once picked up (driver has the paperwork)", () => {
    const pickedUp = deriveLoadAlerts(makeRow({ status: "PICKED_UP", bolMatchTask: "NOT_DONE" }), CTX).find((a) => a.kind === "BOL_MATCH");
    expect(pickedUp).toMatchObject({ severity: "URGENT", isObligation: true });
    // Not before pickup — the driver doesn't get the BOL until loaded at the shipper.
    expect(kinds(makeRow({ status: "BOOKED", bolMatchTask: "NOT_DONE" }))).not.toContain("BOL_MATCH");
    expect(kinds(makeRow({ status: "DISPATCHED", bolMatchTask: "NOT_DONE" }))).not.toContain("BOL_MATCH");
    expect(kinds(makeRow({ status: "DELIVERED", bolMatchTask: "NOT_DONE" }))).not.toContain("BOL_MATCH");
  });

  test("advise pickup ETA fires while dispatched", () => {
    expect(kinds(makeRow({ status: "DISPATCHED", pickupEtaAdvised: "NOT_DONE" }))).toContain("ADVISE_PU_ETA");
    expect(kinds(makeRow({ status: "PICKED_UP", pickupEtaAdvised: "NOT_DONE" }))).not.toContain("ADVISE_PU_ETA");
  });

  test("advise pickup arrival + delivery ETA fire while picked up", () => {
    const k = kinds(makeRow({ status: "PICKED_UP", pickupArrivalAdvised: "NOT_DONE", deliveryEtaAdvised: "NOT_DONE" }));
    expect(k).toEqual(expect.arrayContaining(["ADVISE_PU_ARRIVAL", "ADVISE_DEL_ETA"]));
  });

  test("advise delivery arrival fires once delivered", () => {
    expect(kinds(makeRow({ status: "DELIVERED", deliveryArrivalAdvised: "NOT_DONE" }))).toContain("ADVISE_DEL_ARRIVAL");
  });

  test("all obligations done → no workflow alerts", () => {
    expect(kinds(makeRow({ status: "PICKED_UP" }))).toEqual([]);
  });
});

describe("deriveLoadAlerts — per-leg verify-on-site nudge (Phase 3b)", () => {
  const now = Date.parse("2026-06-21T12:00:00Z");

  function makeLeg(overrides: Partial<ViewBoardLoadRow["legs"][number]> = {}): ViewBoardLoadRow["legs"][number] {
    return {
      id: "leg-1",
      legIndex: 1,
      legType: "PTP",
      driverName: "J. Doe",
      startCity: null,
      startState: null,
      endCity: null,
      endState: null,
      legMiles: null,
      notes: null,
      etaAtIso: null,
      arrivalAtIso: null,
      trailer: null,
      trailerHookConfirmed: "NOT_DONE",
      ...overrides
    };
  }

  test("ETA passed with no arrival → warn obligation", () => {
    const eta = new Date(now - 10 * 60 * 1000).toISOString(); // 10 min ago
    const a = deriveLoadAlerts(makeRow({ status: "PICKED_UP", legs: [makeLeg({ etaAtIso: eta })] }), { ...CTX, now }).find(
      (x) => x.kind === "LEG_VERIFY_ONSITE"
    );
    expect(a).toMatchObject({ severity: "WARN", isObligation: true });
    expect(a?.label).toContain("verify driver on-site");
  });

  test("overdue past the 1h threshold → urgent", () => {
    const eta = new Date(now - 90 * 60 * 1000).toISOString(); // 90 min ago
    const a = deriveLoadAlerts(makeRow({ status: "PICKED_UP", legs: [makeLeg({ etaAtIso: eta })] }), { ...CTX, now }).find(
      (x) => x.kind === "LEG_VERIFY_ONSITE"
    );
    expect(a).toMatchObject({ severity: "URGENT", isObligation: true });
    expect(a?.label).toContain("overdue");
  });

  test("ETA not yet reached → no nudge", () => {
    const eta = new Date(now + 30 * 60 * 1000).toISOString(); // 30 min out
    expect(kinds(makeRow({ status: "PICKED_UP", legs: [makeLeg({ etaAtIso: eta })] }), { ...CTX, now })).not.toContain(
      "LEG_VERIFY_ONSITE"
    );
  });

  test("arrival logged clears the nudge even when ETA has passed", () => {
    const eta = new Date(now - 30 * 60 * 1000).toISOString();
    const arr = new Date(now - 25 * 60 * 1000).toISOString();
    expect(
      kinds(makeRow({ status: "PICKED_UP", legs: [makeLeg({ etaAtIso: eta, arrivalAtIso: arr })] }), { ...CTX, now })
    ).not.toContain("LEG_VERIFY_ONSITE");
  });

  test("status-gated to in-transit: none at BOOKED, fires at DELIVERED", () => {
    const eta = new Date(now - 10 * 60 * 1000).toISOString();
    expect(kinds(makeRow({ status: "BOOKED", legs: [makeLeg({ etaAtIso: eta })] }), { ...CTX, now })).not.toContain(
      "LEG_VERIFY_ONSITE"
    );
    expect(kinds(makeRow({ status: "DELIVERED", legs: [makeLeg({ etaAtIso: eta })] }), { ...CTX, now })).toContain(
      "LEG_VERIFY_ONSITE"
    );
  });

  test("no client clock (SSR) → no nudge", () => {
    const eta = new Date(now - 10 * 60 * 1000).toISOString();
    expect(kinds(makeRow({ status: "PICKED_UP", legs: [makeLeg({ etaAtIso: eta })] }))).not.toContain("LEG_VERIFY_ONSITE");
  });

  test("each stale leg gets its own alert with a leg-scoped key", () => {
    const eta = new Date(now - 10 * 60 * 1000).toISOString();
    const row = makeRow({
      status: "PICKED_UP",
      legs: [makeLeg({ id: "leg-a", legIndex: 1, etaAtIso: eta }), makeLeg({ id: "leg-b", legIndex: 2, etaAtIso: eta })]
    });
    const alerts = deriveLoadAlerts(row, { ...CTX, now }).filter((a) => a.kind === "LEG_VERIFY_ONSITE");
    expect(alerts.map((a) => a.key)).toEqual([`${row.id}:LEG_VERIFY_ONSITE:leg-a`, `${row.id}:LEG_VERIFY_ONSITE:leg-b`]);
  });
});

describe("rollupLoadAlerts", () => {
  test("rolls up top severity, count, obligation, and stable keys", () => {
    const row = makeRow({ status: "BOOKED", pickupDriverAssigned: null, legs: [], rateConfirmationId: null });
    const r = rollupLoadAlerts(row, CTX);
    expect(r.count).toBeGreaterThanOrEqual(2);
    expect(r.topSeverity).toBe("URGENT"); // coverage gap is urgent
    expect(r.hasObligation).toBe(true);
    expect(r.alerts.every((a) => a.key === `${row.id}:${a.kind}`)).toBe(true);
  });

  test("clean load rolls up to zero", () => {
    const r = rollupLoadAlerts(makeRow(), CTX);
    expect(r.count).toBe(0);
    expect(r.topSeverity).toBeNull();
  });
});

describe("scoreRollup ordering", () => {
  test("obligation outranks a higher-severity non-obligation", () => {
    const obligationWarn = rollupLoadAlerts(makeRow({ id: "a", podStatus: "REQUESTED" }), CTX);
    const nonObligationUrgent = rollupLoadAlerts(
      makeRow({ id: "b", emptyPct: 0.30 }),
      CTX
    );
    expect(scoreRollup(obligationWarn)).toBeGreaterThan(scoreRollup(nonObligationUrgent));
  });
});

describe("collectBoardAlertRollups", () => {
  function makeBoard(loads: ViewBoardLoadRow[]): ViewBoardResponse {
    return {
      regionId: "r1",
      regionCode: "NE",
      regionLabel: "NE",
      date: "2026-06-21",
      sections: [
        {
          id: "s1",
          type: "drop_lot",
          title: "Lot",
          code: null,
          note: null,
          filledCount: loads.length,
          capacity: null,
          city: null,
          state: null,
          slipSeat: false,
          dropHookRequired: false,
          loads
        }
      ],
      totals: { loads: loads.length, lineHaul: null, fsc: null, tonu: null, allIn: null, loadedMiles: null, emptyPctRatio: null, nby: null },
      config: { emptyPctAmber: 15, emptyPctRed: 25, emptyPctAlert: 6.5 },
      availableRegions: [],
      activeRegionId: "r1"
    };
  }

  test("keeps only loads with open items and sorts most-demanding first", () => {
    const clean = makeRow({ id: "clean" });
    const urgentCoverage = makeRow({ id: "urgent", ref: "3P-9", status: "BOOKED", pickupDriverAssigned: null, legs: [] });
    const warnPod = makeRow({ id: "warn", ref: "3P-2", podStatus: "REQUESTED" });
    const rollups = collectBoardAlertRollups(makeBoard([clean, warnPod, urgentCoverage]));
    expect(rollups.map((r) => r.loadId)).toEqual(["urgent", "warn"]);
  });
});

describe("diffNewUrgentKeys", () => {
  test("returns only keys not already seen", () => {
    const seen = new Set(["load-1:COVERAGE_GAP"]);
    expect(diffNewUrgentKeys(seen, ["load-1:COVERAGE_GAP", "load-2:POD_NEEDS_ATTENTION"])).toEqual([
      "load-2:POD_NEEDS_ATTENTION"
    ]);
  });
});

describe("HANDOFF_STALL — the baton must never drop at a relay node", () => {
  test("fires urgent when an arrived leg hands off to a driverless next leg", () => {
    const row = makeRow({
      status: "PICKED_UP",
      legs: [makeLeg(1, { arrivalAtIso: "2026-06-21T12:00:00Z" }), makeLeg(2, { driverName: null })]
    });
    const stalls = deriveLoadAlerts(row, CTX).filter((a) => a.kind === "HANDOFF_STALL");
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toMatchObject({ severity: "URGENT", isObligation: true });
    // Stable per-handoff key so the notifier de-dupes on the downstream leg.
    expect(stalls[0].key).toBe("load-1:HANDOFF_STALL:leg-2");
  });

  test("silent when the next leg already has a driver", () => {
    const row = makeRow({
      status: "PICKED_UP",
      legs: [makeLeg(1, { arrivalAtIso: "2026-06-21T12:00:00Z" }), makeLeg(2, { driverName: "K. Tran" })]
    });
    expect(kinds(row)).not.toContain("HANDOFF_STALL");
  });

  test("silent before the upstream leg has arrived (no stall yet)", () => {
    const row = makeRow({
      status: "PICKED_UP",
      legs: [makeLeg(1, { arrivalAtIso: null }), makeLeg(2, { driverName: null })]
    });
    expect(kinds(row)).not.toContain("HANDOFF_STALL");
  });

  test("silent on terminal loads", () => {
    const row = makeRow({
      status: "COMPLETED",
      legs: [makeLeg(1, { arrivalAtIso: "2026-06-21T12:00:00Z" }), makeLeg(2, { driverName: null })]
    });
    expect(kinds(row)).not.toContain("HANDOFF_STALL");
  });
});

describe("TRAILER_MISMATCH — the right trailer through every node", () => {
  test("fires urgent when adjacent legs name different trailers and the hook is unconfirmed", () => {
    const row = makeRow({ status: "PICKED_UP", legs: [makeLeg(1, { trailer: "T100" }), makeLeg(2, { trailer: "T200" })] });
    const m = deriveLoadAlerts(row, CTX).filter((a) => a.kind === "TRAILER_MISMATCH");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ severity: "URGENT", isObligation: true });
    expect(m[0].key).toBe("load-1:TRAILER_MISMATCH:leg-2");
  });

  test("silent when trailers match across the handoff", () => {
    const row = makeRow({ status: "PICKED_UP", legs: [makeLeg(1, { trailer: "T1" }), makeLeg(2, { trailer: "T1" })] });
    expect(kinds(row)).not.toContain("TRAILER_MISMATCH");
  });

  test("silent when the next hook is confirmed despite a different trailer (intentional swap)", () => {
    const row = makeRow({
      status: "PICKED_UP",
      legs: [makeLeg(1, { trailer: "T1" }), makeLeg(2, { trailer: "T2", trailerHookConfirmed: "DONE" })]
    });
    expect(kinds(row)).not.toContain("TRAILER_MISMATCH");
  });

  test("silent when a trailer is missing on either leg", () => {
    const row = makeRow({ status: "PICKED_UP", legs: [makeLeg(1, { trailer: "T1" }), makeLeg(2, { trailer: null })] });
    expect(kinds(row)).not.toContain("TRAILER_MISMATCH");
  });
});
