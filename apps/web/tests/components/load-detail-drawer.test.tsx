import React from "react";
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoadDetailDrawer } from "@/components/board/load-detail-drawer";

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
  nby: "4.3478",
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
  legs: [],
  createdAt: "2026-04-29T00:00:00.000Z",
  updatedAt: "2026-04-29T02:30:00.000Z",
  createdByName: "Chris McDaniel",
  lastUpdatedByName: "System",
  lastUpdatedAction: "STATUS_CHANGE"
};

const detailWithRatecon = {
  ...detailPayload,
  rateConfirmation: {
    id: "rc-1",
    sourceFileUrl: "https://example.com/files/RXO_44230_CARLISLE.pdf",
    parseState: "EXTRACTED",
    parseConfidence: "0.9600"
  }
};

describe("load detail drawer interactions", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(detailPayload), { status: 200, headers: { "Content-Type": "application/json" } }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  test("renders nothing when loadId is null", () => {
    render(<LoadDetailDrawer loadId={null} regionId="region-1" onClose={() => undefined} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("renders dialog with accessible title linkage", async () => {
    render(<LoadDetailDrawer loadId="load-1" regionId="region-1" onClose={() => undefined} />);
    const dialog = await screen.findByRole("dialog");
    const title = await screen.findByRole("heading", { name: "REF-1" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", title.id);
  });

  test("closes on Escape and backdrop click", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<LoadDetailDrawer loadId="load-1" regionId="region-1" onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    const dialog = screen.getByRole("dialog");
    const closeButton = within(dialog).getByRole("button", { name: "Close load details" });
    closeButton.focus();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    const backdrop = document.querySelector(".db-drawer-backdrop");
    expect(backdrop).toBeInstanceOf(HTMLElement);
    await user.click(backdrop as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test("traps focus inside drawer", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button>Outside action</button>
        <LoadDetailDrawer loadId="load-1" regionId="region-1" onClose={() => undefined} />
      </div>
    );

    await screen.findByRole("dialog");
    const dialog = screen.getByRole("dialog");
    const outsideButton = screen.getByRole("button", { name: "Outside action" });
    const closeButton = within(dialog).getByRole("button", { name: "Close load details" });
    const editButton = within(dialog).getByRole("button", { name: "Edit" });

    closeButton.focus();
    expect(closeButton).toHaveFocus();

    // Tab from the last focusable wraps to the first (the Edit toggle).
    await user.tab();
    expect(editButton).toHaveFocus();

    await user.tab({ shift: true });
    expect(closeButton).toHaveFocus();
    expect(outsideButton).not.toHaveFocus();
  });

  test("renders the redesigned read-mode sections", async () => {
    render(<LoadDetailDrawer loadId="load-1" regionId="region-1" onClose={() => undefined} />);
    const dialog = await screen.findByRole("dialog");
    // Eyebrow + identifiers KV + NBY trio card + audit footer.
    expect(within(dialog).getByText("Net Backhaul Yield")).toBeInTheDocument();
    expect(within(dialog).getByText("3PL REF #")).toBeInTheDocument();
    expect(within(dialog).getByText("Created by")).toBeInTheDocument();
    expect(within(dialog).getByText("Chris McDaniel")).toBeInTheDocument();
    // Edit-only controls are hidden in read mode.
    expect(within(dialog).queryByRole("button", { name: "Mark Canceled" })).toBeNull();
  });

  test("edit toggle reveals operational form and saves", async () => {
    const user = userEvent.setup();
    const onUpdateFields = vi.fn(async (_loadId: string, _fields: unknown) => undefined);
    render(
      <LoadDetailDrawer loadId="load-1" regionId="region-1" onClose={() => undefined} onUpdateFields={onUpdateFields} />
    );
    const dialog = await screen.findByRole("dialog");

    await user.click(within(dialog).getByRole("button", { name: "Edit" }));
    expect(within(dialog).getByRole("button", { name: "Mark Canceled" })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      expect(onUpdateFields).toHaveBeenCalledTimes(1);
    });
    expect(onUpdateFields.mock.calls[0][0]).toBe("load-1");
  });

  test("renders the rate confirmation card with an Open link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(detailWithRatecon), { status: 200, headers: { "Content-Type": "application/json" } }))
    );
    render(<LoadDetailDrawer loadId="load-1" regionId="region-1" onClose={() => undefined} />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("RXO_44230_CARLISLE.pdf")).toBeInTheDocument();
    const link = within(dialog).getByRole("link");
    expect(link).toHaveAttribute("href", "https://example.com/files/RXO_44230_CARLISLE.pdf");
  });

  test("restores focus to trigger when closed", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = React.useState(false);
      return (
        <div>
          <button onClick={() => setOpen(true)}>Open drawer</button>
          <LoadDetailDrawer loadId={open ? "load-1" : null} regionId="region-1" onClose={() => setOpen(false)} />
        </div>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open drawer" });
    trigger.focus();
    await user.click(trigger);

    await screen.findByRole("dialog");
    const dialog = screen.getByRole("dialog");
    const closeButton = within(dialog).getByRole("button", { name: "Close load details" });
    closeButton.focus();

    const backdrop = document.querySelector(".db-drawer-backdrop");
    expect(backdrop).toBeInstanceOf(HTMLElement);
    await user.click(backdrop as HTMLElement);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(trigger).toHaveFocus();
    });
  });

  test("renders fetch error state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "No detail available" }), { status: 404 }))
    );
    render(<LoadDetailDrawer loadId="missing" regionId="region-1" onClose={() => undefined} />);
    expect(await screen.findByText("No detail available")).toBeInTheDocument();
  });
});
