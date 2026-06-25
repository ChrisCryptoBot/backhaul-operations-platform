import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateBoardLoadFields: vi.fn(async (_input: unknown) => undefined),
  setBoardLoadStatus: vi.fn(async (_input: unknown) => undefined),
  setLoadTonuLifecycle: vi.fn(async (_input: unknown) => undefined),
  softDeleteBoardLoad: vi.fn(async (_input: unknown) => undefined),
  getLoadDetail: vi.fn(async (_input: unknown) => ({ id: "load-1" })),
  createBroker: vi.fn(async (_input: unknown) => ({ id: "broker-new", name: "Acme" })),
  updateBroker: vi.fn(async (_input: unknown) => undefined),
  listBrokers: vi.fn(async (_input: unknown) => [
    { id: "broker-1", name: "Acme", onboardingStatus: "APPROVED", fscDefaultApplies: true, reps: [], createdAt: "", updatedAt: "" }
  ]),
  createLane: vi.fn(async (_input: unknown) => ({ id: "lane-new" })),
  setLaneTarget: vi.fn(async (_input: unknown) => undefined),
  listLanes: vi.fn(async (_input: unknown) => [
    { id: "lane-1", originCity: "Carlisle", originState: "PA", destinationCity: "Boston", destinationState: "MA", targetRate: "2.15" }
  ]),
  createDropLot: vi.fn(async (_input: unknown) => ({ id: "lot-new" })),
  updateDropLot: vi.fn(async (_input: unknown) => undefined),
  listDropLots: vi.fn(async (_input: unknown) => [
    { id: "lot-1", name: "CDC", code: "CDC", note: null, city: "Carlisle", state: "PA", sortOrder: 1, dailyCapacity: 8, slipSeat: false, dropHookRequired: false }
  ]),
  getBoardResponse: vi.fn(async (_input: unknown) => ({
    regionId: "r1",
    date: "2026-06-18",
    dayTotals: {
      loadCount: 1,
      lineHaulTotal: "1000",
      fscTotal: "0",
      tonuTotal: "0",
      allInTotal: "1000",
      loadedMilesTotal: "200",
      emptyMilePct: "0.1"
    },
    sections: [
      {
        type: "drop_lot",
        title: "CDC",
        code: "CDC",
        note: null,
        filledCount: 1,
        dropLot: { id: "lot-1", name: "CDC", code: "CDC", note: null, city: "Carlisle", state: "PA", sortOrder: 1, dailyCapacity: 8, slipSeat: false, dropHookRequired: false },
        loads: [
          { id: "load-1", threePlRefNumber: "3P-1", loadNumber: null, status: "BOOKED", attentionSeverity: "URGENT", podStatus: null, lateCancelFailedNote: "verify temp", shipperName: "Acme", receiverName: "BigBox", pickupDriverAssigned: "J. Doe", deliveryDate: "2026-06-22T00:00:00.000Z" }
        ]
      }
    ]
  })),
  moveBoardLoad: vi.fn(async (_input: unknown) => undefined),
  upsertBoardLoadLeg: vi.fn(async (_input: unknown) => undefined),
  deleteBoardLoadLeg: vi.fn(async (_input: unknown) => undefined),
  getKpiDashboard: vi.fn(async (_input: unknown) => ({
    weekIso: "2026-W25",
    comparisonWeekIso: "2026-W24",
    comparisonMode: "wow",
    mileMaxMissingInbound: true,
    cards: [{ key: "loads", label: "Total Loads", value: "5", delta: 1, deltaLabel: "WoW" }],
    lanes: [{ lane: "Carlisle, PA → Boston, MA", target: "2.0", revenue: "5000", vsTarget: "100", status: "ON_TARGET", laneNote: null }],
    alerts: [],
    trend: [{ week: "2026-W25", loads: 5, rev: "5000", empty: "5.8" }],
    rules: [{ code: "EMPTY_MILE", title: "Empty mile", severity: "WARN", statement: "watch empty %", appliesTo: "Region" }]
  })),
  loadFindMany: vi.fn(async (_args?: unknown) => []),
  getEffectiveFscRate: vi.fn(async (): Promise<{ toString(): string }> => ({ toString: () => "0.55" })),
  getAuditHistory: vi.fn(async (_input: unknown) => [
    { id: "a1", entityType: "Load", entityId: "load-1", action: "BOARD_FIELD_UPDATE", actorId: "u1", actorName: "Jane", timestamp: "2026-06-18T00:00:00.000Z", reason: null, beforeValue: null, afterValue: { deliveryDate: "2026-06-22" } }
  ]),
  listAuditLog: vi.fn(async (_input: unknown) => ({
    entries: [
      { id: "al1", entityType: "Lane", entityId: "lane-1", action: "REFERENCE_LANE_CREATE", actorId: "u1", actorName: "Jane", timestamp: "2026-06-18T00:00:00.000Z", reason: null, beforeValue: null, afterValue: { targetRate: "2.15" } }
    ],
    nextCursor: "al1"
  })),
  getLlmSettingsStatus: vi.fn(async () => ({
    provider: "anthropic", model: "claude-haiku-4-5", copilotModel: "claude-sonnet-4-6", isActive: true, hasKey: true, apiKeyLast4: "1234", updatedAt: "2026-06-18T00:00:00.000Z"
  })),
  updateLlmSettings: vi.fn(async (_input: unknown) => ({
    provider: "anthropic", model: "claude-opus-4-8", copilotModel: "claude-sonnet-4-6", isActive: true, hasKey: true, apiKeyLast4: "9999", updatedAt: "2026-06-19T00:00:00.000Z"
  })),
  getRoadMiles: vi.fn(async (): Promise<{ miles: number | null; source: string }> => ({ miles: 300, source: "google" })),
  createManualLoad: vi.fn(async (_input: unknown) => ({ loadId: "load-new" })),
  approveRateConfirmationReview: vi.fn(async (_input: unknown) => ({ loadId: "load-appr", alreadyExisted: false })),
  rejectRateConfirmationReview: vi.fn(async (_input: unknown) => ({ reviewDecision: "REJECTED" })),
  getRateConfirmationActivity: vi.fn(async (_input: unknown) => ({
    pending: [],
    ready: [{ id: "rc1", parseState: "EXTRACTED", reviewDecision: "PENDING", duplicateSignal: null }],
    recent: []
  })),
  upsertFscIndex: vi.fn(async (_input: unknown) => undefined),
  updateRegionConfig: vi.fn(async (_input: unknown) => ({ emptyPctAmber: 20, emptyPctRed: 30 })),
  acknowledgeKpiAlert: vi.fn(async (_input: unknown) => undefined),
  setLaneNote: vi.fn(async (_input: unknown) => undefined),
  setLaneWeeklyTarget: vi.fn(async (_input: unknown) => undefined),
  listOperationalRules: vi.fn(async (_input: unknown) => [
    { id: "r1", code: "EMPTY_MILE", severity: "WARN", title: "Empty mile", statement: "...", appliesTo: "Region" }
  ]),
  createOperationalRule: vi.fn(async (_input: unknown) => ({ id: "rule-new" })),
  listDistributionCenters: vi.fn(async (_input: unknown) => [{ id: "dc1", name: "Carlisle DC", city: "Carlisle", state: "PA" }]),
  addBrokerRep: vi.fn(async (_input: unknown) => ({ id: "rep-new" })),
  updateBrokerRep: vi.fn(async (_input: unknown) => undefined),
  softDeleteBrokerRep: vi.fn(async (_input: unknown) => undefined),
  softDeleteBroker: vi.fn(async (_input: unknown) => undefined),
  softDeleteLane: vi.fn(async (_input: unknown) => undefined),
  softDeleteDropLot: vi.fn(async (_input: unknown) => undefined),
  assertPermission: vi.fn()
}));
const {
  updateBoardLoadFields,
  setBoardLoadStatus,
  softDeleteBoardLoad,
  createBroker,
  updateBroker,
  createLane,
  setLaneTarget,
  createDropLot,
  updateDropLot,
  getBoardResponse,
  moveBoardLoad,
  upsertBoardLoadLeg,
  deleteBoardLoadLeg,
  getKpiDashboard,
  loadFindMany,
  getEffectiveFscRate,
  getAuditHistory,
  getRoadMiles,
  createManualLoad,
  approveRateConfirmationReview,
  rejectRateConfirmationReview,
  getRateConfirmationActivity,
  upsertFscIndex,
  acknowledgeKpiAlert,
  setLaneNote,
  setLaneWeeklyTarget,
  createOperationalRule,
  listDistributionCenters,
  addBrokerRep,
  softDeleteDropLot,
  assertPermission
} = mocks;

