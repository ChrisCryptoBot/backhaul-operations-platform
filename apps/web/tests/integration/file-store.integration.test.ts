import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { checkAttachment } from "@/lib/attachments";
import { prisma } from "@/lib/db";
import { SHOWCASE_WORKSPACE_ID } from "@/lib/showcase";
import { wipeShowcase } from "@/server/partners/showcase";
import { addLoadDocument, removeLoadDocument } from "@/server/tl/documents";
import { readFile, setFileStoreForTest, type FileStore } from "@/server/tl/message-files";
import { purgeWorkspaceFiles } from "@/server/tl/storage";

/**
 * Phase 4 durable file store integration proof:
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_gate RUN_DB_INTEGRATION=true npx vitest run tests/integration/file-store.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "fs-w";
const VALID_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

describe.skipIf(!run)("durable file store integration", () => {
  const objects = new Map<string, { data: Buffer; mime: string }>();
  const fakeRemote: FileStore = {
    async put(key, data, mime, opts) {
      if (!opts?.upsert && objects.has(key)) throw new Error("already exists");
      objects.set(key, { data: Buffer.from(data), mime });
    },
    async get(key) {
      return objects.get(key)?.data ?? null;
    },
    async remove(keys) {
      for (const k of keys) objects.delete(k);
    }
  };

  let emptyUploadDir = "";
  let loadId = "";
  let showcaseLoadId = "";
  const savedUploadDir = process.env.DESK_UPLOAD_DIR;

  async function wipeTestWs(workspaceId: string) {
    await prisma.auditEvent.deleteMany({ where: { workspaceId } });
    await prisma.assignment.deleteMany({ where: { load: { workspaceId } } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  }

  beforeAll(async () => {
    emptyUploadDir = mkdtempSync(path.join(tmpdir(), "tl-fs-int-"));
    process.env.DESK_UPLOAD_DIR = emptyUploadDir;
    await wipeTestWs(W);
    await wipeShowcase();

    await prisma.workspace.create({ data: { id: W, name: "File Store Test Fleet", plan: "growth" } });
    const load = await prisma.load.create({
      data: {
        workspaceId: W,
        loadNumber: "FS-1001",
        status: "delivered",
        brokerName: "Test Broker",
        originAddress: "Dallas, TX",
        destinationAddress: "Tulsa, OK",
        quotedRevenue: 1200,
        loadedMiles: 266,
        stops: {
          create: [
            { stopSequence: 1, stopType: "pickup", addressString: "Dallas, TX" },
            { stopSequence: 2, stopType: "delivery", addressString: "Tulsa, OK" }
          ]
        }
      }
    });
    loadId = load.id;
  });

  afterEach(() => {
    setFileStoreForTest(null);
    objects.clear();
  });

  afterAll(async () => {
    setFileStoreForTest(null);
    if (savedUploadDir === undefined) delete process.env.DESK_UPLOAD_DIR;
    else process.env.DESK_UPLOAD_DIR = savedUploadDir;
    if (emptyUploadDir) rmSync(emptyUploadDir, { recursive: true, force: true });
    await wipeTestWs(W);
    await wipeShowcase();
  });

  test("POD upload goes to configured store, reads with empty local disk, and removeLoadDocument deletes stored object", async () => {
    setFileStoreForTest(fakeRemote);
    const checked = checkAttachment("pod-delivery.png", "image/png", VALID_PNG);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;

    const added = await addLoadDocument(loadId, "pod", checked, new Date(), W, "Dispatcher");
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const row = await prisma.loadDocument.findUniqueOrThrow({ where: { id: added.id }, select: { storageKey: true } });
    expect(objects.has(row.storageKey)).toBe(true);

    // Removing the local upload directory does not affect reading from the configured durable store.
    rmSync(emptyUploadDir, { recursive: true, force: true });
    const readBack = await readFile(row.storageKey);
    expect(readBack?.equals(Buffer.from(checked.data))).toBe(true);

    const removed = await removeLoadDocument(added.id, new Date(), W);
    expect(removed).toEqual({ ok: true, id: added.id });
    expect(objects.has(row.storageKey)).toBe(false);
    expect(await readFile(row.storageKey)).toBeNull();
  });

  test("permanent purge removes stored objects before/when wiping workspace records", async () => {
    setFileStoreForTest(fakeRemote);
    const checked = checkAttachment("rate-con.png", "image/png", VALID_PNG);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;

    const doc1 = await addLoadDocument(loadId, "rate_con", checked, new Date(), W, "Dispatcher");
    expect(doc1.ok).toBe(true);
    if (!doc1.ok) return;
    const key1 = (await prisma.loadDocument.findUniqueOrThrow({ where: { id: doc1.id }, select: { storageKey: true } })).storageKey;
    expect(objects.has(key1)).toBe(true);

    const removedCount = await purgeWorkspaceFiles(W);
    expect(removedCount).toBe(1);
    expect(objects.has(key1)).toBe(false);

    // Also verify showcase permanent wipe removes stored objects attached to the showcase workspace.
    await prisma.workspace.create({ data: { id: SHOWCASE_WORKSPACE_ID, name: "Showcase", plan: "pro" } });
    const sLoad = await prisma.load.create({
      data: {
        workspaceId: SHOWCASE_WORKSPACE_ID,
        loadNumber: "SHOW-FS-1",
        status: "delivered",
        brokerName: "Showcase Broker",
        originAddress: "Dallas, TX",
        destinationAddress: "Tulsa, OK",
        quotedRevenue: 1000,
        loadedMiles: 250
      }
    });
    showcaseLoadId = sLoad.id;
    const sDoc = await addLoadDocument(showcaseLoadId, "pod", checked, new Date(), SHOWCASE_WORKSPACE_ID, "Showcase");
    expect(sDoc.ok).toBe(true);
    if (!sDoc.ok) return;
    const sKey = (await prisma.loadDocument.findUniqueOrThrow({ where: { id: sDoc.id }, select: { storageKey: true } })).storageKey;
    expect(objects.has(sKey)).toBe(true);

    await wipeShowcase();
    expect(objects.has(sKey)).toBe(false);
    expect(await prisma.workspace.count({ where: { id: SHOWCASE_WORKSPACE_ID } })).toBe(0);
  });
});
