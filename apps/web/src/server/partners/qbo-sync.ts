import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ACCOUNT_KEYS, type AccountMap } from "@/lib/accounting-map";
import { advanceCreditKey, dayIn, factoringWindow, ROW_ACCOUNT_DESCRIPTION, statementPostings } from "@/lib/journal";
import { advanceLabel } from "@/lib/deductions";
import { normName, sameCompany } from "@/lib/name-match";
import { recordAudit } from "@/server/tl/audit";
import { markLoadPaid } from "@/server/tl/invoicing";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { workspaceTimezone } from "@/server/tl/zone";
import { centsOf, requireMapped } from "./accounting";
import { toQboBill, toQboCustomer, toQboItem, toQboJournalEntry, toQboPayment, toQboSalesDoc, toQboVendor, type JeLine, type QboAnswer, type QboBody, type QboEntity, type QboRecord, type QboRequest } from "./adapters/quickbooks";
import { callPartner } from "./call";
import { advanceCursor, contentHash, cursorFailed, linkRef, readCursor, refByExternal, refOf, unlinkRef, type RefEntity } from "./external-refs";
import { accessTokenFor } from "./oauth";

/**
 * The QuickBooks Online sync (docs/MONEY_PLAN.md, Wave 3; rules D, E and F). One run:
 *   1. Signs in (oauth.ts) and reads the desk's records. Works out every document QuickBooks should hold, and every account each needs; `requireMapped` stops the run before any call
 *      when a kind has no account.
 *   2. Finds every account in QuickBooks by its name (accounts are the bookkeeper's: never created here; a missing one stops the run, named).
 *   3. Matches before it creates: an item by name, a customer by normalized name (rule D), a 1099 driver as a vendor by name, an invoice or credit memo by its number (a bookkeeper may have
 *      typed it first). What it finds is linked in ExternalRef; only what it cannot find is created. Two QuickBooks customers that both match one name are a problem to settle by hand.
 *   4. Pushes, in order: invoices and credit memos; payments (the fleet's cash, a credit memo applied, a write-off applied); factoring (the invoice paid into the factor's reserve while the
 *      factor owns it, and journal entries for the advance and fee, the release, and a chargeback); and 1099 statements as bills to the driver as a vendor (rule E: a W-2 driver's pay is
 *      payroll's). A document already pushed is updated only when what the desk would send has changed (its content hash), with QuickBooks' SyncToken.
 *   5. Voids (sales documents, payments) or deletes (journal entries, bills) what it pushed before and the desk no longer has: a voided invoice, factoring undone by a chargeback.
 *   6. Pulls QuickBooks' change feed from the cursor: a payment a bookkeeper entered there against one of the desk's invoices is recorded on the desk once (source "accounting").
 * A record that cannot be pushed as it stands is named and left alone, and nothing that depends on it is touched; the rest go on. One run at a time per fleet.
 */
const P = "quickbooks";
const STREAM = "changes";
const LOCK = "push-lock";
const LOCK_MS = 5 * 60_000;

export type SyncCounts = { created: number; matched: number; updated: number; unchanged: number; voided: number; skipped: number; pulled: number };
export type AccountingSyncResult = ({ ok: true } & SyncCounts & { problems: string[] }) | { ok: false; error: string; problems: string[]; unmapped: string[] };

type Ids = { customer(norm: string): string | null; vendor(driverId: string): string | null; item(key: string): string | null; account(key: string): string | null; doc(entity: RefEntity, localId: string): string | null };
type Doc = { refEntity: RefEntity; localId: string; qbo: QboEntity; stage: 1 | 2 | 3 | 4; invoiceId: string | null; docNumber: string | null; build(ids: Ids): QboBody | null };

const ITEM_NAME: Record<string, string> = Object.fromEntries(ACCOUNT_KEYS.map((k) => [k.key, k.label]));
const cents = (d: Prisma.Decimal | null | undefined): number | null => (d == null ? null : d.times(100).toDecimalPlaces(0).toNumber());
const dollarsOf = (c: number): number => new Prisma.Decimal(c).dividedBy(100).toDecimalPlaces(2).toNumber();

