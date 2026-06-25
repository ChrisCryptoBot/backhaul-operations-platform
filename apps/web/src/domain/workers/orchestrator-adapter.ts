import { enqueueJob } from "@/server/queue";
import type { QueueJobPayload } from "@/contracts/queue";

export interface WorkerOrchestratorAdapter {
  enqueue(queueUrl: string | undefined, payload: QueueJobPayload): Promise<void>;
}

class DefaultWorkerOrchestratorAdapter implements WorkerOrchestratorAdapter {
  async enqueue(queueUrl: string | undefined, payload: QueueJobPayload): Promise<void> {
    // No queue URL means SQS isn't configured (local dev). Jobs are processed
    // inline by the caller (e.g. finalizeUpload's inlineProcessParse) instead of
    // being queued, so this is a logged no-op rather than a crash.
    if (!queueUrl) {
      // eslint-disable-next-line no-console
      console.info(`[orchestrator] SQS not configured — skipping enqueue of ${payload.eventType}`);
      return;
    }
    await enqueueJob(queueUrl, payload);
  }
}

export const workerOrchestratorAdapter: WorkerOrchestratorAdapter = new DefaultWorkerOrchestratorAdapter();
