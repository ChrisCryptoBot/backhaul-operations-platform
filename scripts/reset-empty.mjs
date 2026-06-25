// Reset the dev database to an EMPTY-but-usable state.
//
// Deletes all operational + reference + config content (loads, snapshots, rate
// confirmations, brokers/reps, lanes, drop lots, distribution centers, rules,
// region config, LLM settings, audit log) so every area of the app renders its
// empty state and can be populated from scratch through the UI.
//
// Keeps the minimum the app needs to boot and accept writes:
//   - the Northeast (NE) region (resolvePhase1RegionId requires a region),
//   - an ADMIN user matching the BYPASS_AUTH actor id "dev-bypass-user"
//     (load/rule/etc. writes set createdById/actorId to this id),
//   - the showcase-user ADMIN membership (harmless; kept if present).
//
// This does NOT touch scripts/seed-showcase.mjs — re-run that anytime to put the
// demo data back. Run:  node scripts/reset-empty.mjs   (from backhaul-rewrite/)

import { PrismaClient, Role } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.$transaction(
    async (tx) => {
      // Ensure the bootstrap region exists (kept across the wipe).
      const region = await tx.region.upsert({
        where: { code: "NE" },
        update: { name: "Northeast" },
        create: { code: "NE", name: "Northeast" }
      });

      // Delete content in FK-safe order (children before parents).
      await tx.auditLog.deleteMany({});
      await tx.loadLeg.deleteMany({});
      await tx.load.deleteMany({});
      await tx.rateConfirmation.deleteMany({});
      await tx.weekSnapshot.deleteMany({});
      await tx.fuelSurchargeIndex.deleteMany({});
      await tx.operationalRule.deleteMany({});
      await tx.brokerRep.deleteMany({});
      await tx.broker.deleteMany({});
      await tx.lane.deleteMany({});
      await tx.dropLot.deleteMany({});
      await tx.distributionCenter.deleteMany({});
      await tx.regionConfig.deleteMany({});
      await tx.llmProviderConfig.deleteMany({});

      // Ensure an ADMIN user that matches the BYPASS_AUTH actor so UI writes work.
      const bypassUser = await tx.user.upsert({
        where: { id: "dev-bypass-user" },
        update: { email: "dev-bypass@local.dev", name: "Dev Admin" },
        create: { id: "dev-bypass-user", email: "dev-bypass@local.dev", name: "Dev Admin" }
      });
      await tx.userRegionRole.upsert({
        where: { userId_regionId: { userId: bypassUser.id, regionId: region.id } },
        update: { role: Role.ADMIN },
        create: { userId: bypassUser.id, regionId: region.id, role: Role.ADMIN }
      });

      // Keep the seeded showcase user usable too, if it still exists.
      const showcaseUser = await tx.user.findUnique({ where: { id: "showcase-user" } });
      if (showcaseUser) {
        await tx.userRegionRole.upsert({
          where: { userId_regionId: { userId: showcaseUser.id, regionId: region.id } },
          update: { role: Role.ADMIN },
          create: { userId: showcaseUser.id, regionId: region.id, role: Role.ADMIN }
        });
      }
    },
    { maxWait: 20000, timeout: 120000 }
  );

  console.log("Reset complete — DB is empty except the NE region + admin user.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
