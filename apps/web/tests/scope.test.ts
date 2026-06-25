import { describe, expect, test, vi } from "vitest";

const findUnique = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    region: {
      findUnique
    }
  }
}));

vi.mock("@/lib/env", () => ({
  getPhase1RegionCode: () => "NE"
}));

describe("region scope", () => {
  test("enforces region id resolved from NE code", async () => {
    findUnique.mockResolvedValue({ id: "region-ne-id" });
    const { assertRegionAccess } = await import("@/lib/scope");

    await expect(
      assertRegionAccess(
        {
          userId: "u1",
          role: "COORDINATOR",
          regionId: "region-ne-id"
        },
        "region-ne-id"
      )
    ).resolves.toBeUndefined();
  });

  test("allows corporate ops cross-region in expanded mode", async () => {
    process.env.MULTIREGION_POLICY_MODE = "expanded";
    findUnique.mockResolvedValue({ id: "region-ne-id" });
    const { assertRegionAccess } = await import("@/lib/scope");
    await expect(
      assertRegionAccess(
        {
          userId: "u1",
          role: "CORPORATE_OPS",
          regionId: "region-ne-id"
        },
        "region-west-id"
      )
    ).resolves.toBeUndefined();
    delete process.env.MULTIREGION_POLICY_MODE;
  });
});
