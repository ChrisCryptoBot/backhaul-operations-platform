import { cookies } from "next/headers";
import { prisma } from "@/lib/db";

/**
 * The tenancy seam. The demo has one workspace; TrueLane's user_id / Clerk org id replaces `currentWorkspaceId` later without touching callers.
 * Every read and write in the desk asks for its workspace here (a function's `workspaceId` parameter defaults to it), so no screen or action is tied to the demo's id.
 * `DEMO_WORKSPACE_ID` is only the default, the seed's and the tests' id; tests/workspace-guard.test.ts keeps it out of everything else.
 */
export const DEMO_WORKSPACE_ID = "demo-workspace";

/** The cookie that names the workspace, honoured only while DESK_WORKSPACE_COOKIE=on (a development and test seam; there is no login yet to make it safe to trust). */
export const WORKSPACE_COOKIE = "desk-workspace";
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The workspace of the request being served, or the demo's when there is no request (a script, a test) or the seam is off. */
export function currentWorkspaceId(): string {
  if (process.env.DESK_WORKSPACE_COOKIE !== "on") return DEMO_WORKSPACE_ID;
  try {
    const v = cookies().get(WORKSPACE_COOKIE)?.value;
    return v && ID.test(v) ? v : DEMO_WORKSPACE_ID;
  } catch {
    return DEMO_WORKSPACE_ID;
  }
}

/**
 * The current workspace's record. The demo's is created on first use so an empty database still works; any other workspace is made by whoever provisions it,
 * never by a request, so one that does not exist is an error rather than a quiet switch to the demo's data.
 */
export async function currentWorkspace() {
  const id = currentWorkspaceId();
  if (id !== DEMO_WORKSPACE_ID) return prisma.workspace.findUniqueOrThrow({ where: { id } });
  return prisma.workspace.upsert({
    where: { id: DEMO_WORKSPACE_ID },
    update: {},
    create: { id: DEMO_WORKSPACE_ID, name: "Demo fleet" }
  });
}
