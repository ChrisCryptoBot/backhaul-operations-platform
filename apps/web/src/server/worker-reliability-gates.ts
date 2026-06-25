export interface WorkerReliabilitySnapshot {
  queueLagSeconds: number;
  retryPressure: number;
  deadLetterRate: number;
  parseFailureRate: number;
}

export interface WorkerReliabilityThresholds {
  maxQueueLagSeconds: number;
  maxRetryPressure: number;
  maxDeadLetterRate: number;
  maxParseFailureRate: number;
}

export function evaluateWorkerReliabilityGate(
  snapshot: WorkerReliabilitySnapshot,
  thresholds: WorkerReliabilityThresholds
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (snapshot.queueLagSeconds > thresholds.maxQueueLagSeconds) reasons.push("queue lag above threshold");
  if (snapshot.retryPressure > thresholds.maxRetryPressure) reasons.push("retry pressure above threshold");
  if (snapshot.deadLetterRate > thresholds.maxDeadLetterRate) reasons.push("dead-letter rate above threshold");
  if (snapshot.parseFailureRate > thresholds.maxParseFailureRate) reasons.push("parse failure rate above threshold");
  return { pass: reasons.length === 0, reasons };
}

