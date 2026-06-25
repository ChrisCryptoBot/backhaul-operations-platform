export interface WorkerMetricEvent {
  metric: "queue_lag" | "retry_pressure" | "dead_letter_rate" | "parse_failure_class";
  value: number;
  tags?: Record<string, string>;
}

// Placeholder sink for now: emits structured logs consumable by external alerting.
export function emitWorkerMetric(event: WorkerMetricEvent): void {
  // eslint-disable-next-line no-console
  console.info("[worker-metric]", JSON.stringify(event));
}

