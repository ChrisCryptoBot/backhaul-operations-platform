import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CopilotPanel } from "@/components/copilot/copilot-panel";
import type { LoadAlert, LoadAlertRollup } from "@/lib/ui/load-alerts";

function alert(loadId: string, kind: LoadAlert["kind"], severity: LoadAlert["severity"], label: string): LoadAlert {
  return { kind, severity, label, isObligation: true, sourceLoadId: loadId, key: `${loadId}:${kind}` };
}

const ROLLUPS: LoadAlertRollup[] = [
  {
    loadId: "load-1",
    ref: "REF-1",
    alerts: [
      alert("load-1", "COVERAGE_GAP", "URGENT", "No driver assigned"),
      alert("load-1", "POD_REQUESTED", "WARN", "POD requested — follow up")
    ],
    count: 2,
    topSeverity: "URGENT",
    hasObligation: true,
    score: 1_003_002
  },
  {
    loadId: "load-2",
    ref: "REF-2",
    alerts: [alert("load-2", "MISSING_MILES", "INFO", "Missing loaded miles")],
    count: 1,
    topSeverity: "INFO",
    hasObligation: true,
    score: 1_001_001
  }
];

// The panel persists its collapse preference; start each test expanded so the
// feed is on screen without a click (which would otherwise trigger auto-brief).
beforeEach(() => {
  window.localStorage.setItem("db-copilot-collapsed", "false");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ reply: "" }), { status: 200, headers: { "Content-Type": "application/json" } }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  cleanup();
});

describe("CopilotPanel attention feed", () => {
  test("renders the attention rollups as a feed with a header count", async () => {
    render(<CopilotPanel attention={ROLLUPS} selectedLoadId={null} onSelectLoad={() => undefined} />);
    const feed = await screen.findByRole("region", { name: "Needs attention" });
    // Header count matches the number of loads needing attention.
    expect(within(feed).getByText("2", { selector: ".db-cop-attn-total" })).toBeInTheDocument();
    // Each load's ref and its top reasons render.
    expect(within(feed).getByText("REF-1")).toBeInTheDocument();
    expect(within(feed).getByText("REF-2")).toBeInTheDocument();
    expect(within(feed).getByText("No driver assigned")).toBeInTheDocument();
  });

  test("clicking a feed item calls onSelectLoad with its loadId", async () => {
    const onSelectLoad = vi.fn();
    render(<CopilotPanel attention={ROLLUPS} selectedLoadId={null} onSelectLoad={onSelectLoad} />);
    const feed = await screen.findByRole("region", { name: "Needs attention" });
    fireEvent.click(within(feed).getByText("REF-1"));
    expect(onSelectLoad).toHaveBeenCalledWith("load-1");
    fireEvent.click(within(feed).getByText("Missing loaded miles"));
    expect(onSelectLoad).toHaveBeenCalledWith("load-2");
  });

  test("renders no feed when there is nothing to attend to", async () => {
    render(<CopilotPanel attention={[]} selectedLoadId={null} onSelectLoad={() => undefined} />);
    // The panel still mounts (header present) but the attention region does not.
    await screen.findByRole("complementary", { name: "Operations copilot" });
    expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull();
  });

  test("collapsed rail surfaces the attention count as a badge", () => {
    window.localStorage.setItem("db-copilot-collapsed", "true");
    render(<CopilotPanel attention={ROLLUPS} selectedLoadId={null} onSelectLoad={() => undefined} />);
    expect(screen.getByLabelText("2 need attention")).toBeInTheDocument();
  });
});
