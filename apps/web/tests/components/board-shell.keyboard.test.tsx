import React from "react";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BoardShell } from "@/components/board/board-shell";
import { ThemeProvider } from "@/components/shell/theme";
import type { ViewBoardResponse } from "@/lib/ui/board-mappers";

const boardFixture: ViewBoardResponse = {
  regionId: "region-1",
  regionCode: "CDC",
  regionLabel: "NORTHEAST",
  date: "2026-04-29",
  totals: {
    loads: 1,
    lineHaul: 1000,
    fsc: 0,
    tonu: 0,
    allIn: 1000,
    loadedMiles: 200,
    emptyPctRatio: 0.1,
    nby: 1.5
  },
  config: { emptyPctAmber: 15, emptyPctRed: 25, emptyPctAlert: 6.5 },
  availableRegions: [{ id: "region-1", code: "CDC", name: "NORTHEAST" }],
  activeRegionId: "region-1",
  sections: [
    {
      id: "lot-a",
      type: "drop_lot",
      title: "LOT A",
      code: "CDC",
      note: "24/7 dock",
      filledCount: 1,
      capacity: 5,
      city: "Westbrook",
      state: "PA",
      slipSeat: false,
      dropHookRequired: true,
      loads: [
        {
          id: "load-1",
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
          pickupDriverAssigned: "Driver",
          deliveryDriver: null,
          tractorTrailer1: "TT1",
          tractorTrailer2: "TT2",
          commodity: "General",
          equipmentNeeds: "Van",
          equipmentType: "VAN_53",
          equipmentAccessory: "NONE",
          equipmentOtherText: null,
          puStatusPreset: "OTHER",
          puStatusCustom: null,
          deliveryDate: null,
          deliveryApptType: null,
          deliveryWindowStartIso: null,
          deliveryWindowEndIso: null,
          delStatusPreset: "OTHER",
          delStatusCustom: null,
          podStatus: "Pending",
          fscAmount: 0,
          tonuAmount: 0,
          allInRevenue: 1000,
          coordinatorNotes: null,
          driverType: "PTP",
          pickupCityState: "A, PA",
          pickupWindow: "AM",
          deliveryCityState: "B, PA",
          deliveryWindow: "PM",
          dropLotName: "LOT A",
          legs: []
        }
      ]
    }
  ]
};

const detailPayload = {
  id: "load-1",
  status: "BOOKED",
  sectionCode: "LOT-A",
  threePlRefNumber: "REF-1",
  routeId: "route-1",
  loadNumber: "L1",
  pickupNumber: "P1",
  shipperName: "Shipper",
  pickupCityState: "A, PA",
  pickupWindow: "AM",
  receiverName: "Receiver",
  deliveryCityState: "B, PA",
  deliveryWindow: "PM",
  lineHaulRate: "1000",
  loadedMiles: "200",
  puDeadheadMiles: "10",
  delDeadheadMiles: "20",
  totalTripMiles: "230",
  negotiableMiles: "210",
  loadedRpm: "5",
  emptyMilePct: "0.1",
  brokerName: "Broker",
  pickupDriverAssigned: "Driver",
  tractorTrailer1: "TT1",
  tractorTrailer2: "TT2",
  commodity: "General",
  equipmentNeeds: "Van",
  mgStatus: "OK",
  tmwStatus: "OK",
  podStatus: "Pending",
  rateConfirmation: null,
  createdAt: "2026-04-29T00:00:00.000Z",
  updatedAt: "2026-04-29T00:00:00.000Z"
};

