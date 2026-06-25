import { DeleteMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { drainQueues } from "@/server/queue-drain";

interface FakeMessage {
  Body: string;
  ReceiptHandle: string;
}

function makeFakeClient(messagesByQueue: Record<string, FakeMessage[]>) {
  const deleted: string[] = [];
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof ReceiveMessageCommand) {
      const url = command.input.QueueUrl ?? "";
      const queue = messagesByQueue[url] ?? [];
      const batch = queue.splice(0, command.input.MaxNumberOfMessages ?? 10);
      return { Messages: batch };
    }
    if (command instanceof DeleteMessageCommand) {
      deleted.push(command.input.ReceiptHandle ?? "");
      return {};
    }
    return {};
  });
  return { client: { send }, deleted, send };
}

function envelope(receipt: string): FakeMessage {
  return {
    ReceiptHandle: receipt,
    Body: JSON.stringify({
      contractVersion: "v1",
      payload: { eventType: "RECOMPUTE_WEEK_SNAPSHOT", regionId: "region-1", weekIso: "2026-W25" }
    })
  };
}

describe("drainQueues", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("processes and deletes each message that succeeds", async () => {
    const { client, deleted } = makeFakeClient({
      "parse-queue": [envelope("r1"), envelope("r2")]
    });
    const process = vi.fn(async () => undefined);

    const result = await drainQueues({
      client: client as never,
      queueUrls: ["parse-queue"],
      process
    });

    expect(process).toHaveBeenCalledTimes(2);
    expect(result.processed).toBe(2);
    expect(result.deleted).toBe(2);
    expect(result.failed).toBe(0);
    expect(deleted).toEqual(["r1", "r2"]);
  });

  test("leaves failed messages on the queue (no delete) and counts them", async () => {
    const { client, deleted } = makeFakeClient({
      "parse-queue": [envelope("ok"), envelope("boom")]
    });
    // First message succeeds, second throws — only the first should be deleted.
    const process = vi
      .fn<(raw: unknown) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("parse failed"));

    const result = await drainQueues({
      client: client as never,
      queueUrls: ["parse-queue"],
      process
    });

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.deleted).toBe(1);
    // Only the successful message was deleted.
    expect(deleted).toEqual(["ok"]);
  });

  test("drains multiple queues and reports per-queue stats", async () => {
    const { client } = makeFakeClient({
      "parse-queue": [envelope("p1")],
      "recompute-queue": [envelope("r1"), envelope("r2")]
    });

    const result = await drainQueues({
      client: client as never,
      queueUrls: ["parse-queue", "recompute-queue"],
      process: vi.fn(async () => undefined)
    });

    expect(result.processed).toBe(3);
    expect(result.byQueue).toEqual([
      { queueUrl: "parse-queue", received: 1, processed: 1, failed: 0 },
      { queueUrl: "recompute-queue", received: 2, processed: 2, failed: 0 }
    ]);
  });

  test("stops when a queue is empty", async () => {
    const { client, send } = makeFakeClient({ "parse-queue": [] });
    const result = await drainQueues({
      client: client as never,
      queueUrls: ["parse-queue"],
      process: vi.fn(async () => undefined)
    });
    expect(result.processed).toBe(0);
    // One receive call that returns empty, then it stops.
    expect(send).toHaveBeenCalledTimes(1);
  });
});
