import { AsyncLocalStorage } from "node:async_hooks";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { NotSignedIn, authOn, sessionIdentity } from "./identity";
// Registers how a time on a page finds the carrier's zone (src/lib/tz.ts); every server path that knows a workspace loads it.
import "./zone";

/**
 * The tenancy seam. The demo has one workspace; TrueLane's user_id / Clerk org id replaces `currentWorkspaceId` later without touching callers.
 * Every read and write in the desk asks for its workspace here (a function's `workspaceId` parameter defaults to it), so no screen or action is tied to the demo's id.
 * `DEMO_WORKSPACE_ID` is only the default, the seed's and the tests' id; tests/workspace-guard.test.ts keeps it out of everything else.
 */
export const DEMO_WORKSPACE_ID = "demo-workspace";

/**
 * The cookie that names the workspace, honoured only while DESK_WORKSPACE_COOKIE=on AND not in production (a development and test seam: anyone can set it, so it is never
 * trusted where it could be read as a way in). With sign-in on it is not read at all; the workspace comes from the signed-in person's desk session.
 */
export const WORKSPACE_COOKIE = "desk-workspace";
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The workspace of the request being served. With sign-in on it is the signed-in person's workspace, and when nobody is signed in it is an error, never the demo's data. With
 * sign-in off it is the demo's, unless a development cookie names another, or when there is no request at all (a script, a test).
 */
/**
 * Explicit tenancy (money plan Wave 7, the read API). A request that does not come from a person (the partner read API, outbound deliveries) names its workspace from its own credential and
 * runs inside `explicitTenancy`. Inside it `currentWorkspaceId()` throws, sign-in on or off: with sign-in off it would otherwise answer the demo's id without a word, so a read that forgot
 * to pass its workspace would serve the demo fleet's rows to a stranger. Every function such code calls must be given the workspace; this makes forgetting a loud error, not a leak.
 */
const tenancy = new AsyncLocalStorage<{ workspaceId: string }>();

export class ImplicitWorkspace extends Error {
  constructor() {
    super("This request names its workspace explicitly: pass workspaceId, never the request's default.");
    this.name = "ImplicitWorkspace";
  }
}

export function explicitTenancy<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  if (!ID.test(workspaceId)) return Promise.reject(new Error("Not a workspace id."));
  return tenancy.run({ workspaceId }, fn);
}

/** The workspace an explicit-tenancy request named, or null outside one. For checks and tests; code reads its own `workspaceId` parameter. */
export const explicitWorkspaceId = (): string | null => tenancy.getStore()?.workspaceId ?? null;

export function currentWorkspaceId(): string {
  if (tenancy.getStore()) throw new ImplicitWorkspace();
  if (authOn()) {
    const id = sessionIdentity();
    if (!id) throw new NotSignedIn();
    return id.workspaceId;
  }
  if (process.env.DESK_WORKSPACE_COOKIE !== "on" || process.env.NODE_ENV === "production") return DEMO_WORKSPACE_ID;
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
    create: { id: DEMO_WORKSPACE_ID, name: "Demo fleet", plan: "pro" }
  });
}
