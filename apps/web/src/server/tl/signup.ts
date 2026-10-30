import { prisma } from "@/lib/db";
import { checkRequest, kindFor, parseTrucks, type RequestErrors, type RequestValues, type SignupKind } from "@/lib/signup";

/**
 * Requests for an account. The kind (self-serve or enterprise) is worked out here from the truck count; the form never chooses it.
 * A request is not tied to a workspace: none exists yet. A person (or, later, the sign-up itself) makes the workspace and fills `workspaceId`.
 */
export type SaveRequestResult = { ok: true; id: string; kind: SignupKind; repeat: boolean } | { ok: false; errors: RequestErrors };

const DAY = 24 * 3_600_000;

export async function saveSignupRequest(v: RequestValues): Promise<SaveRequestResult> {
  const trucks = parseTrucks(v.trucks);
  const kind = kindFor(trucks ?? 1);
  const errors = checkRequest(v, kind);
  if (Object.keys(errors).length > 0 || trucks == null) return { ok: false, errors };

  // The same person asking twice in a day (a double click, a refresh) is one request, not two.
  const email = v.email.toLowerCase();
  const again = await prisma.signupRequest.findFirst({ where: { email, kind, createdAt: { gte: new Date(Date.now() - DAY) } }, select: { id: true } });
  if (again) return { ok: true, id: again.id, kind, repeat: true };

  const row = await prisma.signupRequest.create({
    data: {
      kind,
      name: v.name,
      company: v.company,
      role: v.role || null,
      email,
      phone: v.phone || null,
      trucks,
      mcNumber: v.mcNumber || null,
      bestTime: v.bestTime || null,
      note: v.note || null
    },
    select: { id: true }
  });
  return { ok: true, id: row.id, kind, repeat: false };
}

export async function listSignupRequests(limit = 200) {
  return prisma.signupRequest.findMany({ orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: limit });
}
