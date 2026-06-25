import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  auditCreate: vi.fn()
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    regionConfig: { findUnique: mocks.findUnique, upsert: mocks.upsert },
    auditLog: { create: mocks.auditCreate }
  }
}));

import {
  DEFAULT_EMPTY_PCT_ALERT,
  DEFAULT_EMPTY_PCT_AMBER,
  DEFAULT_EMPTY_PCT_RED,
  getRegionConfig,
  RegionConfigValidationError,
  updateRegionConfig
} from "@/server/region-config";

describe("region-config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auditCreate.mockResolvedValue(undefined);
  });

  test("getRegionConfig returns defaults when no row exists", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const cfg = await getRegionConfig("r1");
    expect(cfg).toEqual({
      emptyPctAmber: DEFAULT_EMPTY_PCT_AMBER,
      emptyPctRed: DEFAULT_EMPTY_PCT_RED,
      emptyPctAlert: DEFAULT_EMPTY_PCT_ALERT
    });
  });

  test("getRegionConfig returns stored values as numbers", async () => {
    mocks.findUnique.mockResolvedValue({
      emptyPctAmber: new Prisma.Decimal("12"),
      emptyPctRed: new Prisma.Decimal("22"),
      emptyPctAlert: new Prisma.Decimal("7")
    });
    expect(await getRegionConfig("r1")).toEqual({ emptyPctAmber: 12, emptyPctRed: 22, emptyPctAlert: 7 });
  });

  test("updateRegionConfig upserts both thresholds and writes an audit entry", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue({
      id: "rc1",
      emptyPctAmber: new Prisma.Decimal("12"),
      emptyPctRed: new Prisma.Decimal("20"),
      emptyPctAlert: new Prisma.Decimal("6.5")
    });
    const cfg = await updateRegionConfig({ actorId: "u1", regionId: "r1", emptyPctAmber: "12", emptyPctRed: "20" });
    expect(cfg).toEqual({ emptyPctAmber: 12, emptyPctRed: 20, emptyPctAlert: 6.5 });
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
  });

  test("updateRegionConfig keeps the current value when a threshold is omitted", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "rc1",
      emptyPctAmber: new Prisma.Decimal("15"),
      emptyPctRed: new Prisma.Decimal("25"),
      emptyPctAlert: new Prisma.Decimal("6.5")
    });
    mocks.upsert.mockResolvedValue({
      id: "rc1",
      emptyPctAmber: new Prisma.Decimal("15"),
      emptyPctRed: new Prisma.Decimal("30"),
      emptyPctAlert: new Prisma.Decimal("6.5")
    });
    await updateRegionConfig({ actorId: "u1", regionId: "r1", emptyPctRed: "30" });
    const arg = mocks.upsert.mock.calls[0][0] as {
      update: { emptyPctAmber: Prisma.Decimal; emptyPctRed: Prisma.Decimal; emptyPctAlert: Prisma.Decimal };
    };
    expect(arg.update.emptyPctAmber.toString()).toBe("15");
    expect(arg.update.emptyPctRed.toString()).toBe("30");
    expect(arg.update.emptyPctAlert.toString()).toBe("6.5");
  });

  test("updateRegionConfig sets the dashboard alert threshold", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue({
      id: "rc1",
      emptyPctAmber: new Prisma.Decimal("15"),
      emptyPctRed: new Prisma.Decimal("25"),
      emptyPctAlert: new Prisma.Decimal("8")
    });
    const cfg = await updateRegionConfig({ actorId: "u1", regionId: "r1", emptyPctAlert: "8" });
    expect(cfg.emptyPctAlert).toBe(8);
    const arg = mocks.upsert.mock.calls[0][0] as { update: { emptyPctAlert: Prisma.Decimal } };
    expect(arg.update.emptyPctAlert.toString()).toBe("8");
  });

  test("updateRegionConfig rejects an out-of-range alert threshold", async () => {
    mocks.findUnique.mockResolvedValue(null);
    await expect(
      updateRegionConfig({ actorId: "u1", regionId: "r1", emptyPctAlert: "0" })
    ).rejects.toBeInstanceOf(RegionConfigValidationError);
    await expect(
      updateRegionConfig({ actorId: "u1", regionId: "r1", emptyPctAlert: "150" })
    ).rejects.toBeInstanceOf(RegionConfigValidationError);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  test("updateRegionConfig rejects amber >= red", async () => {
    mocks.findUnique.mockResolvedValue(null);
    await expect(
      updateRegionConfig({ actorId: "u1", regionId: "r1", emptyPctAmber: "30", emptyPctRed: "20" })
    ).rejects.toBeInstanceOf(RegionConfigValidationError);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  test("updateRegionConfig rejects red > 100", async () => {
    mocks.findUnique.mockResolvedValue(null);
    await expect(
      updateRegionConfig({ actorId: "u1", regionId: "r1", emptyPctRed: "150" })
    ).rejects.toBeInstanceOf(RegionConfigValidationError);
  });
});
