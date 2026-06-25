import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { getEnv } from "@/lib/env";
import { queueEnvelopeSchema, queueEnvelopeVersion, type QueueJobPayload } from "@/contracts/queue";
import { emitWorkerMetric } from "@/server/worker-metrics";

function getSqsClient() {
  const { AWS_REGION } = getEnv();
  return new SQSClient({ region: AWS_REGION });
}

export async function enqueueJob(queueUrl: string | undefined, payload: QueueJobPayload): Promise<void> {
  if (!queueUrl) {
    throw new Error("Cannot enqueue job: SQS queue URL is not configured.");
  }
  const envelope = queueEnvelopeSchema.parse({
    contractVersion: queueEnvelopeVersion,
    payload
  });
  emitWorkerMetric({
    metric: "queue_lag",
    value: 0,
    tags: { eventType: payload.eventType, queueUrl }
  });
  const sqs = getSqsClient();
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(envelope)
    })
  );
}
