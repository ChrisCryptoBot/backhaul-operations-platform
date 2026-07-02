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

const FIXABLE: LoadAlertRollup = {
  loadId: "load-9",
  ref: "REF-9",
  alerts: [alert("load-9", "TASK_MG", "INFO", "MG task not done")],
  count: 1,
  topSeverity: "INFO",
  hasObligation: true,
  score: 1_001_001
};

// The panel persists its collapse preference; start each test expanded so the
// feed is on screen without a click (which would otherwise trigger auto-brief).
// The mock body satisfies both the auto-brief (reads `reply`) and the confirm
// endpoint (reads `ok`/`summary`).
beforeEach(() => {
  window.localStorage.setItem("db-copilot-collapsed", "false");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: true, summary: "Applied", reply: "" }), { status: 200, headers: { "Content-Type": "application/json" } }))
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

describe("CopilotPanel fix-with-copilot flow", () => {
  test("a fixable reason shows a Fix button that seeds a confirm card and posts the prefilled tool", async () => {
    render(<CopilotPanel attention={[FIXABLE]} selectedLoadId={null} onSelectLoad={() => undefined} onChanged={() => undefined} />);
    const feed = await screen.findByRole("region", { name: "Needs attention" });

    // The MG obligation offers a one-click fix.
    const fixButton = within(feed).getByRole("button", { name: "Mark MG done" });
    fireEvent.click(fixButton);

    // A confirm card appears naming the tool; no request has fired yet.
    const toolChip = await screen.findByText("update_load_fields");
    expect(toolChip).toBeInTheDocument();
    const confirmCalls = () =>
      (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => {
        try {
          return JSON.parse((c[1] as RequestInit).body as string).confirm;
        } catch {
          return false;
        }
      });
    expect(confirmCalls()).toHaveLength(0);

    // Confirming posts the prefilled update_load_fields payload to /api/copilot.
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByText(/Applied this session/i);

    const calls = confirmCalls();
    expect(calls).toHaveLength(1);
    expect(JSON.parse((calls[0][1] as RequestInit).body as string).confirm).toEqual({
      tool: "update_load_fields",
      input: { loadId: "load-9", fields: { mgStatusTask: "DONE" } }
    });
  });

  test("clicking the same Fix twice does not stack duplicate confirm cards", async () => {
    render(<CopilotPanel attention={[FIXABLE]} selectedLoadId={null} onSelectLoad={() => undefined} onChanged={() => undefined} />);
    const feed = await screen.findByRole("region", { name: "Needs attention" });
    const fixButton = within(feed).getByRole("button", { name: "Mark MG done" });
    fireEvent.click(fixButton);
    fireEvent.click(fixButton);
    expect(await screen.findAllByText("update_load_fields")).toHaveLength(1);
  });
});

describe("CopilotPanel off-board (global) attention", () => {
  test("fetches attention on expand and renders the same feed without board props", async () => {
    // Off-board mount: no attention/onSelectLoad props. Start expanded so the
    // off-board fetch fires (it's gated on expand, like the auto-brief).
    window.localStorage.setItem("db-copilot-collapsed", "false");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.attention) {
        return new Response(JSON.stringify({ rollups: [FIXABLE], date: "2026-06-21" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true, reply: "" }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CopilotPanel />);
    const feed = await screen.findByRole("region", { name: "Needs attention" });
    expect(within(feed).getByText("REF-9")).toBeInTheDocument();

    // It pulled the rollups via the deterministic attention endpoint.
    const attentionCalls = fetchMock.mock.calls.filter((c) => {
      try {
        return JSON.parse((c[1] as RequestInit).body as string).attention === true;
      } catch {
        return false;
      }
    });
    expect(attentionCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("does not fetch attention while collapsed", async () => {
    window.localStorage.setItem("db-copilot-collapsed", "true");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ rollups: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CopilotPanel />);
    // Collapsed rail mounts without firing any request.
    await screen.findByRole("complementary", { name: "Operations copilot" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
