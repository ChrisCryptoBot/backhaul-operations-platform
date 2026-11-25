import { createHash, randomUUID } from "crypto";
import { existsSync, promises as fs } from "fs";
import path from "path";
import type { Checked } from "@/lib/attachments";

/**
 * The desk's private storage for message pictures, load documents and driver receipts: either a folder on disk (default for dev and tests) or a private Supabase Storage
 * bucket (`DESK_FILE_STORE=supabase`), never served directly without workspace checks. Every read goes through workspace-checked routes (`documents/[id]`, `messages/file/[id]`,
 * `receipts/[id]`). Keys always stay `<workspace>/<uuid>`, so callers remain unaware of which backend holds the bytes.
 */
const SAFE_KEY = /^[A-Za-z0-9_-]{1,64}\/[0-9a-f-]{36}$/;
const BUCKET_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const REMOVE_BATCH = 100;

export function isSafeStorageKey(key: string): boolean {
  return SAFE_KEY.test(key);
}

export function diskUploadRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DESK_UPLOAD_DIR) return path.resolve(env.DESK_UPLOAD_DIR);
  const cwd = process.cwd();
  // The desk may be started from its own folder, from apps/web, or from a folder above it.
  for (const rel of ["", path.join("apps", "web"), path.join("dispatch-desk", "apps", "web")]) {
    const dir = path.join(cwd, rel);
    if (existsSync(path.join(dir, "next.config.mjs"))) return path.join(dir, ".uploads", "messages");
  }
  return path.join(cwd, ".uploads", "messages");
}

export type FileStore = {
  put(key: string, data: Uint8Array, mime: string, opts?: { upsert?: boolean }): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  remove(keys: string[]): Promise<void>;
};

export type FileStoreConfig =
  | { mode: "disk"; dir: string }
  | { mode: "supabase"; url: string; key: string; bucket: string };

function validateSupabaseStoreArgs(urlRaw: string, keyRaw: string, bucketRaw?: string): { url: string; key: string; bucket: string } {
  const url = urlRaw.trim();
  const key = keyRaw.trim();
  const bucket = (bucketRaw ?? "").trim() || "desk-files";
  if (!url) throw new Error("DESK_FILES_SUPABASE_URL is required when DESK_FILE_STORE=supabase.");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DESK_FILES_SUPABASE_URL must be a valid https URL.");
  }
  if (parsed.protocol !== "https:") throw new Error("DESK_FILES_SUPABASE_URL must use https://.");
  if (!key) throw new Error("DESK_FILES_SUPABASE_SERVICE_KEY is required when DESK_FILE_STORE=supabase.");
  if (!BUCKET_NAME.test(bucket)) throw new Error("DESK_FILES_SUPABASE_BUCKET must be a valid bucket name.");
  return { url: url.replace(/\/+$/, ""), key, bucket };
}

export function fileStoreConfig(env: NodeJS.ProcessEnv = process.env): FileStoreConfig {
  const rawMode = (env.DESK_FILE_STORE ?? "").trim().toLowerCase();
  const mode = rawMode || "disk";
  if (mode === "disk") return { mode: "disk", dir: diskUploadRoot(env) };
  if (mode !== "supabase") throw new Error("DESK_FILE_STORE must be 'disk' or 'supabase'.");
  const validated = validateSupabaseStoreArgs(
    env.DESK_FILES_SUPABASE_URL ?? "",
    env.DESK_FILES_SUPABASE_SERVICE_KEY ?? "",
    env.DESK_FILES_SUPABASE_BUCKET
  );
  return { mode: "supabase", ...validated };
}

export function diskFileStore(baseDir = diskUploadRoot()): FileStore {
  return {
    async put(key, data, _mime, opts) {
      if (!SAFE_KEY.test(key)) throw new Error("unsafe storage key");
      const file = path.join(baseDir, key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, data, { flag: opts?.upsert ? "w" : "wx" });
    },
    async get(key) {
      if (!SAFE_KEY.test(key)) return null;
      try {
        return await fs.readFile(path.join(baseDir, key));
      } catch {
        return null;
      }
    },
    async remove(keys) {
      await Promise.all(
        keys.filter((k) => SAFE_KEY.test(k)).map((k) =>
          fs.rm(path.join(baseDir, k), { force: true }).catch(() => undefined)
        )
      );
    }
  };
}

export function supabaseFileStore(cfg: { url: string; key: string; bucket?: string }, fetchFn: typeof fetch = fetch): FileStore {
  const { url: base, key: serviceKey, bucket } = validateSupabaseStoreArgs(cfg.url, cfg.key, cfg.bucket);
  const objectUrl = (storageKey: string): string => {
    if (!SAFE_KEY.test(storageKey)) throw new Error("unsafe storage key");
    return `${base}/storage/v1/object/${bucket}/${storageKey}`;
  };
  return {
    async put(storageKey, data, mime, opts) {
      const target = objectUrl(storageKey);
      const res = await fetchFn(target, {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": mime,
          "x-upsert": opts?.upsert ? "true" : "false"
        },
        body: Buffer.from(data)
      });
      if (!res.ok) throw new Error(`File store upload failed (HTTP ${res.status})`);
    },
    async get(storageKey) {
      if (!SAFE_KEY.test(storageKey)) return null;
      const res = await fetchFn(`${base}/storage/v1/object/${bucket}/${storageKey}`, {
        method: "GET",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
      });
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) throw new Error(`File store read failed (HTTP ${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    },
    async remove(keys) {
      const safe = keys.filter((k) => SAFE_KEY.test(k));
      if (safe.length === 0) return;
      for (let i = 0; i < safe.length; i += REMOVE_BATCH) {
        const chunk = safe.slice(i, i + REMOVE_BATCH);
        const res = await fetchFn(`${base}/storage/v1/object/${bucket}`, {
          method: "DELETE",
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ prefixes: chunk })
        });
        if (!res.ok && res.status !== 404) throw new Error(`File store remove failed (HTTP ${res.status})`);
      }
    }
  };
}

let overrideStore: FileStore | null = null;

export function setFileStoreForTest(store: FileStore | null): void {
  overrideStore = store;
}

export function resolveFileStore(env: NodeJS.ProcessEnv = process.env): FileStore {
  if (overrideStore) return overrideStore;
  const cfg = fileStoreConfig(env);
  return cfg.mode === "supabase" ? supabaseFileStore(cfg) : diskFileStore(cfg.dir);
}

export type Stored = { id: string; kind: string; name: string; mime: string; bytes: number; sha256: string; storageKey: string };

/** Write one checked file; the key is `<workspace>/<uuid>`, never anything the sender chose. */
export async function storeFile(workspaceId: string, f: Extract<Checked, { ok: true }>): Promise<Stored> {
  const id = randomUUID();
  const storageKey = `${workspaceId}/${id}`;
  if (!SAFE_KEY.test(storageKey)) throw new Error("unsafe storage key");
  await resolveFileStore().put(storageKey, f.data, f.type.mime);
  return { id, kind: f.type.kind, name: f.name, mime: f.type.mime, bytes: f.data.length, sha256: createHash("sha256").update(f.data).digest("hex"), storageKey };
}

export async function readFile(storageKey: string): Promise<Buffer | null> {
  if (!SAFE_KEY.test(storageKey)) return null;
  return resolveFileStore().get(storageKey);
}

export async function removeFiles(keys: string[]): Promise<void> {
  const safe = keys.filter((k) => SAFE_KEY.test(k));
  if (safe.length === 0) return;
  await resolveFileStore().remove(safe);
}
