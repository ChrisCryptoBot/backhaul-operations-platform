/**
 * Put a person on a desk by hand (the first admin of the demo desk, say, before sign-in is switched on).
 *
 *   DATABASE_URL=... npx tsx scripts/add-member.ts <workspaceId> <email> "<name>" <viewer|dispatcher|accounting|admin>
 *
 * The person signs in with that email; the first verified sign-in binds their provider user id to the row. It skips the plan's seat limit on purpose (a person setting a desk up
 * is the one who may), and says if the person is already on a desk.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const [workspaceId, rawEmail, name, role] = process.argv.slice(2);
  if (!workspaceId || !rawEmail || !name || !["viewer", "dispatcher", "accounting", "admin"].includes(role ?? "")) throw new Error('Usage: add-member.ts <workspaceId> <email> "<name>" <viewer|dispatcher|accounting|admin>');
  const email = rawEmail.trim().toLowerCase();
  if (!(await prisma.workspace.findUnique({ where: { id: workspaceId } }))) throw new Error(`No workspace ${workspaceId}.`);
  const there = await prisma.member.findFirst({ where: { email } });
  if (there) throw new Error(`${email} is already on workspace ${there.workspaceId}.`);
  const m = await prisma.member.create({ data: { workspaceId, email, name, role: role! } });
  console.log(`${name} <${email}> added to ${workspaceId} as ${role} (${m.id}). They sign in with that email.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
