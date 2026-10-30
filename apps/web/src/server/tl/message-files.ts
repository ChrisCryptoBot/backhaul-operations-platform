import { createHash, randomUUID } from "crypto";
import { existsSync, promises as fs } from "fs";
import path from "path";
import type { Checked } from "@/lib/attachments";

/**
 * The desk's private storage for message pictures and files: a folder on the machine the desk runs on, never served as plain files. Every read goes through the
 * workspace-checked route (app/(desk)/messages/file/[id]/route.ts). When the desk moves to hosted storage this is the one file that changes (put, get, delete).
 */
function root(): string {
  if (process.env.DESK_UPLOAD_DIR) return path.resolve(process.env.DESK_UPLOAD_DIR);
  const cwd = process.cwd();
  // The desk may be started from its own folder, from apps/web, or from a folder above it.
  for (const rel of ["", path.join("apps", "web"), path.join("dispatch-desk", "apps", "web")]) {
    const dir = path.join(cwd, rel);
    if (existsSync(path.join(dir, "next.config.mjs"))) return path.join(dir, ".uploads", "messages");
  }
  return path.join(cwd, ".uploads", "messages");
}

const SAFE_KEY = /^[A-Za-z0-9_-]{1,64}\/[0-9a-f-]{36}$/;

export type Stored = { id: string; kind: string; name: string; mime: string; bytes: number; sha256: string; storageKey: string };

/** Write one checked file; the key is `<workspace>/<uuid>`, never anything the sender chose. */
export async function storeFile(workspaceId: string, f: Extract<Checked, { ok: true }>): Promise<Stored> {
  const id = randomUUID();
  const storageKey = `${workspaceId}/${id}`;
  if (!SAFE_KEY.test(storageKey)) throw new Error("unsafe storage key");
  const file = path.join(root(), storageKey);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, f.data, { flag: "wx" });
  return { id, kind: f.type.kind, name: f.name, mime: f.type.mime, bytes: f.data.length, sha256: createHash("sha256").update(f.data).digest("hex"), storageKey };
}

export async function readFile(storageKey: string): Promise<Buffer | null> {
  if (!SAFE_KEY.test(storageKey)) return null;
  try {
    return await fs.readFile(path.join(root(), storageKey));
  } catch {
    return null;
  }
}

export async function removeFiles(keys: string[]): Promise<void> {
  await Promise.all(
    keys.filter((k) => SAFE_KEY.test(k)).map((k) =>
      fs.rm(path.join(root(), k), { force: true }).catch(() => undefined)
    )
  );
}
