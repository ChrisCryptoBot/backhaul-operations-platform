// One live read of a rate confirmation through the desk's own reader, to prove the Anthropic key and the reading path work.
//   npx tsx scripts/live-read-check.ts <path-to-pdf>
// The key is read from apps/web/.env.local (Next loads it for the app; this script loads it the same way). Nothing is saved.
import { readFileSync } from "node:fs";
import path from "node:path";
import { readRateCon } from "../src/server/ratecon/reader";

const envFile = path.join(__dirname, "..", ".env.local");
for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.trim().replace(/^"|"$/g, "");
}

const file = process.argv[2];
if (!file) throw new Error("Give the path of a PDF.");

async function main() {
  const bytes = new Uint8Array(readFileSync(file!));
  const started = Date.now();
  const out = await readRateCon({ fileName: path.basename(file!), mime: "application/pdf", bytes });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (!out.ok) {
    console.log(`not read (${out.reason}) after ${seconds}s`);
    return;
  }
  const d = out.draft;
  console.log(`read live in ${seconds}s, source=${out.source}`);
  console.log(JSON.stringify({ broker: d.load.brokerName, loadNumber: d.load.loadNumber, po: d.load.poNumber, rate: d.load.quotedRevenue, miles: d.load.loadedMiles, terms: d.load.payTermsDays, stops: d.stops.map((s) => ({ type: s.stopType, address: s.addressString, from: s.timeWindowEarliest, to: s.timeWindowLatest, refs: s.referenceNumbers })), warnings: d.warnings }, null, 2));
}

main();
