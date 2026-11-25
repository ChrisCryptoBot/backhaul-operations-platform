import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { CLAIM_STATUS_LABEL, CLAIM_TYPE_LABEL, validateClaimCreate, validateClaimUpdate, type ClaimCreateInput, type ClaimStatus, type ClaimType, type ClaimUpdateInput } from "@/lib/claims";
import type { Terminals } from "@/lib/scope";
import { recordAudit } from "./audit";
import { numOrNull } from "./convert";
import { allowedFor, loadInScope } from "./scope";
import { inTerminal } from "./terminal-sql";
import { currentWorkspaceId } from "./workspace";

export type LoadClaimRow = {
  id: string;
  loadId: string;
  type: ClaimType;
  pieces: number | null;
  amount: number | null;
  claimant: string | null;
  externalNumber: string | null;
  openedAt: Date;
  ackBy: Date;
  decideBy: Date;
  status: ClaimStatus;
  note: string | null;
  createdAt: Date;
};

export type ClaimResult = { ok: true; id: string } | { ok: false; error: string };

const toRow = (c: {
  id: string;
  loadId: string;
  type: string;
  pieces: number | null;
  amount: Prisma.Decimal | null;
  claimant: string | null;
  externalNumber: string | null;
  openedAt: Date;
  ackBy: Date;
  decideBy: Date;
  status: string;
  note: string | null;
  createdAt: Date;
}): LoadClaimRow => ({
  id: c.id,
  loadId: c.loadId,
  type: c.type as ClaimType,
  pieces: c.pieces,
  amount: numOrNull(c.amount),
  claimant: c.claimant,
  externalNumber: c.externalNumber,
  openedAt: c.openedAt,
  ackBy: c.ackBy,
  decideBy: c.decideBy,
  status: c.status as ClaimStatus,
  note: c.note,
  createdAt: c.createdAt
});

export async function listLoadClaims(loadId: string, workspaceId = currentWorkspaceId(), allowed?: Terminals): Promise<LoadClaimRow[]> {
  const scope = await allowedFor(workspaceId, allowed);
  if (!(await loadInScope(loadId, workspaceId, scope))) return [];
  const rows = await prisma.loadClaim.findMany({
    where: { workspaceId, loadId },
    orderBy: [{ openedAt: "desc" }, { id: "desc" }]
  });
  return rows.map(toRow);
}

export async function createLoadClaim(loadId: string, raw: ClaimCreateInput, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals): Promise<ClaimResult> {
  const scope = await allowedFor(workspaceId, allowed);
  const check = validateClaimCreate(raw, now);
  if (!check.ok) return check;
  const v = check.value;
  const load = await prisma.load.findFirst({
    where: { id: loadId, workspaceId, deletedAt: null, status: { not: "quote" }, ...inTerminal(scope) },
    select: { id: true, loadNumber: true, brokerName: true }
  });
  if (!load) return { ok: false, error: "That load does not exist." };
  const amountDec = v.amount != null ? new Prisma.Decimal(v.amount).toDecimalPlaces(2) : null;
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.loadClaim.create({
      data: {
        workspaceId,
        loadId,
        type: v.type,
        pieces: v.pieces,
        amount: amountDec,
        claimant: v.claimant ?? load.brokerName,
        externalNumber: v.externalNumber,
        openedAt: v.openedAt,
        ackBy: v.ackBy,
        decideBy: v.decideBy,
        status: "open",
        note: v.note
      },
      select: { id: true }
    });
    await recordAudit(
      {
        entity: "load",
        action: "claim_opened",
        loadId,
        loadNumber: load.loadNumber,
        summary: `OS&D ${CLAIM_TYPE_LABEL[v.type].toLowerCase()} claim opened${amountDec ? ` ($${amountDec.toFixed(2)})` : ""}`,
        before: null,
        after: {
          Type: CLAIM_TYPE_LABEL[v.type],
          Amount: amountDec ? `$${amountDec.toFixed(2)}` : null,
          Pieces: v.pieces != null ? String(v.pieces) : null,
          Claimant: v.claimant ?? load.brokerName,
          "External #": v.externalNumber,
          "Ack by": v.ackBy.toISOString().slice(0, 10),
          "Decide by": v.decideBy.toISOString().slice(0, 10)
        },
        at: now,
        workspaceId
      },
      tx
    );
    return row;
  });
  return { ok: true, id: created.id };
}

