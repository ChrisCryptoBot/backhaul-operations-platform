import { Prisma } from "@prisma/client";
import { err, ok } from "@/truelane/partners/contract";
import { ACCOUNT_KEYS } from "@/lib/accounting-map";
import { notImplemented } from "../not-implemented";
import { NotLive, type Adapter, type ProviderAdapter } from "./types";

/**
 * Accounting, modeled after QuickBooks Online's v3 API (docs/MONEY_PLAN.md, Wave 3): Customer, Vendor, Item and Account; Invoice, CreditMemo, Payment, Bill and JournalEntry; sparse updates
 * guarded by SyncToken; voiding sales documents; deleting journal entries and bills; and the change data capture feed. As with the other adapters, these shapes are what the desk ASSUMES of
 * the company until it gives TrueLane access: the live client answers "not implemented", and the sandbox client is a small in-memory QuickBooks that keeps one set of books per fleet and
 * enforces what the real one does (refs that must exist, a stale SyncToken, duplicate names and document numbers, payments no larger than what is open, journal entries that balance).
 *
 * The three layers (types.ts): the CLIENT speaks QuickBooks' own objects; the NORMALIZER (fromQbo) turns them into QboRecord; the ADAPTER answers a PartnerResult. The body builders
 * (toQbo...) are the desk-to-QuickBooks half of the normalizer: pure, in cents in and dollars out.
 */
export type QboEntity = "Customer" | "Vendor" | "Item" | "Account" | "Invoice" | "CreditMemo" | "Payment" | "Bill" | "JournalEntry";
export type QboBody = Record<string, unknown>;
export type QboRequest =
  | { op: "list"; entity: "Customer" | "Vendor" | "Item" | "Account" }
  | { op: "find"; entity: "Invoice" | "CreditMemo"; docNumber: string }
  | { op: "create"; entity: QboEntity; body: QboBody }
  | { op: "update"; entity: QboEntity; id: string; syncToken: string; body: QboBody }
  | { op: "void"; entity: "Invoice" | "CreditMemo" | "Payment"; id: string; syncToken: string }
  | { op: "delete"; entity: "JournalEntry" | "Bill"; id: string; syncToken: string }
  | { op: "changes"; entities: QboEntity[]; since: string };

/** One QuickBooks object as the desk reads it. Amounts in cents. */
export type QboRecord = {
  entity: QboEntity;
  id: string;
  syncToken: string;
  status: "active" | "voided" | "deleted";
  name: string | null;
  companyName: string | null;
  docNumber: string | null;
  txnDate: string | null;
  total: number | null;
  balance: number | null;
  customerId: string | null;
  accountType: string | null;
  /** What a payment is applied to: invoices and credit memos, with the amount on each. */
  links: Array<{ id: string; type: string; amount: number }>;
  updatedAt: string | null;
};
export type QboAnswer = { records: QboRecord[]; at: string };

type Auth = { accessToken: string; realmId: string; tenant: string };
type In = { auth: Auth; at: string; request: QboRequest };

/** What QuickBooks answers when it refuses a request: its own error code and words. */
export class QboFault extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400
  ) {
    super(message);
    this.name = "QboFault";
  }
}

export interface QboClient {
  send(auth: Auth, at: string, req: QboRequest): Promise<Array<{ entity: QboEntity; obj: QboBody }>>;
}

export const liveQboClient: QboClient = {
  async send() {
    throw new NotLive();
  }
};

// ── Desk to QuickBooks (pure) ───────────────────────────────────────────────────────────────

const dollars = (cents: number): number => new Prisma.Decimal(cents).dividedBy(100).toDecimalPlaces(2).toNumber();
const ref = (id: string) => ({ value: id });

export const toQboCustomer = (name: string): QboBody => ({ DisplayName: name.slice(0, 100), CompanyName: name.slice(0, 100) });
export const toQboVendor = (name: string): QboBody => ({ DisplayName: name.slice(0, 100), Vendor1099: true });
export const toQboItem = (name: string, incomeAccountId: string): QboBody => ({ Name: name.slice(0, 100), Type: "Service", IncomeAccountRef: ref(incomeAccountId) });

export type SalesLine = { amount: number; itemId: string; description: string };
export function toQboSalesDoc(d: { docNumber: string; txnDate: string; dueDate?: string | null; customerId: string; lines: SalesLine[]; note?: string | null }): QboBody {
  return {
    DocNumber: d.docNumber.slice(0, 21),
    TxnDate: d.txnDate,
    ...(d.dueDate ? { DueDate: d.dueDate } : {}),
    CustomerRef: ref(d.customerId),
    Line: d.lines.map((l) => ({ Amount: dollars(l.amount), Description: l.description.slice(0, 4000), DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: ref(l.itemId) } })),
    ...(d.note ? { PrivateNote: d.note.slice(0, 4000) } : {})
  };
}