vi.mock("@/server/board", () => ({
  updateBoardLoadFields: mocks.updateBoardLoadFields,
  setBoardLoadStatus: mocks.setBoardLoadStatus,
  setLoadTonuLifecycle: mocks.setLoadTonuLifecycle,
  softDeleteBoardLoad: mocks.softDeleteBoardLoad,
  getBoardResponse: mocks.getBoardResponse,
  moveBoardLoad: mocks.moveBoardLoad,
  upsertBoardLoadLeg: mocks.upsertBoardLoadLeg,
  deleteBoardLoadLeg: mocks.deleteBoardLoadLeg
}));
vi.mock("@/server/kpi-dashboard", () => ({ getKpiDashboard: mocks.getKpiDashboard }));
vi.mock("@/server/fsc", () => ({ getEffectiveFscRate: mocks.getEffectiveFscRate, upsertFscIndex: mocks.upsertFscIndex }));
vi.mock("@/server/region-config", () => ({ updateRegionConfig: mocks.updateRegionConfig }));
vi.mock("@/server/audit-read", () => ({ getAuditHistory: mocks.getAuditHistory, listAuditLog: mocks.listAuditLog }));
vi.mock("@/server/llm/settings", () => ({ getLlmSettingsStatus: mocks.getLlmSettingsStatus, updateLlmSettings: mocks.updateLlmSettings }));
vi.mock("@/server/llm/registry", () => ({ SUPPORTED_PROVIDERS: ["anthropic"] }));
vi.mock("@/server/kpi-alerts", () => ({ acknowledgeKpiAlert: mocks.acknowledgeKpiAlert }));
vi.mock("@/server/rate-confirmation-activity", () => ({ getRateConfirmationActivity: mocks.getRateConfirmationActivity }));
vi.mock("@/server/lane-week-write", () => ({ setLaneNote: mocks.setLaneNote, setLaneWeeklyTarget: mocks.setLaneWeeklyTarget }));
vi.mock("@/server/operational-rules", () => ({
  listOperationalRules: mocks.listOperationalRules,
  createOperationalRule: mocks.createOperationalRule
}));
vi.mock("@/server/review", () => ({
  createManualLoad: mocks.createManualLoad,
  approveRateConfirmationReview: mocks.approveRateConfirmationReview,
  rejectRateConfirmationReview: mocks.rejectRateConfirmationReview
}));
vi.mock("@/server/distance", () => ({ getRoadMiles: mocks.getRoadMiles }));
vi.mock("@/server/board-detail", () => ({ getLoadDetail: mocks.getLoadDetail }));
vi.mock("@/server/reference", () => ({
  createBroker: mocks.createBroker,
  updateBroker: mocks.updateBroker,
  listBrokers: mocks.listBrokers,
  createLane: mocks.createLane,
  setLaneTarget: mocks.setLaneTarget,
  listLanes: mocks.listLanes,
  createDropLot: mocks.createDropLot,
  updateDropLot: mocks.updateDropLot,
  listDropLots: mocks.listDropLots,
  listDistributionCenters: mocks.listDistributionCenters,
  addBrokerRep: mocks.addBrokerRep,
  updateBrokerRep: mocks.updateBrokerRep,
  softDeleteBrokerRep: mocks.softDeleteBrokerRep,
  softDeleteBroker: mocks.softDeleteBroker,
  softDeleteLane: mocks.softDeleteLane,
  softDeleteDropLot: mocks.softDeleteDropLot
}));
vi.mock("@/domain/policy/policy-adapter", () => ({ policyAdapter: { assertPermission: mocks.assertPermission } }));
vi.mock("@/lib/db", () => ({ prisma: { load: { findMany: mocks.loadFindMany } } }));