async function lock(workspaceId: string, now: Date): Promise<boolean> {
  const until = new Date(now.getTime() + LOCK_MS).toISOString();
  const row = await prisma.syncCursor.findUnique({ where: { workspaceId_provider_stream: { workspaceId, provider: P, stream: LOCK } } });
  if (!row) {
    try {
      await prisma.syncCursor.create({ data: { workspaceId, provider: P, stream: LOCK, cursor: until, lastRunAt: now } });
      return true;
    } catch {
      return false;
    }
  }
  const got = await prisma.syncCursor.updateMany({ where: { id: row.id, OR: [{ cursor: null }, { cursor: { lt: now.toISOString() } }] }, data: { cursor: until, lastRunAt: now } });
  return got.count === 1;
}
const unlock = (workspaceId: string) => prisma.syncCursor.updateMany({ where: { workspaceId, provider: P, stream: LOCK }, data: { cursor: null } });

export async function syncAccounting(opts: { who?: string | null } = {}, now = new Date(), workspaceId = currentWorkspaceId()): Promise<AccountingSyncResult> {
  const token = await accessTokenFor(P, now, workspaceId);
  if (!token.ok) return { ok: false, error: token.error, problems: [], unmapped: [] };
  if (!(await lock(workspaceId, now))) return { ok: false, error: "A QuickBooks sync is already running for this fleet. Try again in a few minutes.", problems: [], unmapped: [] };
  try {
    return await run(token, opts, now, workspaceId);
  } finally {
    await unlock(workspaceId);
  }
}

