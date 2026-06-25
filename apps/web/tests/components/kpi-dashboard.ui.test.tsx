import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { KpiDashboard } from "@/components/kpi/kpi-dashboard";

const replaceMock = vi.fn();
const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: replaceMock,
    refresh: refreshMock
  }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams()
}));

afterEach(() => {
  cleanup();
  replaceMock.mockReset();
  refreshMock.mockReset();
  vi.restoreAllMocks();
});

const fixture = {
  weekIso: "2026-W17",
  comparisonWeekIso: "2026-W16",
  cards: [
    { key: "loads", label: "Total Loads", value: "47", delta: 6, deltaLabel: "WoW" },
    { key: "revenue", label: "Total 3P Revenue", value: "58420", delta: 4180, deltaLabel: "WoW" },
    { key: "loadedMiles", label: "Loaded Miles", value: "12800", delta: 420, deltaLabel: "WoW" },
    { key: "emptyPct", label: "Empty Mile %", value: "5.8", delta: -0.9, deltaLabel: "WoW", inverted: true },
    { key: "nby", label: "NBY ($/mi)", value: "3.45", delta: 0.05, deltaLabel: "WoW" },
    { key: "mileMaxRpm", label: "MileMax RPM", value: "1.94", delta: 0.03, deltaLabel: "WoW" },
    { key: "tender", label: "Tender Accept %", value: "82.3", delta: null, deltaLabel: "no prior", noPrior: true }
  ],
  lanes: [
    {
      lane: "Pittsburgh, PA -> Carlisle, PA",
      target: "1200",
      loads: 5,
      revenue: "6200",
      vsTarget: "75",
      emptyPct: "6.1",
      nby: "1.85",
      revLoad: "1240",
      status: "ON_TARGET"
    }
  ],
  trend: [
    { week: "W06", loads: 33, rev: "45820", empty: "7.9" },
    { week: "W07", loads: 35, rev: "47060", empty: "7.6" },
    { week: "W08", loads: 34, rev: "46610", empty: "7.4" },
    { week: "W09", loads: 37, rev: "48900", empty: "7.3" },
    { week: "W10", loads: 39, rev: "50240", empty: "7.1" },
    { week: "W11", loads: 36, rev: "49180", empty: "7.0" },
    { week: "W12", loads: 38, rev: "51620", empty: "6.9" },
    { week: "W13", loads: 41, rev: "53420", empty: "6.6" },
    { week: "W14", loads: 40, rev: "52960", empty: "6.5" },
    { week: "W15", loads: 43, rev: "55100", empty: "6.2" },
    { week: "W16", loads: 45, rev: "56840", empty: "6.0" },
    { week: "W17", loads: 47, rev: "58420", empty: "5.8" }
  ],
  managementNotes: ["Empty miles improved week over week.", "Top lane stayed above target."],
  activeFilters: {
    weeks: 6
  },
  rules: [
    {
      code: "FRONT_DROP_HOOK",
      title: "Front-end drop-hook required",
      severity: "ACTION_REQUIRED",
      statement: "Live-load tenders are auto-rejected.",
      appliesTo: "RLY3, RLY2"
    }
  ]
};

