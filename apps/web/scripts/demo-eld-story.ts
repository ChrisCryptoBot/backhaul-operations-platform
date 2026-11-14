import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Staging for the partner clips on the demo desk (the radar map and the ELD story). Demo-workspace only; it never touches the showcase fleet. Run from apps/web:
 *
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo npx tsx scripts/demo-eld-story.ts <mode> [options]
 *
 *   stage            Give Units 104-106 a cost profile, a home base and a body with an mpg (so the Quote has no "No cost profile" rows and can price them), and record the pickup arrival on every load that is under way
 *                    (otherwise the radar says "Next stop: pickup" for a truck that is already driving to the delivery), and correct the pay kind "per_mile" to "cpm" on the two
 *                    drivers that carry it (the Quote could not judge their rows). Safe to run again.
 *   refresh          Re-anchor the whole story to now: the seeded fixes, windows and clocks were stamped when the demo was seeded and age every minute. Every fix, fix time, hours
 *                    read time and stop window moves by the same amount, so the story (who is late, who is on schedule) is exactly as seeded, a moment ago. Run before each take.
 *   ahead [miles]    Take the last `miles` (default 15) of each moving unit's own trail off the database and keep it in a file; the unit stands that far back. Then refresh.
 *                    `live` replays that road, so the truck drives forward along the road it really took, not a straight line.
 *   live [options]   Move the units forward along the kept road, writing a fix every step (what an ELD read lands), until the road is used up or you press Ctrl+C.
 *                      --every 5      seconds between steps (match the radar's ?live=5)
 *                      --speed 6      times real speed (1 = the truck's own 64 mph; 6 shows about 0.5 mile a step at 5 s)
 *   restore          Put every kept fix back (the unit is where it was before `ahead`) and refresh.
 *   before | after   The ELD sync moment, for a cut: `before` is the stale picture (hours read 3 hours ago, fixes 40 minutes old, clocks as they were); `after` is what a sync lands
 *                    (fresh fixes, today's clocks). Pass --low "Alex Rivera=150" (minutes of drive left) to make one driver short on hours in the `after` picture.
 *
 * Positions are demo data standing in for an ELD's answer. This is the same set of writes syncEld makes (server/partners/eld.ts), without calling a company.
 */
const W = "demo-workspace";
const prisma = new PrismaClient();
const STATE = path.join(os.tmpdir(), "truelane-radar-replay.json");
/** The clocks as they stood before `before` made them older, so `after` can put them back (a sync lands today's clocks). */
const CLOCKS = path.join(os.tmpdir(), "truelane-eld-clocks.json");
type Clocks = Record<string, { drive: number | null; shift: number | null; cycle: number | null }>;
const MIN = 60_000;

type Fix = { lat: number; lng: number; speedMph: number | null; headingDeg: number | null; engine: string | null; at: string };
type Kept = { vehicleId: string; name: string; headAt: string; fixes: Fix[] };
/** What is kept between `ahead` and `restore`: the fixes taken off, where each unit then stood, and how far the refresh after `ahead` moved the story (so the fixes go back in the same frame). */
type State = { shiftedSecs: number; kept: Kept[] };

const miles = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const R = 3958.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
const bearing = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const rad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
};
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

async function stage() {
  const model = await prisma.costProfile.findFirstOrThrow({ where: { vehicle: { workspaceId: W, name: "Unit 101" } } });
  const homes: Record<string, { address: string; lat: number; lng: number }> = {
    "Unit 104": { address: "Dallas, TX", lat: 32.7767, lng: -96.797 },
    "Unit 105": { address: "Houston, TX", lat: 29.7604, lng: -95.3698 },
    "Unit 106": { address: "Dallas, TX", lat: 32.7767, lng: -96.797 }
  };
  const truck101 = await prisma.vehicle.findFirstOrThrow({ where: { workspaceId: W, name: "Unit 101" } });
  const mpgOf: Record<string, number> = { "Unit 104": 6.9, "Unit 105": 6.7, "Unit 106": 6.6 };
  const { id: _id, vehicleId: _v, createdAt: _c, updatedAt: _u, ...fields } = model;
  void _id; void _v; void _c; void _u;
  for (const [name, home] of Object.entries(homes)) {
    const v = await prisma.vehicle.findFirst({ where: { workspaceId: W, name, archivedAt: null } });
    if (!v) continue;
    // A truck with no mpg or fuel cannot be priced ("its cost is not known yet"): it takes Unit 101's body and tank, with its own mpg.
    const body = v.mpg == null ? { type: truck101.type, mpg: mpgOf[name] ?? 6.7, fuelType: truck101.fuelType, tankCapacityGallons: truck101.tankCapacityGallons, payloadLbs: truck101.payloadLbs, maxLengthFt: truck101.maxLengthFt, maxWidthFt: truck101.maxWidthFt, maxHeightIn: truck101.maxHeightIn } : {};
    await prisma.vehicle.update({ where: { id: v.id }, data: { homeBaseAddress: home.address, homeBaseLat: home.lat, homeBaseLng: home.lng, ...body } });
    const has = await prisma.costProfile.findUnique({ where: { vehicleId: v.id } });
    if (!has) await prisma.costProfile.create({ data: { ...fields, fuelCardProvider: null, fuelCardAccountId: null, vehicleId: v.id } });
    console.log(`${name}: home base ${home.address}${has ? "" : ", cost profile added"}`);
  }
  // The two drivers added with Units 104-105 carry the pay kind "per_mile", which the desk does not know (it says "cpm"), so the Quote read their pay as a flat amount and could not judge their rows.
  const fixed = await prisma.driver.updateMany({ where: { workspaceId: W, defaultPayKind: "per_mile" }, data: { defaultPayKind: "cpm", payrollWorkerType: "contractor" } });
  if (fixed.count > 0) console.log(`pay kind per_mile -> cpm on ${fixed.count} driver(s)`);
  // The story's hours: Morgan Vance (Unit 104) is the fresh driver with room for a Dallas to Houston run (10h30m of drive left); Alex Rivera (Unit 101) stays low at 6h, so the
  // Quote cautions his truck and prefers Morgan's. Only raised, never lowered, so running stage again (or after `live` has ticked the clock) changes nothing.
  const morgan = await prisma.driver.findFirst({ where: { workspaceId: W, name: "Morgan Vance" } });
  if (morgan && (morgan.hosDriveMinutes ?? 0) < 630) {
    await prisma.driver.update({ where: { id: morgan.id }, data: { hosDriveMinutes: 630, hosShiftMinutes: Math.max(morgan.hosShiftMinutes ?? 0, 630) } });
    if (morgan.assignedVehicleId) await prisma.vehicle.update({ where: { id: morgan.assignedVehicleId }, data: { hosAvailableHours: 10.5 } });
    console.log("Morgan Vance: 10h30m of drive left");
  }
  // A load under way has picked up: record the arrival at the pickup (ten minutes into its window) where none is recorded.
  const stops = await prisma.stop.findMany({ where: { load: { workspaceId: W, status: "in_progress" }, stopType: "pickup", arrivedAt: null }, select: { id: true, timeWindowEarliest: true } });
  for (const s of stops) await prisma.stop.update({ where: { id: s.id }, data: { arrivedAt: new Date((s.timeWindowEarliest ?? new Date()).getTime() + 10 * MIN) } });
  console.log(`pickup arrival recorded on ${stops.length} stop(s)`);
}

/** Move the story by `secs` seconds: every fix, fix time, hours read time and stop window together, so nothing changes but the clock. */
async function shiftAll(secs: number): Promise<number> {
  if (Math.abs(secs) < 2) {
    console.log("already current");
    return 0;
  }
  const f = Prisma_interval(secs);
  await prisma.$executeRawUnsafe(`update vehicle_pings set at = at + ${f} where workspace_id = $1`, W);
  await prisma.$executeRawUnsafe(`update vehicles set last_located_at = last_located_at + ${f}, hos_synced_at = hos_synced_at + ${f}, idle_since = idle_since + ${f} where workspace_id = $1`, W);
  await prisma.$executeRawUnsafe(`update drivers set hos_synced_at = hos_synced_at + ${f} where workspace_id = $1`, W);
  await prisma.$executeRawUnsafe(`update trailers set last_located_at = last_located_at + ${f} where workspace_id = $1`, W);
  await prisma.$executeRawUnsafe(`update stops set time_window_earliest = time_window_earliest + ${f}, time_window_latest = time_window_latest + ${f}, arrived_at = arrived_at + ${f} where load_id in (select id from loads where workspace_id = $1 and status = 'in_progress')`, W);
  await prisma.$executeRawUnsafe(`update loads set scheduled_date = scheduled_date + ${f} where workspace_id = $1 and status = 'in_progress'`, W);
  console.log(`moved the story ${Math.round(secs / 60)} minutes`);
  return secs;
}
const Prisma_interval = (secs: number) => `(${Math.round(secs)} * interval '1 second')`;

async function refresh(): Promise<number> {
  const last = await prisma.vehiclePing.aggregate({ where: { workspaceId: W }, _max: { at: true } });
  if (!last._max.at) {
    console.log("no fixes to anchor to");
    return 0;
  }
  return shiftAll((Date.now() - last._max.at.getTime()) / 1000);
}

async function movingUnits() {
  return prisma.vehicle.findMany({ where: { workspaceId: W, archivedAt: null, engineState: "moving" }, orderBy: { name: "asc" } });
}

async function setUnit(vehicleId: string, f: { lat: number; lng: number; speedMph: number | null; headingDeg: number | null; engine: string | null; at: Date }) {
  await prisma.vehicle.update({ where: { id: vehicleId }, data: { lastLat: f.lat, lastLng: f.lng, lastLocatedAt: f.at, lastSpeedMph: f.speedMph, lastHeadingDeg: f.headingDeg, engineState: f.engine } });
  await prisma.$executeRaw`update trailers t set last_lat = v.last_lat, last_lng = v.last_lng, last_located_at = v.last_located_at from vehicles v where t.current_vehicle_id = v.id and t.workspace_id = ${W} and v.id = ${vehicleId}`;
}

async function ahead(aheadMiles: number) {
  if (fs.existsSync(STATE)) return console.log(`a replay is already kept (${STATE}). Run restore first.`);
  const kept: Kept[] = [];
  for (const v of await movingUnits()) {
    const pings = (await prisma.vehiclePing.findMany({ where: { vehicleId: v.id }, orderBy: { at: "asc" } })).map((p) => ({ ...p, lat: Number(p.lat), lng: Number(p.lng), speedMph: p.speedMph == null ? null : Number(p.speedMph) }));
    let walked = 0;
    let cut = pings.length;
    for (let i = pings.length - 1; i > 0 && walked < aheadMiles; i--) {
      walked += miles(pings[i - 1]!, pings[i]!);
      cut = i;
    }
    const peeled = pings.slice(cut);
    if (peeled.length < 2) continue;
    kept.push({ vehicleId: v.id, name: v.name ?? v.id, headAt: pings[cut - 1]!.at.toISOString(), fixes: peeled.map((p) => ({ lat: p.lat, lng: p.lng, speedMph: p.speedMph, headingDeg: p.headingDeg, engine: p.engine, at: p.at.toISOString() })) });
    await prisma.vehiclePing.deleteMany({ where: { vehicleId: v.id, at: { in: peeled.map((p) => p.at) } } });
    const head = pings[cut - 1]!;
    await setUnit(v.id, { lat: head.lat, lng: head.lng, speedMph: head.speedMph, headingDeg: head.headingDeg, engine: head.engine, at: head.at });
    console.log(`${v.name}: stands ${Math.round(walked * 10) / 10} miles back, ${peeled.length} fixes kept`);
  }
  const shiftedSecs = await refresh();
  fs.writeFileSync(STATE, JSON.stringify({ shiftedSecs, kept } satisfies State));
}

async function restore() {
  if (!fs.existsSync(STATE)) return console.log("nothing kept; nothing to restore");
  const { shiftedSecs, kept } = JSON.parse(fs.readFileSync(STATE, "utf8")) as State;
  const frame = (iso: string) => new Date(new Date(iso).getTime() + shiftedSecs * 1000);
  for (const k of kept) {
    // Whatever `live` wrote since the unit stood back goes; the unit's own fixes go back in their place, in the same frame the refresh after `ahead` put the rest of the story in.
    const gone = await prisma.vehiclePing.deleteMany({ where: { vehicleId: k.vehicleId, at: { gt: frame(k.headAt) } } });
    await prisma.vehiclePing.createMany({ data: k.fixes.map((f) => ({ workspaceId: W, vehicleId: k.vehicleId, lat: f.lat, lng: f.lng, speedMph: f.speedMph, headingDeg: f.headingDeg, engine: f.engine, at: frame(f.at) })), skipDuplicates: true });
    const tail = k.fixes[k.fixes.length - 1]!;
    await setUnit(k.vehicleId, { ...tail, at: frame(tail.at) });
    console.log(`${k.name}: ${gone.count} driven fixes removed, ${k.fixes.length} fixes put back`);
  }
  fs.unlinkSync(STATE);
  await refresh();
}

/** A point `d` miles along a polyline. */
function along(path: Fix[], d: number): { lat: number; lng: number; heading: number; done: boolean } {
  let left = d;
  for (let i = 1; i < path.length; i++) {
    const seg = miles(path[i - 1]!, path[i]!);
    if (left <= seg) {
      const f = seg === 0 ? 0 : left / seg;
      const a = path[i - 1]!;
      const b = path[i]!;
      return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, heading: bearing(a, b), done: false };
    }
    left -= seg;
  }
  const end = path[path.length - 1]!;
  return { lat: end.lat, lng: end.lng, heading: end.headingDeg ?? 0, done: true };
}

async function live() {
  if (!fs.existsSync(STATE)) return console.log("nothing kept to drive along. Run `ahead` first.");
  const every = Number.parseInt(arg("every", "5"), 10);
  const speedUp = Number.parseFloat(arg("speed", "6"));
  const { kept } = JSON.parse(fs.readFileSync(STATE, "utf8")) as State;
  const roads = new Map<string, Fix[]>();
  for (const k of kept) {
    const v = await prisma.vehicle.findUniqueOrThrow({ where: { id: k.vehicleId } });
    roads.set(k.vehicleId, [{ lat: Number(v.lastLat), lng: Number(v.lastLng), speedMph: null, headingDeg: v.lastHeadingDeg, engine: "moving", at: new Date().toISOString() }, ...k.fixes]);
  }
  const driven = new Map<string, number>(kept.map((k) => [k.vehicleId, 0]));
  // Clocks are whole minutes and one step spends a fraction of one, so the fraction is carried until it makes a minute.
  const owed = new Map<string, number>(kept.map((k) => [k.vehicleId, 0]));
  let stop = false;
  process.on("SIGINT", () => (stop = true));
  console.log(`driving ${kept.length} units along their own road, a step every ${every}s at ${speedUp}x. Ctrl+C to stop.`);
  while (!stop) {
    const now = new Date();
    let moving = 0;
    for (const k of kept) {
      const road = roads.get(k.vehicleId)!;
      const v = await prisma.vehicle.findUniqueOrThrow({ where: { id: k.vehicleId } });
      const mph = Number(v.lastSpeedMph ?? 64) || 64;
      const total = (driven.get(k.vehicleId) ?? 0) + (mph * speedUp * every) / 3600;
      driven.set(k.vehicleId, total);
      const p = along(road, total);
      if (p.done) continue;
      moving += 1;
      const lat = Math.round(p.lat * 1e6) / 1e6;
      const lng = Math.round(p.lng * 1e6) / 1e6;
      await prisma.vehiclePing.create({ data: { workspaceId: W, vehicleId: k.vehicleId, lat, lng, speedMph: mph, headingDeg: p.heading, engine: "moving", at: now } });
      await setUnit(k.vehicleId, { lat, lng, speedMph: mph, headingDeg: p.heading, engine: "moving", at: now });
      // The driver's clocks run down with the road (in the sped-up time), and the hours the Quote reads follow.
      const carry = (owed.get(k.vehicleId) ?? 0) + (every * speedUp) / 60;
      const spent = Math.floor(carry);
      owed.set(k.vehicleId, carry - spent);
      const d = spent < 1 ? null : await prisma.driver.findFirst({ where: { workspaceId: W, assignedVehicleId: k.vehicleId, hosDriveMinutes: { not: null } }, orderBy: { name: "asc" } });
      if (d) {
        const drive = Math.max(0, Math.round((d.hosDriveMinutes ?? 0) - spent));
        const shift = Math.max(0, Math.round((d.hosShiftMinutes ?? 0) - spent));
        await prisma.driver.update({ where: { id: d.id }, data: { hosDriveMinutes: drive, hosShiftMinutes: d.hosShiftMinutes == null ? null : shift, hosCycleMinutes: d.hosCycleMinutes == null ? null : Math.max(0, Math.round(d.hosCycleMinutes - spent)), hosSyncedAt: now } });
        await prisma.vehicle.update({ where: { id: k.vehicleId }, data: { hosAvailableHours: Math.round((Math.min(drive, d.hosShiftMinutes == null ? drive : shift) / 60) * 10) / 10, hosSyncedAt: now } });
      }
    }
    console.log(`${now.toISOString().slice(11, 19)}  ${moving} moving`);
    if (moving === 0) break;
    await new Promise((r) => setTimeout(r, every * 1000));
  }
  console.log("stopped. `restore` puts the road back, `ahead` stages it again.");
}

async function syncMoment(mode: "before" | "after") {
  await refresh();
  const now = Date.now();
  const units = await prisma.vehicle.findMany({ where: { workspaceId: W, archivedAt: null }, orderBy: { name: "asc" } });
  const low = arg("low", "");
  const [lowName, lowMin] = low.includes("=") ? [low.split("=")[0]!, Number.parseInt(low.split("=")[1]!, 10)] : ["", 0];
  const kept: Clocks = mode === "after" && fs.existsSync(CLOCKS) ? (JSON.parse(fs.readFileSync(CLOCKS, "utf8")) as Clocks) : {};
  const saved: Clocks = {};
  for (const v of units) {
    const drivers = await prisma.driver.findMany({ where: { workspaceId: W, assignedVehicleId: v.id, hosDriveMinutes: { not: null } }, orderBy: { name: "asc" } });
    if (mode === "before") {
      // What the desk knew three hours ago: hours read 3 h ago, a little more on every clock (the driver has driven since), fixes 40 minutes old.
      if (v.lastLocatedAt) await prisma.vehicle.update({ where: { id: v.id }, data: { lastLocatedAt: new Date(now - 40 * MIN), hosSyncedAt: new Date(now - 180 * MIN) } });
      let least: number | null = null;
      for (const d of drivers) {
        if (!(d.id in saved) && !fs.existsSync(CLOCKS)) saved[d.id] = { drive: d.hosDriveMinutes, shift: d.hosShiftMinutes, cycle: d.hosCycleMinutes };
        const drive = (d.hosDriveMinutes ?? 0) + 150;
        least = least == null ? drive : Math.min(least, drive);
        await prisma.driver.update({ where: { id: d.id }, data: { hosDriveMinutes: drive, hosShiftMinutes: d.hosShiftMinutes == null ? null : d.hosShiftMinutes + 150, hosSyncedAt: new Date(now - 180 * MIN) } });
      }
      if (least != null) await prisma.vehicle.update({ where: { id: v.id }, data: { hosAvailableHours: Math.round((least / 60) * 10) / 10 } });
    } else {
      if (v.lastLocatedAt) await prisma.vehicle.update({ where: { id: v.id }, data: { lastLocatedAt: new Date(now - MIN), hosSyncedAt: new Date(now) } });
      const mins: number[] = [];
      for (const d of drivers) {
        const was = kept[d.id];
        const drive = d.name === lowName ? lowMin : (was?.drive ?? d.hosDriveMinutes ?? 0);
        const shift = was ? was.shift : d.hosShiftMinutes;
        mins.push(drive);
        // A driver made short on hours cannot have more shift than drive left.
        await prisma.driver.update({ where: { id: d.id }, data: { hosDriveMinutes: drive, hosShiftMinutes: shift == null ? null : d.name === lowName ? Math.min(shift, drive) : shift, hosCycleMinutes: was ? was.cycle : d.hosCycleMinutes, hosSyncedAt: new Date(now) } });
      }
      if (mins.length > 0) await prisma.vehicle.update({ where: { id: v.id }, data: { hosAvailableHours: Math.round((Math.min(...mins) / 60) * 10) / 10 } });
    }
  }
  if (mode === "before" && Object.keys(saved).length > 0) fs.writeFileSync(CLOCKS, JSON.stringify(saved));
  if (mode === "after" && fs.existsSync(CLOCKS)) fs.unlinkSync(CLOCKS);
  console.log(mode === "before" ? "before: hours read 3 hours ago (and a little higher), fixes 40 minutes old. Run `after` for what the sync lands." : `after: fresh fixes, today's clocks${lowName ? `, ${lowName} at ${lowMin} minutes` : ""}`);
}

async function main() {
  const mode = process.argv[2];
  if (mode === "stage") await stage();
  else if (mode === "refresh") await refresh();
  else if (mode === "ahead") await ahead(Number.parseFloat(process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : "15"));
  else if (mode === "live") await live();
  else if (mode === "restore") await restore();
  else if (mode === "before" || mode === "after") await syncMoment(mode);
  else console.log("modes: stage | refresh | ahead [miles] | live [--every 5] [--speed 6] | restore | before | after [--low \"Name=minutes\"]");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
