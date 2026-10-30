import { prisma } from "@/lib/db";
import type { AuditSnapshot } from "@/lib/audit-diff";
import { kindLabel, validateCustomer, type CustomerCheck, type CustomerValues } from "@/lib/customer";
import { customerScorecard } from "@/lib/customer-scorecard";
import { notQuote } from "@/lib/quote-status";
import { recordAudit } from "./audit";
import { num, numOrNull } from "./convert";
import { getDeskKpi } from "./kpi";
import { getThresholds } from "./thresholds";
import { currentWorkspaceId } from "./workspace";

/**
 * Customers as records. A load keeps its customer's name as text, so a record is the profile attached to that name: its kind, MC, billing
 * contact, default terms and notes. Saving a record keeps the loads and the record spelling the name the same way: a new record with a name the
 * loads spell differently only in capitals brings them to its spelling, and renaming a record renames its loads with it (each audited).
 */
const lc = (s: string) => s.trim().toLowerCase();

export type SaveCustomerResult = { ok: true; id: string; changed: boolean } | { ok: false; errors?: Extract<CustomerCheck, { ok: false }>["errors"]; error?: string };

const LABEL = { name: "Name", kind: "Kind", mcNumber: "MC number", contactName: "Contact", contactEmail: "Contact email", contactPhone: "Contact phone", defaultPayTermsDays: "Default terms (days)", notes: "Notes" } as const;

type Row = { name: string; kind: string; mcNumber: string | null; contactName: string | null; contactEmail: string | null; contactPhone: string | null; defaultPayTermsDays: number | null; notes: string | null };
const snapshot = (c: Row): AuditSnapshot => ({ [LABEL.name]: c.name, [LABEL.kind]: kindLabel(c.kind), [LABEL.mcNumber]: c.mcNumber, [LABEL.contactName]: c.contactName, [LABEL.contactEmail]: c.contactEmail, [LABEL.contactPhone]: c.contactPhone, [LABEL.defaultPayTermsDays]: c.defaultPayTermsDays == null ? null : String(c.defaultPayTermsDays), [LABEL.notes]: c.notes });

export const listCustomerRecords = (workspaceId = currentWorkspaceId()) => prisma.customer.findMany({ where: { workspaceId }, orderBy: { name: "asc" } });

/** Each customer's usual terms by lower-cased name, for an invoice to a customer whose load names none. */
export async function customerTermsMap(workspaceId = currentWorkspaceId()): Promise<Map<string, number>> {
  const rows = await prisma.customer.findMany({ where: { workspaceId, defaultPayTermsDays: { not: null } }, select: { name: true, defaultPayTermsDays: true } });
  return new Map(rows.map((r) => [lc(r.name), r.defaultPayTermsDays!]));
}

export async function saveCustomer(values: CustomerValues, id: string | null, now = new Date(), workspaceId = currentWorkspaceId()): Promise<SaveCustomerResult> {
  const check = validateCustomer(values);
  if (!check.ok) return { ok: false, errors: check.errors };
  const v = check.value;
  const clash = await prisma.customer.findFirst({ where: { workspaceId, name: { equals: v.name, mode: "insensitive" }, ...(id ? { id: { not: id } } : {}) } });
  if (clash) return { ok: false, errors: { name: `${clash.name} is already on the desk.` } };

  if (id == null) {
    const created = await prisma.$transaction(async (tx) => {
      const c = await tx.customer.create({ data: { workspaceId, ...v } });
      // Loads that spell this name differently only in capitals come to the record's spelling, so the two stay one customer.
      const respelled = await tx.load.updateMany({ where: { workspaceId, brokerName: { equals: v.name, mode: "insensitive" }, NOT: { brokerName: v.name } }, data: { brokerName: v.name } });
      await recordAudit({ entity: "customer", action: "customer_added", summary: `${v.name} added as a ${kindLabel(v.kind).toLowerCase()}${respelled.count > 0 ? `; ${respelled.count} ${respelled.count === 1 ? "load" : "loads"} now spell it the same` : ""}`, before: null, after: snapshot(v), at: now, workspaceId }, tx);
      return c;
    });
    return { ok: true, id: created.id, changed: true };
  }

  const prev = await prisma.customer.findFirst({ where: { id, workspaceId } });
  if (!prev) return { ok: false, error: "That customer does not exist." };
  const before = snapshot(prev);
  const after = snapshot(v);
  const moved = Object.keys(after).filter((k) => (before[k] ?? null) !== (after[k] ?? null));
  if (moved.length === 0) return { ok: true, id, changed: false };
  await prisma.$transaction(async (tx) => {
    await tx.customer.update({ where: { id }, data: v });
    const renamed = prev.name !== v.name ? await tx.load.updateMany({ where: { workspaceId, brokerName: { equals: prev.name, mode: "insensitive" } }, data: { brokerName: v.name } }) : null;
    await recordAudit({ entity: "customer", action: "customer_changed", summary: `${v.name}: changed ${moved.join(", ").toLowerCase()}${renamed ? `; ${renamed.count} ${renamed.count === 1 ? "load" : "loads"} renamed with it` : ""}`, before: Object.fromEntries(moved.map((k) => [k, before[k] ?? null])), after: Object.fromEntries(moved.map((k) => [k, after[k] ?? null])), at: now, workspaceId }, tx);
  });
  return { ok: true, id, changed: true };
}

const RECENT = 12;

/**
 * One customer's page: its record (when there is one), the scorecard the finished loads give (the KPI's row, plus how it pays against its terms),
 * what is still out, and its latest loads. `key` is a record's id, or a name that appears on loads and has no record yet.
 */
export async function getCustomerDetail(key: { id?: string; name?: string }, now = new Date(), workspaceId = currentWorkspaceId()) {
  const record = key.id ? await prisma.customer.findFirst({ where: { id: key.id, workspaceId } }) : key.name ? await prisma.customer.findFirst({ where: { workspaceId, name: { equals: key.name.trim(), mode: "insensitive" } } }) : null;
  if (key.id && !record) return null;
  const name = (record?.name ?? key.name ?? "").trim();
  if (!name) return null;

  const [loads, thresholds, kpi] = await Promise.all([
    prisma.load.findMany({ where: { workspaceId, deletedAt: null, ...notQuote, brokerName: { equals: name, mode: "insensitive" } }, orderBy: [{ scheduledDate: "desc" }, { createdAt: "desc" }] }),
    getThresholds(workspaceId),
    getDeskKpi({ period: "all", compare: false }, now)
  ]);
  const fallback = record?.defaultPayTermsDays ?? thresholds.defaultPayTermsDays;
  const scorecard = customerScorecard(
    loads.map((l) => ({ paymentStatus: l.paymentStatus, invoicedAt: l.invoicedAt, paidAt: l.paidAt, payTermsDays: l.payTermsDays, invoicedAmount: numOrNull(l.invoicedAmount), paidAmount: numOrNull(l.paidAmount) })),
    now,
    fallback
  );
  return {
    record,
    name,
    /** The same row the Customers list shows (finished loads, what they paid per mile, days to pay, waits, loads that fell through). */
    kpi: kpi.brokers.find((b) => lc(b.name) === lc(name)) ?? null,
    scorecard,
    termsUsed: fallback,
    loadCount: loads.length,
    recent: loads.slice(0, RECENT).map((l) => ({ id: l.id, loadNumber: l.loadNumber, status: l.status, paymentStatus: l.paymentStatus, lane: `${l.originAddress ?? "?"} → ${l.destinationAddress ?? "?"}`, scheduledDate: l.scheduledDate, amount: num(l.invoicedAmount ?? l.quotedRevenue) }))
  };
}
