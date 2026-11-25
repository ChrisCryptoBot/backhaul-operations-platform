// Copies existing files from local disk (.uploads/messages or DESK_UPLOAD_DIR) into the private Supabase Storage bucket.
// Dry-run by default:
//   npx tsx scripts/move-files-to-store.ts
// Actually upload and verify each object:
//   npx tsx scripts/move-files-to-store.ts --apply
import { createHash } from "node:crypto";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import path from "node:path";

const envFile = path.join(__dirname, "..", ".env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.trim().replace(/^"|"$/g, "");
  }
}

type LocalFile = { key: string; fullPath: string; bytes: number };

async function scanLocalFiles(rootDir: string, isSafeKey: (k: string) => boolean): Promise<LocalFile[]> {
  if (!existsSync(rootDir)) return [];
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const out: LocalFile[] = [];
  for (const ws of entries) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(rootDir, ws.name);
    for (const f of await fs.readdir(wsDir, { withFileTypes: true })) {
      if (!f.isFile()) continue;
      const key = `${ws.name}/${f.name}`;
      if (!isSafeKey(key)) continue;
      const fullPath = path.join(wsDir, f.name);
      const stat = await fs.stat(fullPath);
      out.push({ key, fullPath, bytes: stat.size });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

async function lookupMimes(keys: string[]): Promise<Map<string, string>> {
  const mimes = new Map<string, string>();
  if (keys.length === 0 || !process.env.DATABASE_URL) return mimes;
  const { prisma } = await import("../src/lib/db");
  try {
    const [docs, attachments, receipts] = await Promise.all([
      prisma.loadDocument.findMany({ where: { storageKey: { in: keys } }, select: { storageKey: true, mime: true } }),
      prisma.messageAttachment.findMany({ where: { storageKey: { in: keys } }, select: { storageKey: true, mime: true } }),
      prisma.driverReceipt.findMany({ where: { storageKey: { in: keys } }, select: { storageKey: true, mime: true } })
    ]);
    for (const d of docs) mimes.set(d.storageKey, d.mime);
    for (const a of attachments) mimes.set(a.storageKey, a.mime);
    for (const r of receipts) if (r.storageKey && r.mime) mimes.set(r.storageKey, r.mime);
  } catch (err) {
    console.warn(`Note: could not query DB for mime types (${err instanceof Error ? err.message : "unknown error"}); falling back to application/octet-stream.`);
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
  return mimes;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const { diskUploadRoot, isSafeStorageKey, supabaseFileStore } = await import("../src/server/tl/message-files");
  const rootDir = diskUploadRoot();
  const files = await scanLocalFiles(rootDir, isSafeStorageKey);
  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  console.log(`Scanned ${rootDir}: ${files.length} file(s), ${totalBytes} byte(s).`);
  if (files.length === 0) return;

  const mimes = await lookupMimes(files.map((f) => f.key));

  if (!apply) {
    for (const f of files.slice(0, 20)) {
      console.log(`  [dry-run] ${f.key} (${f.bytes} bytes, ${mimes.get(f.key) ?? "application/octet-stream"})`);
    }
    if (files.length > 20) console.log(`  ... and ${files.length - 20} more.`);
    console.log("Dry run complete. Re-run with --apply to upload and verify each file in Supabase Storage.");
    return;
  }

  const store = supabaseFileStore({
    url: process.env.DESK_FILES_SUPABASE_URL ?? "",
    key: process.env.DESK_FILES_SUPABASE_SERVICE_KEY ?? "",
    bucket: process.env.DESK_FILES_SUPABASE_BUCKET
  });

  let ok = 0;
  let failed = 0;
  for (const f of files) {
    const mime = mimes.get(f.key) ?? "application/octet-stream";
    try {
      const data = await fs.readFile(f.fullPath);
      const expectedSha = createHash("sha256").update(data).digest("hex");
      await store.put(f.key, data, mime, { upsert: true });
      const fetched = await store.get(f.key);
      if (!fetched || fetched.length !== data.length) {
        failed++;
        console.error(`  FAIL ${f.key}: size mismatch (expected ${data.length}, got ${fetched?.length ?? "null"})`);
        continue;
      }
      const gotSha = createHash("sha256").update(fetched).digest("hex");
      if (gotSha !== expectedSha) {
        failed++;
        console.error(`  FAIL ${f.key}: checksum mismatch`);
        continue;
      }
      ok++;
      console.log(`  OK   ${f.key} (${data.length} bytes)`);
    } catch (err) {
      failed++;
      console.error(`  FAIL ${f.key}: ${err instanceof Error ? err.message : "upload failed"}`);
    }
  }

  console.log(`Done: ${ok} verified, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : "Failed.");
  process.exit(1);
});
