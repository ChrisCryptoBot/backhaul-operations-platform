import React from "react";
import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusPill } from "@/components/board/status-pill";

describe("status pill rendering parity", () => {
  test("maps TONU to canceled tone", () => {
    const { container } = render(<StatusPill status="TONU" />);
    expect(screen.getByText("TONU")).toBeInTheDocument();
    expect(container.querySelector(".db-pill-canceled")).not.toBeNull();
  });

  test("falls back unknown status to unknown tone", () => {
    const { container } = render(<StatusPill status="CUSTOM_STATUS" />);
    expect(screen.getByText("CUSTOM STATUS")).toBeInTheDocument();
    expect(container.querySelector(".db-pill-unknown")).not.toBeNull();
  });
});