export function toQboPayment(p: { customerId: string; txnDate: string; total: number; depositAccountId: string | null; reference: string | null; links: Array<{ id: string; type: "Invoice" | "CreditMemo"; amount: number }>; note?: string | null }): QboBody {
  return {
    CustomerRef: ref(p.customerId),
    TxnDate: p.txnDate,
    TotalAmt: dollars(p.total),
    ...(p.depositAccountId ? { DepositToAccountRef: ref(p.depositAccountId) } : {}),
    ...(p.reference ? { PaymentRefNum: p.reference.slice(0, 21) } : {}),
    Line: p.links.map((l) => ({ Amount: dollars(l.amount), LinkedTxn: [{ TxnId: l.id, TxnType: l.type }] })),
    ...(p.note ? { PrivateNote: p.note.slice(0, 4000) } : {})
  };
}

export type JeLine = { posting: "Debit" | "Credit"; amount: number; accountId: string; description: string };
export function toQboJournalEntry(j: { docNumber: string; txnDate: string; lines: JeLine[]; note?: string | null }): QboBody {
  return {
    DocNumber: j.docNumber.slice(0, 21),
    TxnDate: j.txnDate,
    Line: j.lines.map((l) => ({ Amount: dollars(l.amount), Description: l.description.slice(0, 4000), DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: l.posting, AccountRef: ref(l.accountId) } })),
    ...(j.note ? { PrivateNote: j.note.slice(0, 4000) } : {})
  };
}

export function toQboBill(b: { vendorId: string; docNumber: string; txnDate: string; lines: Array<{ amount: number; accountId: string; description: string }>; note?: string | null }): QboBody {
  return {
    VendorRef: ref(b.vendorId),
    DocNumber: b.docNumber.slice(0, 21),
    TxnDate: b.txnDate,
    Line: b.lines.map((l) => ({ Amount: dollars(l.amount), Description: l.description.slice(0, 4000), DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: ref(l.accountId) } })),
    ...(b.note ? { PrivateNote: b.note.slice(0, 4000) } : {})
  };
}

// ── QuickBooks to desk (pure) ───────────────────────────────────────────────────────────────

const centsOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? new Prisma.Decimal(v).times(100).toDecimalPlaces(0).toNumber() : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const refId = (v: unknown): string | null => (v && typeof v === "object" ? str((v as { value?: unknown }).value) : null);

export function fromQbo(entity: QboEntity, o: QboBody): QboRecord {
  const lines = Array.isArray(o.Line) ? (o.Line as QboBody[]) : [];
  const links = entity === "Payment" ? lines.flatMap((l) => (Array.isArray(l.LinkedTxn) ? (l.LinkedTxn as QboBody[]) : []).map((t) => ({ id: String(t.TxnId ?? ""), type: String(t.TxnType ?? ""), amount: centsOf(l.Amount) ?? 0 }))) : [];
  const meta = (o.MetaData ?? {}) as QboBody;
  return {
    entity,
    id: String(o.Id ?? ""),
    syncToken: String(o.SyncToken ?? "0"),
    status: o.status === "voided" ? "voided" : o.status === "deleted" ? "deleted" : "active",
    name: str(o.DisplayName) ?? str(o.Name),
    companyName: str(o.CompanyName),
    docNumber: str(o.DocNumber),
    txnDate: str(o.TxnDate),
    total: centsOf(o.TotalAmt),
    balance: centsOf(o.Balance),
    customerId: refId(o.CustomerRef),
    accountType: str(o.AccountType),
    links,
    updatedAt: str(meta.LastUpdatedTime)
  };
}

// ── The adapter ─────────────────────────────────────────────────────────────────────────────

function adapterFor(client: QboClient): Adapter<In, QboAnswer> {
  return async ({ provider, input }) => {
    try {
      const items = await client.send(input.auth, input.at, input.request);
      return ok({ records: items.map((i) => fromQbo(i.entity, i.obj)), at: input.at });
    } catch (e) {
      if (e instanceof NotLive) return notImplemented(provider);
      if (e instanceof QboFault) return err(e.status === 401 ? "unauthenticated" : "bad_request", `QuickBooks: ${e.message}`, `qbo:${e.code}`);
      throw e;
    }
  };
}

