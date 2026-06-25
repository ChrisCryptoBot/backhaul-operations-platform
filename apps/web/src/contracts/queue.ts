import { z } from "zod";

export const queueEnvelopeVersion = "v1";

export const queueEventTypeSchema = z.enum(["PARSE_RATE_CON", "RECOMPUTE_WEEK_SNAPSHOT"]);

export const queueJobPayloadSchema = z.object({
  regionId: z.string().min(1),
  weekIso: z.string().regex(/^\d{4}-W\d{2}$/),
  entityId: z.string().min(1),
  eventType: queueEventTypeSchema
});

export type QueueJobPayload = z.infer<typeof queueJobPayloadSchema>;

export const parserFailureCodeSchema = z.enum(["invalid", "timeout", "schema", "low-confidence"]);
export type ParserFailureCode = z.infer<typeof parserFailureCodeSchema>;

export const parserExtractionSchema = z.object({
  pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Optional: present when the rate con states a delivery/appointment date.
  // The regex fallback parser does not produce it, so it must stay optional.
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // Optional structured appointment data. All optional so the regex fallback
  // parser and pre-appointment payloads still validate. Times are local HH:MM
  // (24h); the server localises them to the stop's timezone.
  pickupApptType: z.enum(["FIRM_APPT", "OPEN_WINDOW", "FCFS"]).optional(),
  pickupWindowStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  pickupWindowEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  deliveryApptType: z.enum(["FIRM_APPT", "OPEN_WINDOW", "FCFS"]).optional(),
  deliveryWindowStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  deliveryWindowEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  pickupNumber: z.string().min(1),
  lineHaulRate: z.string().regex(/^\d+(\.\d{1,2})?$/),
  loadedMiles: z.string().regex(/^\d+(\.\d{1,2})?$/),
  shipperName: z.string().min(1),
  receiverName: z.string().min(1),
  brokerName: z.string().min(1),
  loadNumber: z.string().min(1),
  originCityState: z.string().min(3),
  destinationCityState: z.string().min(3)
});

export const parserResultSchema = z.object({
  extractedPayload: parserExtractionSchema,
  confidence: z.number().min(0).max(1),
  parserVersion: z.string().min(1)
});

export type ParserResult = z.infer<typeof parserResultSchema>;

export const queueEnvelopeSchema = z.object({
  contractVersion: z.literal(queueEnvelopeVersion),
  payload: queueJobPayloadSchema
});

export type QueueEnvelope = z.infer<typeof queueEnvelopeSchema>;

