import { describe, expect, test } from "vitest";
import { z } from "zod";

interface ParseBaseline {
  id: string;
  expected: Record<string, string>;
}

const criticalFields = [
  "pickupDate",
  "pickupNumber",
  "lineHaulRate",
  "loadedMiles",
  "shipperName",
  "receiverName",
  "originCityState",
  "destinationCityState",
  "brokerName",
  "loadNumber"
];

const expectedSchema = z.object({
  pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  pickupNumber: z.string().min(1),
  lineHaulRate: z.string().regex(/^\d+(\.\d{1,2})?$/),
  loadedMiles: z.string().regex(/^\d+(\.\d{1,2})?$/),
  shipperName: z.string().min(1),
  receiverName: z.string().min(1),
  originCityState: z.string().min(3),
  destinationCityState: z.string().min(3),
  brokerName: z.string().min(1),
  loadNumber: z.string().min(1)
});

function validateHarnessDataset(dataset: ParseBaseline[]): boolean {
  if (dataset.length < 50) {
    return false;
  }
  return dataset.every((row) => {
    if (!criticalFields.every((field) => typeof row.expected[field] === "string")) {
      return false;
    }
    return expectedSchema.safeParse(row.expected).success;
  });
}

describe("parser accuracy harness", () => {
  test("fails when dataset is under the required baseline size", () => {
    const seededDataset: ParseBaseline[] = [];
    expect(validateHarnessDataset(seededDataset)).toBe(false);
  });

  test("accepts dataset with required critical fields", () => {
    const sample = {
      id: "row",
      expected: {
        pickupDate: "2026-04-28",
        pickupNumber: "PU123",
        lineHaulRate: "1500.00",
        loadedMiles: "300.00",
        shipperName: "Northbridge",
        receiverName: "DC",
        originCityState: "Carlisle, PA",
        destinationCityState: "Westbrook, PA",
        brokerName: "Echo",
        loadNumber: "LD1"
      }
    };
    const dataset = Array.from({ length: 50 }, (_, idx) => ({
      ...sample,
      id: `row-${idx}`
    }));
    expect(validateHarnessDataset(dataset)).toBe(true);
  });
});
