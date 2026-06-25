import { z } from "zod";

// Shared field validators for the board mutation API. Extracted from route.ts so
// the cross-field refinements are unit-testable without the auth/route harness.

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Non-negative decimal, up to 4 fractional digits (matches the Decimal(_,4) columns). */
const DECIMAL_4 = /^\d+(\.\d{1,4})?$/;
const DECIMAL_2 = /^\d+(\.\d{1,2})?$/;

const taskDoneSchema = z.enum(["NOT_DONE", "DONE"]);
const puDelStatusSchema = z.enum(["ETA_TO_PU_DEL", "LOADED_SET_TO_DEL", "LATE", "DONE", "OTHER"]);

export const boardMutationSchema = z
  .discriminatedUnion("action", [
    z.object({
      action: z.literal("move"),
      date: z.string().regex(ISO_DAY),
      regionId: z.string().min(1).optional(),
      loadId: z.string().min(1),
      targetSectionId: z.string().min(1)
    }),
    z.object({
      action: z.literal("tonu"),
      date: z.string().regex(ISO_DAY),
      regionId: z.string().min(1).optional(),
      loadId: z.string().min(1),
      isTonu: z.boolean(),
      tonuAmount: z.string().optional()
    }),
    z.object({
      action: z.literal("status"),
      date: z.string().regex(ISO_DAY),
      regionId: z.string().min(1).optional(),
      loadId: z.string().min(1),
      status: z.enum(["BOOKED", "DISPATCHED", "PICKED_UP", "DELIVERED", "POD_RECEIVED", "COMPLETED", "CANCELED", "FAILED"]),
      // Recorded when advancing past open soft obligations (override-with-reason).
      overrideReason: z.string().trim().min(1).optional()
    }),
    z.object({
      action: z.literal("update-fields"),
      date: z.string().regex(ISO_DAY),
      regionId: z.string().min(1).optional(),
      loadId: z.string().min(1),
      fields: z
        .object({
          mgStatusTask: taskDoneSchema.optional(),
          tmwStatusTask: taskDoneSchema.optional(),
          scaleBeforeTask: taskDoneSchema.optional(),
          scaleAfterTask: taskDoneSchema.optional(),
          bolMatchTask: taskDoneSchema.optional(),
          pickupEtaAdvised: taskDoneSchema.optional(),
          pickupArrivalAdvised: taskDoneSchema.optional(),
          deliveryEtaAdvised: taskDoneSchema.optional(),
          deliveryArrivalAdvised: taskDoneSchema.optional(),
          // RESCHEDULED is set ONLY via the dedicated reschedule-delivery action (which
          // always sets a forward window in the same transaction); allowing it here would
          // permit a "RESCHEDULED with no window" inconsistent state.
          deliveryExceptionState: z.enum(["NONE", "WORK_IN_REQUESTED"]).optional(),
          rescheduleDriverConfirmed: taskDoneSchema.optional(),
          puStatusPreset: puDelStatusSchema.optional(),
          puStatusCustom: z.string().nullable().optional(),
          delStatusPreset: puDelStatusSchema.optional(),
          delStatusCustom: z.string().nullable().optional(),
          deliveryDate: z.string().regex(ISO_DAY).nullable().optional(),
          pickupDriverAssigned: z.string().nullable().optional(),
          deliveryDriver: z.string().nullable().optional(),
          commodity: z.string().nullable().optional(),
          equipmentNeeds: z.string().nullable().optional(),
          driverType: z.enum(["SHUTTLE", "PTP", "LTL"]).nullable().optional(),
          coordinatorNotes: z.string().nullable().optional(),
          attentionNote: z.string().nullable().optional(),
          attentionSeverity: z.enum(["INFO", "WARN", "URGENT"]).optional(),
          podStatus: z.string().nullable().optional(),
          shipperName: z.string().nullable().optional(),
          receiverName: z.string().nullable().optional(),
          pickupCity: z.string().nullable().optional(),
          pickupState: z.string().nullable().optional(),
          pickupWindow: z.string().nullable().optional(),
          deliveryCity: z.string().nullable().optional(),
          deliveryState: z.string().nullable().optional(),
          deliveryWindow: z.string().nullable().optional(),
          loadNumber: z.string().nullable().optional(),
          pickupNumber: z.string().nullable().optional(),
          pickupNumbers: z.array(z.string()).optional(),
          threePlRefNumber: z.string().nullable().optional(),
          tractorTrailer1: z.string().nullable().optional(),
          tractorTrailer2: z.string().nullable().optional(),
          equipmentType: z.enum(["BOX_TRUCK", "FLATBED_OR_STEPDECK", "VAN_48", "VAN_53", "OTHER"]).nullable().optional(),
          equipmentAccessory: z.enum(["STRAPS", "TARPS", "CHAINS", "BARS", "NONE", "OTHER"]).nullable().optional(),
          equipmentOtherText: z.string().nullable().optional(),
          brokerId: z.string().nullable().optional(),
          lumperFeeAmount: z.string().regex(DECIMAL_2).nullable().optional(),
          lineHaulRate: z.string().regex(DECIMAL_4).optional(),
          loadedMiles: z.string().regex(DECIMAL_4).optional(),
          puDeadheadMiles: z.string().regex(DECIMAL_4).optional(),
          delDeadheadMiles: z.string().regex(DECIMAL_4).optional(),
          fscApplies: z.boolean().optional()
        })
        .refine((value) => Object.keys(value).length > 0, {
          message: "At least one field is required."
        })
    }),
    z.object({
      action: z.literal("delete"),
      date: z.string().regex(ISO_DAY),
      regionId: z.string().min(1).optional(),
      loadId: z.string().min(1),
      reason: z.string().trim().min(1)
    }),
    z.object({
      action: z.literal("leg-upsert"),
      date: z.string().regex(ISO_DAY),
      regionId: z.string().min(1).optional(),
      loadId: z.string().min(1),
      leg: z.object({
        id: z.string().optional(),
        legIndex: z.coerce.number().int().min(0),
        legType: z.enum(["SHUTTLE", "PTP", "DELIVERY"]),
        driverName: z.string().nullable().optional(),
        startCity: z.string().nullable().optional(),
        startState: z.string().nullable().optional(),
        endCity: z.string().nullable().optional(),
        endState: z.string().nullable().optional(),
        // Mileage must be a real decimal — otherwise `new Prisma.Decimal(...)` throws a 500.
        legMiles: z.string().regex(DECIMAL_4).nullable().optional(),
        notes: z.string().nullable().optional(),
        etaAt: z.string().datetime().nullable().optional(),
        arrivalAt: z.string().datetime().nullable().optional(),
        trailer: z.string().nullable().optional(),
        trailerHookConfirmed: z.enum(["NOT_DONE", "DONE"]).optional()
      })
    }),
    z.object({
      action: z.literal("leg-delete"),
      date: z.string().regex(ISO_DAY),
      regionId: z.string().min(1).optional(),
      loadId: z.string().min(1),
      legId: z.string().min(1)
    }),
    z.object({
      action: z.literal("reschedule-delivery"),
      date: z.string().regex(ISO_DAY),
      regionId: z.string().min(1).optional(),
      loadId: z.string().min(1),
      // The NEW appointment day — distinct from `date` (the board-reload key).
      newDate: z.string().regex(ISO_DAY),
      windowStart: z.string().regex(HHMM),
      windowEnd: z.string().regex(HHMM),
      apptType: z.enum(["FIRM_APPT", "OPEN_WINDOW", "FCFS"])
    })
  ])
  .superRefine((val, ctx) => {
    // Cross-field checks (discriminatedUnion members can't carry .refine themselves).
    if (val.action === "reschedule-delivery" && val.windowEnd <= val.windowStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["windowEnd"],
        message: "windowEnd must be after windowStart."
      });
    }
    if (
      val.action === "leg-upsert" &&
      val.leg.etaAt &&
      val.leg.arrivalAt &&
      Date.parse(val.leg.arrivalAt) < Date.parse(val.leg.etaAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["leg", "arrivalAt"],
        message: "arrivalAt cannot be before etaAt."
      });
    }
  });
