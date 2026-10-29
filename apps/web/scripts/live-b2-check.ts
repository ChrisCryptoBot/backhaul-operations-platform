// One live check of each Wave B2 service, through the desk's own server modules, to prove the keys and the request shapes work.
//   npx tsx scripts/live-b2-check.ts [MC number]
// The keys are read from apps/web/.env.local the way Next reads them. Nothing is saved and no key is ever printed: only what came back.
import { readFileSync } from "node:fs";
import path from "node:path";

const envFile = path.join(__dirname, "..", ".env.local");
for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.trim().replace(/^"|"$/g, "");
}

async function main() {
  // Imported after the environment is loaded, because the modules read their keys when they are called.
  const { geocode, mapboxConfigured } = await import("../src/server/geo/mapbox");
  const { resolveStopZones } = await import("../src/server/geo/zones");
  const { latestFuelPrice, eiaConfigured } = await import("../src/server/fuel/eia");
  const { lookupMc, fmcsaConfigured } = await import("../src/server/fmcsa/lookup");
  const { weekOf } = await import("../src/lib/eia");

  console.log(`keys present: mapbox=${mapboxConfigured()} eia=${eiaConfigured()} fmcsa=${fmcsaConfigured()}`);

  // 1. Time zones: two places on a boundary, where a state guess is wrong, and one in a split state.
  const stops = ["Bowman, ND", "El Paso, TX", "Atlanta, GA"];
  const started = Date.now();
  const zones = await resolveStopZones(stops);
  stops.forEach((s, i) => console.log(`zone  ${s.padEnd(14)} -> ${zones[i]!.zone} (${zones[i]!.source})`));
  console.log(`      ${((Date.now() - started) / 1000).toFixed(1)}s for ${stops.length} lookups`);
  const place = await geocode("Dallas, TX");
  console.log(`geocode Dallas, TX -> ${place ? `${place.lat.toFixed(3)}, ${place.lng.toFixed(3)}` : "not found"}`);

  // 2. EIA: this week's Gulf Coast on-highway diesel, and the national price the region falls back to.
  for (const padd of ["R30", "NUS"] as const) {
    const price = await latestFuelPrice("diesel", padd);
    console.log(price ? `eia   ${price.regionLabel}: $${price.pricePerGallon.toFixed(3)} a gallon, ${weekOf(price.period)}${price.nationalFallback ? " (national fallback)" : ""}` : `eia   ${padd}: no price`);
  }

  // 3. FMCSA: one MC number (the docket the FMCSA documentation uses unless one is given).
  const mc = process.argv[2] ?? "1515";
  const found = await lookupMc(mc);
  console.log(`fmcsa MC ${mc}: ${found.state} (${found.label})${found.name ? `, ${found.name}${found.place ? `, ${found.place}` : ""}` : ""}`);
}

main();
