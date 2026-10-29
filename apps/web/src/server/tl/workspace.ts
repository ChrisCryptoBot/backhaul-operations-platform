import { prisma } from "@/lib/db";

/**
 * The tenancy seam. The demo has one workspace; TrueLane's user_id / Clerk org id replaces this later without
 * touching callers. Created on first use so an empty database still works.
 */
export const DEMO_WORKSPACE_ID = "demo-workspace";

export async function currentWorkspace() {
  return prisma.tlWorkspace.upsert({
    where: { id: DEMO_WORKSPACE_ID },
    update: {},
    create: { id: DEMO_WORKSPACE_ID, name: "Demo fleet" }
  });
}