export async function updateLoadClaim(claimId: string, raw: ClaimUpdateInput, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals): Promise<ClaimResult> {
  const scope = await allowedFor(workspaceId, allowed);
  const check = validateClaimUpdate(raw);
  if (!check.ok) return check;
  const v = check.value;
  const existing = await prisma.loadClaim.findFirst({
    where: { id: claimId, workspaceId, load: { deletedAt: null, ...inTerminal(scope) } },
    include: { load: { select: { id: true, loadNumber: true } } }
  });
  if (!existing) return { ok: false, error: "That OS&D claim does not exist." };
  const amountDec = v.amount !== undefined ? (v.amount != null ? new Prisma.Decimal(v.amount).toDecimalPlaces(2) : null) : existing.amount;
  await prisma.$transaction(async (tx) => {
    await tx.loadClaim.update({
      where: { id: claimId },
      data: {
        ...(v.type !== undefined ? { type: v.type } : {}),
        ...(v.status !== undefined ? { status: v.status } : {}),
        ...(v.pieces !== undefined ? { pieces: v.pieces } : {}),
        ...(v.amount !== undefined ? { amount: amountDec } : {}),
        ...(v.claimant !== undefined ? { claimant: v.claimant } : {}),
        ...(v.externalNumber !== undefined ? { externalNumber: v.externalNumber } : {}),
        ...(v.note !== undefined ? { note: v.note } : {})
      }
    });
    const nextType = (v.type ?? existing.type) as ClaimType;
    const nextStatus = (v.status ?? existing.status) as ClaimStatus;
    await recordAudit(
      {
        entity: "load",
        action: "claim_updated",
        loadId: existing.loadId,
        loadNumber: existing.load.loadNumber,
        summary: `OS&D ${CLAIM_TYPE_LABEL[nextType]?.toLowerCase() ?? nextType} claim updated (${CLAIM_STATUS_LABEL[nextStatus] ?? nextStatus})`,
        before: {
          Status: CLAIM_STATUS_LABEL[existing.status as ClaimStatus] ?? existing.status,
          Amount: existing.amount ? `$${existing.amount.toDecimalPlaces(2).toFixed(2)}` : null,
          Note: existing.note
        },
        after: {
          Status: CLAIM_STATUS_LABEL[nextStatus] ?? nextStatus,
          Amount: amountDec ? `$${amountDec.toDecimalPlaces(2).toFixed(2)}` : null,
          Note: v.note !== undefined ? v.note : existing.note
        },
        at: now,
        workspaceId
      },
      tx
    );
  });
  return { ok: true, id: claimId };
}

export async function removeLoadClaim(claimId: string, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals): Promise<ClaimResult> {
  const scope = await allowedFor(workspaceId, allowed);
  const existing = await prisma.loadClaim.findFirst({
    where: { id: claimId, workspaceId, load: { deletedAt: null, ...inTerminal(scope) } },
    include: { load: { select: { id: true, loadNumber: true } } }
  });
  if (!existing) return { ok: false, error: "That OS&D claim is already gone." };
  await prisma.$transaction(async (tx) => {
    await tx.loadClaim.delete({ where: { id: claimId } });
    await recordAudit(
      {
        entity: "load",
        action: "claim_removed",
        loadId: existing.loadId,
        loadNumber: existing.load.loadNumber,
        summary: `OS&D ${CLAIM_TYPE_LABEL[existing.type as ClaimType]?.toLowerCase() ?? existing.type} claim removed`,
        before: {
          Type: CLAIM_TYPE_LABEL[existing.type as ClaimType] ?? existing.type,
          Status: CLAIM_STATUS_LABEL[existing.status as ClaimStatus] ?? existing.status,
          Amount: existing.amount ? `$${existing.amount.toDecimalPlaces(2).toFixed(2)}` : null
        },
        after: null,
        at: now,
        workspaceId
      },
      tx
    );
  });
  return { ok: true, id: claimId };
}