// ── The simulator ───────────────────────────────────────────────────────────────────────────

type SimObj = QboBody & { Id: string; SyncToken: string; status: "active" | "voided" | "deleted"; MetaData: { LastUpdatedTime: string } };
type Book = { next: number; objects: Map<QboEntity, Map<string, SimObj>> };

const D = (v: unknown) => new Prisma.Decimal(typeof v === "number" ? v : 0);
const ACCOUNT_TYPE: Record<string, string> = {
  "Accounts Receivable": "Accounts Receivable",
  "Undeposited Funds": "Other Current Asset",
  "Factoring Reserve": "Other Current Asset",
  "Accounts Payable": "Accounts Payable",
  "Fuel Card Payable": "Other Current Liability",
  // Escrow is the driver's money the fleet holds (a liability); an advance is money the driver owes back (an asset).
  "Driver Escrow": "Other Current Liability",
  "Driver Advances": "Other Current Asset",
  Checking: "Bank"
};
/** A test company's chart of accounts: every default account name, a discounts account, and a bank; and one customer typed in by a bookkeeper before the desk ever synced. */
function seed(book: Book, at: string) {
  const names = new Set<string>([...ACCOUNT_KEYS.flatMap((k) => (k.fallback ? [k.fallback] : [])), "Sales Discounts", "Checking"]);
  for (const name of names) {
    const group = ACCOUNT_KEYS.find((k) => k.fallback === name)?.group;
    put(book, "Account", { Name: name, AccountType: ACCOUNT_TYPE[name] ?? (group === "expense" ? "Expense" : "Income") }, at);
  }
  put(book, "Customer", { DisplayName: "ACME LOGISTICS, LLC", CompanyName: "Acme Logistics LLC" }, at);
}

function put(book: Book, entity: QboEntity, body: QboBody, at: string): SimObj {
  const id = String(book.next++);
  const obj = { ...body, Id: id, SyncToken: "0", status: "active", MetaData: { LastUpdatedTime: at } } as SimObj;
  if (!book.objects.has(entity)) book.objects.set(entity, new Map());
  book.objects.get(entity)!.set(id, obj);
  return obj;
}

const globalBooks = globalThis as unknown as { __qboSandboxBooks?: Map<string, Book> };
const books = (globalBooks.__qboSandboxBooks ??= new Map<string, Book>());

/** One fleet's simulated QuickBooks company, made (and seeded) on first use. Lives as long as the server process: a restart starts a fresh test company. */
export function sandboxBook(realmId: string, tenant: string, at = new Date().toISOString()): Book {
  const key = `${realmId}:${tenant}`;
  let b = books.get(key);
  if (!b) {
    b = { next: 1, objects: new Map() };
    seed(b, at);
    books.set(key, b);
  }
  return b;
}

/** For tests and the demo: forget a fleet's simulated company. */
export const resetSandboxBook = (realmId: string, tenant: string) => books.delete(`${realmId}:${tenant}`);

const all = (b: Book, e: QboEntity) => [...(b.objects.get(e)?.values() ?? [])];
const get = (b: Book, e: QboEntity, id: unknown): SimObj | null => {
  const o = typeof id === "string" ? b.objects.get(e)?.get(id) : undefined;
  return o && o.status === "active" ? o : null;
};
const fault = (code: string, msg: string): never => {
  throw new QboFault(code, msg);
};
const norm = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : "");
const sumLines = (o: QboBody) => (Array.isArray(o.Line) ? (o.Line as QboBody[]) : []).reduce((s, l) => s.plus(D(l.Amount)), new Prisma.Decimal(0));

