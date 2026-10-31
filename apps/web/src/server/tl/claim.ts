import type { Prisma } from "@prisma/client";

/**
 * A move on a load is made from the state it was read in, not from whatever it has become: the write names the state it expects, and if somebody else's move got there first
 * (a double click, a second tab, a retry) it finds nothing to move and says so, instead of overwriting their work, writing the audit entry twice, or stranding the load.
 * Used inside the transaction that also writes the audit entry, so a move that does not happen leaves no entry either.
 */
export const MOVED = "That load changed while you were working on it. Reload it to see where it stands now.";

export class LoadMoved extends Error {
  constructor(message: string = MOVED) {
    super(message);
    this.name = "LoadMoved";
  }
}

type Tx = Prisma.TransactionClient;

/** Move a load that is in one of `from`, and still on the desk, or throw `LoadMoved`. `extra` narrows it further (not invoiced, not on a statement). */
export async function claimLoad(tx: Tx, loadId: string, workspaceId: string, from: readonly string[], data: Prisma.LoadUpdateManyMutationInput, extra: Prisma.LoadWhereInput = {}): Promise<void> {
  // A claim that changes nothing still has to count as a move: an update with no fields would report no rows, so it touches the row's time.
  const set = Object.keys(data).length === 0 ? { updatedAt: new Date() } : data;
  const out = await tx.load.updateMany({ where: { id: loadId, workspaceId, deletedAt: null, status: { in: [...from] }, ...extra }, data: set });
  if (out.count !== 1) throw new LoadMoved();
}

/** Move a load's assignment that is in one of `from`, or throw `LoadMoved`. */
export async function claimAssignment(tx: Tx, loadId: string, from: readonly string[], data: Prisma.AssignmentUpdateManyMutationInput): Promise<void> {
  const out = await tx.assignment.updateMany({ where: { loadId, status: { in: [...from] } }, data });
  if (out.count !== 1) throw new LoadMoved();
}

/** Take a load's assignment off, once: a second try finds none to take and throws `LoadMoved`. */
export async function dropAssignment(tx: Tx, loadId: string): Promise<void> {
  const out = await tx.assignment.deleteMany({ where: { loadId } });
  if (out.count !== 1) throw new LoadMoved();
}
