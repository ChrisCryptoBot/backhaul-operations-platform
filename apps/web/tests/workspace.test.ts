import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The workspace seam. Every read and write asks `currentWorkspaceId()` for its workspace, so the day a login names the workspace nothing else changes.
 * The demo's id is the seed's, the tests' and the seam's default; anywhere else it is a screen or an action tied to one workspace, and this fails.
 */
const SRC = path.join(__dirname, "..", "src");
const SEAM = path.join("server", "tl", "workspace.ts");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "truelane" ? [] : files(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("the workspace seam", () => {
  it("keeps the demo workspace's id out of every file but the seam", () => {
    const offenders = files(SRC)
      .filter((f) => !f.endsWith(SEAM))
      .filter((f) => readFileSync(f, "utf8").includes("DEMO_WORKSPACE_ID"))
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("names no workspace by string in the desk's own source", () => {
    const offenders = files(SRC)
      .filter((f) => !f.endsWith(SEAM))
      .filter((f) => /["'`]demo-workspace["'`]/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});

describe("currentWorkspaceId", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("next/headers");
    vi.resetModules();
  });

  async function loadWith(cookie: string | undefined, env: string | undefined) {
    vi.resetModules();
    if (env === undefined) vi.stubEnv("DESK_WORKSPACE_COOKIE", "");
    else vi.stubEnv("DESK_WORKSPACE_COOKIE", env);
    vi.doMock("next/headers", () => ({ cookies: () => ({ get: (name: string) => (name === "desk-workspace" && cookie !== undefined ? { value: cookie } : undefined) }) }));
    vi.doMock("@/lib/db", () => ({ prisma: {} }));
    return import("@/server/tl/workspace");
  }

  it("is the demo workspace outside a request", async () => {
    vi.resetModules();
    vi.doMock("next/headers", () => ({
      cookies: () => {
        throw new Error("cookies() was called outside a request scope");
      }
    }));
    vi.doMock("@/lib/db", () => ({ prisma: {} }));
    vi.stubEnv("DESK_WORKSPACE_COOKIE", "on");
    const w = await import("@/server/tl/workspace");
    expect(w.currentWorkspaceId()).toBe(w.DEMO_WORKSPACE_ID);
  });

  it("ignores the cookie unless the seam is switched on", async () => {
    const w = await loadWith("ws-other", undefined);
    expect(w.currentWorkspaceId()).toBe(w.DEMO_WORKSPACE_ID);
  });

  it("reads the cookie when the seam is on, and only a plain id", async () => {
    const on = await loadWith("ws-other", "on");
    expect(on.currentWorkspaceId()).toBe("ws-other");
    const bad = await loadWith("a b; drop table", "on");
    expect(bad.currentWorkspaceId()).toBe(bad.DEMO_WORKSPACE_ID);
    const none = await loadWith(undefined, "on");
    expect(none.currentWorkspaceId()).toBe(none.DEMO_WORKSPACE_ID);
  });
});
