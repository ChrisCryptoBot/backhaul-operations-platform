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

// ---------------------------------------------------------------------------
// Drivers (Phase 1 — Daily Booking Plan foundation)
// Append to apps/web/src/contracts/reference.ts
// ---------------------------------------------------------------------------

export const driverAttributeSchema = z.enum([
  "LTL_CERT",
  "SLEEPER",
  "TURNS_ONLY",
  "DEDICATED",
  "REGIONAL",
  "FLEX",
  "SHUTTLE",
  "PTP"
]);

export const dayOfWeekSchema = z.enum(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);

const driverCodeSchema = z.string().trim().min(1).max(16);
const driverFullNameSchema = z.string().trim().min(1).max(160);
// Local wall-clock start time, 24h "HH:MM" (e.g. "05:00").
const scheduleStartSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24h HH:MM, e.g. 05:00");
const timeZoneSchema = z.string().trim().min(1).max(64);
const driverNoteSchema = z.string().trim().max(500);

export const driverCreateSchema = z.object({
  code: driverCodeSchema,
  fullName: driverFullNameSchema,
  phone: phoneSchema.nullable().optional(),
  homeDropLotId: z.string().min(1).nullable().optional(),
  active: z.boolean().optional(),
  attributes: z.array(driverAttributeSchema).max(8).optional(),
  scheduleDays: z.array(dayOfWeekSchema).max(7).optional(),
  scheduleStart: scheduleStartSchema.nullable().optional(),
  scheduleTimeZone: timeZoneSchema.nullable().optional(),
  scheduleNote: driverNoteSchema.nullable().optional()
});

export const driverUpdateFieldsSchema = z
  .object({
    code: driverCodeSchema.optional(),
    fullName: driverFullNameSchema.optional(),
    phone: phoneSchema.nullable().optional(),
    homeDropLotId: z.string().min(1).nullable().optional(),
    active: z.boolean().optional(),
    attributes: z.array(driverAttributeSchema).max(8).optional(),
    scheduleDays: z.array(dayOfWeekSchema).max(7).optional(),
    scheduleStart: scheduleStartSchema.nullable().optional(),
    scheduleTimeZone: timeZoneSchema.nullable().optional(),
    scheduleNote: driverNoteSchema.nullable().optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required."
  });

export const driverMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_driver"),
    regionId: z.string().min(1).optional(),
    driver: driverCreateSchema
  }),
  z.object({
    action: z.literal("update_driver"),
    regionId: z.string().min(1).optional(),
    driverId: z.string().min(1),
    fields: driverUpdateFieldsSchema
  }),
  z.object({
    action: z.literal("delete_driver"),
    regionId: z.string().min(1).optional(),
    driverId: z.string().min(1),
    reason: z.string().trim().min(1)
  })
]);

export type DriverMutation = z.infer<typeof driverMutationSchema>;

// ---------------------------------------------------------------------------
// Direct customers (guaranteed recurring backhaul freight, e.g. SEALED AIR 1/DAY)
// ---------------------------------------------------------------------------

export const cadencePeriodSchema = z.enum(["DAY", "WEEK"]);

const directCustomerNameSchema = z.string().trim().min(1).max(160);
const cadenceCountSchema = z.number().int().min(1).max(1000);
const directCustomerNotesSchema = z.string().trim().max(500);

// Cadence is a pair: both set (e.g. 10/WEEK) or both null (no stated cadence).
export const directCustomerCreateSchema = z
  .object({
    name: directCustomerNameSchema,
    cadenceCount: cadenceCountSchema.nullable().optional(),
    cadencePeriod: cadencePeriodSchema.nullable().optional(),
    notes: directCustomerNotesSchema.nullable().optional()
  })
  .refine((value) => (value.cadenceCount == null) === (value.cadencePeriod == null), {
    message: "Cadence needs both a count and a period."
  });

export const directCustomerUpdateFieldsSchema = z
  .object({
    name: directCustomerNameSchema.optional(),
    cadenceCount: cadenceCountSchema.nullable().optional(),
    cadencePeriod: cadencePeriodSchema.nullable().optional(),
    notes: directCustomerNotesSchema.nullable().optional()
  })
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "At least one field is required." });
    }
    const hasCount = "cadenceCount" in value;
    const hasPeriod = "cadencePeriod" in value;
    if (hasCount !== hasPeriod || (hasCount && (value.cadenceCount == null) !== (value.cadencePeriod == null))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Cadence must be updated as a pair — both a count and a period, or both cleared."
      });
    }
  });

