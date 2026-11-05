import type { Prisma } from "@prisma/client";
import { nextDriverCode } from "@/lib/driver-code";

type Db = Pick<Prisma.TransactionClient, "driver">;

/** The codes a fleet already uses (every driver, active or not, since a code is never reused for someone else). */
export async function takenCodes(db: Db, workspaceId: string): Promise<Set<string>> {
  const rows = await db.driver.findMany({ where: { workspaceId, code: { not: null } }, select: { code: true } });
  return new Set(rows.map((r) => r.code!));
}

/** The next free code for a new driver: JSMI, then JSMI2, JSMI3. */
export async function allocateDriverCode(db: Db, workspaceId: string, name: string): Promise<string> {
  return nextDriverCode(name, await takenCodes(db, workspaceId));
}

/** Codes for a batch of new drivers in order, against the fleet's and each other's, so two Smiths in one file get JSMI and JSMI2. */
export async function allocateDriverCodes(db: Db, workspaceId: string, names: string[]): Promise<string[]> {
  const taken = await takenCodes(db, workspaceId);
  return names.map((n) => {
    const code = nextDriverCode(n, taken);
    taken.add(code);
    return code;
  });
}
