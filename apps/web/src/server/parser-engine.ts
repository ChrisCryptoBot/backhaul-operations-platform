import { Prisma } from "@prisma/client";
import { parserExtractionSchema, type ParserFailureCode, type ParserResult } from "@/contracts/queue";
import { getActiveLlmConfig } from "@/server/llm/config";
import { getProvider } from "@/server/llm/registry";

const parserVersion = "rc-parser-v2";

type Extraction = Record<string, string | null>;

function pick(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function normalizeIsoDate(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(trimmed)) {
    const [mm, dd, yyyy] = trimmed.split("/");
    return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}

function normalizeDecimal(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,4})?$/.test(cleaned)) {
    return null;
  }
  return new Prisma.Decimal(cleaned).toFixed(2);
}

function normalizeCode(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[^A-Za-z0-9-]/g, "").toUpperCase();
  return cleaned.length > 0 ? cleaned : null;
}

function extractWithLabels(text: string): Extraction {
  return {
    pickupDate: normalizeIsoDate(
      pick(
        /pickup date[:\s]+([0-9]{4}-[0-9]{2}-[0-9]{2})/i.exec(text)?.[1] ?? null,
        /pickup date[:\s]+([0-9]{2}\/[0-9]{2}\/[0-9]{4})/i.exec(text)?.[1] ?? null
      )
    ),
    pickupNumber: normalizeCode(/pickup(?: number| #| no\.?)[:\s]+([A-Za-z0-9-]+)/i.exec(text)?.[1] ?? null),
    lineHaulRate: normalizeDecimal(/line haul(?: rate)?[:\s$]+([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i.exec(text)?.[1] ?? null),
    loadedMiles: normalizeDecimal(/loaded miles?[:\s]+([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i.exec(text)?.[1] ?? null),
    shipperName: pick(/shipper[:\s]+([A-Za-z0-9 .,&'-]{3,})/i.exec(text)?.[1] ?? null),
    receiverName: pick(/receiver[:\s]+([A-Za-z0-9 .,&'-]{3,})/i.exec(text)?.[1] ?? null),
    brokerName: pick(/broker[:\s]+([A-Za-z0-9 .,&'-]{3,})/i.exec(text)?.[1] ?? null),
    loadNumber: normalizeCode(/load(?: number| #| no\.?)[:\s]+([A-Za-z0-9-]+)/i.exec(text)?.[1] ?? null),
    originCityState: pick(/origin[:\s]+([A-Za-z .'-]+,\s*[A-Z]{2})/i.exec(text)?.[1] ?? null),
    destinationCityState: pick(/destination[:\s]+([A-Za-z .'-]+,\s*[A-Z]{2})/i.exec(text)?.[1] ?? null)
  };
}

function extractFallback(text: string): Extraction {
  return {
    pickupDate: normalizeIsoDate(/\b(20\d{2}-\d{2}-\d{2})\b/.exec(text)?.[1] ?? null),
    pickupNumber: normalizeCode(/\b(PU[-\s]?\d{2,})\b/i.exec(text)?.[1] ?? null),
    lineHaulRate: normalizeDecimal(/\$?(\d{3,6}(?:\.\d{1,2})?)/.exec(text)?.[1] ?? null),
    loadedMiles: normalizeDecimal(/\b(\d{2,4}(?:\.\d{1,2})?)\s*(?:mi|miles)\b/i.exec(text)?.[1] ?? null),
    shipperName: pick(/shipper[:\s]+([A-Za-z0-9 .,&'-]{3,})/i.exec(text)?.[1] ?? "Parsed Shipper"),
    receiverName: pick(/receiver[:\s]+([A-Za-z0-9 .,&'-]{3,})/i.exec(text)?.[1] ?? "Parsed Receiver"),
    brokerName: pick(/broker[:\s]+([A-Za-z0-9 .,&'-]{3,})/i.exec(text)?.[1] ?? "Parsed Broker"),
    loadNumber: normalizeCode(/\b(LD[-\s]?\d{2,})\b/i.exec(text)?.[1] ?? null),
    originCityState: pick(/from[:\s]+([A-Za-z .'-]+,\s*[A-Z]{2})/i.exec(text)?.[1] ?? "Unknown, PA"),
    destinationCityState: pick(/to[:\s]+([A-Za-z .'-]+,\s*[A-Z]{2})/i.exec(text)?.[1] ?? "Unknown, PA")
  };
}

function mergeExtraction(primary: Extraction, fallback: Extraction): Record<string, string> {
  return {
    pickupDate: pick(primary.pickupDate, fallback.pickupDate, new Date().toISOString().slice(0, 10))!,
    pickupNumber: pick(primary.pickupNumber, fallback.pickupNumber, "PU-AUTO-001")!,
    lineHaulRate: pick(primary.lineHaulRate, fallback.lineHaulRate, "1000.00")!,
    loadedMiles: pick(primary.loadedMiles, fallback.loadedMiles, "200.00")!,
    shipperName: pick(primary.shipperName, fallback.shipperName, "Parsed Shipper")!,
    receiverName: pick(primary.receiverName, fallback.receiverName, "Parsed Receiver")!,
    brokerName: pick(primary.brokerName, fallback.brokerName, "Parsed Broker")!,
    loadNumber: pick(primary.loadNumber, fallback.loadNumber, "LD-AUTO-001")!,
    originCityState: pick(primary.originCityState, fallback.originCityState, "Unknown, PA")!,
    destinationCityState: pick(primary.destinationCityState, fallback.destinationCityState, "Unknown, PA")!
  };
}

function computeConfidence(extracted: Record<string, string>): number {
  const values = Object.values(extracted);
  const nonFallbackCount = values.filter(
    (value) => !value.startsWith("Parsed ") && !value.startsWith("Unknown,") && !value.includes("AUTO")
  ).length;
  const confidence = 0.5 + (nonFallbackCount / values.length) * 0.5;
  const rounded = new Prisma.Decimal(confidence).toDecimalPlaces(4).toNumber();
  return Math.max(0, Math.min(1, rounded));
}

export function parseRateConfirmationText(
  text: string
): { ok: true; result: ParserResult } | { ok: false; code: ParserFailureCode; confidence: number } {
  if (text.trim().length < 20) {
    return { ok: false, code: "invalid", confidence: 0 };
  }
  try {
    const strict = extractWithLabels(text);
    const fallback = extractFallback(text);
    const merged = mergeExtraction(strict, fallback);
    const validation = parserExtractionSchema.safeParse(merged);
    if (!validation.success) {
      return { ok: false, code: "schema", confidence: 0.2 };
    }
    const confidence = computeConfidence(validation.data);
    if (confidence < 0.75) {
      return { ok: false, code: "low-confidence", confidence };
    }
    return {
      ok: true,
      result: {
        extractedPayload: validation.data,
        confidence,
        parserVersion
      }
    };
  } catch {
    return { ok: false, code: "schema", confidence: 0.15 };
  }
}

/**
 * Primary entry point for parsing a rate-confirmation PDF buffer.
 *
 * When an LLM provider is configured (via Settings or the env bootstrap), the
 * PDF is sent to that provider for structured extraction. If no provider is
 * configured, the provider is unknown, or the LLM call fails/returns an
 * unusable result, we fall back to the legacy regex parser over the document's
 * text so ingestion keeps working. The return shape is identical in all cases.
 */
export async function parseRateConfirmation(
  buffer: Buffer
): Promise<{ ok: true; result: ParserResult } | { ok: false; code: ParserFailureCode; confidence: number }> {
  try {
    const config = await getActiveLlmConfig();
    if (config) {
      const provider = getProvider(config.provider);
      const llmResult = await provider.extractRateConfirmation(buffer, {
        apiKey: config.apiKey,
        model: config.model
      });
      if (llmResult.ok) {
        return llmResult;
      }
      // LLM produced a non-ok result (schema/low-confidence/etc.). Try the
      // regex parser as a second chance before surfacing a failure.
    }
  } catch {
    // No config, unknown provider, or provider threw — fall through to regex.
  }

  return parseRateConfirmationText(buffer.toString("utf8"));
}