export const directCustomerMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_direct_customer"),
    regionId: z.string().min(1).optional(),
    directCustomer: directCustomerCreateSchema
  }),
  z.object({
    action: z.literal("update_direct_customer"),
    regionId: z.string().min(1).optional(),
    directCustomerId: z.string().min(1),
    fields: directCustomerUpdateFieldsSchema
  }),
  z.object({
    action: z.literal("delete_direct_customer"),
    regionId: z.string().min(1).optional(),
    directCustomerId: z.string().min(1),
    reason: z.string().trim().min(1)
  })
]);

export type DirectCustomerMutation = z.infer<typeof directCustomerMutationSchema>;

// ---------------------------------------------------------------------------
// Booking plan (Phase 2 — Daily Booking Plan)
// Append to apps/web/src/contracts/reference.ts after the DirectCustomer
// section. Reuses the file-scope citySchema / stateSchema / scheduleStartSchema.
// ---------------------------------------------------------------------------

export const bookingPlanStatusSchema = z.enum(["NEEDS_BACKHAUL", "SOURCING", "BOOKED"]);
// BOOKED is reachable only via book_booking_plan_entry — never settable directly.
export const bookingPlanEditableStatusSchema = z.enum(["NEEDS_BACKHAUL", "SOURCING"]);

const planDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const bookingPlanNoteSchema = z.string().trim().max(500);
// Planner shorthand cells lifted from the sheet ("READING PA +25", "0800-1400").
const bookingPlanShorthandSchema = z.string().trim().min(1).max(200);
const emptyCityAltSchema = z.string().trim().min(1).max(160);
// Booking-log capture: the broker sourced from and the agreed amount (decimal string).
const bookingPlanAmountSchema = z.string().trim().regex(/^\d+(\.\d{1,4})?$/, "Enter a dollar amount");

export const bookingPlanEntryCreateSchema = z.object({
  planDate: planDateSchema,
  driverId: z.string().min(1),
  expectedEmptyAt: scheduleStartSchema.nullable().optional(),
  emptyCity: citySchema.nullable().optional(),
  emptyState: stateSchema.nullable().optional(),
  emptyCityAlt: emptyCityAltSchema.nullable().optional(),
  backhaulNote: bookingPlanNoteSchema.nullable().optional(),
  status: bookingPlanEditableStatusSchema.optional(),
  brokerId: z.string().min(1).nullable().optional(),
  bookedAmount: bookingPlanAmountSchema.nullable().optional(),
  puCityDh: bookingPlanShorthandSchema.nullable().optional(),
  puTimes: bookingPlanShorthandSchema.nullable().optional(),
  delCityDh: bookingPlanShorthandSchema.nullable().optional(),
  delTimes: bookingPlanShorthandSchema.nullable().optional()
});

export const bookingPlanEntryUpdateFieldsSchema = z
  .object({
    planDate: planDateSchema.optional(),
    driverId: z.string().min(1).optional(),
    expectedEmptyAt: scheduleStartSchema.nullable().optional(),
    emptyCity: citySchema.nullable().optional(),
    emptyState: stateSchema.nullable().optional(),
    emptyCityAlt: emptyCityAltSchema.nullable().optional(),
    backhaulNote: bookingPlanNoteSchema.nullable().optional(),
    status: bookingPlanEditableStatusSchema.optional(),
    brokerId: z.string().min(1).nullable().optional(),
    bookedAmount: bookingPlanAmountSchema.nullable().optional(),
    puCityDh: bookingPlanShorthandSchema.nullable().optional(),
    puTimes: bookingPlanShorthandSchema.nullable().optional(),
    delCityDh: bookingPlanShorthandSchema.nullable().optional(),
    delTimes: bookingPlanShorthandSchema.nullable().optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required."
  });

export const bookingPlanMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_booking_plan_entry"),
    regionId: z.string().min(1).optional(),
    entry: bookingPlanEntryCreateSchema
  }),
  z.object({
    action: z.literal("update_booking_plan_entry"),
    regionId: z.string().min(1).optional(),
    entryId: z.string().min(1),
    fields: bookingPlanEntryUpdateFieldsSchema
  }),
  z.object({
    action: z.literal("delete_booking_plan_entry"),
    regionId: z.string().min(1).optional(),
    entryId: z.string().min(1),
    reason: z.string().trim().min(1)
  }),
  // The "source a Load" transition: creates a minimal BOOKED Load headed to the
  // region's home DC, links it, and flips the entry's status to BOOKED.
  z.object({
    action: z.literal("book_booking_plan_entry"),
    regionId: z.string().min(1).optional(),
    entryId: z.string().min(1)
  })
]);

export type BookingPlanMutation = z.infer<typeof bookingPlanMutationSchema>;