function checkBody(b: Book, entity: QboEntity, body: QboBody, selfId: string | null) {
  const lines = Array.isArray(body.Line) ? (body.Line as QboBody[]) : [];
  if (entity === "Customer" || entity === "Vendor") {
    if (!norm(body.DisplayName)) fault("2020", "Required param missing: DisplayName");
    // Names are unique across customers and vendors.
    if ([...all(b, "Customer"), ...all(b, "Vendor")].some((o) => o.status === "active" && o.Id !== selfId && norm(o.DisplayName) === norm(body.DisplayName))) fault("6240", `Duplicate Name Exists Error: ${String(body.DisplayName)}`);
  }
  if (entity === "Item") {
    if (all(b, "Item").some((o) => o.status === "active" && o.Id !== selfId && norm(o.Name) === norm(body.Name))) fault("6240", `Duplicate Name Exists Error: ${String(body.Name)}`);
    if (!get(b, "Account", refId(body.IncomeAccountRef))) fault("2500", "Invalid Reference Id: IncomeAccountRef");
  }
  if (entity === "Invoice" || entity === "CreditMemo") {
    if (!get(b, "Customer", refId(body.CustomerRef))) fault("2500", "Invalid Reference Id: CustomerRef");
    if (lines.length === 0) fault("2020", "Required param missing: Line");
    for (const l of lines) {
      if (!get(b, "Item", refId((l.SalesItemLineDetail as QboBody | undefined)?.ItemRef))) fault("2500", "Invalid Reference Id: ItemRef");
      if (!D(l.Amount).gt(0)) fault("6000", "A line amount must be more than zero.");
    }
    if (body.DocNumber && all(b, entity).some((o) => o.Id !== selfId && o.DocNumber === body.DocNumber)) fault("6140", `Duplicate Document Number Error: ${String(body.DocNumber)}`);
  }
  if (entity === "JournalEntry") {
    let dr = new Prisma.Decimal(0);
    let cr = new Prisma.Decimal(0);
    for (const l of lines) {
      const det = (l.JournalEntryLineDetail ?? {}) as QboBody;
      if (!get(b, "Account", refId(det.AccountRef))) fault("2500", "Invalid Reference Id: AccountRef");
      if (!D(l.Amount).gt(0)) fault("6000", "A line amount must be more than zero.");
      if (det.PostingType === "Debit") dr = dr.plus(D(l.Amount));
      else if (det.PostingType === "Credit") cr = cr.plus(D(l.Amount));
      else fault("2020", "Required param missing: PostingType");
    }
    if (!dr.equals(cr)) fault("6000", "Transaction must balance: debits and credits differ.");
  }
  if (entity === "Bill") {
    if (!get(b, "Vendor", refId(body.VendorRef))) fault("2500", "Invalid Reference Id: VendorRef");
    for (const l of lines) if (!get(b, "Account", refId(((l.AccountBasedExpenseLineDetail ?? {}) as QboBody).AccountRef))) fault("2500", "Invalid Reference Id: AccountRef");
    if (sumLines(body).isNegative()) fault("6000", "A bill cannot total less than zero.");
  }
  if (entity === "Payment") {
    if (!get(b, "Customer", refId(body.CustomerRef))) fault("2500", "Invalid Reference Id: CustomerRef");
    if (body.DepositToAccountRef && !get(b, "Account", refId(body.DepositToAccountRef))) fault("2500", "Invalid Reference Id: DepositToAccountRef");
  }
}

/** A payment's links applied to (sign 1) or taken back from (sign -1) the documents' open balances. Invoices are paid by the amount; credit memos give the amount. */
function applyPayment(b: Book, pay: QboBody, sign: 1 | -1, check: boolean) {
  let net = new Prisma.Decimal(0);
  for (const l of Array.isArray(pay.Line) ? (pay.Line as QboBody[]) : []) {
    for (const t of Array.isArray(l.LinkedTxn) ? (l.LinkedTxn as QboBody[]) : []) {
      const type = t.TxnType === "CreditMemo" ? "CreditMemo" : "Invoice";
      const doc = get(b, type, t.TxnId);
      if (!doc) fault("2500", `Invalid Reference Id: LinkedTxn ${String(t.TxnId)}`);
      if (refId(doc!.CustomerRef) !== refId(pay.CustomerRef)) fault("6000", "A payment can only be applied to its own customer's documents.");
      const amt = D(l.Amount);
      const after = D(doc!.Balance).minus(amt.times(sign));
      if (check && sign === 1 && after.isNegative()) fault("6000", `The amount applied is more than ${type === "Invoice" ? "the invoice" : "the credit"} has open.`);
      doc!.Balance = after.toDecimalPlaces(2).toNumber();
      net = type === "Invoice" ? net.plus(amt) : net.minus(amt);
    }
  }
  if (check && sign === 1 && !net.equals(D(pay.TotalAmt))) fault("6000", "The payment's total does not match what it is applied to.");
}

function stamp(o: SimObj, at: string) {
  o.SyncToken = String(Number.parseInt(o.SyncToken, 10) + 1);
  o.MetaData = { LastUpdatedTime: at };
}

