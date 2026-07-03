import { getKpiDashboard } from "../src/server/kpi-dashboard";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const region = await prisma.region.findFirst();
  if (!region) throw new Error("No region");

  const result = await getKpiDashboard({
    regionId: region.id,
    weekIso: "2026-W27"
  });

  console.log(JSON.stringify(result.opsAnalytics, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
