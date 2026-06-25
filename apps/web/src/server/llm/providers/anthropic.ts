import Anthropic from "@anthropic-ai/sdk";
import { parserExtractionSchema } from "@/contracts/queue";
import type { LlmExtractionResult, LlmExtractOptions, LlmProvider } from "@/server/llm/types";

const PARSER_VERSION = "rc-llm-anthropic-v1";
const LOW_CONFIDENCE_THRESHOLD = 0.75;
const TOOL_NAME = "record_rate_confirmation";

/**
 * Tool input schema mirroring `parserExtractionSchema` (src/contracts/queue.ts).
 * Forcing this single tool gives us reliable, schema-shaped extraction without
 * depending on the newest structured-output API surface, so it works across
 * SDK/model versions (Haiku 4.5 included).
 */
const TOOL_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    pickupDate: { type: "string", description: "Pickup date in YYYY-MM-DD format." },
    deliveryDate: {
      type: "string",
      description: "Delivery / delivery-appointment date in YYYY-MM-DD format, if stated. Omit if not present."
    },
    pickupNumber: { type: "string", description: "Pickup / PU number." },
    lineHaulRate: { type: "string", description: "Line haul rate as a decimal number, no currency symbol (e.g. 1450.00)." },
    loadedMiles: { type: "string", description: "Loaded miles as a decimal number (e.g. 312.00)." },
    shipperName: { type: "string", description: "Shipper / origin facility name." },
    receiverName: { type: "string", description: "Receiver / destination facility name." },
    brokerName: { type: "string", description: "Broker / customer name." },
    loadNumber: { type: "string", description: "Load number / reference." },
    originCityState: { type: "string", description: "Origin as 'City, ST' (two-letter state)." },
    destinationCityState: { type: "string", description: "Destination as 'City, ST' (two-letter state)." },
    pickupApptType: {
      type: "string",
      enum: ["FIRM_APPT", "OPEN_WINDOW", "FCFS"],
      description:
        "Pickup appointment type: FIRM_APPT (a fixed appointment time), OPEN_WINDOW (a time window/block), or FCFS (first come first served / live). Omit if unclear."
    },
    pickupWindowStart: { type: "string", description: "Pickup window/appointment START time as local HH:MM (24h), e.g. 06:00. Omit if not stated." },
    pickupWindowEnd: { type: "string", description: "Pickup window END time as local HH:MM (24h), e.g. 14:00. For a firm single time, set equal to the start. Omit if not stated." },
    deliveryApptType: {
      type: "string",
      enum: ["FIRM_APPT", "OPEN_WINDOW", "FCFS"],
      description: "Delivery appointment type (same meanings as pickupApptType). Delivery is often FIRM_APPT. Omit if unclear."
    },
    deliveryWindowStart: { type: "string", description: "Delivery window/appointment START time as local HH:MM (24h), e.g. 00:01. Omit if not stated." },
    deliveryWindowEnd: { type: "string", description: "Delivery window END time as local HH:MM (24h), e.g. 09:30. For a firm single time, set equal to the start. Omit if not stated." },
    confidence: {
      type: "number",
      description: "Your confidence from 0 to 1 that every field above was read correctly from the document."
    }
  },
  required: [
    "pickupDate",
    "pickupNumber",
    "lineHaulRate",
    "loadedMiles",
    "shipperName",
    "receiverName",
    "brokerName",
    "loadNumber",
    "originCityState",
    "destinationCityState",
    "confidence"
  ],
  additionalProperties: false
};

const SYSTEM_PROMPT =
  "You extract structured fields from freight broker rate confirmation PDFs. " +
  "Read the document carefully and call the record_rate_confirmation tool with the exact values found. " +
  "Normalize the pickup date to YYYY-MM-DD and strip currency symbols and commas from numeric fields. " +
  "Capture pickup and delivery appointment windows as local HH:MM (24h) times plus their type " +
  "(FIRM_APPT / OPEN_WINDOW / FCFS) when the document states them; omit any you cannot read. " +
  "If a field is genuinely not present, make your best inference and lower your confidence accordingly.";

function clampConfidence(value: unknown): number {
  // The tool schema declares `confidence` as a number, so we only trust numeric
  // inputs; anything else is treated as zero confidence.
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

export const anthropicProvider: LlmProvider = {
  name: "anthropic",

  async extractRateConfirmation(pdf: Buffer, opts: LlmExtractOptions): Promise<LlmExtractionResult> {
    const client = new Anthropic({ apiKey: opts.apiKey });

    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: opts.model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: [
          {
            name: TOOL_NAME,
            description: "Record the fields extracted from the rate confirmation document.",
            input_schema: TOOL_INPUT_SCHEMA
          }
        ],
        tool_choice: { type: "tool", name: TOOL_NAME },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: pdf.toString("base64")
                }
              },
              { type: "text", text: "Extract the rate confirmation fields from this document." }
            ]
          }
        ]
      });
    } catch (error) {
      const code = error instanceof Anthropic.APIError && error.status === 408 ? "timeout" : "invalid";
      return { ok: false, code, confidence: 0 };
    }

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === TOOL_NAME
    );
    if (!toolUse) {
      return { ok: false, code: "schema", confidence: 0 };
    }

    const raw = toolUse.input as Record<string, unknown>;
    const reportedConfidence = clampConfidence(raw.confidence);

    const validation = parserExtractionSchema.safeParse(raw);
    if (!validation.success) {
      return { ok: false, code: "schema", confidence: Math.min(reportedConfidence, 0.5) };
    }

    if (reportedConfidence < LOW_CONFIDENCE_THRESHOLD) {
      return { ok: false, code: "low-confidence", confidence: reportedConfidence };
    }

    return {
      ok: true,
      result: {
        extractedPayload: validation.data,
        confidence: reportedConfidence,
        parserVersion: PARSER_VERSION
      }
    };
  }
};
