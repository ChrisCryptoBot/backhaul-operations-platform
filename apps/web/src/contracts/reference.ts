import { z } from "zod";

/**
 * Reference-data API contracts (v1). Broker + broker-rep management; lanes/drop-lots
 * extend this file in Part B. The POST body is a discriminated union on `action`,
 * mirroring the board mutation contract.
 */
export const referenceContractVersion = "v1";

export const brokerOnboardingStatusSchema = z.enum(["PENDING", "APPROVED", "BLOCKED"]);

const brokerNameSchema = z.string().trim().min(1).max(160);
const repNameSchema = z.string().trim().min(1).max(160);
const emailSchema = z.string().trim().email().max(200);
const phoneSchema = z.string().trim().min(1).max(40);

export const brokerCreateSchema = z.object({
  name: brokerNameSchema,
  onboardingStatus: brokerOnboardingStatusSchema.optional(),
  fscDefaultApplies: z.boolean().optional()
});

export const brokerUpdateFieldsSchema = z
  .object({
    name: brokerNameSchema.optional(),
    onboardingStatus: brokerOnboardingStatusSchema.optional(),
    fscDefaultApplies: z.boolean().optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required."
  });

export const brokerRepCreateSchema = z.object({
  name: repNameSchema,
  email: emailSchema.nullable().optional(),
  phone: phoneSchema.nullable().optional()
});

export const brokerRepUpdateFieldsSchema = z
  .object({
    name: repNameSchema.optional(),
    email: emailSchema.nullable().optional(),
    phone: phoneSchema.nullable().optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required."
  });

export const brokerMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_broker"),
    regionId: z.string().min(1).optional(),
    broker: brokerCreateSchema
  }),
  z.object({
    action: z.literal("update_broker"),
    regionId: z.string().min(1).optional(),
    brokerId: z.string().min(1),
    fields: brokerUpdateFieldsSchema
  }),
  z.object({
    action: z.literal("delete_broker"),
    regionId: z.string().min(1).optional(),
    brokerId: z.string().min(1),
    reason: z.string().trim().min(1)
  }),
  z.object({
    action: z.literal("add_rep"),
    regionId: z.string().min(1).optional(),
    brokerId: z.string().min(1),
    rep: brokerRepCreateSchema
  }),
  z.object({
    action: z.literal("update_rep"),
    regionId: z.string().min(1).optional(),
    brokerId: z.string().min(1),
    repId: z.string().min(1),
    fields: brokerRepUpdateFieldsSchema
  }),
  z.object({
    action: z.literal("delete_rep"),
    regionId: z.string().min(1).optional(),
    brokerId: z.string().min(1),
    repId: z.string().min(1)
  })
]);

export type BrokerMutation = z.infer<typeof brokerMutationSchema>;

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

const citySchema = z.string().trim().min(1).max(120);
const stateSchema = z.string().trim().min(1).max(40);
// targetRate is a Decimal(12,4) stored as a string; allow up to 4 decimal places.
const targetRateSchema = z.string().regex(/^\d+(\.\d{1,4})?$/);

export const laneCreateSchema = z.object({
  originCity: citySchema,
  originState: stateSchema,
  destinationCity: citySchema,
  destinationState: stateSchema,
  targetRate: targetRateSchema
});

export const laneMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_lane"),
    regionId: z.string().min(1).optional(),
    lane: laneCreateSchema
  }),
  z.object({
    action: z.literal("set_lane_target"),
    regionId: z.string().min(1).optional(),
    laneId: z.string().min(1),
    targetRate: targetRateSchema
  }),
  z.object({
    action: z.literal("delete_lane"),
    regionId: z.string().min(1).optional(),
    laneId: z.string().min(1),
    reason: z.string().trim().min(1)
  })
]);

export type LaneMutation = z.infer<typeof laneMutationSchema>;

// ---------------------------------------------------------------------------
// Drop lots
// ---------------------------------------------------------------------------

const dropLotNameSchema = z.string().trim().min(1).max(120);
const dropLotCodeSchema = z.string().trim().min(1).max(12);
const dropLotNoteSchema = z.string().trim().max(500);
const sortOrderSchema = z.number().int().min(0).max(10_000);
const dailyCapacitySchema = z.number().int().min(0).max(100_000);

export const dropLotCreateSchema = z.object({
  name: dropLotNameSchema,
  code: dropLotCodeSchema.nullable().optional(),
  note: dropLotNoteSchema.nullable().optional(),
  city: citySchema,
  state: stateSchema,
  sortOrder: sortOrderSchema.optional(),
  dailyCapacity: dailyCapacitySchema.nullable().optional(),
  slipSeat: z.boolean().optional(),
  dropHookRequired: z.boolean().optional()
});

export const dropLotUpdateFieldsSchema = z
  .object({
    name: dropLotNameSchema.optional(),
    code: dropLotCodeSchema.nullable().optional(),
    note: dropLotNoteSchema.nullable().optional(),
    city: citySchema.optional(),
    state: stateSchema.optional(),
    sortOrder: sortOrderSchema.optional(),
    dailyCapacity: dailyCapacitySchema.nullable().optional(),
    slipSeat: z.boolean().optional(),
    dropHookRequired: z.boolean().optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required."
  });

export const dropLotMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_drop_lot"),
    regionId: z.string().min(1).optional(),
    dropLot: dropLotCreateSchema
  }),
  z.object({
    action: z.literal("update_drop_lot"),
    regionId: z.string().min(1).optional(),
    dropLotId: z.string().min(1),
    fields: dropLotUpdateFieldsSchema
  }),
  z.object({
    action: z.literal("delete_drop_lot"),
    regionId: z.string().min(1).optional(),
    dropLotId: z.string().min(1),
    reason: z.string().trim().min(1)
  })
]);

export type DropLotMutation = z.infer<typeof dropLotMutationSchema>;
