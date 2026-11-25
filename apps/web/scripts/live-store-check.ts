// One live round-trip check (put -> get -> remove -> get=null) against the private desk-files Supabase Storage bucket.
//   npx tsx scripts/live-store-check.ts
// Reads DESK_FILES_SUPABASE_URL and DESK_FILES_SUPABASE_SERVICE_KEY (and optional DESK_FILES_SUPABASE_BUCKET) from apps/web/.env.local or the shell. Never prints keys.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const envFile = path.join(__dirname, "..", ".env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.trim().replace(/^"|"$/g, "");
  }
}

async function main() {
  const url = (process.env.DESK_FILES_SUPABASE_URL ?? "").trim();
  const key = (process.env.DESK_FILES_SUPABASE_SERVICE_KEY ?? "").trim();
  const bucket = (process.env.DESK_FILES_SUPABASE_BUCKET ?? "").trim() || "desk-files";

  if (!url || !key) {
    console.error("Missing DESK_FILES_SUPABASE_URL or DESK_FILES_SUPABASE_SERVICE_KEY. Create a private bucket (default: desk-files), set both variables in apps/web/.env.local, and retry.");
    process.exit(1);
  }

  const { supabaseFileStore } = await import("../src/server/tl/message-files");
  const store = supabaseFileStore({ url, key, bucket });
  const probeKey = `live-check/${randomUUID()}`;
  const payload = Buffer.from(`truelane-live-store-check:${new Date().toISOString()}`, "utf8");

  await store.put(probeKey, payload, "text/plain", { upsert: false });
  console.log(`put    ${bucket}/${probeKey} (${payload.length} bytes) -> ok`);

  const got = await store.get(probeKey);
  if (!got || !got.equals(payload)) {
    throw new Error(`get returned mismatched payload (expected ${payload.length} bytes, got ${got?.length ?? "null"})`);
  }
  console.log(`get    ${bucket}/${probeKey} -> exact match (${got.length} bytes)`);

  await store.remove([probeKey]);
  console.log(`remove ${bucket}/${probeKey} -> ok`);

  const after = await store.get(probeKey);
  if (after !== null) {
    throw new Error(`get after remove expected null, got ${after.length} bytes`);
  }
  console.log(`verify ${bucket}/${probeKey} -> null (deleted)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : "Live store check failed.");
  process.exit(1);
});
