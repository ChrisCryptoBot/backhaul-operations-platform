import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BoardShell } from "@/components/board/board-shell";
import type { ViewBoardResponse } from "@/lib/ui/board-mappers";

/** All 32 pre-Phase-3 column labels — every one must still be present. */
// "PU Driver" was removed as redundant with Driver 1 (leg 0 = the pickup driver).
const ORIGINAL_HEADERS = [
  "REF#", "STATUS", "NOTE", "SCALE BEF", "SCALE AFT", "PU#(s)", "Broker (rep)", "MG", "TMW",
  "Trk/Trlr", "Commodity", "Equip", "Shipper", "PU City, ST", "PU Window",
  "Receiver", "DEL City, ST", "DEL Date/Win", "POD", "Line Haul", "TONU Amt", "All-In Rev",
  "Ldd Mi", "PU DH", "DEL DH", "Total Mi", "Neg Mi", "Ldd RPM", "NBY", "Empty %", "Del"
];

const NEW_HEADERS = [
  "Driver 1", "Driver 2", "Driver 3", "Driver 4",
  "PU Appt", "PU Status/ETA", "DEL Appt", "DEL Status/ETA"
];

const boardFixture: ViewBoardResponse = {
  regionId: "region-1",
  regionCode: "CDC",
  regionLabel: "NORTHEAST",
  date: "2026-07-03",
  totals: { loads: 1, lineHaul: 1000, fsc: 0, tonu: 0, allIn: 1000, loadedMiles: 200, emptyPctRatio: 0.1, nby: 1.5 },
  config: { emptyPctAmber: 15, emptyPctRed: 25, emptyPctAlert: 6.5 },
  availableRegions: [{ id: "region-1", code: "CDC", name: "NORTHEAST" }],
  activeRegionId: "region-1",
  sections: [
    {
      id: "lot-a",
      type: "drop_lot",
      title: "LOT A",
      code: "CDC",
      note: null,
      filledCount: 1,
      capacity: 5,
      city: "Westbrook",
      state: "PA",
      slipSeat: false,
      dropHookRequired: false,
      loads: [
        {
          id: "load-1",
          priorityBand: "today",
          rateConfirmationId: "rc-1",
          ref: "REF-1",
          status: "BOOKED",
          shipper: "Shipper",
          receiver: "Receiver",
          lineHaul: 1000,
          loadedMi: 200,
          puDh: 10,
          delDh: 20,
          totalMi: 230,
          negMi: 210,
          loadedRpm: 5,
          nby: 1.5,
          emptyPct: 0.1,
          routeId: "route-1",
          loadNumber: "L1",
          pickupNumber: "P1",
          pickupNumbers: ["P1"],
          referenceNumbers: [],
          lateCancelFailedNote: null,
          attentionSeverity: "INFO",
          scaleBeforeTask: "NOT_DONE",
          scaleAfterTask: "NOT_DONE",
          bolMatchTask: "NOT_DONE",
          pickupEtaAdvised: "NOT_DONE",
          pickupArrivalAdvised: "NOT_DONE",
          deliveryEtaAdvised: "NOT_DONE",
          deliveryArrivalAdvised: "NOT_DONE",
          deliveryExceptionState: "NONE",
          rescheduleDriverConfirmed: "NOT_DONE",
          brokerName: "Broker",
          brokerRepName: null,
          mgStatusTask: "NOT_DONE",
          tmwStatusTask: "NOT_DONE",
          // Rostered PU driver (FK resolved) — free text intentionally different to
          // prove the roster code wins the cell.
          pickupDriverAssigned: "old free text",
          pickupDriverId: "drv-schm2",
          pickupDriverCode: "SCHM2",
          pickupDriverFullName: "S. Schmidt",
          deliveryDriver: null,
          tractorTrailer1: "TT1",
          tractorTrailer2: null,
          commodity: "General",
          equipmentNeeds: "Van",
          equipmentType: "VAN_53",
          equipmentAccessory: "NONE",
          equipmentOtherText: null,
          puStatusPreset: "OTHER",
          puStatusCustom: "ETA 0930, ON TIME",
          pickupApptType: "FIRM_APPT",
          pickupWindowStartIso: "2026-07-03T12:00:00.000Z",
          pickupWindowEndIso: "2026-07-03T18:00:00.000Z",
          deliveryDate: null,
          deliveryApptType: "FCFS",
          deliveryWindowStartIso: null,
          deliveryWindowEndIso: null,
          delStatusPreset: "LATE",
          delStatusCustom: null,
          podStatus: "Pending",
          fscAmount: 0,
          tonuAmount: 0,
          allInRevenue: 1000,
          coordinatorNotes: null,
          driverType: "PTP",
          pickupCityState: "Utica, NY",
          pickupWindow: "AM",
          deliveryCityState: "Leesport, PA",
          deliveryWindow: "PM",
          dropLotName: "LOT A",
          legs: [
            {
              id: "leg-1",
              legIndex: 1,
              legType: "SHUTTLE",
              driverName: null,
              driverId: "drv-rees2",
              driverCode: "REES2",
              driverFullName: "R. Reese",
              startCity: "Utica",
              startState: "NY",
              endCity: "Holland",
              endState: "MA",
              legMiles: 120,
              notes: null,
              etaAtIso: "2026-07-03T14:30:00.000Z",
              arrivalAtIso: null,
              trailer: null,
              trailerHookConfirmed: "NOT_DONE"
            },
            {
              id: "leg-2",
              legIndex: 2,
              legType: "PTP",
              driverName: "P. Kelly",
              startCity: "Holland",
              startState: "MA",
              endCity: "Leesport",
              endState: "PA",
              legMiles: 180,
              notes: null,
              etaAtIso: null,
              arrivalAtIso: null,
              trailer: null,
              trailerHookConfirmed: "NOT_DONE"
            }
          ]
        }
      ]
    }
  ]
};