async function run(token: { accessToken: string; accountId: string }, opts: { who?: string | null }, now: Date, workspaceId: string): Promise<AccountingSyncResult> {
  const at = now.toISOString();
  const day = dayIn(await workspaceTimezone(workspaceId));
  const auth = { accessToken: token.accessToken, realmId: token.accountId, tenant: workspaceId };
  const call = async (request: QboRequest) => (await callPartner("accounting", P, { auth, at, request }, workspaceId)).result;
  const problems: string[] = [];
  const counts: SyncCounts = { created: 0, matched: 0, updated: 0, unchanged: 0, voided: 0, skipped: 0, pulled: 0 };

  // ── 1. The desk's records, and the documents QuickBooks should hold ──
  const [invoices, settlements] = await Promise.all([
    prisma.invoice.findMany({
      where: { workspaceId, kind: { in: ["invoice", "credit_memo"] } },
      include: { lines: { orderBy: { sort: "asc" }, select: { kind: true, label: true, amount: true } }, payments: { select: { id: true, amount: true, paidAt: true, source: true, externalId: true, reference: true } } },
      orderBy: { issuedAt: "asc" }
    }),
    prisma.settlement.findMany({ where: { workspaceId, status: { in: ["final", "void"] }, finalizedAt: { not: null } }, include: { driver: { select: { id: true, name: true, payrollWorkerType: true } }, lineRows: { select: { kind: true, amount: true }, orderBy: { sort: "asc" } } } })
  ]);
  const advances = await prisma.driverAdvance.findMany({ where: { workspaceId }, include: { driver: { select: { name: true, payrollWorkerType: true } } } });
  const docs: Doc[] = [];
  const keys = new Set<string>();
  const customers = new Map<string, string>(); // norm -> name as the desk has it
  const vendors = new Map<string, string>(); // driver id -> name
  const items = new Set<string>();
  /** Invoices that cannot be pushed as they stand: nothing pushed before for them is voided either. */
  const held = new Set<string>();
  const paymentInvoice = new Map<string, string>();
  const keep = new Set<string>();
  const byId = new Map(invoices.map((i) => [i.id, i]));

  for (const inv of invoices) {
    for (const p of inv.payments) paymentInvoice.set(p.id, inv.id);
    if (inv.status === "void") continue;
    const memo = inv.kind === "credit_memo";
    const lines = inv.lines.map((l) => ({ kind: l.kind, label: l.label, amount: cents(l.amount)! }));
    const total = cents(inv.total)!;
    const sum = lines.reduce((s, l) => s + l.amount, 0);
    const billTo = inv.billToName?.trim() ?? "";
    const why = sum !== total ? "its lines do not add up to its total" : !billTo ? "it has no customer to bill" : lines.some((l) => (memo ? l.amount > 0 : l.amount <= 0)) ? (memo ? "a credit memo line is not a credit" : "a line is zero or negative, which QuickBooks does not take on an invoice") : null;
    if (why) {
      problems.push(`${inv.number}: ${why}. Fix it on the desk; nothing was sent for it.`);
      held.add(inv.id);
      continue;
    }
    const cust = normName(billTo);
    customers.set(cust, billTo);
    for (const l of lines) {
      keys.add(l.kind);
      items.add(l.kind);
    }
    const due = new Date(inv.issuedAt.getTime() + inv.termsDays * 86_400_000);
    docs.push({
      refEntity: memo ? "credit_memo" : "invoice",
      localId: inv.id,
      qbo: memo ? "CreditMemo" : "Invoice",
      stage: 1,
      invoiceId: inv.id,
      docNumber: inv.number,
      build: (ids) => {
        const customerId = ids.customer(cust);
        const its = lines.map((l) => ids.item(l.kind));
        if (!customerId || its.some((x) => !x)) return null;
        return toQboSalesDoc({ docNumber: inv.number, txnDate: day(inv.issuedAt), dueDate: memo ? null : day(due), customerId, lines: lines.map((l, i) => ({ amount: l.amount < 0 ? -l.amount : l.amount, itemId: its[i]!, description: l.label })), note: "From TrueLane" });
      }
    });
    if (memo) continue;

    const f = { fundedAt: inv.factoringFundedAt, advance: cents(inv.factoringAdvance), fee: cents(inv.factoringFee), reserveReleased: cents(inv.factoringReserveReleased), chargeback: cents(inv.factoringChargeback), updatedAt: inv.factoringUpdatedAt };
    const { chargedAt, owns } = factoringWindow(f);
    let appliedBeforeFunding = 0;

    for (const p of inv.payments) {
      const amount = cents(p.amount)!;
      if (p.source === "accounting") {
        if (f.fundedAt && p.paidAt < f.fundedAt) appliedBeforeFunding += amount; // entered in QuickBooks before funding: not sold
        keep.add(p.id); // pulled from QuickBooks: it is already there
        continue;
      }
      if (p.source === "credit") {
        // A credit memo applied to this invoice: a zero payment that links the two (rule F).
        const memoId = p.externalId;
        if (!memoId || !byId.has(memoId)) continue;
        if (f.fundedAt && p.paidAt < f.fundedAt) appliedBeforeFunding += amount;
        docs.push({
          refEntity: "payment",
          localId: p.id,
          qbo: "Payment",
          stage: 2,
          invoiceId: inv.id,
          docNumber: null,
          build: (ids) => {
            const customerId = ids.customer(cust);
            const invId = ids.doc("invoice", inv.id);
            const memoQbo = ids.doc("credit_memo", memoId);
            if (!customerId || !invId || !memoQbo) return null;
            return toQboPayment({ customerId, txnDate: day(p.paidAt), total: 0, depositAccountId: null, reference: null, links: [{ id: invId, type: "Invoice", amount }, { id: memoQbo, type: "CreditMemo", amount }], note: "Credit memo applied, from TrueLane" });
          }
        });
        continue;
      }
      if (owns(p.paidAt)) continue; // the customer paid the factor
      if (f.fundedAt && p.paidAt < f.fundedAt) appliedBeforeFunding += amount;
      keys.add("cash");
      docs.push({
        refEntity: "payment",
        localId: p.id,
        qbo: "Payment",
        stage: 2,
        invoiceId: inv.id,
        docNumber: null,
        build: (ids) => {
          const customerId = ids.customer(cust);
          const invId = ids.doc("invoice", inv.id);
          const deposit = ids.account("cash");
          if (!customerId || !invId || !deposit) return null;
          return toQboPayment({ customerId, txnDate: day(p.paidAt), total: amount, depositAccountId: deposit, reference: p.reference, links: [{ id: invId, type: "Invoice", amount }], note: "From TrueLane" });
        }
      });
    }

    const writeOff = cents(inv.writeOffAmount);
    if (writeOff && writeOff > 0 && !owns(inv.paidAt ?? inv.issuedAt)) {
      // A short pay written off: a credit memo to the write-off item, applied to the invoice.
      keys.add("write_off");
      items.add("write_off");
      const woId = `writeoff:${inv.id}`;
      const woDate = day(inv.paidAt ?? inv.issuedAt);
      docs.push({
        refEntity: "credit_memo",
        localId: woId,
        qbo: "CreditMemo",
        stage: 1,
        invoiceId: inv.id,
        docNumber: `${inv.number}-WO`,
        build: (ids) => {
          const customerId = ids.customer(cust);
          const item = ids.item("write_off");
          if (!customerId || !item) return null;
          return toQboSalesDoc({ docNumber: `${inv.number}-WO`, txnDate: woDate, customerId, lines: [{ amount: writeOff, itemId: item, description: inv.writeOffReason ?? "Short pay written off" }], note: "Short pay written off, from TrueLane" });
        }
      });
      docs.push({
        refEntity: "payment",
        localId: woId,
        qbo: "Payment",
        stage: 2,
        invoiceId: inv.id,
        docNumber: null,
        build: (ids) => {
          const customerId = ids.customer(cust);
          const invId = ids.doc("invoice", inv.id);
          const memoQbo = ids.doc("credit_memo", woId);
          if (!customerId || !invId || !memoQbo) return null;
          return toQboPayment({ customerId, txnDate: woDate, total: 0, depositAccountId: null, reference: null, links: [{ id: invId, type: "Invoice", amount: writeOff }, { id: memoQbo, type: "CreditMemo", amount: writeOff }], note: "Write-off applied, from TrueLane" });
        }
      });
    }

    if (f.fundedAt) {
      const advance = f.chargeback ?? f.advance;
      if (advance == null) {
        problems.push(`${inv.number}: the factor funded it but no advance is recorded, so its factoring was not sent.`);
        held.add(inv.id);
        continue;
      }
      keys.add("cash");
      keys.add("factor_reserve");
      const fundedDay = day(f.fundedAt);
      const fee = f.chargeback != null ? 0 : (f.fee ?? 0);
      if (fee > 0) keys.add("factoring_fee");
      if (f.chargeback == null) {
        // While the factor owns it, the invoice is paid into the factor's reserve: QuickBooks then shows it as no longer the customer's to pay the fleet.
        const sold = total - appliedBeforeFunding;
        if (sold > 0)
          docs.push({
            refEntity: "payment",
            localId: `factoring:${inv.id}`,
            qbo: "Payment",
            stage: 2,
            invoiceId: inv.id,
            docNumber: null,
            build: (ids) => {
              const customerId = ids.customer(cust);
              const invId = ids.doc("invoice", inv.id);
              const reserve = ids.account("factor_reserve");
              if (!customerId || !invId || !reserve) return null;
              return toQboPayment({ customerId, txnDate: fundedDay, total: sold, depositAccountId: reserve, reference: inv.factoringReferenceId, links: [{ id: invId, type: "Invoice", amount: sold }], note: "Factored: sold to the factor, from TrueLane" });
            }
          });
      }
      const je = (localId: string, docNumber: string, date: string, lines: Array<[JeLine["posting"], string, number, string]>): Doc => ({
        refEntity: "journal_entry",
        localId,
        qbo: "JournalEntry",
        stage: 3,
        invoiceId: inv.id,
        docNumber: null,
        build: (ids) => {
          const resolved = lines.map(([posting, key, amount, description]) => ({ posting, accountId: ids.account(key), amount, description }));
          if (resolved.some((l) => !l.accountId)) return null;
          return toQboJournalEntry({ docNumber, txnDate: date, lines: resolved.filter((l) => l.amount > 0) as JeLine[], note: `${inv.number}, from TrueLane` });
        }
      });
      docs.push(
        je(`factoring_funded:${inv.id}`, `${inv.number}-F`, fundedDay, [
          ["Debit", "cash", advance, "Advance from the factor"],
          ["Debit", "factoring_fee", fee, "Factoring fee"],
          ["Credit", "factor_reserve", advance + fee, "Taken from the reserve"]
        ])
      );
      if (f.chargeback == null && f.reserveReleased && f.reserveReleased > 0) {
        const rel = f.reserveReleased;
        docs.push(je(`factoring_release:${inv.id}`, `${inv.number}-R`, day(inv.paidAt ?? f.updatedAt ?? f.fundedAt), [["Debit", "cash", rel, "Reserve released"], ["Credit", "factor_reserve", rel, "Reserve released"]]));
      }
      if (chargedAt) docs.push(je(`factoring_chargeback:${inv.id}`, `${inv.number}-CB`, day(chargedAt), [["Debit", "factor_reserve", advance, "Charged back"], ["Credit", "cash", advance, "Advance returned to the factor"]]));
    }
  }

  for (const s of settlements) {
    // A voided statement is not wanted: a bill pushed for it before is deleted below, with everything else the desk no longer has.
    if (s.status !== "final" || s.voidedAt) continue;
    if (s.driver.payrollWorkerType !== "contractor") continue; // rule E: only a 1099 owner-operator's statement is a bill
    // From the frozen rows, the same postings the journal books (lib/journal.ts statementPostings): one bill line per account, the bill's total the net owed.
    const p = statementPostings({ number: s.number, total: cents(s.total) ?? 0, rows: s.lineRows.map((r) => ({ kind: r.kind, amount: cents(r.amount)! })) });
    if ("problem" in p) {
      problems.push(p.problem);
      keep.add(s.id);
      continue;
    }
    if (p.net <= 0) {
      // QuickBooks takes no bill of nothing or less: a statement on which the driver owes is the fleet's to book by hand (a vendor credit). The journal books it.
      problems.push(`${s.number} comes to ${(p.net / 100).toFixed(2)}: QuickBooks takes no bill of nothing or less. Book it there as a vendor credit, or by journal.`);
      keep.add(s.id);
      continue;
    }
    const lines = p.postings.filter(([k]) => k !== "accounts_payable");
    for (const [k] of lines) keys.add(k);
    vendors.set(s.driver.id, s.driver.name);
    docs.push({
      refEntity: "bill",
      localId: s.id,
      qbo: "Bill",
      stage: 4,
      invoiceId: null,
      docNumber: s.number,
      build: (ids) => {
        const vendorId = ids.vendor(s.driver.id);
        const resolved = lines.map(([k, amount]) => ({ amount, accountId: ids.account(k), description: ROW_ACCOUNT_DESCRIPTION[k] ?? k }));
        if (!vendorId || resolved.some((l) => !l.accountId)) return null;
        return toQboBill({ vendorId, docNumber: s.number, txnDate: day(s.finalizedAt!), lines: resolved as Array<{ amount: number; accountId: string; description: string }>, note: `Statement ${s.number}, from TrueLane` });
      }
    });
  }

  // Advances given outside a statement: a journal entry each, Driver Advances against cash (or the fuel card), exactly as the journal books them. Rule E: contractors only.
  for (const a of advances) {
    if (a.driver.payrollWorkerType !== "contractor") continue;
    const amount = cents(a.amount)!;
    const givenOn = a.givenOn.toISOString().slice(0, 10);
    const credit = advanceCreditKey(a.method);
    const label = advanceLabel({ amountCents: amount, givenOn, method: a.method });
    keys.add("driver_advances");
    keys.add(credit);
    docs.push({
      refEntity: "journal_entry",
      localId: `advance:${a.id}`,
      qbo: "JournalEntry",
      stage: 3,
      invoiceId: null,
      docNumber: null,
      build: (ids) => {
        const asset = ids.account("driver_advances");
        const from = ids.account(credit);
        if (!asset || !from) return null;
        return toQboJournalEntry({ docNumber: `ADV-${a.id.slice(-8).toUpperCase()}`, txnDate: givenOn, lines: [{ posting: "Debit", accountId: asset, amount, description: `${label}, ${a.driver.name}` }, { posting: "Credit", accountId: from, amount, description: label }], note: `${label}, ${a.driver.name}, from TrueLane` });
      }
    });
  }
  for (const k of items) keys.add(k); // an item needs its income account

  const mapped = await requireMapped(keys, workspaceId);
  if (!mapped.ok) return { ok: false, error: mapped.error, problems, unmapped: mapped.unmapped };
  const map: AccountMap = mapped.map;

  // ── 2. Accounts: found by name, never created ──
  const accountsAt = await call({ op: "list", entity: "Account" });
  if (!accountsAt.ok) return { ok: false, error: accountsAt.message ?? "QuickBooks did not answer.", problems, unmapped: [] };
  const accountByName = new Map(accountsAt.data.records.map((a) => [a.name?.trim().toLowerCase() ?? "", a.id]));
  const accountIds = new Map<string, string>();
  const missing: string[] = [];
  for (const k of keys) {
    const name = map[k]!.account;
    const id = accountByName.get(name.toLowerCase());
    if (id) accountIds.set(k, id);
    else missing.push(name);
  }
  if (missing.length > 0) return { ok: false, error: `QuickBooks has no account named ${[...new Set(missing)].map((n) => `"${n}"`).join(", ")}. Create it there, or choose another in Accounting accounts.`, problems, unmapped: [] };

  // ── 3. Match before create: items, customers, vendors ──
  const resolved = { item: new Map<string, string>(), customer: new Map<string, string>(), vendor: new Map<string, string>() };
  const master = async (refEntity: "item" | "customer" | "vendor", entity: "Item" | "Customer" | "Vendor", want: Map<string, string>, body: (localId: string, name: string) => QboBody, matchName: (name: string, list: QboRecord[]) => QboRecord[]) => {
    if (want.size === 0) return;
    const listed = await call({ op: "list", entity });
    if (!listed.ok) {
      problems.push(`QuickBooks did not list its ${entity.toLowerCase()}s: ${listed.message ?? listed.code}`);
      return;
    }
    const active = new Map(listed.data.records.map((r) => [r.id, r]));
    for (const [localId, name] of want) {
      const linked = await refOf(P, refEntity, localId, workspaceId);
      if (linked && active.has(linked.externalId)) {
        resolved[refEntity].set(localId, linked.externalId);
        continue;
      }
      if (linked) await unlinkRef(P, refEntity, localId, workspaceId); // it was made inactive or merged in QuickBooks: find it again
      const found = matchName(name, [...active.values()]);
      if (found.length > 1) {
        problems.push(`${found.length} ${entity.toLowerCase()}s in QuickBooks match "${name}" (${found.map((f) => f.name).join(", ")}). Merge them there, then sync again.`);
        continue;
      }
      if (found.length === 1) {
        const taken = await refByExternal(P, refEntity, found[0]!.id, workspaceId);
        if (taken && taken.localId !== localId) {
          problems.push(`"${name}" matches QuickBooks' ${found[0]!.name}, which is already linked to another record on the desk.`);
          continue;
        }
        await linkRef({ provider: P, entity: refEntity, localId, externalId: found[0]!.id, syncToken: found[0]!.syncToken }, new Date(), workspaceId);
        resolved[refEntity].set(localId, found[0]!.id);
        counts.matched += 1;
        continue;
      }
      const made = await call({ op: "create", entity, body: body(localId, name) });
      if (!made.ok || !made.data.records[0]) {
        problems.push(`"${name}" could not be added to QuickBooks: ${made.ok ? "no answer" : (made.message ?? made.code)}`);
        continue;
      }
      await linkRef({ provider: P, entity: refEntity, localId, externalId: made.data.records[0].id, syncToken: made.data.records[0].syncToken }, new Date(), workspaceId);
      resolved[refEntity].set(localId, made.data.records[0].id);
      counts.created += 1;
    }
  };
  await master("item", "Item", new Map([...items].map((k) => [k, ITEM_NAME[k] ?? k])), (k, name) => toQboItem(name, accountIds.get(k)!), (name, list) => list.filter((r) => (r.name ?? "").trim().toLowerCase() === name.toLowerCase()));
  await master("customer", "Customer", customers, (_k, name) => toQboCustomer(name), sameCompany);
  await master("vendor", "Vendor", vendors, (_k, name) => toQboVendor(name), sameCompany);

  // ── 4. Push the documents, in order ──
  const docIds = new Map<string, string>();
  const ids: Ids = {
    customer: (n) => resolved.customer.get(n) ?? null,
    vendor: (d) => resolved.vendor.get(d) ?? null,
    item: (k) => resolved.item.get(k) ?? null,
    account: (k) => accountIds.get(k) ?? null,
    doc: (e, l) => docIds.get(`${e}:${l}`) ?? null
  };
  for (const stage of [1, 2, 3, 4] as const) {
    for (const d of docs.filter((x) => x.stage === stage)) {
      const body = d.build(ids);
      if (!body) {
        counts.skipped += 1;
        if (d.invoiceId) held.add(d.invoiceId);
        continue;
      }
      const hash = contentHash(body);
      let ref = await refOf(P, d.refEntity, d.localId, workspaceId);
      if (!ref && d.docNumber && (d.qbo === "Invoice" || d.qbo === "CreditMemo")) {
        // A bookkeeper may have typed this invoice into QuickBooks first: take it over rather than make a second.
        const found = await call({ op: "find", entity: d.qbo, docNumber: d.docNumber });
        const hit = found.ok ? found.data.records.find((r) => r.status === "active") : undefined;
        if (found.ok && !hit && found.data.records.length > 0) {
          problems.push(`${d.docNumber}: QuickBooks has a voided document with this number, so it cannot be sent again under it.`);
          counts.skipped += 1;
          if (d.invoiceId) held.add(d.invoiceId);
          continue;
        }
        if (hit && !(await refByExternal(P, d.refEntity, hit.id, workspaceId))) {
          await linkRef({ provider: P, entity: d.refEntity, localId: d.localId, externalId: hit.id, syncToken: hit.syncToken, pushedHash: null }, new Date(), workspaceId);
          ref = await refOf(P, d.refEntity, d.localId, workspaceId);
          counts.matched += 1;
        }
      }
      if (ref && ref.pushedHash === hash) {
        docIds.set(`${d.refEntity}:${d.localId}`, ref.externalId);
        counts.unchanged += 1;
        continue;
      }
      const res = ref ? await call({ op: "update", entity: d.qbo, id: ref.externalId, syncToken: ref.syncToken ?? "0", body }) : await call({ op: "create", entity: d.qbo, body });
      const rec = res.ok ? res.data.records[0] : undefined;
      if (!rec) {
        problems.push(`${d.docNumber ?? `${d.qbo} for ${byId.get(d.invoiceId ?? "")?.number ?? d.localId}`}: ${res.ok ? "QuickBooks gave no answer" : (res.message ?? res.code)}`);
        counts.skipped += 1;
        if (d.invoiceId) held.add(d.invoiceId);
        if (ref) docIds.set(`${d.refEntity}:${d.localId}`, ref.externalId);
        continue;
      }
      await linkRef({ provider: P, entity: d.refEntity, localId: d.localId, externalId: rec.id, syncToken: rec.syncToken, pushedHash: hash }, new Date(), workspaceId);
      docIds.set(`${d.refEntity}:${d.localId}`, rec.id);
      if (ref) counts.updated += 1;
      else counts.created += 1;
    }
  }

  // ── 5. Void or delete what was pushed before and is no longer the desk's ──
  const wanted = new Set(docs.map((d) => `${d.refEntity}:${d.localId}`));
  const invoiceOfLocal = (localId: string): string | null => paymentInvoice.get(localId) ?? (localId.includes(":") ? localId.split(":")[1]! : localId);
  const stale = (await prisma.externalRef.findMany({ where: { workspaceId, provider: P, entity: { in: ["payment", "invoice", "credit_memo", "journal_entry", "bill"] } } })).filter((r) => !wanted.has(`${r.entity}:${r.localId}`) && !keep.has(r.localId) && !held.has(invoiceOfLocal(r.localId) ?? ""));
  const order: Record<string, number> = { payment: 0, credit_memo: 1, invoice: 2, journal_entry: 3, bill: 3 };
  stale.sort((a, b) => order[a.entity]! - order[b.entity]!);
  for (const r of stale) {
    const qbo: QboEntity = r.entity === "payment" ? "Payment" : r.entity === "invoice" ? "Invoice" : r.entity === "credit_memo" ? "CreditMemo" : r.entity === "bill" ? "Bill" : "JournalEntry";
    const req: QboRequest = qbo === "JournalEntry" || qbo === "Bill" ? { op: "delete", entity: qbo, id: r.externalId, syncToken: r.syncToken ?? "0" } : { op: "void", entity: qbo, id: r.externalId, syncToken: r.syncToken ?? "0" };
    const res = await call(req);
    if (!res.ok && !(res.field === "qbo:610")) {
      problems.push(`QuickBooks ${qbo} ${r.externalId} could not be ${req.op === "void" ? "voided" : "deleted"}: ${res.message ?? res.code}`);
      continue;
    }
    await unlinkRef(P, r.entity as RefEntity, r.localId, workspaceId);
    counts.voided += 1;
  }

  // ── 6. Pull: payments a bookkeeper entered in QuickBooks ──
  const cur = await readCursor(P, STREAM, workspaceId);
  const conn = await prisma.partnerConnection.findUnique({ where: { workspaceId_capability_provider: { workspaceId, capability: "accounting", provider: P } }, select: { connectedAt: true } });
  const since = cur.cursor ?? (conn?.connectedAt ?? now).toISOString();
  const feed = await call({ op: "changes", entities: ["Payment"], since });
  if (!feed.ok) {
    await cursorFailed(P, STREAM, feed.message ?? feed.code, now, workspaceId);
    problems.push(`QuickBooks' changes could not be read: ${feed.message ?? feed.code}. They are read again next time.`);
  } else {
    await pullPayments(feed.data, { now, workspaceId, problems, counts, today: day(now) });
    if (!(await advanceCursor(P, STREAM, cur.cursor, feed.data.at, now, workspaceId))) problems.push("Another sync read QuickBooks' changes at the same time; this one's are read again next time.");
  }

  const total = counts.created + counts.updated + counts.voided + counts.pulled + counts.matched;
  if (total > 0 || problems.length > 0)
    await recordAudit({
      entity: "partner",
      action: "accounting_synced",
      summary: `QuickBooks sync: ${counts.created} created, ${counts.matched} matched, ${counts.updated} updated, ${counts.voided} voided, ${counts.pulled} payments pulled${problems.length > 0 ? `, ${problems.length} not sent` : ""}`,
      before: null,
      after: { Created: String(counts.created), Matched: String(counts.matched), Updated: String(counts.updated), Voided: String(counts.voided), Pulled: String(counts.pulled), "Not sent": String(problems.length), ...(opts.who ? { By: opts.who } : {}) },
      at: now,
      workspaceId
    });
  return { ok: true, ...counts, problems };
}

