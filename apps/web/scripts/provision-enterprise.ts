/**
 * Set up a large fleet by hand (a person's job: the enterprise door makes no account on its own).
 *
 *   DATABASE_URL=... npx tsx scripts/provision-enterprise.ts --list          open enterprise requests
 *   DATABASE_URL=... npx tsx scripts/provision-enterprise.ts <requestId>     make the workspace for one and mark the request provisioned
 *
 * It makes the workspace (named for the company, plan "enterprise") and links the request to it. It does not invite anyone: with sign-in off there is nobody to
 * invite, and when sign-in is on the invitation is sent from the provider's own dashboard. It never touches an existing workspace and refuses a request that is
 * already provisioned, so running it twice cannot make two.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const arg = process.argv[2];
  if (!arg || arg === "--list") {
    const open = await prisma.signupRequest.findMany({ where: { kind: "enterprise", status: { in: ["open", "contacted"] } }, orderBy: { createdAt: "asc" } });
    if (open.length === 0) console.log("No open enterprise requests.");
    for (const r of open) console.log(`${r.id}  ${r.createdAt.toISOString().slice(0, 16)}  ${r.company} (${r.trucks} trucks)  ${r.name} <${r.email}>  ${r.phone ?? r.bestTime ?? ""}`);
    return;
  }
  const req = await prisma.signupRequest.findUnique({ where: { id: arg } });
  if (!req) throw new Error(`No request with id ${arg}.`);
  if (req.kind !== "enterprise") throw new Error("That is a self-serve request; only enterprise requests are set up by hand.");
  if (req.workspaceId || req.status === "provisioned") throw new Error(`Already provisioned (workspace ${req.workspaceId ?? "?"}).`);
  const ws = await prisma.workspace.create({ data: { name: req.company, plan: "enterprise" } });
  await prisma.signupRequest.update({ where: { id: req.id }, data: { status: "provisioned", workspaceId: ws.id } });
  console.log(`Workspace ${ws.id} made for ${req.company}. Next: invite ${req.email}.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