describe("board shell — Phase 3 parity columns", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/rate-confirmations/activity")) {
          return new Response(JSON.stringify({ pending: [], ready: [], recent: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response("Not found", { status: 404 });
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  test("with details + metrics shown, keeps every tracker column = 39 columns", () => {
    const { container } = render(<BoardShell board={boardFixture} />);
    // Secondary + metric columns are hidden by default now; reveal both for the full parity check.
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(screen.getByRole("button", { name: "Metrics" }));

    const headerCells = Array.from(container.querySelectorAll("tr.db-collabel-row th")).map(
      (cell) => cell.textContent?.trim() ?? ""
    );
    for (const label of ORIGINAL_HEADERS) {
      expect(headerCells).toContain(label);
    }
    for (const label of NEW_HEADERS) {
      expect(headerCells).toContain(label);
    }
    expect(headerCells).toHaveLength(39);

    // Group-header colSpans must still cover every column.
    const groupSpan = Array.from(container.querySelectorAll("tr.db-colgroup-row th")).reduce(
      (sum, cell) => sum + Number(cell.getAttribute("colspan") ?? 1),
      0
    );
    expect(groupSpan).toBe(39);
  });

  test("shows essentials only by default (financials, miles, and secondary columns hidden)", () => {
    const { container } = render(<BoardShell board={boardFixture} />);
    const headerCells = Array.from(container.querySelectorAll("tr.db-collabel-row th")).map(
      (cell) => cell.textContent?.trim() ?? ""
    );
    // Essentials + the always-visible Del action remain.
    for (const label of ["REF#", "STATUS", "PU#(s)", "Driver 1", "PU City, ST", "PU Appt", "DEL City, ST", "DEL Date/Win", "DEL Status/ETA", "Del"]) {
      expect(headerCells).toContain(label);
    }
    // The redundant "PU Driver" column is gone (Driver 1 is the pickup driver).
    expect(headerCells).not.toContain("PU Driver");
    // Metric columns are hidden…
    expect(headerCells).not.toContain("Line Haul");
    expect(headerCells).not.toContain("Neg Mi");
    // …and so are the secondary/detail columns.
    expect(headerCells).not.toContain("NOTE");
    expect(headerCells).not.toContain("Broker (rep)");
    expect(headerCells).not.toContain("Commodity");
    expect(headerCells).not.toContain("POD");
    expect(headerCells).toHaveLength(15);
  });

  test("Details toggle reveals the secondary columns", () => {
    const { container } = render(<BoardShell board={boardFixture} />);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const headerCells = Array.from(container.querySelectorAll("tr.db-collabel-row th")).map(
      (cell) => cell.textContent?.trim() ?? ""
    );
    for (const label of ["NOTE", "Broker (rep)", "Commodity", "Equip", "Shipper", "Receiver", "POD"]) {
      expect(headerCells).toContain(label);
    }
    // Metrics stay hidden (independent toggle).
    expect(headerCells).not.toContain("Neg Mi");
    expect(headerCells).toHaveLength(28);
  });

  test("rostered drivers render the roster code with a marker; free-text renders as-is", () => {
    const { container } = render(<BoardShell board={boardFixture} />);
    const row = container.querySelector("tr.db-row");
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement);

    // Driver 1 = relay leg 0 (REES2, rostered). The redundant PU Driver column is gone, so
    // the load's separate pickup-driver code (SCHM2) is no longer rendered.
    expect(cells.getByText("REES2")).toBeInTheDocument();
    expect(cells.getByTitle("REES2 — R. Reese (rostered)")).toBeInTheDocument();
    expect(cells.queryByText("SCHM2")).toBeNull();
    expect(cells.queryByText("old free text")).toBeNull();

    // Driver 2 (leg 1) is free text.
    expect(cells.getByText("P. Kelly")).toBeInTheDocument();

    // Rostered marker dot: only Driver 1 (REES2); free-text P. Kelly gets none.
    expect((row as HTMLElement).querySelectorAll(".db-roster-dot")).toHaveLength(1);

    // Empty relay slots (Driver 3 & 4) render em-dashes, not blanks.
    const relayCells = (row as HTMLElement).querySelectorAll("td.db-relay-cell");
    expect(relayCells).toHaveLength(4);
    expect(relayCells[2]?.textContent).toBe("—");
    expect(relayCells[3]?.textContent).toBe("—");
  });

  test("PU/DEL appt and status cells render formatted values", () => {
    const { container } = render(<BoardShell board={boardFixture} />);
    const row = container.querySelector("tr.db-row") as HTMLElement;
    const cells = within(row);

    // PU Appt: FIRM + a local HH:MM–HH:MM window (times are locale/tz dependent — assert shape).
    const apptCells = row.querySelectorAll("td.db-appt-cell");
    expect(apptCells).toHaveLength(2);
    expect(apptCells[0]?.textContent).toMatch(/^FIRM \d{2}:\d{2}–\d{2}:\d{2}$/);
    // DEL Appt: type only (no window set).
    expect(apptCells[1]?.textContent).toBe("FCFS");

    // PU Status/ETA: custom text wins; DEL Status/ETA: preset label.
    expect(cells.getByText("ETA 0930, ON TIME")).toBeInTheDocument();
    expect(cells.getByText("LATE")).toBeInTheDocument();
  });
});
