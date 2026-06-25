// Local ingestion battle-test harness.
//
// Sends a rate-con file (PDF or .txt) through the REAL ingestion pipeline via the
// dev-only /api/internal/ingest-local route: persist -> inline parse (regex
// fallback, or live LLM if a funded key is set) -> approve -> Load. No AWS needed.
//
// Usage:
//   node scripts/ingest-local.mjs <file> [--pickup YYYY-MM-DD] [--no-approve] [--base <url>]
//
// Requires the dev server running (npm run dev) with BYPASS_AUTH and no AWS env.

import { readFile } from "node:fs/promises";
import path from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const file = process.argv[2];
if (!file || file.startsWith("--")) {
  console.error("Usage: node scripts/ingest-local.mjs <file> [--pickup YYYY-MM-DD] [--no-approve] [--base http://localhost:3000]");
  process.exit(1);
}

const base = arg("--base", "http://localhost:3000");
const pickupDate = arg("--pickup", new Date().toISOString().slice(0, 10));
const autoApprove = !process.argv.includes("--no-approve");

const buffer = await readFile(file);
const body = {
  fileName: path.basename(file),
  fileBase64: buffer.toString("base64"),
  pickupDate,
  autoApprove
};

const res = await fetch(`${base}/api/internal/ingest-local`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

const text = await res.text();
let json;
try {
  json = JSON.parse(text);
} catch {
  console.error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  process.exit(1);
}

if (!res.ok) {
  console.error(`HTTP ${res.status}:`, JSON.stringify(json, null, 2));
  process.exit(1);
}

console.log("=== Local ingestion result ===");
console.log("rateConfirmationId:", json.rateConfirmationId);
console.log("parseState:       ", json.parseState);
console.log("parseConfidence:  ", json.parseConfidence);
console.log("loadId:           ", json.loadId ?? "(not approved)");
if (json.approveError) console.log("approveError:     ", json.approveError);
console.log("extractedPayload:");
console.log(JSON.stringify(json.extractedPayload, null, 2));
