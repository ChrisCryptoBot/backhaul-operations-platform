import { describe, expect, test } from "vitest";

// FSC parked (spot-broker-first): POST /api/fsc is disabled and returns 410 Gone. The previous
// upsert/RBAC/validation suite is retired with the endpoint; restore it when FSC is re-added.
describe("POST /api/fsc (disabled)", () => {
  test("returns 410 Gone while FSC is neutralized", async () => {
    const { POST } = await import("@/app/api/fsc/route");
    const response = await POST();
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("disabled")
    });
  });
});
