import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * A filed IFTA quarter is locked (money plan Wave 5 step 8): nothing the return was worked out from may be replaced while a filed return holds the quarter: not its rates (commit, clear, sample),
 * not its miles (ELD read, routed fallback), not a fuel file with a purchase in it. Each writer asks here inside its own transaction, after taking the workspace lock, so a filing and a write can
 * never interleave. Reopening the return (server/partners/ifta-filing.ts) frees the quarter.
 */
type Db = Pick<Prisma.TransactionClient, "iftaReturn"> | typeof prisma;

/** The quarters of these that a filed return holds. */
export async function filedQuarters(db: Db, workspaceId: string, quarters: readonly string[]): Promise<Set<string>> {
  if (quarters.length === 0) return new Set();
  const rows = await db.iftaReturn.findMany({ where: { workspaceId, status: "filed", quarter: { in: [...new Set(quarters)] } }, select: { quarter: true } });
  return new Set(rows.map((r) => r.quarter));
}

export async function isQuarterFiled(db: Db, workspaceId: string, quarter: string): Promise<boolean> {
  return (await filedQuarters(db, workspaceId, [quarter])).has(quarter);
}

/** The words every refusal uses. */
export const filedRefusal = (quarters: string | readonly string[]): string => {
  const list = typeof quarters === "string" ? [quarters] : [...quarters].sort();
  return `${list.join(", ")} ${list.length === 1 ? "is" : "are"} filed. Reopen the return on IFTA first if this really needs to change.`;
};