import { dispatchTool, type CopilotContext } from "@/server/copilot/tools";

const ctx: CopilotContext = { userId: "u1", regionId: "r1", role: "COORDINATOR", boardDate: "2026-06-18" };

describe("copilot tool dispatch — safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("soft_delete_load stages for confirmation and does NOT execute by default", async () => {
    const result = await dispatchTool("soft_delete_load", { loadId: "load-1", reason: "dup" }, ctx);
    expect(result.needsConfirmation).toBe(true);
    expect(softDeleteBoardLoad).not.toHaveBeenCalled();
  });

  test("soft_delete_load executes once confirmed", async () => {
    await dispatchTool("soft_delete_load", { loadId: "load-1", reason: "dup" }, ctx, { confirmed: true });
    expect(softDeleteBoardLoad).toHaveBeenCalledWith(
      expect.objectContaining({ regionId: "r1", loadId: "load-1", reason: "dup", actorId: "u1" })
    );
  });

  test("update_load_fields applies non-financial edits directly", async () => {
    const result = await dispatchTool(
      "update_load_fields",
      { loadId: "load-1", fields: { deliveryDate: "2026-06-22", podStatus: "UPLOADED" } },
      ctx
    );
    expect(result.needsConfirmation).toBeFalsy();
    expect(updateBoardLoadFields).toHaveBeenCalledWith(
      expect.objectContaining({ fields: { deliveryDate: "2026-06-22", podStatus: "UPLOADED" } })
    );
  });

  test("update_load_fields stages financial edits for confirmation", async () => {
    const result = await dispatchTool(
      "update_load_fields",
      { loadId: "load-1", fields: { lineHaulRate: "1850" } },
      ctx
    );
    expect(result.needsConfirmation).toBe(true);
    expect(updateBoardLoadFields).not.toHaveBeenCalled();
  });

  test("update_load_fields allows broker assignment and custom PU/DEL status (non-financial, applies directly)", async () => {
    const result = await dispatchTool(
      "update_load_fields",
      {
        loadId: "load-1",
        fields: { brokerId: "broker-7", puStatusCustom: "Loaded, ETA 1500", delStatusCustom: "On time" }
      },
      ctx
    );
    expect(result.needsConfirmation).toBeFalsy();
    expect(updateBoardLoadFields).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: { brokerId: "broker-7", puStatusCustom: "Loaded, ETA 1500", delStatusCustom: "On time" }
      })
    );
  });

  test("update_load_fields drops keys outside the allowed set", async () => {
    await dispatchTool(
      "update_load_fields",
      { loadId: "load-1", fields: { podStatus: "UPLOADED", regionId: "evil", id: "x" } },
      ctx,
      { confirmed: true }
    );
    const call = updateBoardLoadFields.mock.calls[0][0] as unknown as { fields: Record<string, unknown> };
    expect(call.fields).toEqual({ podStatus: "UPLOADED" });
  });

  test("write tools enforce BOARD:WRITE permission", async () => {
    await dispatchTool("update_load_fields", { loadId: "load-1", fields: { podStatus: "UPLOADED" } }, ctx);
    expect(assertPermission).toHaveBeenCalledWith(
      { userId: "u1", regionId: "r1", role: "COORDINATOR" },
      { resource: "BOARD", action: "WRITE" }
    );
  });

  test("set_load_status to CANCELED needs confirmation; BOOKED does not", async () => {
    const canceled = await dispatchTool("set_load_status", { loadId: "load-1", status: "CANCELED" }, ctx);
    expect(canceled.needsConfirmation).toBe(true);
    expect(setBoardLoadStatus).not.toHaveBeenCalled();

    const booked = await dispatchTool("set_load_status", { loadId: "load-1", status: "BOOKED" }, ctx);
    expect(booked.needsConfirmation).toBeFalsy();
    expect(setBoardLoadStatus).toHaveBeenCalled();
  });
});

