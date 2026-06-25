import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { getEnv } from "@/lib/env";
import { processQueueEnvelope } from "@/server/queue-consumer";
import { emitWorkerMetric } from "@/server/worker-metrics";

/**
 * Pulls jobs off the SQS queues and runs them through `processQueueEnvelope` (the same
 * consumer used by the synchronous /consume route). Successfully processed messages are
 * deleted; failures are left on the queue for SQS to redeliver / route to a DLQ. Intended
 * to be driven by a scheduled trigger (Vercel Cron) since nothing consumes SQS in prod.
 */

export interface DrainQueueStat {
  queueUrl: string;
  received: number;
  processed: number;
  failed: number;
}

export interface DrainResult {
  processed: number;
  failed: number;
  deleted: number;
  byQueue: DrainQueueStat[];
}

export interface DrainOptions {
  /** Override the SQS client (tests inject a fake). */
  client?: Pick<SQSClient, "send">;
  /** Queues to drain; defaults to the parse + recompute queues from env. */
  queueUrls?: string[];
  /** Upper bound on messages pulled per queue per invocation. */
  maxMessagesPerQueue?: number;
  /** Envelope processor; defaults to the real consumer. */
  process?: (raw: unknown) => Promise<void>;
}

export async function drainQueues(options: DrainOptions = {}): Promise<DrainResult> {
  const client = options.client ?? new SQSClient({ region: getEnv().AWS_REGION });
  const queueUrls =
    options.queueUrls ?? (() => {
      const env = getEnv();
      return [env.SQS_PARSE_QUEUE_URL, env.SQS_RECOMPUTE_QUEUE_URL].filter((u): u is string => Boolean(u));
    })();
  if (queueUrls.length === 0) {
    // No SQS configured (local dev) — nothing to drain.
    return { processed: 0, failed: 0, deleted: 0, byQueue: [] };
  }
  const maxMessages = options.maxMessagesPerQueue ?? 50;
  const processEnvelope = options.process ?? processQueueEnvelope;

  const result: DrainResult = { processed: 0, failed: 0, deleted: 0, byQueue: [] };

  for (const queueUrl of queueUrls) {
    const stat: DrainQueueStat = { queueUrl, received: 0, processed: 0, failed: 0 };

    while (stat.received < maxMessages) {
      const batchSize = Math.min(10, maxMessages - stat.received);
      const response = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: batchSize,
          WaitTimeSeconds: 1,
          VisibilityTimeout: 60
        })
      );
      const messages = response.Messages ?? [];
      if (messages.length === 0) {
        break;
      }

      for (const message of messages) {
        stat.received += 1;
        try {
          const raw = message.Body ? JSON.parse(message.Body) : null;
          await processEnvelope(raw);
          await client.send(
            new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle })
          );
          stat.processed += 1;
          result.processed += 1;
          result.deleted += 1;
        } catch {
          // Leave the message for SQS redelivery / DLQ; record and continue.
          stat.failed += 1;
          result.failed += 1;
        }
      }

      // A short batch means the queue is drained for now.
      if (messages.length < batchSize) {
        break;
      }
    }

    emitWorkerMetric({
      metric: "queue_lag",
      value: stat.failed,
      tags: { eventType: "drain", queueUrl }
    });
    result.byQueue.push(stat);
  }

  return result;
}
