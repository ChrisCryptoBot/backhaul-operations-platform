import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewPanel } from "@/app/review/review-panel";
import type { ReviewRateConfirmation } from "@/server/review";

const baseReview: ReviewRateConfirmation = {
  contractVersion: "v1",
  id: "rc-1",
  parseState: "EXTRACTED",
  reviewDecision: "PENDING",
  sourceFileUrl: "https://example.com/rc-1.pdf",
  parseConfidence: 0.94,
  loadId: null,
  extractedPayload: {
    shipperName: "Example Shipper"
  },
  reviewedAt: null,
  reviewedById: null,
  reviewReason: null,
  createdAt: "2026-04-29T00:00:00.000Z",
  updatedAt: "2026-04-29T00:00:00.000Z"
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("review panel gating behavior", () => {
  test("keeps reject disabled until exception mode and reason are set", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(baseReview), { status: 200, headers: { "Content-Type": "application/json" } }))
    );

    render(<ReviewPanel initial={baseReview} regionId="region-1" />);

    const rejectButton = screen.getByRole("button", { name: "Reject" });
    const exceptionToggle = screen.getByRole("checkbox", { name: /enable exception workflow/i });
    const reasonInput = screen.getByLabelText("Reject reason");

    expect(rejectButton).toBeDisabled();

    await user.click(exceptionToggle);
    expect(rejectButton).toBeDisabled();

    await user.type(reasonInput, "Missing signature");
    expect(rejectButton).toBeEnabled();
  });

  test("hides approve action and disables reject when review is already linked to a load", () => {
    render(
      <ReviewPanel
        initial={
          {
            ...baseReview,
            loadId: "load-42"
          } as ReviewRateConfirmation
        }
        regionId="region-1"
      />
    );

    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });

  test("requires explicit second click before posting reject", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ reviewDecision: "REJECTED" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ReviewPanel initial={baseReview} regionId="region-1" />);

    await user.click(screen.getByRole("checkbox", { name: /enable exception workflow/i }));
    await user.type(screen.getByLabelText("Reject reason"), "Missing signature");

    const rejectButton = screen.getByRole("button", { name: "Reject" });
    await user.click(rejectButton);
    expect(fetchMock).toHaveBeenCalledTimes(0);

    await user.click(rejectButton);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const postCall = fetchMock.mock.calls.find((call: Parameters<typeof fetch>) => {
      const options = call[1];
      return options?.method === "POST";
    });
    expect(postCall).toBeDefined();
    const payload = JSON.parse(String(postCall?.[1]?.body ?? "{}")) as { action?: string };
    expect(payload.action).toBe("reject");
  });
});
