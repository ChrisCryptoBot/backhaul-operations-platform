/**
 * The demo's conversations: a few threads that read like a dispatch day, including the "sent, no answer" case the Alerts page raises.
 * Run on its own against an already-seeded database (DATABASE_URL=... npx tsx scripts/seed-messages.ts) or through seed-demo.ts, which calls seedMessages.
 * It replaces the workspace's threads each time, so running it twice leaves one set.
 */
import { PrismaClient } from "@prisma/client";

const MIN = 60_000;

type Line = { dir: "out" | "in" | "system"; body: string; minutesAgo: number; about?: boolean; read?: boolean };

const SCRIPTS: Line[][] = [
  [
    { dir: "out", body: "Are you on your way to the pickup?", minutesAgo: 300, about: true },
    { dir: "in", body: "Leaving the yard now, about 40 minutes out.", minutesAgo: 292, read: true },
    { dir: "out", body: "Thanks. Let me know when you are loaded.", minutesAgo: 240 },
    { dir: "in", body: "Loaded and rolling. BOL says 38 pallets.", minutesAgo: 118, about: true }
  ],
  [
    { dir: "system", body: "Load sent to the driver. No answer yet.", minutesAgo: 900, about: true },
    { dir: "out", body: "Can you confirm the load I sent? The broker wants an answer today.", minutesAgo: 860, about: true }
  ],
  [
    { dir: "in", body: "Reefer is showing 41. Is that ok?", minutesAgo: 34, about: true },
    { dir: "in", body: "Also the dock is backed up about two hours.", minutesAgo: 22, about: true }
  ],
  [
    { dir: "out", body: "The pickup time moved. Check the load.", minutesAgo: 1700 },
    { dir: "in", body: "Got it, thanks.", minutesAgo: 1690, read: true }
  ]
];

export async function seedMessages(prisma: PrismaClient, workspaceId: string, now = Date.now()): Promise<number> {
  await prisma.thread.deleteMany({ where: { workspaceId } });
  const drivers = await prisma.driver.findMany({ where: { workspaceId, active: true }, orderBy: { name: "asc" }, take: SCRIPTS.length });
  let made = 0;
  for (const [i, driver] of drivers.entries()) {
    const lines = SCRIPTS[i]!;
    const assignment = await prisma.assignment.findFirst({
      where: { driverId: driver.id, load: { workspaceId, deletedAt: null, status: { in: ["draft", "accepted", "in_progress"] } } },
      select: { loadId: true, load: { select: { loadNumber: true } } }
    });
    const last = new Date(now - Math.min(...lines.map((l) => l.minutesAgo)) * MIN);
    const thread = await prisma.thread.create({ data: { workspaceId, driverId: driver.id, lastMessageAt: last } });
    for (const l of lines) {
      const sentAt = new Date(now - l.minutesAgo * MIN);
      await prisma.message.create({
        data: {
          threadId: thread.id,
          direction: l.dir,
          body: l.dir === "system" && assignment?.load.loadNumber ? `${assignment.load.loadNumber} sent to ${driver.name}. No answer yet.` : l.body,
          loadId: l.about ? (assignment?.loadId ?? null) : null,
          sentAt,
          readAt: l.dir === "in" && l.read ? sentAt : null
        }
      });
      made += 1;
    }
  }
  return made;
}

// Run directly: seed the demo workspace of whatever DATABASE_URL points at.
if (process.argv[1] && /seed-messages\.(ts|js)$/.test(process.argv[1])) {
  const prisma = new PrismaClient();
  void (async () => {
    const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
    if (!ws) throw new Error("No workspace: seed the demo first (scripts/seed-demo.ts).");
    console.log("messages seeded:", await seedMessages(prisma, ws.id));
  })()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