async function pullPayments(feed: QboAnswer, c: { now: Date; workspaceId: string; problems: string[]; counts: SyncCounts; today: string }) {
  for (const rec of feed.records) {
    if (rec.entity !== "Payment") continue;
    const ours = await refByExternal(P, "payment", rec.id, c.workspaceId);
    if (ours) {
      if (rec.status !== "active") c.problems.push(`A payment the desk sent (QuickBooks ${rec.id}) was voided or deleted in QuickBooks. If that is right, take it back on the desk too.`);
      continue;
    }
    if (rec.status !== "active") {
      // Pulled payments carry no ExternalRef; the InvoicePayment row (source "accounting") is their only record.
      const pulled = await prisma.invoicePayment.count({ where: { workspaceId: c.workspaceId, source: "accounting", externalId: { startsWith: `${rec.id}#` } } });
      if (pulled > 0) c.problems.push(`A payment pulled from QuickBooks (${rec.id}) was voided or deleted there. If that is right, take it back on the desk too.`);
      continue;
    }
    for (const link of rec.links.filter((l) => l.type === "Invoice" && l.amount > 0)) {
      const inv = await refByExternal(P, "invoice", link.id, c.workspaceId);
      if (!inv) continue; // not one of the desk's invoices
      const externalId = `${rec.id}#${link.id}`;
      if ((await prisma.invoicePayment.count({ where: { workspaceId: c.workspaceId, source: "accounting", externalId } })) > 0) continue;
      const record = await prisma.invoice.findFirst({ where: { id: inv.localId, workspaceId: c.workspaceId }, include: { lines: { orderBy: { sort: "asc" }, select: { loadId: true } }, loads: { select: { loadId: true } } } });
      const lead = record?.lines.find((l) => l.loadId)?.loadId ?? record?.loads[0]?.loadId;
      if (!record || !lead) continue;
      if (record.status !== "open") {
        c.problems.push(`${record.number}: QuickBooks has a payment on it (${rec.id}) but the desk already has it ${record.status === "paid" ? "paid" : record.status}. Check both.`);
        continue;
      }
      const today = c.today;
      const out = await markLoadPaid(lead, c.now, { amount: dollarsOf(link.amount), paidOn: rec.txnDate && rec.txnDate <= today ? rec.txnDate : undefined, source: "accounting", externalId, reference: `QuickBooks payment ${rec.id}`, shortAction: "balance" }, c.workspaceId);
      if (!out.ok) {
        c.problems.push(`${record.number}: the payment entered in QuickBooks (${rec.id}) could not be recorded: ${out.error ?? "it was refused"}`);
        continue;
      }
      // No ExternalRef here: the InvoicePayment row (source + externalId) deduplicates, and a ref
      // under `${rec.id}#${link.id}` would later be "voided" with an id QuickBooks never issued.
      c.counts.pulled += 1;
    }
  }
}
