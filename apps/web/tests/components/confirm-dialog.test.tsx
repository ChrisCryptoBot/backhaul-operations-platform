import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

afterEach(cleanup);

describe("ConfirmDialog reason field", () => {
  test("renders the reason as a stacked (flex-column) label above a 2-row textarea", () => {
    render(
      <ConfirmDialog
        title="Remove broker"
        message={<>Remove broker <strong>Atlas 3PL Partners</strong>?</>}
        reason={{ label: "Reason for removal", placeholder: "e.g. No longer a partner" }}
        destructive
        confirmLabel="Remove broker"
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />
    );
    const label = screen.getByText("Reason for removal").closest("label")!;
    // The label must be a block/flex container so its top margin applies and the
    // text stacks above the field (a bare inline label silently drops both).
    expect(label).toHaveStyle({ display: "flex", flexDirection: "column" });
    const textarea = screen.getByPlaceholderText("e.g. No longer a partner");
    expect(textarea).toHaveAttribute("rows", "2");
  });

  test("keeps the confirm button disabled until a reason is entered", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        title="Remove broker"
        reason={{ label: "Reason for removal", placeholder: "e.g. No longer a partner" }}
        destructive
        confirmLabel="Remove broker"
        onCancel={() => undefined}
        onConfirm={onConfirm}
      />
    );
    const confirm = screen.getByRole("button", { name: "Remove broker" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("e.g. No longer a partner"), { target: { value: "No longer a partner" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith("No longer a partner");
  });
});