describe("copilot tool dispatch — reference data", () => {
  const rmCtx: CopilotContext = { userId: "rm1", regionId: "r1", role: "REGIONAL_MANAGER", boardDate: "2026-06-18" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("find_brokers lists without requiring a write permission", async () => {
    const result = await dispatchTool("find_brokers", {}, rmCtx);
    expect(assertPermission).not.toHaveBeenCalled();
    expect(Array.isArray(result.content)).toBe(true);
    expect((result.content as Array<{ name: string }>)[0].name).toBe("Acme");
  });

  test("find_brokers filters by name query", async () => {
    const result = await dispatchTool("find_brokers", { query: "zzz" }, rmCtx);
    expect((result.content as unknown[]).length).toBe(0);
  });

  test("create_broker enforces REFERENCE_DATA:WRITE and executes directly (no confirmation)", async () => {
    const result = await dispatchTool("create_broker", { name: "Acme Logistics" }, rmCtx);
    expect(assertPermission).toHaveBeenCalledWith(
      { userId: "rm1", regionId: "r1", role: "REGIONAL_MANAGER" },
      { resource: "REFERENCE_DATA", action: "WRITE" }
    );
    expect(result.needsConfirmation).toBeFalsy();
    expect(createBroker).toHaveBeenCalledWith(
      expect.objectContaining({ regionId: "r1", actorId: "rm1", name: "Acme Logistics" })
    );
  });

  test("update_broker passes only the provided fields", async () => {
    await dispatchTool("update_broker", { brokerId: "broker-1", onboardingStatus: "APPROVED" }, rmCtx);
    expect(updateBroker).toHaveBeenCalledWith(
      expect.objectContaining({ brokerId: "broker-1", fields: { onboardingStatus: "APPROVED" } })
    );
  });

  test("a COORDINATOR is refused broker management (policy throws)", async () => {
    assertPermission.mockImplementationOnce(() => {
      throw new Error("Policy denies COORDINATOR WRITE on REFERENCE_DATA");
    });
    const coordCtx: CopilotContext = { userId: "c1", regionId: "r1", role: "COORDINATOR", boardDate: "2026-06-18" };
    await expect(dispatchTool("create_broker", { name: "Acme" }, coordCtx)).rejects.toThrow(/Policy denies/);
    expect(createBroker).not.toHaveBeenCalled();
  });

  test("create_lane enforces REFERENCE_DATA:WRITE and executes directly", async () => {
    const result = await dispatchTool(
      "create_lane",
      { originCity: "Carlisle", originState: "PA", destinationCity: "Boston", destinationState: "MA", targetRate: "2.15" },
      rmCtx
    );
    expect(assertPermission).toHaveBeenCalledWith(
      { userId: "rm1", regionId: "r1", role: "REGIONAL_MANAGER" },
      { resource: "REFERENCE_DATA", action: "WRITE" }
    );
    expect(result.needsConfirmation).toBeFalsy();
    expect(createLane).toHaveBeenCalledWith(
      expect.objectContaining({ regionId: "r1", originCity: "Carlisle", targetRate: "2.15" })
    );
  });

  test("set_lane_target updates the target on an existing lane", async () => {
    await dispatchTool("set_lane_target", { laneId: "lane-1", targetRate: "2.50" }, rmCtx);
    expect(setLaneTarget).toHaveBeenCalledWith(
      expect.objectContaining({ laneId: "lane-1", targetRate: "2.50" })
    );
  });

  test("find_lanes lists without a write permission and filters by query", async () => {
    const all = await dispatchTool("find_lanes", {}, rmCtx);
    expect(assertPermission).not.toHaveBeenCalled();
    expect((all.content as unknown[]).length).toBe(1);
    const none = await dispatchTool("find_lanes", { query: "nowhere" }, rmCtx);
    expect((none.content as unknown[]).length).toBe(0);
  });

  test("create_drop_lot requires name/city/state and executes under the write gate", async () => {
    const missing = await dispatchTool("create_drop_lot", { name: "CDC" }, rmCtx);
    expect((missing.content as { error?: string }).error).toMatch(/required/);
    expect(createDropLot).not.toHaveBeenCalled();

    const result = await dispatchTool("create_drop_lot", { name: "CDC", city: "Carlisle", state: "PA" }, rmCtx);
    expect(result.needsConfirmation).toBeFalsy();
    expect(createDropLot).toHaveBeenCalledWith(
      expect.objectContaining({ regionId: "r1", fields: expect.objectContaining({ name: "CDC", city: "Carlisle", state: "PA" }) })
    );
  });

  test("update_drop_lot passes only provided fields", async () => {
    await dispatchTool("update_drop_lot", { dropLotId: "lot-1", slipSeat: true }, rmCtx);
    expect(updateDropLot).toHaveBeenCalledWith(
      expect.objectContaining({ dropLotId: "lot-1", fields: { slipSeat: true } })
    );
  });
});

describe("copilot tool dispatch — board awareness & legs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("get_board_summary returns day totals and sections with capacity/fill (read-only)", async () => {
    const result = await dispatchTool("get_board_summary", {}, ctx);
    expect(getBoardResponse).toHaveBeenCalledWith({ regionId: "r1", date: "2026-06-18" });
    expect(assertPermission).not.toHaveBeenCalled();
    const content = result.content as {
      dayTotals: { loadCount: number };
      sections: Array<{ capacity: number | null; filled: number; overCapacity: boolean; loads: unknown[] }>;
    };
    expect(content.dayTotals.loadCount).toBe(1);
    expect(content.sections[0].capacity).toBe(8);
    expect(content.sections[0].filled).toBe(1);
    expect(content.sections[0].overCapacity).toBe(false);
    expect(content.sections[0].loads).toHaveLength(1);
  });

  test("get_board_summary honors an explicit date", async () => {
    await dispatchTool("get_board_summary", { date: "2026-06-20" }, ctx);
    expect(getBoardResponse).toHaveBeenCalledWith({ regionId: "r1", date: "2026-06-20" });
  });

  test("get_attention_items returns flagged loads from the board (read-only)", async () => {
    const result = await dispatchTool("get_attention_items", {}, ctx);
    expect(assertPermission).not.toHaveBeenCalled();
    const content = result.content as { count: number; items: Array<{ ref: string | null; attentionSeverity: string }> };
    expect(content.count).toBe(1);
    expect(content.items[0]).toMatchObject({ ref: "3P-1", attentionSeverity: "URGENT" });
  });

  test("get_fsc returns the week's rate and brokers without default FSC", async () => {
    const result = await dispatchTool("get_fsc", {}, ctx);
    expect(getEffectiveFscRate).toHaveBeenCalled();
    const content = result.content as { weekIso: string; fscRate: string | null; brokersWithoutDefaultFsc: string[] };
    expect(content.fscRate).toBe("0.55");
    expect(content.weekIso).toMatch(/^\d{4}-W\d{2}$/);
    expect(Array.isArray(content.brokersWithoutDefaultFsc)).toBe(true);
  });

  test("get_audit_history resolves a loadId to entityType Load", async () => {
    const result = await dispatchTool("get_audit_history", { loadId: "load-1" }, ctx);
    expect(getAuditHistory).toHaveBeenCalledWith(expect.objectContaining({ entityId: "load-1", entityType: "Load" }));
    const content = result.content as { entityType: string | null; count: number };
    expect(content.entityType).toBe("Load");
    expect(content.count).toBe(1);
  });

  test("get_audit_history errors when no id is given", async () => {
    const result = await dispatchTool("get_audit_history", {}, ctx);
    expect((result.content as { error?: string }).error).toMatch(/loadId or entityId/);
    expect(getAuditHistory).not.toHaveBeenCalled();
  });

  test("get_kpis resolves the week from the board date and returns cards/lanes", async () => {
    const result = await dispatchTool("get_kpis", {}, ctx);
    expect(getKpiDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ regionId: "r1", weekIso: expect.stringMatching(/^\d{4}-W\d{2}$/) })
    );
    const content = result.content as { cards: unknown[]; lanes: unknown[]; mileMaxMissingInbound: boolean };
    expect(content.cards.length).toBeGreaterThan(0);
    expect(Array.isArray(content.lanes)).toBe(true);
  });

  test("find_loads passes a bookingDate range when a date is given", async () => {
    await dispatchTool("find_loads", { date: "2026-06-18" }, ctx);
    const call = loadFindMany.mock.calls[0][0] as unknown as { where: Record<string, unknown> };
    expect(call.where).toHaveProperty("bookingDate");
  });

  test("move_load to a drop lot executes directly under BOARD:WRITE", async () => {
    const result = await dispatchTool("move_load", { loadId: "load-1", targetSectionId: "lot-2" }, ctx);
    expect(result.needsConfirmation).toBeFalsy();
    expect(assertPermission).toHaveBeenCalledWith(
      { userId: "u1", regionId: "r1", role: "COORDINATOR" },
      { resource: "BOARD", action: "WRITE" }
    );
    expect(moveBoardLoad).toHaveBeenCalledWith(
      expect.objectContaining({ regionId: "r1", loadId: "load-1", targetSectionId: "lot-2", actorId: "u1" })
    );
  });

  test("move_load to canceled stages for confirmation", async () => {
    const result = await dispatchTool("move_load", { loadId: "load-1", targetSectionId: "canceled" }, ctx);
    expect(result.needsConfirmation).toBe(true);
    expect(moveBoardLoad).not.toHaveBeenCalled();
  });

  test("upsert_load_leg assigns a driver directly", async () => {
    const result = await dispatchTool(
      "upsert_load_leg",
      { loadId: "load-1", leg: { legIndex: 0, legType: "PTP", driverName: "J. Morales" } },
      ctx
    );
    expect(result.needsConfirmation).toBeFalsy();
    expect(upsertBoardLoadLeg).toHaveBeenCalledWith(
      expect.objectContaining({
        regionId: "r1",
        loadId: "load-1",
        leg: expect.objectContaining({ legIndex: 0, legType: "PTP", driverName: "J. Morales" })
      })
    );
  });

  test("upsert_load_leg rejects an invalid legType", async () => {
    const result = await dispatchTool("upsert_load_leg", { loadId: "load-1", leg: { legIndex: 0, legType: "BOGUS" } }, ctx);
    expect((result.content as { error?: string }).error).toMatch(/legType/);
    expect(upsertBoardLoadLeg).not.toHaveBeenCalled();
  });

  test("delete_load_leg stages for confirmation, then executes when confirmed", async () => {
    const staged = await dispatchTool("delete_load_leg", { loadId: "load-1", legId: "leg-1" }, ctx);
    expect(staged.needsConfirmation).toBe(true);
    expect(deleteBoardLoadLeg).not.toHaveBeenCalled();

    await dispatchTool("delete_load_leg", { loadId: "load-1", legId: "leg-1" }, ctx, { confirmed: true });
    expect(deleteBoardLoadLeg).toHaveBeenCalledWith(
      expect.objectContaining({ regionId: "r1", loadId: "load-1", legId: "leg-1", actorId: "u1" })
    );
  });
});

