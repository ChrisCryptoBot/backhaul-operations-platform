import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkAttachment } from "@/lib/attachments";
import {
  diskFileStore,
  fileStoreConfig,
  readFile,
  removeFiles,
  setFileStoreForTest,
  storeFile,
  supabaseFileStore,
  type FileStore
} from "@/server/tl/message-files";

const VALID_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function memoryStore(): { store: FileStore; map: Map<string, { data: Buffer; mime: string }> } {
  const map = new Map<string, { data: Buffer; mime: string }>();
  const store: FileStore = {
    async put(key, data, mime, opts) {
      if (!opts?.upsert && map.has(key)) throw new Error("already exists");
      map.set(key, { data: Buffer.from(data), mime });
    },
    async get(key) {
      return map.get(key)?.data ?? null;
    },
    async remove(keys) {
      for (const k of keys) map.delete(k);
    }
  };
  return { store, map };
}

describe("fileStoreConfig", () => {
  it("defaults to disk when DESK_FILE_STORE is unset or empty", () => {
    expect(fileStoreConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toMatchObject({ mode: "disk" });
    expect(fileStoreConfig({ NODE_ENV: "test", DESK_FILE_STORE: "  " } as unknown as NodeJS.ProcessEnv)).toMatchObject({ mode: "disk" });
    expect(fileStoreConfig({ NODE_ENV: "test", DESK_FILE_STORE: "DISK" } as unknown as NodeJS.ProcessEnv)).toMatchObject({ mode: "disk" });
  });

  it("rejects unknown DESK_FILE_STORE values", () => {
    expect(() => fileStoreConfig({ NODE_ENV: "test", DESK_FILE_STORE: "cloud" } as unknown as NodeJS.ProcessEnv)).toThrow(/disk.*supabase/i);
  });

  it("requires dedicated DESK_FILES_SUPABASE_* env vars and never falls back to BRIDGE_SUPABASE_*", () => {
    expect(() =>
      fileStoreConfig({
        NODE_ENV: "test",
        DESK_FILE_STORE: "supabase",
        BRIDGE_SUPABASE_URL: "https://bridge-only.supabase.co",
        BRIDGE_SUPABASE_SERVICE_KEY: "bridge-secret"
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/DESK_FILES_SUPABASE_URL/);

    expect(() =>
      fileStoreConfig({
        NODE_ENV: "test",
        DESK_FILE_STORE: "supabase",
        DESK_FILES_SUPABASE_URL: "https://files.supabase.co",
        BRIDGE_SUPABASE_SERVICE_KEY: "bridge-secret"
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/DESK_FILES_SUPABASE_SERVICE_KEY/);
  });

  it("validates https URL and bucket name, defaulting bucket to desk-files", () => {
    expect(() =>
      fileStoreConfig({
        NODE_ENV: "test",
        DESK_FILE_STORE: "supabase",
        DESK_FILES_SUPABASE_URL: "http://insecure.supabase.co",
        DESK_FILES_SUPABASE_SERVICE_KEY: "secret-key"
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/https/);

    expect(() =>
      fileStoreConfig({
        NODE_ENV: "test",
        DESK_FILE_STORE: "supabase",
        DESK_FILES_SUPABASE_URL: "https://files.supabase.co",
        DESK_FILES_SUPABASE_SERVICE_KEY: "secret-key",
        DESK_FILES_SUPABASE_BUCKET: "bad/bucket!"
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/bucket/i);

    expect(
      fileStoreConfig({
        NODE_ENV: "test",
        DESK_FILE_STORE: "supabase",
        DESK_FILES_SUPABASE_URL: "https://files.supabase.co/",
        DESK_FILES_SUPABASE_SERVICE_KEY: "secret-key"
      } as unknown as NodeJS.ProcessEnv)
    ).toEqual({ mode: "supabase", url: "https://files.supabase.co", key: "secret-key", bucket: "desk-files" });

    expect(
      fileStoreConfig({
        NODE_ENV: "test",
        DESK_FILE_STORE: "supabase",
        DESK_FILES_SUPABASE_URL: "https://files.supabase.co",
        DESK_FILES_SUPABASE_SERVICE_KEY: "secret-key",
        DESK_FILES_SUPABASE_BUCKET: "custom-bucket"
      } as unknown as NodeJS.ProcessEnv)
    ).toEqual({ mode: "supabase", url: "https://files.supabase.co", key: "secret-key", bucket: "custom-bucket" });
  });
});

describe("supabaseFileStore", () => {
  const SECRET = "super-secret-service-key-value";
  const KEY1 = "ws_demo/11111111-1111-4111-8111-111111111111";

  it("uploads with expected Supabase REST path, headers, x-upsert, and never leaks secrets on error", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const store = supabaseFileStore(
      { url: "https://files.supabase.co/", key: SECRET, bucket: "desk-files" },
      async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return new Response("", { status: 200 });
      }
    );

    await store.put(KEY1, Buffer.from("hello"), "application/pdf");
    expect(calls[0]?.url).toBe(`https://files.supabase.co/storage/v1/object/desk-files/${KEY1}`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({
      apikey: SECRET,
      Authorization: `Bearer ${SECRET}`,
      "Content-Type": "application/pdf",
      "x-upsert": "false"
    });

    await store.put(KEY1, Buffer.from("updated"), "image/png", { upsert: true });
    expect((calls[1]?.init.headers as Record<string, string>)["x-upsert"]).toBe("true");

    const failing = supabaseFileStore({ url: "https://files.supabase.co", key: SECRET }, async () => new Response("nope", { status: 500 }));
    await expect(failing.put(KEY1, Buffer.from("x"), "text/plain")).rejects.toThrow(/HTTP 500/);
    try {
      await failing.put(KEY1, Buffer.from("x"), "text/plain");
    } catch (err) {
      expect((err as Error).message).not.toContain(SECRET);
    }
  });

  it("reads exact bytes on 200, returns null on 404/400, and rejects unsafe keys without fetching", async () => {
    let fetchCount = 0;
    const store = supabaseFileStore({ url: "https://files.supabase.co", key: SECRET }, async (url) => {
      fetchCount++;
      const s = String(url);
      if (s.endsWith("22222222-2222-4222-8222-222222222222")) return new Response("not found", { status: 404 });
      if (s.endsWith("33333333-3333-4333-8333-333333333333")) return new Response("bad", { status: 400 });
      return new Response(VALID_PNG, { status: 200 });
    });

    expect(await store.get("../etc/passwd")).toBeNull();
    expect(await store.get("ws_demo/not-a-uuid")).toBeNull();
    expect(fetchCount).toBe(0);

    const hit = await store.get(KEY1);
    expect(hit?.equals(VALID_PNG)).toBe(true);
    expect(await store.get("ws_demo/22222222-2222-4222-8222-222222222222")).toBeNull();
    expect(await store.get("ws_demo/33333333-3333-4333-8333-333333333333")).toBeNull();
  });

  it("batch deletes safe keys in chunks of 100 and skips invalid keys", async () => {
    const bodies: Array<{ prefixes: string[] }> = [];
    const store = supabaseFileStore({ url: "https://files.supabase.co", key: SECRET, bucket: "my-bucket" }, async (url, init = {}) => {
      expect(String(url)).toBe("https://files.supabase.co/storage/v1/object/my-bucket");
      expect(init.method).toBe("DELETE");
      bodies.push(JSON.parse(String(init.body)) as { prefixes: string[] });
      return new Response("[]", { status: 200 });
    });

    await store.remove(["bad/key", "../escape"]);
    expect(bodies).toHaveLength(0);

    const keys = Array.from({ length: 105 }, (_, i) => `ws_demo/${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`);
    await store.remove([...keys, "bad/key"]);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.prefixes).toHaveLength(100);
    expect(bodies[1]!.prefixes).toHaveLength(5);
  });
});

describe("diskFileStore and storeFile/readFile/removeFiles delegation", () => {
  const dirs: string[] = [];

  afterEach(() => {
    setFileStoreForTest(null);
    delete process.env.DESK_UPLOAD_DIR;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("puts, prevents accidental overwrite without upsert, overwrites with upsert, and removes on disk", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tl-disk-store-"));
    dirs.push(dir);
    const store = diskFileStore(dir);
    const key = "ws_disk/11111111-1111-4111-8111-111111111111";

    await store.put(key, Buffer.from("v1"), "text/plain");
    expect((await store.get(key))?.toString("utf8")).toBe("v1");
    await expect(store.put(key, Buffer.from("v2"), "text/plain")).rejects.toThrow();

    await store.put(key, Buffer.from("v2"), "text/plain", { upsert: true });
    expect((await store.get(key))?.toString("utf8")).toBe("v2");

    await store.remove([key]);
    expect(await store.get(key)).toBeNull();
  });

  it("routes storeFile, readFile, and removeFiles through the configured FileStore even when local disk dir is empty", async () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), "tl-empty-disk-"));
    dirs.push(emptyDir);
    process.env.DESK_UPLOAD_DIR = emptyDir;

    const mem = memoryStore();
    setFileStoreForTest(mem.store);

    const checked = checkAttachment("pod.png", "image/png", VALID_PNG);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;

    const stored = await storeFile("ws_remote", checked);
    expect(stored.storageKey).toMatch(/^ws_remote\/[0-9a-f-]{36}$/);
    expect(mem.map.has(stored.storageKey)).toBe(true);
    expect(existsSync(path.join(emptyDir, stored.storageKey))).toBe(false);

    // Wiping the local disk folder still leaves the object readable from the configured store.
    rmSync(emptyDir, { recursive: true, force: true });
    const bytes = await readFile(stored.storageKey);
    expect(bytes?.equals(Buffer.from(checked.data))).toBe(true);

    await removeFiles([stored.storageKey]);
    expect(mem.map.has(stored.storageKey)).toBe(false);
    expect(await readFile(stored.storageKey)).toBeNull();
  });
});
