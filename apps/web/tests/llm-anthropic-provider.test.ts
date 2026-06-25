import { beforeEach, describe, expect, test, vi } from "vitest";

const createMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {
    status?: number;
    constructor(status?: number) {
      super("api error");
      this.status = status;
    }
  }
  class Anthropic {
    messages = { create: createMock };
    static APIError = APIError;
    constructor(_opts: unknown) {
      void _opts;
    }
  }
  return { default: Anthropic };
});

import Anthropic from "@anthropic-ai/sdk";
import { anthropicProvider } from "@/server/llm/providers/anthropic";

const PDF = Buffer.from("%PDF-1.4 fake");
const OPTS = { apiKey: "test-key", model: "claude-haiku-4-5" };

const VALID_FIELDS = {
  pickupDate: "2026-06-18",
  pickupNumber: "PU-001",
  lineHaulRate: "1450.00",
  loadedMiles: "312.00",
  shipperName: "Acme Shipper",
  receiverName: "Northbridge DC",
  brokerName: "Best Broker",
  loadNumber: "LD-9001",
  originCityState: "Carlisle, PA",
  destinationCityState: "Newark, NJ"
};

function toolUseMessage(input: Record<string, unknown>) {
  return { content: [{ type: "tool_use", name: "record_rate_confirmation", input }] };
}

describe("anthropic provider", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  test("returns ok with the extracted payload on a confident tool call", async () => {
    createMock.mockResolvedValue(toolUseMessage({ ...VALID_FIELDS, confidence: 0.95 }));
    const result = await anthropicProvider.extractRateConfirmation(PDF, OPTS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.parserVersion).toBe("rc-llm-anthropic-v1");
      expect(result.result.confidence).toBe(0.95);
      expect(result.result.extractedPayload).toMatchObject(VALID_FIELDS);
    }
  });

  test("sends the PDF as a base64 document block", async () => {
    createMock.mockResolvedValue(toolUseMessage({ ...VALID_FIELDS, confidence: 0.9 }));
    await anthropicProvider.extractRateConfirmation(PDF, OPTS);
    const request = createMock.mock.calls[0][0];
    expect(request.model).toBe("claude-haiku-4-5");
    expect(request.tool_choice).toEqual({ type: "tool", name: "record_rate_confirmation" });
    const doc = request.messages[0].content.find((block: { type: string }) => block.type === "document");
    expect(doc.source).toMatchObject({ type: "base64", media_type: "application/pdf" });
    expect(doc.source.data).toBe(PDF.toString("base64"));
  });

  test("fails with low-confidence when the model is unsure", async () => {
    createMock.mockResolvedValue(toolUseMessage({ ...VALID_FIELDS, confidence: 0.4 }));
    const result = await anthropicProvider.extractRateConfirmation(PDF, OPTS);
    expect(result).toEqual({ ok: false, code: "low-confidence", confidence: 0.4 });
  });

  test("fails with schema when fields are invalid", async () => {
    createMock.mockResolvedValue(toolUseMessage({ ...VALID_FIELDS, pickupDate: "not-a-date", confidence: 0.9 }));
    const result = await anthropicProvider.extractRateConfirmation(PDF, OPTS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("schema");
  });

  test("fails with schema when no tool_use block is returned", async () => {
    createMock.mockResolvedValue({ content: [{ type: "text", text: "I cannot read this." }] });
    const result = await anthropicProvider.extractRateConfirmation(PDF, OPTS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("schema");
  });

  test("maps a 408 API error to a timeout failure", async () => {
    createMock.mockRejectedValue(new (Anthropic as unknown as { APIError: new (s: number) => Error }).APIError(408));
    const result = await anthropicProvider.extractRateConfirmation(PDF, OPTS);
    expect(result).toEqual({ ok: false, code: "timeout", confidence: 0 });
  });
});