describe("copilot tool dispatch — create load & extended gaps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRoadMiles.mockResolvedValue({ miles: 300, source: "google" });
  });

  test("create_load auto-calculates miles and stages for confirmation", async () => {
    const result = await dispatchTool(
      "create_load",
      { pickupCity: "Pittsburgh", pickupState: "PA", deliveryCity: "Carlisle", deliveryState: "PA", lineHaulRate: "2400", fscApplies: true, puDeadheadMiles: "300", delDeadheadMiles: "0" },
      ctx
    );
    expect(getRoadMiles).toHaveBeenCalled();
    expect(result.needsConfirmation).toBe(true);
    expect(createManualLoad).not.toHaveBeenCalled();
    expect((result.content as { loadedMiles?: string }).loadedMiles).toBe("300");
  });

  test("create_load asks for miles when routing is unavailable", async () => {
    mocks.getRoadMiles.mockResolvedValue({ miles: null, source: "unavailable" });
    const result = await dispatchTool(
      "create_load",
      { pickupCity: "Pittsburgh", pickupState: "PA", deliveryCity: "Carlisle", deliveryState: "PA", lineHaulRate: "2400", fscApplies: true, puDeadheadMiles: "300", delDeadheadMiles: "0" },
      ctx
    );
    expect((result.content as { status?: string }).status).toBe("need_miles");
    expect(result.needsConfirmation).toBeFalsy();
  });

  test("create_load requires deadhead before staging", async () => {
    const result = await dispatchTool(
      "create_load",
      { pickupCity: "Pittsburgh", pickupState: "PA", deliveryCity: "Carlisle", deliveryState: "PA", lineHaulRate: "2400", fscApplies: true },
      ctx
    );
    expect((result.content as { status?: string }).status).toBe("need_info");
    expect((result.content as { message: string }).message).toMatch(/deadhead/i);
  });

  test("create_load (confirmed) resolves broker by name and creates under BOARD:WRITE", async () => {
    const result = await dispatchTool(
      "create_load",
      { pickupCity: "Pittsburgh", pickupState: "PA", deliveryCity: "Carlisle", deliveryState: "PA", lineHaulRate: "2400", fscApplies: true, puDeadheadMiles: "300", delDeadheadMiles: "0", brokerName: "Acme" },
      ctx,
      { confirmed: true }
    );
    expect(assertPermission).toHaveBeenCalledWith(
      { userId: "u1", regionId: "r1", role: "COORDINATOR" },
      { resource: "BOARD", action: "WRITE" }
    );
    expect(createManualLoad).toHaveBeenCalledWith(expect.objectContaining({ regionId: "r1", actorId: "u1", brokerId: "broker-1" }));
    expect((result.content as { status?: string }).status).toBe("created");
  });

  test("create_relayed_load (confirmed) links the rate con and births each leg", async () => {
    const relayInput = {
      pickupCity: "Allentown",
      pickupState: "PA",
      deliveryCity: "Columbus",
      deliveryState: "OH",
      lineHaulRate: "1850",
      loadedMiles: "500",
      puDeadheadMiles: "10",
      delDeadheadMiles: "12",
      fscApplies: false,
      rateConfirmationId: "rc_abc123",
      legs: [
        { legIndex: 0, legType: "SHUTTLE", driverName: "Ann" },
        { legIndex: 1, legType: "PTP", driverName: "Bob" }
      ]
    };
    const result = await dispatchTool("create_relayed_load", relayInput, ctx, { confirmed: true });
    expect(createManualLoad).toHaveBeenCalledWith(
      expect.objectContaining({ regionId: "r1", actorId: "u1", rateConfirmationId: "rc_abc123" })
    );
    expect(upsertBoardLoadLeg).toHaveBeenCalledTimes(2);
    expect((result.content as { status?: string }).status).toBe("created");
  });

  test("create_relayed_load without a rate con passes rateConfirmationId null", async () => {
    const relayInput = {
      pickupCity: "Reading",
      pickupState: "PA",
      deliveryCity: "Newark",
      deliveryState: "NJ",
      lineHaulRate: "1200",
      loadedMiles: "250",
      puDeadheadMiles: "5",
      delDeadheadMiles: "5",
      fscApplies: false,
      legs: [{ legIndex: 0, legType: "PTP", driverName: "Dan" }]
    };
    await dispatchTool("create_relayed_load", relayInput, ctx, { confirmed: true });
    expect(createManualLoad).toHaveBeenCalledWith(expect.objectContaining({ rateConfirmationId: null }));
  });

  test("find_destinations lists DCs and drop lots (read-only)", async () => {
    const result = await dispatchTool("find_destinations", {}, ctx);
    expect(assertPermission).not.toHaveBeenCalled();
    expect(listDistributionCenters).toHaveBeenCalled();
    const content = result.content as { distributionCenters: unknown[]; dropLots: unknown[] };
    expect(content.distributionCenters).toHaveLength(1);
    expect(content.dropLots.length).toBeGreaterThan(0);
  });

  test("get_rate_confirmations returns the review queue", async () => {
    const result = await dispatchTool("get_rate_confirmations", {}, ctx);
    expect(getRateConfirmationActivity).toHaveBeenCalledWith({ regionId: "r1", date: "2026-06-18" });
    const content = result.content as { ready: Array<{ id: string }> };
    expect(content.ready[0].id).toBe("rc1");
  });

  test("set_fsc stages then upserts the override when confirmed", async () => {
    const staged = await dispatchTool("set_fsc", { value: "0.52", reason: "tuesday update", source: "override" }, ctx);
    expect(staged.needsConfirmation).toBe(true);
    expect(upsertFscIndex).not.toHaveBeenCalled();

    await dispatchTool("set_fsc", { value: "0.52", reason: "tuesday update", source: "override" }, ctx, { confirmed: true });
    expect(upsertFscIndex).toHaveBeenCalledWith(expect.objectContaining({ regionId: "r1", source: "manual_override", reason: "tuesday update" }));
  });

  test("set_board_thresholds stages then updates region config when confirmed", async () => {
    const staged = await dispatchTool("set_board_thresholds", { emptyPctAmber: "12", emptyPctRed: "20" }, ctx);
    expect(staged.needsConfirmation).toBe(true);
    expect(mocks.updateRegionConfig).not.toHaveBeenCalled();

    await dispatchTool("set_board_thresholds", { emptyPctAmber: "12", emptyPctRed: "20" }, ctx, { confirmed: true });
    expect(assertPermission).toHaveBeenCalledWith(
      { userId: "u1", regionId: "r1", role: "COORDINATOR" },
      { resource: "SYSTEM_SETTINGS", action: "WRITE" }
    );
    expect(mocks.updateRegionConfig).toHaveBeenCalledWith(
      expect.objectContaining({ regionId: "r1", actorId: "u1", emptyPctAmber: "12", emptyPctRed: "20" })
    );
  });

  test("set_board_thresholds asks for a value when none provided", async () => {
    const result = await dispatchTool("set_board_thresholds", {}, ctx);
    expect((result.content as { status?: string }).status).toBe("need_info");
    expect(mocks.updateRegionConfig).not.toHaveBeenCalled();
  });

  test("acknowledge_alert calls the ack action under KPI write", async () => {
    await dispatchTool("acknowledge_alert", { alertId: "alert-1", reason: "seen" }, ctx);
    expect(assertPermission).toHaveBeenCalledWith(
      { userId: "u1", regionId: "r1", role: "COORDINATOR" },
      { resource: "KPI_DASHBOARD", action: "WRITE" }
    );
    expect(acknowledgeKpiAlert).toHaveBeenCalledWith(expect.objectContaining({ alertId: "alert-1", actorId: "u1" }));
  });

  test("set_lane_note writes the note for the current week", async () => {
    await dispatchTool("set_lane_note", { lane: "Pittsburgh, PA -> Carlisle, PA", note: "watch this lane" }, ctx);
    expect(setLaneNote).toHaveBeenCalledWith(expect.objectContaining({ regionId: "r1", lane: "Pittsburgh, PA -> Carlisle, PA", note: "watch this lane" }));
  });

  test("set_lane_weekly_target rejects a non-numeric rate", async () => {
    const result = await dispatchTool("set_lane_weekly_target", { lane: "A -> B", targetRate: "abc" }, ctx);
    expect((result.content as { status?: string }).status).toBe("need_info");
    expect(setLaneWeeklyTarget).not.toHaveBeenCalled();
  });

  test("create_operational_rule validates the code format", async () => {
    const bad = await dispatchTool("create_operational_rule", { code: "lower case", title: "T", severity: "WARN", statement: "s" }, ctx);
    expect((bad.content as { status?: string }).status).toBe("need_info");
    expect(createOperationalRule).not.toHaveBeenCalled();

    const ok = await dispatchTool("create_operational_rule", { code: "EMPTY_MILE", title: "T", severity: "WARN", statement: "s" }, ctx);
    expect((ok.content as { status?: string }).status).toBe("created");
    expect(createOperationalRule).toHaveBeenCalled();
  });

  test("add_broker_rep adds a contact under REFERENCE_DATA:WRITE", async () => {
    await dispatchTool("add_broker_rep", { brokerId: "broker-1", name: "Sam Rep", email: "sam@x.com" }, ctx);
    expect(assertPermission).toHaveBeenCalledWith(
      { userId: "u1", regionId: "r1", role: "COORDINATOR" },
      { resource: "REFERENCE_DATA", action: "WRITE" }
    );
    expect(addBrokerRep).toHaveBeenCalledWith(expect.objectContaining({ brokerId: "broker-1", name: "Sam Rep" }));
  });

  test("delete_drop_lot stages then deletes when confirmed", async () => {
    const staged = await dispatchTool("delete_drop_lot", { dropLotId: "lot-1", reason: "test" }, ctx);
    expect(staged.needsConfirmation).toBe(true);
    expect(softDeleteDropLot).not.toHaveBeenCalled();

    await dispatchTool("delete_drop_lot", { dropLotId: "lot-1", reason: "test" }, ctx, { confirmed: true });
    expect(softDeleteDropLot).toHaveBeenCalledWith(expect.objectContaining({ dropLotId: "lot-1", reason: "test" }));
  });

  test("review_rate_confirmation approve stages, then creates a load when confirmed", async () => {
    const staged = await dispatchTool("review_rate_confirmation", { rateConfirmationId: "rc1", decision: "approve" }, ctx);
    expect(staged.needsConfirmation).toBe(true);
    expect(approveRateConfirmationReview).not.toHaveBeenCalled();

    const done = await dispatchTool("review_rate_confirmation", { rateConfirmationId: "rc1", decision: "approve" }, ctx, { confirmed: true });
    expect(assertPermission).toHaveBeenCalledWith(
      { userId: "u1", regionId: "r1", role: "COORDINATOR" },
      { resource: "RATE_CONFIRMATION_REVIEW", action: "REVIEW" }
    );
    expect(approveRateConfirmationReview).toHaveBeenCalledWith(expect.objectContaining({ rateConfirmationId: "rc1" }));
    expect((done.content as { status?: string }).status).toBe("approved");
  });

  test("review_rate_confirmation reject runs directly", async () => {
    const result = await dispatchTool("review_rate_confirmation", { rateConfirmationId: "rc1", decision: "reject", reason: "dup" }, ctx);
    expect(result.needsConfirmation).toBeFalsy();
    expect(rejectRateConfirmationReview).toHaveBeenCalledWith(expect.objectContaining({ rateConfirmationId: "rc1", reason: "dup" }));
  });
});

