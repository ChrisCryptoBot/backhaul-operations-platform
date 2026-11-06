/**
 * The demo's detention evidence: two recently delivered loads whose trucks have position fixes (made up, like everything in the demo), so the evidence sheet and the Invoices card have something to show.
 *   DM-EV-01: the truck sat at the shipper for four and a half hours, fixes every fifteen minutes: a good track.
 *   DM-EV-02: the truck sat at a plant for about three hours, fixes only every seventy minutes: a thin track.
 * It writes the loads and the fixes only. The evidence itself is frozen by the same catch-up the heartbeat runs (POST /signals/cron, or /partners/cron before it deletes fixes), so the demo shows the real path.
 * Opt-in, and deliberately NOT part of seed-demo.ts: the demo's baseline (31 finished loads and the totals the tests pin) must stay as it is. Run it on its own against an already-seeded database
 * (DATABASE_URL=... npx tsx scripts/seed-evidence-demo.ts), then POST /signals/cron once to freeze the evidence. Running it twice leaves one set. `--remove` takes the two loads (and their fixes) away again.
 */
import { PrismaClient } from "@prisma/client";

const MIN = 60_000;
const miles = (p: { lat: number; lng: number }, m: number) => ({ lat: p.lat + m / 69.09, lng: p.lng });

type Place = { name: string; address: string; lat: number; lng: number };
const DALLAS: Place = { name: "Harbor Foods dock 4 (sample)", address: "Dallas, TX", lat: 32.8, lng: -96.87 };
const OKC: Place = { name: "Plains Cold Storage (sample)", address: "Oklahoma City, OK", lat: 35.47, lng: -97.52 };
const FW: Place = { name: "Lone Star Plastics (sample)", address: "Fort Worth, TX", lat: 32.76, lng: -97.33 };
const WACO: Place = { name: "Brazos Distribution (sample)", address: "Waco, TX", lat: 31.55, lng: -97.15 };

export async function seedEvidenceDemo(prisma: PrismaClient, workspaceId: string, now = Date.now()): Promise<number> {
  const trucks = await prisma.vehicle.findMany({ where: { workspaceId, terminal: { not: null } }, orderBy: { name: "asc" }, take: 2 });
  if (trucks.length < 2) return 0;
  const at = (minutes: number) => new Date(now + minutes * MIN);
  await prisma.load.deleteMany({ where: { workspaceId, loadNumber: { in: ["DM-EV-01", "DM-EV-02"] } } });

  const make = async (n: string, truck: { id: string }, from: Place, to: Place, doneAgo: number, customer: string) => {
    const load = await prisma.load.create({
      data: {
        workspaceId,
        vehicleId: truck.id,
        loadNumber: n,
        status: "completed",
        brokerName: customer,
        originAddress: from.address,
        destinationAddress: to.address,
        quotedRevenue: 1850,
        actualRevenue: 1850,
        loadedMiles: 210,
        completedAt: at(-doneAgo),
        scheduledDate: at(-doneAgo - 600),
        snapshotDetentionRate: 75,
        snapshotFreeGraceMinutes: 120,
        stops: {
          create: [
            { stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: from.address, facilityName: from.name, lat: from.lat, lng: from.lng, timeWindowEarliest: at(-doneAgo - 560), timeWindowLatest: at(-doneAgo - 500) },
            { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: to.address, facilityName: to.name, lat: to.lat, lng: to.lng, timeWindowEarliest: at(-doneAgo - 40), timeWindowLatest: at(-doneAgo + 20) }
          ]
        }
      }
    });
    return load;
  };

  const fixes = (truck: { id: string }, from: Place, to: Place, doneAgo: number, dwellEveryMin: number, dwellStart: number, dwellEnd: number) => {
    const rows: Array<{ m: number; p: { lat: number; lng: number } }> = [];
    rows.push({ m: -doneAgo - dwellStart - dwellEveryMin, p: miles(from, 0.7) });
    for (let m = -doneAgo - dwellStart; m <= -doneAgo - dwellEnd; m += dwellEveryMin) rows.push({ m, p: miles(from, 0.05) });
    rows.push({ m: -doneAgo - dwellEnd + dwellEveryMin, p: miles(from, 0.7) });
    // The delivery: a short stop under the free time.
    rows.push({ m: -doneAgo - 70, p: miles(to, 0.7) });
    for (const m of [-doneAgo - 55, -doneAgo - 40, -doneAgo - 25, -doneAgo - 10]) rows.push({ m, p: miles(to, 0.05) });
    rows.push({ m: -doneAgo + 5, p: miles(to, 0.7) });
    return rows.map((f) => ({ workspaceId, vehicleId: truck.id, lat: f.p.lat, lng: f.p.lng, at: at(f.m) }));
  };

  const a = trucks[0]!;
  const b = trucks[1]!;
  await make("DM-EV-01", a, DALLAS, OKC, 180, "Harbor Foods (sample)");
  await prisma.vehiclePing.createMany({ data: fixes(a, DALLAS, OKC, 180, 15, 520, 250), skipDuplicates: true });
  await make("DM-EV-02", b, FW, WACO, 150, "Lone Star Plastics (sample)");
  await prisma.vehiclePing.createMany({ data: fixes(b, FW, WACO, 150, 70, 480, 300), skipDuplicates: true });
  return 2;
}

/** Takes the two sample loads away (their stops and evidence go with them) and the made-up fixes of the last day that belong to their trucks' sample tracks. */
export async function removeEvidenceDemo(prisma: PrismaClient, workspaceId: string, now = Date.now()): Promise<number> {
  const loads = await prisma.load.findMany({ where: { workspaceId, loadNumber: { in: ["DM-EV-01", "DM-EV-02"] } }, select: { id: true, vehicleId: true } });
  const trucks = loads.map((l) => l.vehicleId).filter((v): v is string => v != null);
  await prisma.load.deleteMany({ where: { id: { in: loads.map((l) => l.id) } } });
  if (trucks.length > 0) await prisma.vehiclePing.deleteMany({ where: { workspaceId, vehicleId: { in: trucks }, at: { gte: new Date(now - 24 * 3_600_000 * 2), lte: new Date(now + 3_600_000) }, lat: { lt: 36.5 }, lng: { lt: -96 } } });
  return loads.length;
}

// Run directly: seed the demo workspace of whatever DATABASE_URL points at.
if (process.argv[1] && /seed-evidence-demo\.(ts|js)$/.test(process.argv[1])) {
  const prisma = new PrismaClient();
  void (async () => {
    const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
    if (!ws) throw new Error("No workspace: seed the demo first (scripts/seed-demo.ts).");
    if (process.argv.includes("--remove")) {
      const gone = await removeEvidenceDemo(prisma, ws.id);
      console.log("evidence demo loads removed:", gone);
    } else console.log("evidence demo loads seeded:", await seedEvidenceDemo(prisma, ws.id));
  })()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