export const sandboxQboClient: QboClient = {
  async send(auth, at, req) {
    if (!auth.accessToken.startsWith("sandbox_access_")) throw new QboFault("3200", "AuthenticationFailed: the access token was not one the simulator gave.", 401);
    const b = sandboxBook(auth.realmId, auth.tenant, at);
    const out = (entity: QboEntity, obj: SimObj) => [{ entity, obj: { ...obj } as QboBody }];
    switch (req.op) {
      case "list":
        return all(b, req.entity)
          .filter((o) => o.status === "active")
          .map((o) => ({ entity: req.entity, obj: { ...o } as QboBody }));
      case "find":
        return all(b, req.entity)
          .filter((o) => o.DocNumber === req.docNumber)
          .map((o) => ({ entity: req.entity, obj: { ...o } as QboBody }));
      case "create": {
        checkBody(b, req.entity, req.body, null);
        const body: QboBody = { ...req.body };
        if (req.entity === "Invoice" || req.entity === "CreditMemo" || req.entity === "Bill") {
          body.TotalAmt = sumLines(body).toDecimalPlaces(2).toNumber();
          if (req.entity !== "Bill") body.Balance = body.TotalAmt;
        }
        if (req.entity === "Payment") applyPayment(b, body, 1, true);
        return out(req.entity, put(b, req.entity, body, at));
      }
      case "update": {
        const o = get(b, req.entity, req.id);
        if (!o) fault("610", "Object Not Found: it was deleted or voided.");
        if (o!.SyncToken !== req.syncToken) fault("5010", "Stale Object Error: you and someone else changed it at the same time.");
        checkBody(b, req.entity, req.body, o!.Id);
        if (req.entity === "Payment") applyPayment(b, o!, -1, false);
        const applied = req.entity === "Invoice" || req.entity === "CreditMemo" ? D(o!.TotalAmt).minus(D(o!.Balance)) : null;
        Object.assign(o!, req.body);
        if (req.entity === "Invoice" || req.entity === "CreditMemo" || req.entity === "Bill") o!.TotalAmt = sumLines(o!).toDecimalPlaces(2).toNumber();
        if (applied) {
          const bal = D(o!.TotalAmt).minus(applied);
          if (bal.isNegative()) fault("6000", "The new total is less than what has already been applied to it.");
          o!.Balance = bal.toDecimalPlaces(2).toNumber();
        }
        if (req.entity === "Payment") applyPayment(b, o!, 1, true);
        stamp(o!, at);
        return out(req.entity, o!);
      }
      case "void": {
        const o = get(b, req.entity, req.id);
        if (!o) fault("610", "Object Not Found: it was deleted or voided.");
        if (o!.SyncToken !== req.syncToken) fault("5010", "Stale Object Error: you and someone else changed it at the same time.");
        if (req.entity === "Payment") applyPayment(b, o!, -1, false);
        else if (!D(o!.Balance).equals(D(o!.TotalAmt))) fault("6480", "It has payments or credits applied: void those first.");
        o!.status = "voided";
        o!.TotalAmt = 0;
        o!.Balance = 0;
        stamp(o!, at);
        return out(req.entity, o!);
      }
      case "delete": {
        const o = get(b, req.entity, req.id);
        if (!o) fault("610", "Object Not Found: it was deleted or voided.");
        if (o!.SyncToken !== req.syncToken) fault("5010", "Stale Object Error: you and someone else changed it at the same time.");
        o!.status = "deleted";
        stamp(o!, at);
        return out(req.entity, o!);
      }
      case "changes":
        return req.entities.flatMap((e) => all(b, e).filter((o) => o.MetaData.LastUpdatedTime > req.since).map((o) => ({ entity: e, obj: { ...o } as QboBody })));
    }
  }
};

/** For tests and the demo: a bookkeeper enters a customer payment straight into the simulated QuickBooks, as the pull will then find it. */
export function sandboxRecordPayment(realmId: string, tenant: string, p: { invoiceId: string; amount: number; txnDate: string; at: string }): string {
  const b = sandboxBook(realmId, tenant, p.at);
  const inv = get(b, "Invoice", p.invoiceId);
  if (!inv) throw new Error("no such invoice in the sandbox");
  const body: QboBody = { CustomerRef: inv.CustomerRef, TxnDate: p.txnDate, TotalAmt: dollars(p.amount), PaymentRefNum: "CHK-1001", Line: [{ Amount: dollars(p.amount), LinkedTxn: [{ TxnId: p.invoiceId, TxnType: "Invoice" }] }] };
  applyPayment(b, body, 1, true);
  return put(b, "Payment", body, p.at).Id;
}

export const quickbooksAdapter: ProviderAdapter<In, QboAnswer> = { live: adapterFor(liveQboClient), sandbox: adapterFor(sandboxQboClient) };
