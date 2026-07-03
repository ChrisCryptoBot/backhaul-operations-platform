import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FieldPeekPopover } from "@/components/board/field-peek-popover";
import { copyText } from "@/lib/ui/clipboard";

// Mock the clipboard util directly — userEvent.setup() swaps navigator.clipboard,
// so asserting on the util is more robust than stubbing the global.
vi.mock("@/lib/ui/clipboard", () => ({ copyText: vi.fn().mockResolvedValue(true) }));
const copyTextMock = vi.mocked(copyText);

beforeEach(() => copyTextMock.mockClear());
afterEach(() => cleanup());

function makeAnchor(): HTMLElement {
  const el = document.createElement("button");
  document.body.appendChild(el);
  return el;
}

describe("FieldPeekPopover", () => {
  const values = [
    { kind: "PU", value: "PU-100" },
    { kind: "BOL", value: "BOL-200" }
  ];

  test("lists each number with a copy button and a copy-all", () => {
    render(<FieldPeekPopover anchorEl={makeAnchor()} loadRef="R1" values={values} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("PU-100")).toBeInTheDocument();
    expect(screen.getByText("BOL-200")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Copy all" })).toBeInTheDocument();
  });

  test("copying a value writes it to the clipboard and flashes Copied", async () => {
    const user = userEvent.setup();
    render(<FieldPeekPopover anchorEl={makeAnchor()} loadRef="R1" values={values} onSave={vi.fn()} onClose={vi.fn()} />);
    await user.click(screen.getAllByRole("button", { name: "Copy" })[0]);
    expect(copyTextMock).toHaveBeenCalledWith("PU-100");
    await waitFor(() => expect(screen.getByText("Copied ✓")).toBeInTheDocument());
  });

  test("copy all joins labeled lines", async () => {
    const user = userEvent.setup();
    render(<FieldPeekPopover anchorEl={makeAnchor()} loadRef="R1" values={values} onSave={vi.fn()} onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Copy all" }));
    expect(copyTextMock).toHaveBeenCalledWith("Pickup #: PU-100\nBOL #: BOL-200");
  });

  test("edit → add/remove/change → Save emits the referenceNumbers patch", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<FieldPeekPopover anchorEl={makeAnchor()} loadRef="R1" values={values} onSave={onSave} onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    // Change PU-100 → PU-999
    const inputs = screen.getAllByRole("textbox");
    await user.clear(inputs[0]);
    await user.type(inputs[0], "PU-999");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({
      referenceNumbers: [
        { kind: "PU", value: "PU-999" },
        { kind: "BOL", value: "BOL-200" }
      ]
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  test("empty values shows the add affordance", () => {
    render(<FieldPeekPopover anchorEl={makeAnchor()} loadRef="R1" values={[]} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/No numbers on file/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });

  test("Escape closes the popover", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<FieldPeekPopover anchorEl={makeAnchor()} loadRef="R1" values={values} onSave={vi.fn()} onClose={onClose} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
