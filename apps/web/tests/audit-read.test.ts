import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditFindMany: vi.fn(),
  userFindMany: vi.fn()
}));

vi.mock("@/lib/db", () => ({
  prisma: { auditLog: { findMany: mocks.auditFindMany }, user: { findMany: mocks.userFindMany } }
}));

import { getAuditHistory } from "@/server/audit-read";

describe("getAuditHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("resolves actorId to a human name", async () => {
    mocks.auditFindMany.mockResolvedValue([
      {
        id: "a1",
        entityType: "Load",
        entityId: "load-1",
        action: "CREATE",
        actorId: "u1",
        timestamp: new Date("2026-06-18T00:00:00Z"),
        reason: null,
        beforeValue: null,
        afterValue: null
      }
    ]);
    mocks.userFindMany.mockResolvedValue([{ id: "u1", name: "Jane Coordinator", email: "jane@x.com" }]);

    const history = await getAuditHistory({ entityId: "load-1" });
    expect(history).toHaveLength(1);
    expect(history[0].actorName).toBe("Jane Coordinator");
    expect(history[0].entityType).toBe("Load");
  });

  test("falls back to null actorName when the user is unknown", async () => {
    mocks.auditFindMany.mockResolvedValue([
      { id: "a2", entityType: "Load", entityId: "load-1", action: "UPDATE", actorId: "ghost", timestamp: new Date("2026-06-18T00:00:00Z"), reason: null, beforeValue: null, afterValue: null }
    ]);
    mocks.userFindMany.mockResolvedValue([]);

    const history = await getAuditHistory({ entityId: "load-1" });
    expect(history[0].actorName).toBeNull();
  });
});
