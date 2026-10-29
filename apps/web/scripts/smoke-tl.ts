/** Prints the dispatcher read model from a seeded database. DATABASE_URL=... npx tsx scripts/smoke-tl.ts */
import { agingFor, analyticsFor, listBoardRows } from "../src/server/tl/queries";

async function main() {
  const rows = await listBoardRows();
  const byVerdict: Record<string, number> = {};
  for (const r of rows) byVerdict[r.verdict ?? "none"] = (byVerdict[r.verdict ?? "none"] ?? 0) + 1;
  console.log("board rows", rows.length, byVerdict);
  const a = rows.find((r) => r.loadNumber === "DM-40001");
  console.log("A2 load", a && { quoted: a.quotedRevenue, miles: a.totalMiles, perMile: a.perMile?.toFixed(2), verdict: a.verdict, floor: a.floorPerMile?.toFixed(2) });
  const an = await analyticsFor("all");
  console.log("analytics all", { loads: an.summary.loadCount, gross: an.summary.grossRevenue, avgRpm: an.summary.avgRpm?.toFixed(2), lanes: an.summary.topLanes.length, months: an.monthly.length, disparity: an.disparity?.benchmarkedLoadCount });
  console.log("aging", await agingFor());
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => process.exit(0));