describe("KpiDashboard full parity surface", () => {
  test("renders top shell and lanes schema", () => {
    const { container } = render(<KpiDashboard initialData={fixture} />);
    // The dashboard now uses the shared app shell: a global sidebar + slim header.
    expect(container.querySelector(".db-sidebar")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Daily Tracker" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "KPI Dashboard" })).toBeInTheDocument();
    expect(container.querySelector(".db-h-title")?.textContent).toContain("KPI Dashboard");
    expect(screen.getByRole("button", { name: "Select reporting week" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch to light mode" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.getByText("Rev / Load")).toBeInTheDocument();
    expect(screen.getByText(/Default targets from DAT RateView/i)).toBeInTheDocument();
    // KPI-TRACKER-4 reconciliation: NBY is a headline tile, FSC is parked (no FSC surface).
    // The label appears in both the KPI grid and the management-report grid (both render the cards).
    expect(screen.getAllByText("NBY ($/mi)").length).toBeGreaterThan(0);
    expect(screen.getByRole("columnheader", { name: "NBY" })).toBeInTheDocument();
    expect(screen.queryByText("Total FSC")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "FSC" })).not.toBeInTheDocument();
    // MileMax is removed from the UI (NBY only).
    expect(screen.queryByText("MileMax RPM")).not.toBeInTheDocument();
  });

  test("renders trend, management, and rules parity elements", async () => {
    const user = userEvent.setup();
    render(<KpiDashboard initialData={fixture} />);

    await user.click(screen.getByRole("tab", { name: "Trend" }));
    expect(screen.getByRole("combobox", { name: "Trend window" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /trend chart horizontal scroll region/i })).toBeInTheDocument();
    // NBY is the only $/mi metric — Floor RPM and MileMax are both gone from the UI.
    expect(screen.getByRole("columnheader", { name: "Tender %" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "MileMax" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Management Report" }));
    expect(screen.getByText("MANAGEMENT REPORT")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export PDF" })).toBeInTheDocument();
    expect(screen.getByText("Operational notes")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Reference Rules" }));
    expect(screen.getByRole("button", { name: "+ New rule" })).toBeInTheDocument();
    expect(screen.getByText("APPLIES TO")).toBeInTheDocument();
  }, 15000);

  test("updates query when selecting a reporting week", async () => {
    const user = userEvent.setup();
    render(<KpiDashboard initialData={fixture} />);

    await user.click(screen.getByRole("button", { name: "Select reporting week" }));
    await user.click(screen.getByRole("option", { name: /W16/i }));
    expect(replaceMock).toHaveBeenCalledWith("/dashboard?weekIso=2026-W16");
  }, 15000);

  test("clears filters without trailing question mark", async () => {
    const user = userEvent.setup();
    render(<KpiDashboard initialData={fixture} />);

    await user.click(screen.getByRole("tab", { name: "Trend" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Trend window" }), "12");
    expect(replaceMock).toHaveBeenLastCalledWith("/dashboard?weeks=12");

    await user.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(replaceMock).toHaveBeenLastCalledWith("/dashboard");
  }, 15000);

  test("supports arrow-key navigation across dashboard tabs", async () => {
    const user = userEvent.setup();
    render(<KpiDashboard initialData={fixture} />);

    const lanesTab = screen.getByRole("tab", { name: "Lanes" });
    lanesTab.focus();
    expect(lanesTab).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    const trendTab = screen.getByRole("tab", { name: "Trend" });
    expect(trendTab).toHaveFocus();
    expect(trendTab).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{End}");
    const rulesTab = screen.getByRole("tab", { name: "Reference Rules" });
    expect(rulesTab).toHaveFocus();
    expect(rulesTab).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{Home}");
    const lanesTabAgain = screen.getByRole("tab", { name: "Lanes" });
    expect(lanesTabAgain).toHaveFocus();
    expect(lanesTabAgain).toHaveAttribute("aria-selected", "true");
  });

  test("shows trend popup details on hover and keyboard focus", async () => {
    const user = userEvent.setup();
    const { container } = render(<KpiDashboard initialData={fixture} />);

    await user.click(screen.getByRole("tab", { name: "Trend" }));
    const currentPoint = screen.getAllByTestId("trend-point-W17")[0];
    expect(currentPoint).toBeInTheDocument();

    const priorPoint = screen.getAllByTestId("trend-point-W16")[0];
    await user.hover(priorPoint);
    expect(container.querySelector(".db-trend-selection .db-trend-popup-week")?.textContent).toBe("W16");
    expect(container.querySelector(".db-trend-selection .db-trend-popup")?.textContent).toContain("Revenue:");

    priorPoint.focus();
    expect(container.querySelector(".db-trend-selection .db-trend-popup-week")?.textContent).toBe("W16");
  });

  test("shows a recoverable message when email request fails", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    render(<KpiDashboard initialData={fixture} />);

    await user.click(screen.getByRole("tab", { name: "Management Report" }));
    await user.click(screen.getByRole("button", { name: "Email manager" }));

    await waitFor(() => {
      expect(screen.getByText("Unable to send summary email. Please try again.")).toBeInTheDocument();
    });
  });

  test("surfaces lane note API errors and keeps editor open", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "forced-lane-note-error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        })
      )
    );
    render(<KpiDashboard initialData={fixture} />);

    await user.click(screen.getByRole("button", { name: "+ note" }));
    await user.type(screen.getByRole("textbox"), "New note");
    await user.click(screen.getByRole("button", { name: "✓" }));

    await waitFor(() => {
      expect(screen.getByText("forced-lane-note-error")).toBeInTheDocument();
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  test("disables lane note controls while save is in flight", async () => {
    const user = userEvent.setup();
    let resolveFetch: (value: Response) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          })
      )
    );
    render(<KpiDashboard initialData={fixture} />);

    await user.click(screen.getByRole("button", { name: "+ note" }));
    const textbox = screen.getByRole("textbox");
    await user.type(textbox, "Pending note");
    await user.click(screen.getByRole("button", { name: "✓" }));

    expect(textbox).toBeDisabled();
    expect(screen.getByRole("button", { name: "..." })).toBeDisabled();

    resolveFetch(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );

    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalled();
    });
  });

  test("surfaces lane target API errors and keeps target editor open", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "forced-lane-target-error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        })
      )
    );
    render(<KpiDashboard initialData={fixture} />);

    await user.click(screen.getByRole("button", { name: /\$1,200/i }));
    const targetInput = screen.getByRole("spinbutton");
    await user.clear(targetInput);
    await user.type(targetInput, "2550");
    await user.click(screen.getByRole("button", { name: "✓" }));

    await waitFor(() => {
      expect(screen.getByText("forced-lane-target-error")).toBeInTheDocument();
      expect(screen.getByRole("spinbutton")).toBeInTheDocument();
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
