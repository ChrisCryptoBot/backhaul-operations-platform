import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SECRET_ENV, WEBHOOK_SECRET_ENV } from "@/truelane/partners/contract";
import { BRIDGE_ENV } from "@/server/bridge/core";

/**
 * docs/ENVIRONMENT.md names every variable the desk reads, and nothing in it is a value. A variable added to the source and left out of that page fails here.
 */
const root = path.join(__dirname, "..");
const doc = fs.readFileSync(path.join(root, "../../docs/ENVIRONMENT.md"), "utf8");

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
};

const read = (dirs: string[]) => dirs.flatMap((d) => walk(path.join(root, d))).map((f) => fs.readFileSync(f, "utf8"));
const named = (texts: string[]): Set<string> => {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)|process\.env\[["']([A-Z][A-Z0-9_]+)["']\]/g)) out.add((m[1] ?? m[2])!);
  return out;
};

describe("the environment page", () => {
  it("names every variable the application reads", () => {
    const names = named(read(["src", "scripts"]));
    const missing = [...names].filter((n) => !doc.includes(`\`${n}\``) && !doc.includes(n));
    expect(missing).toEqual([]);
  });

  it("names the driver link's three, and every partner company's keys and webhook secrets", () => {
    for (const n of Object.values(BRIDGE_ENV)) expect(doc, n).toContain(n);
    for (const names of Object.values(SECRET_ENV)) for (const n of names) expect(doc, n).toContain(n);
    for (const n of Object.values(WEBHOOK_SECRET_ENV)) expect(doc, n).toContain(n);
    expect(doc).toContain("DEMO_LOGIN");
  });

  it("holds no secret value: no key, secret, token or address is assigned", () => {
    // A switch can be shown with its setting (DESK_AUTH=on); a key, a secret, a token or an address never is.
    expect(doc).not.toMatch(/\b[A-Z][A-Z0-9_]*(KEY|SECRET|TOKEN|URL)=\S/);
    expect(doc).not.toMatch(/sk[-_](live|test)_|postgres(ql)?:\/\/[^\s`]*:[^\s`]*@/i);
  });
});