describe("copilot tool dispatch — audit & settings parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("list_audit_log browses the global trail read-only, coercing dates and passing filters", async () => {
    const result = await dispatchTool("list_audit_log", { entityType: "Lane", search: "lane", from: "2026-06-01", limit: 10 }, ctx);
    expect(assertPermission).not.toHaveBeenCalled();
    expect(mocks.listAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "Lane", search: "lane", limit: 10 })
    );
    const fromArg = (mocks.listAuditLog.mock.calls[0][0] as { from?: Date }).from;
    expect(fromArg).toBeInstanceOf(Date);
    const content = result.content as { count: number; entries: unknown[]; nextCursor: string | null };
    expect(content.count).toBe(1);
    expect(content.nextCursor).toBe("al1");
  });

  test("get_llm_settings returns the masked status (no raw key, read-only)", async () => {
    const result = await dispatchTool("get_llm_settings", {}, ctx);
    expect(assertPermission).not.toHaveBeenCalled();
    const content = result.content as { provider: string; apiKeyLast4: string | null };
    expect(content.provider).toBe("anthropic");
    expect(content.apiKeyLast4).toBe("1234");
    expect(JSON.stringify(content)).not.toContain("apiKeyCipher");
  });

  test("set_llm_settings stages for confirmation, does NOT execute, and never leaks the key", async () => {
    const staged = await dispatchTool("set_llm_settings", { copilotModel: "claude-sonnet-4-6", apiKey: "sk-super-secret-XYZ" }, ctx);
    expect(staged.needsConfirmation).toBe(true);
    expect(mocks.updateLlmSettings).not.toHaveBeenCalled();
    expect(JSON.stringify(staged)).not.toContain("sk-super-secret-XYZ");
    expect(staged.summary ?? "").not.toContain("sk-super-secret-XYZ");
  });

  test("set_llm_settings executes under SYSTEM_SETTINGS:WRITE once confirmed and never echoes the key", async () => {
    const done = await dispatchTool("set_llm_settings", { model: "claude-opus-4-8", apiKey: "sk-super-secret-XYZ" }, ctx, { confirmed: true });
    expect(assertPermission).toHaveBeenCalledWith(
      { userId: "u1", regionId: "r1", role: "COORDINATOR" },
      { resource: "SYSTEM_SETTINGS", action: "WRITE" }
    );
    expect(mocks.updateLlmSettings).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "u1", model: "claude-opus-4-8", apiKey: "sk-super-secret-XYZ" })
    );
    expect(JSON.stringify(done)).not.toContain("sk-super-secret-XYZ");
  });

  test("set_llm_settings rejects an unsupported provider", async () => {
    const result = await dispatchTool("set_llm_settings", { provider: "openai" }, ctx);
    expect((result.content as { status?: string }).status).toBe("need_info");
    expect(mocks.updateLlmSettings).not.toHaveBeenCalled();
  });

  test("set_llm_settings asks for input when nothing is provided", async () => {
    const result = await dispatchTool("set_llm_settings", {}, ctx);
    expect((result.content as { status?: string }).status).toBe("need_info");
    expect(mocks.updateLlmSettings).not.toHaveBeenCalled();
  });
});