describe("board shell keyboard accessibility", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/rate-confirmations/activity")) {
          return new Response(JSON.stringify({
            pending: [{ id: "rc-pending-1", parseState: "EXTRACTING", reviewDecision: "PENDING" }],
            ready: [{ id: "rc-ready-1", parseState: "EXTRACTED", reviewDecision: "APPROVED" }],
            recent: [{ id: "rc-ready-1", parseState: "EXTRACTED", reviewDecision: "APPROVED", updatedAt: "2026-04-29T10:42:00.000Z" }]
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/board/load/")) {
          return new Response(JSON.stringify(detailPayload), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response("Not found", { status: 404 });
      })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    cleanup();
  });

  test("opens and closes drawer via keyboard from board row", async () => {
    const user = userEvent.setup();
    render(<BoardShell board={boardFixture} />);

    const rowButton = screen.getByRole("button", { name: "Open details for REF-1" });
    rowButton.focus();
    expect(rowButton).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    const dialog = await screen.findByRole("dialog");
    const closeButton = within(dialog).getByRole("button", { name: "Close load details" });
    await waitFor(() => {
      expect(closeButton).toHaveFocus();
    });

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(rowButton).toHaveFocus();
    });
  });

  test("renders canonical header search affordances", () => {
    const { container } = render(<BoardShell board={boardFixture} />);
    expect(container.querySelector(".db-tb-search")).not.toBeNull();
    expect(screen.getByRole("searchbox", { name: "Search loads" })).toBeInTheDocument();
  });

  test("keeps a single keyboard stop for load row activation button", () => {
    const { container } = render(<BoardShell board={boardFixture} />);
    const row = container.querySelector("tr.db-row");
    expect(row).not.toBeNull();
    expect(row).not.toHaveAttribute("tabindex");
    expect(screen.getByRole("button", { name: "Open details for REF-1" })).toBeInTheDocument();
  });

  test("toolbar search filters loads across ref/broker/city text", async () => {
    const user = userEvent.setup();
    const searchBoard: ViewBoardResponse = {
      ...boardFixture,
      sections: [
        {
          ...boardFixture.sections[0],
          loads: [
            {
              ...boardFixture.sections[0].loads[0],
              id: "load-match",
              ref: "REF-MATCH",
              brokerName: "Acme Logistics"
            },
            {
              ...boardFixture.sections[0].loads[0],
              id: "load-other",
              ref: "REF-OTHER",
              brokerName: "Globex Freight"
            }
          ]
        }
      ]
    };
    render(<BoardShell board={searchBoard} />);
    // Scope to the board table — the Needs Attention rail also lists these refs.
    const table = screen.getByRole("table");
    expect(within(table).getByText("REF-MATCH")).toBeInTheDocument();
    expect(within(table).getByText("REF-OTHER")).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Search loads" }), "acme");
    expect(within(table).getByText("REF-MATCH")).toBeInTheDocument();
    expect(within(table).queryByText("REF-OTHER")).toBeNull();
  });

  test("applies initial highlight for review-to-board handoff", () => {
    const { container } = render(<BoardShell board={boardFixture} initialHighlightLoadId="load-1" />);
    expect(container.querySelector("tr.db-row.selected")).not.toBeNull();
  });

  test("surfaces mutation map-failure and attempts board refetch", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/rate-confirmations/activity")) {
        return new Response(JSON.stringify({ pending: [], ready: [], recent: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url === "/api/board" && init?.method === "POST") {
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.startsWith("/api/board?date=")) {
        return new Response(JSON.stringify({ error: "forced-refresh-failure" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url.includes("/api/board/load/")) {
        return new Response(JSON.stringify(detailPayload), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("Not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<BoardShell board={boardFixture} />);
    const row = screen.getByRole("button", { name: "Open details for REF-1" }).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.contextMenu(row!);
    await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/board?date=2026-04-29&regionId=region-1",
        expect.anything()
      );
      expect(screen.getByText("forced-refresh-failure")).toBeInTheDocument();
    });
  });

  test("confirms delete dialog on Enter key", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/rate-confirmations/activity")) {
        return new Response(JSON.stringify({ pending: [], ready: [], recent: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url === "/api/board" && init?.method === "POST") {
        return new Response(JSON.stringify({ error: "forced-delete-error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url.includes("/api/board/load/")) {
        return new Response(JSON.stringify(detailPayload), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("Not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<BoardShell board={boardFixture} />);

    const row = screen.getByRole("button", { name: "Open details for REF-1" }).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.contextMenu(row!);
    await user.click(screen.getByRole("button", { name: "Edit / View" }));
    await user.click(screen.getByRole("button", { name: "X" }));

    const deleteDialog = screen.getByRole("dialog", { name: "Delete load" });
    const reasonInput = within(deleteDialog).getByRole("textbox");
    await user.type(reasonInput, "valid delete reason");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/board",
        expect.objectContaining({ method: "POST" })
      );
      expect(screen.getByText("forced-delete-error")).toBeInTheDocument();
    });
  });

  test("shows busy state while TONU mutation is pending", async () => {
    const pendingResponses: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/rate-confirmations/activity")) {
        return Promise.resolve(
          new Response(JSON.stringify({ pending: [], ready: [], recent: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          })
        );
      }
      if (url === "/api/board" && init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          pendingResponses.push(resolve);
        });
      }
      if (url.includes("/api/board/load/")) {
        return Promise.resolve(
          new Response(JSON.stringify(detailPayload), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          })
        );
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<BoardShell board={boardFixture} />);

    const row = screen.getByRole("button", { name: "Open details for REF-1" }).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.contextMenu(row!);
    await user.click(screen.getByRole("button", { name: "Mark TONU" }));
    await user.click(screen.getByRole("button", { name: "Confirm TONU" }));

    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    pendingResponses.forEach((resolve) =>
      resolve(
        new Response(JSON.stringify({ error: "forced-timeout" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        })
      )
    );

    await waitFor(() => {
      expect(screen.getByText("forced-timeout")).toBeInTheDocument();
    });
  });

  test("collapses and expands the sidebar with accessible toggle", async () => {
    const user = userEvent.setup();
    const { container } = render(<BoardShell board={boardFixture} />);
    const sidebarToggle = screen.getByRole("button", { name: "Collapse sidebar" });

    expect(container.querySelector('.db-sidebar[data-collapsed="false"]')).not.toBeNull();
    expect(sidebarToggle).toHaveAttribute("aria-expanded", "true");
    await user.click(sidebarToggle);
    expect(sidebarToggle).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector('.db-sidebar[data-collapsed="true"]')).not.toBeNull();
  });

  test("defaults to dark theme and persists light mode toggle", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <BoardShell board={boardFixture} />
      </ThemeProvider>
    );
    const themeToggle = screen.getByRole("button", { name: "Switch to light mode" });

    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    });
    await user.click(themeToggle);
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
      expect(window.localStorage.getItem("db-theme")).toBe("light");
    });
  });
});
