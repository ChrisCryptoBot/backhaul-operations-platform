// Copies TrueLane's pure money/miles/verdict modules into src/truelane so this app computes
// every number the way the phone does. Nothing in src/truelane is edited by hand.
//
//   node scripts/vendor-truelane.mjs                 (TrueLane checkout at TRUELANE_ROOT or the default below)
//
// Each file keeps its path under src/truelane (lib/..., utils/...). The only change made on the way in is
// that '@/lib/' and '@/utils/' imports point at '@/truelane/...', because this app has its own src/lib.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dest = path.join(here, "..", "src", "truelane");
const root = process.env.TRUELANE_ROOT ?? "C:/Users/14698/OneDrive/Desktop/TRUELANE";

// The import closure of the modules this app needs (checked: only 'react' is imported from outside, as a type).
export const FILES = [
  "lib/analytics.ts",
  "lib/calculate/acceptGate.ts",
  "lib/calculate/afterDelivery.ts",
  "lib/calculate/emptyMiles.ts",
  "lib/costProfileHero.ts",
  "lib/appointmentWindow.ts",
  "lib/costProfileSnapshot.ts",
  "lib/domain/calculators.ts",
  "lib/domain/calendarDays.ts",
  "lib/domain/completedAt.ts",
  "lib/domain/costArchetype.ts",
  "lib/domain/detention.ts",
  "lib/domain/equipmentDrift.ts",
  "lib/domain/evaluateLoad.ts",
  "lib/domain/fieldRelevance.ts",
  "lib/domain/hos.ts",
  "lib/domain/loadEconomics.ts",
  "lib/domain/marketVariance.ts",
  "lib/domain/marketVerdict.ts",
  "lib/domain/oversize.ts",
  "lib/domain/quotedMiles.ts",
  "lib/domain/tripHours.ts",
  "lib/eiaRegion.ts",
  "lib/formatNumbers.ts",
  "lib/fuelPriceForRates.ts",
  "lib/fuelSurcharge.ts",
  "lib/insuranceFields.ts",
  "lib/invoice.ts",
  "lib/loadReadiness.ts",
  "lib/rateCon/equipment.ts",
  "lib/rateCon/stopTime.ts",
  "lib/rateCon/types.ts",
  "lib/rateCon/tz-lookup.d.ts",
  "constants/trailerData.ts",
  "constants/vehicleData.ts",
  "utils/calculateHelpers.ts"
];

// Files whose path inside TrueLane differs from where they live here: [source, destination under src/truelane].
export const MOVED = [["supabase/functions/rate-con-extract/core.ts", "rate-con/core.ts"]];

const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"]).toString().trim();

for (const [rel, to] of [...FILES.map((f) => [f, f]), ...MOVED]) {
  const src = fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
  const body = src
    .replaceAll("'@/lib/", "'@/truelane/lib/")
    .replaceAll("'@/utils/", "'@/truelane/utils/")
    .replaceAll("'@/constants/", "'@/truelane/constants/");
  const out = path.join(dest, to);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `// VENDORED from TrueLane ${rel} @ ${sha.slice(0, 8)}. Do not edit; run scripts/vendor-truelane.mjs.\n${body}`);
}

fs.writeFileSync(
  path.join(dest, "VENDORED.md"),
  [
    "# Vendored TrueLane domain code",
    "",
    `Source: TrueLane checkout at commit \`${sha}\`.`,
    "Refresh with `node scripts/vendor-truelane.mjs` (set `TRUELANE_ROOT` if the checkout is elsewhere), then run `npm test`.",
    "These are the same modules the phone uses for the break-even floor, the verdict, market variance, load economics, invoices and analytics.",
    "The golden tests in `tests/truelane-domain.test.ts` pin the figures on the TrueLane site ($650 over 545 mi = $1.19/mi, over 308 mi = $2.11/mi).",
    "",
    "## Files",
    ...FILES.map((f) => `- \`${f}\``),
    ...MOVED.map(([from, to]) => `- \`${from}\` (as \`${to}\`)`),
    ""
  ].join("\n")
);
console.log(`vendored ${FILES.length + MOVED.length} files from ${sha.slice(0, 8)} into ${path.relative(process.cwd(), dest)}`);
