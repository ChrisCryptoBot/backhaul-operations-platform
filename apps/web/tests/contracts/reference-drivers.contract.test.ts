import { describe, expect, test } from "vitest";
import { directCustomerMutationSchema, driverMutationSchema } from "@/contracts/reference";

describe("contracts/reference — driver mutations", () => {
  test("accepts a full create_driver payload", () => {
    const result = driverMutationSchema.safeParse({
      action: "create_driver",
      driver: {
        code: "REES2",
        fullName: "R. Reese",
        homeDropLotId: "lot-1",
        active: true,
        attributes: ["SHUTTLE", "LTL_CERT"],
        scheduleDays: ["MON", "TUE", "WED", "THU", "FRI"],
        scheduleStart: "05:00",
        scheduleTimeZone: "America/New_York",
        scheduleNote: "NEED BH out of Utica"
      }
    });
    expect(result.success).toBe(true);
  });

  test("accepts a minimal create_driver payload (code + fullName only)", () => {
    const result = driverMutationSchema.safeParse({
      action: "create_driver",
      driver: { code: "SWAS", fullName: "S. Wasser" }
    });
    expect(result.success).toBe(true);
  });

  test("rejects a scheduleStart that is not 24h HH:MM", () => {
    for (const bad of ["0500", "5:00", "24:00", "05:60"]) {
      const result = driverMutationSchema.safeParse({
        action: "create_driver",
        driver: { code: "SWAS", fullName: "S. Wasser", scheduleStart: bad }
      });
      expect(result.success).toBe(false);
    }
  });

  test("rejects an unknown attribute or day", () => {
    expect(
      driverMutationSchema.safeParse({
        action: "create_driver",
        driver: { code: "SWAS", fullName: "S. Wasser", attributes: ["HAZMAT"] }
      }).success
    ).toBe(false);
    expect(
      driverMutationSchema.safeParse({
        action: "create_driver",
        driver: { code: "SWAS", fullName: "S. Wasser", scheduleDays: ["MONDAY"] }
      }).success
    ).toBe(false);
  });

  test("update_driver requires at least one field", () => {
    expect(
      driverMutationSchema.safeParse({ action: "update_driver", driverId: "drv-1", fields: {} }).success
    ).toBe(false);
    expect(
      driverMutationSchema.safeParse({ action: "update_driver", driverId: "drv-1", fields: { active: false } }).success
    ).toBe(true);
  });

  test("delete_driver requires a reason", () => {
    expect(driverMutationSchema.safeParse({ action: "delete_driver", driverId: "drv-1" }).success).toBe(false);
    expect(
      driverMutationSchema.safeParse({ action: "delete_driver", driverId: "drv-1", reason: "left fleet" }).success
    ).toBe(true);
  });
});

describe("contracts/reference — direct-customer mutations", () => {
  test("accepts a cadenced customer (1/DAY)", () => {
    const result = directCustomerMutationSchema.safeParse({
      action: "create_direct_customer",
      directCustomer: { name: "SEALED AIR", cadenceCount: 1, cadencePeriod: "DAY" }
    });
    expect(result.success).toBe(true);
  });

  test("accepts a customer without a cadence", () => {
    const result = directCustomerMutationSchema.safeParse({
      action: "create_direct_customer",
      directCustomer: { name: "JERSEY SHORE STEEL CO - FAB DIV" }
    });
    expect(result.success).toBe(true);
  });

  test("rejects a cadence count without a period (and vice versa)", () => {
    expect(
      directCustomerMutationSchema.safeParse({
        action: "create_direct_customer",
        directCustomer: { name: "AB", cadenceCount: 10 }
      }).success
    ).toBe(false);
    expect(
      directCustomerMutationSchema.safeParse({
        action: "create_direct_customer",
        directCustomer: { name: "AB", cadencePeriod: "WEEK" }
      }).success
    ).toBe(false);
  });

  test("update allows clearing the cadence as a pair, but not one side alone", () => {
    expect(
      directCustomerMutationSchema.safeParse({
        action: "update_direct_customer",
        directCustomerId: "cust-1",
        fields: { cadenceCount: null, cadencePeriod: null }
      }).success
    ).toBe(true);
    expect(
      directCustomerMutationSchema.safeParse({
        action: "update_direct_customer",
        directCustomerId: "cust-1",
        fields: { cadenceCount: null }
      }).success
    ).toBe(false);
  });

  test("update requires at least one field; delete requires a reason", () => {
    expect(
      directCustomerMutationSchema.safeParse({
        action: "update_direct_customer",
        directCustomerId: "cust-1",
        fields: {}
      }).success
    ).toBe(false);
    expect(
      directCustomerMutationSchema.safeParse({ action: "delete_direct_customer", directCustomerId: "cust-1" }).success
    ).toBe(false);
  });
});
