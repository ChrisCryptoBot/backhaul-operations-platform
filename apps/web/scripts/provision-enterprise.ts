/**
 * Set up a large fleet by hand (a person's job: the enterprise door makes no account on its own).
 *
 *   DATABASE_URL=... npx tsx scripts/provision-enterprise.ts --list          open enterprise requests
 *   DATABASE_URL=... npx tsx scripts/provision-enterprise.ts <requestId>     make the workspace for one and mark the request provisioned
 *
 * It makes the workspace (named for the company, on the plan its trucks fall in: the count is the visitor's own, so it is printed here for a person to confirm and change
 * on the workspace if it is wrong) and links the request to it. It does not invite anyone: with sign-in off there is nobody to
 * invite, and when sign-in is on the invitation is sent from the provider's own dashboard. It never touches an existing workspace and refuses a request that is
 * already provisioned, so running it twice cannot make two.
 */
import { PrismaClient } from "@prisma/client";
import { planForTruckCount } from "../src/lib/plans";

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
  // The request is claimed and the workspace made in one transaction, so two runs cannot make two, and a declined request cannot be provisioned.
  const plan = planForTruckCount(req.trucks ?? 0).key;
  const ws = await prisma.$transaction(async (tx) => {
    const claimed = await tx.signupRequest.updateMany({ where: { id: req.id, status: { in: ["open", "contacted"] }, workspaceId: null }, data: { status: "provisioned" } });
    if (claimed.count !== 1) throw new Error("That request is no longer open (already provisioned, or declined).");
    const made = await tx.workspace.create({ data: { name: req.company, plan } });
    // The person who asked is the desk's first owner. They sign in with this email and are on the desk; they add the rest of the team in Settings.
    await tx.member.create({ data: { workspaceId: made.id, email: req.email.trim().toLowerCase(), name: req.name, role: "owner" } });
    await tx.signupRequest.update({ where: { id: req.id }, data: { workspaceId: made.id } });
    return made;
  });
  console.log(`Workspace ${ws.id} made for ${req.company} on the ${plan} plan (they say ${req.trucks ?? "?"} trucks; confirm it). Their email is the desk's first owner; they sign in with it. Nothing is sent to them.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
