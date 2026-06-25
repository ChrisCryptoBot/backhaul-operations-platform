import { describe, expect, test } from "vitest";
import { assertPermission, isPermissionAllowed, type PolicyPermission } from "@/domain/policy/permissions";

describe("permission matrix boundary contracts", () => {
  const resources: PolicyPermission[] = [
    { resource: "BOARD", action: "READ" },
    { resource: "KPI_DASHBOARD", action: "READ" },
    { resource: "KPI_DASHBOARD", action: "WRITE" },
    { resource: "RATE_CONFIRMATION_UPLOAD", action: "WRITE" },
    { resource: "RATE_CONFIRMATION_REVIEW", action: "READ" },
    { resource: "RATE_CONFIRMATION_REVIEW", action: "REVIEW" },
    { resource: "FSC_INDEX", action: "WRITE" }
  ];

  test("all defined roles can access approved permission tuples", () => {
    const roles = ["COORDINATOR", "REGIONAL_MANAGER", "CORPORATE_OPS", "ADMIN"] as const;
    for (const role of roles) {
      for (const permission of resources) {
        expect(isPermissionAllowed(role, permission)).toBe(true);
      }
    }
  });

  test("deny-by-default applies to unknown tuples", () => {
    expect(() =>
      assertPermission("COORDINATOR", {
        resource: "RATE_CONFIRMATION_UPLOAD",
        action: "READ"
      } as PolicyPermission)
    ).toThrow(/Policy denies/);
  });

  test("reference-data management is gated to REGIONAL_MANAGER+ (first role differentiation)", () => {
    // Everyone can read reference data.
    for (const role of ["COORDINATOR", "REGIONAL_MANAGER", "CORPORATE_OPS", "ADMIN"] as const) {
      expect(isPermissionAllowed(role, { resource: "REFERENCE_DATA", action: "READ" })).toBe(true);
    }
    // Only REGIONAL_MANAGER and above can write it.
    expect(isPermissionAllowed("COORDINATOR", { resource: "REFERENCE_DATA", action: "WRITE" })).toBe(false);
    expect(() =>
      assertPermission("COORDINATOR", { resource: "REFERENCE_DATA", action: "WRITE" })
    ).toThrow(/Policy denies/);
    for (const role of ["REGIONAL_MANAGER", "CORPORATE_OPS", "ADMIN"] as const) {
      expect(isPermissionAllowed(role, { resource: "REFERENCE_DATA", action: "WRITE" })).toBe(true);
    }
  });
});

