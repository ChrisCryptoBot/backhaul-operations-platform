import { describe, expect, test } from "vitest";
import { evaluateWorkerReliabilityGate } from "@/server/worker-reliability-gates";

describe("worker reliability release gate", () => {
  test("passes when all metrics are within thresholds", () => {
    const result = evaluateWorkerReliabilityGate(
      {
        queueLagSeconds: 10,
        retryPressure: 0.2,
        deadLetterRate: 0.001,
        parseFailureRate: 0.01
      },
      {
        maxQueueLagSeconds: 30,
        maxRetryPressure: 0.5,
        maxDeadLetterRate: 0.01,
        maxParseFailureRate: 0.05
      }
    );
    expect(result.pass).toBe(true);
  });

  test("fails when one or more metrics exceed thresholds", () => {
    const result = evaluateWorkerReliabilityGate(
      {
        queueLagSeconds: 60,
        retryPressure: 0.9,
        deadLetterRate: 0.02,
        parseFailureRate: 0.2
      },
      {
        maxQueueLagSeconds: 30,
        maxRetryPressure: 0.5,
        maxDeadLetterRate: 0.01,
        maxParseFailureRate: 0.05
      }
    );
    expect(result.pass).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});

