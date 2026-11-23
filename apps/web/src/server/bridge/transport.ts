import { randomUUID } from "crypto";
import { wholeOf, type BridgeConfig, type BridgeRow } from "./core";
import type { LinkRow } from "@/lib/driver-link";
import type { DriverMessageRow } from "@/lib/driver-messages";
import type { DriverStatusRow } from "@/lib/driver-status";
import type { LoadDocumentRow, LoadDocumentThere } from "@/lib/load-documents";
import type { DriverBalanceRow, DriverStatementRow } from "@/lib/driver-pay";

/**
 * How the desk reaches `bridge.external_dispatch`. One small interface, two implementations: the real one (PostgREST over `fetch`, with the service key) and an in-memory one the tests drive,
 * which behaves like the table (a version-checked update, a rising `sync_seq`, the phone's own version counter). The desk never talks to Supabase anywhere else.
 */
export class BridgeTransportError extends Error {
  /** unreachable: no answer; rejected: the link answered no. The message is a fixed sentence, never a body, a header or the key. */
  constructor(readonly code: "unreachable" | "rejected", message: string) {
    super(message);
  }
}

export interface BridgeTransport {
  /** The row still open (draft or dispatched) for this load and this driver's phone, or null. */
  findOpenRow(orgId: string, loadId: string, phoneUserId: string): Promise<BridgeRow | null>;
  insert(row: Record<string, unknown>): Promise<BridgeRow>;
  /** An update that only lands if `assignment_version` is still `expected`; null when it was not (someone else moved the row). */
  patch(id: string, expectedAssignmentVersion: number, changes: Record<string, unknown>): Promise<BridgeRow | null>;
  /** Rows of this fleet written since `afterSeq`, oldest first. */
  changedSince(orgId: string, afterSeq: number, limit: number): Promise<BridgeRow[]>;
  /** Every row of this fleet for one load, newest first (G10: to say which row replaced a reassigned one). */
  rowsForLoad(orgId: string, loadId: string): Promise<BridgeRow[]>;
  /** Driver link (Phase 2 step 1): write a new invite's row on `bridge.driver_links`. */
  insertLink(row: Record<string, unknown>): Promise<{ id: string }>;
  /** Withdraw this driver's codes that nobody claimed yet (a new code replaces them). */
  revokeUnclaimedLinks(orgId: string, deskDriverId: string, at: Date): Promise<void>;
  /** End this driver's live link from the desk side. */
  endLink(orgId: string, deskDriverId: string, at: Date): Promise<void>;
  /** This fleet's claimed links (live or ended), so the pull can link and unlink. */
  claimedLinks(orgId: string, limit: number): Promise<LinkRow[]>;
  /** Messages (Phase 2 step 3): write a desk message for the phone. A row with the same sender and client id already there is returned as it is (a re-delivery). */
  insertDriverMessage(row: Record<string, unknown>): Promise<DriverMessageRow>;
  /** This fleet's messages from phones the desk has not taken yet, oldest first. */
  driverMessagesToDesk(orgId: string, limit: number): Promise<DriverMessageRow[]>;
  /** Stamp delivered_at / read_at on rows of this fleet (a stamp already there is kept). */
  stampDriverMessages(orgId: string, ids: string[], field: "delivered_at" | "read_at", at: Date): Promise<void>;
  /** The desk's own sent messages (by client id) the driver has read, with when. */
  readByDriver(orgId: string, clientIds: string[]): Promise<{ client_id: string; read_at: string }[]>;
  /** One file a driver sent (the private `bridge-files` bucket). Null when the bucket does not have it; throws when the link cannot be reached. */
  downloadDriverFile(path: string): Promise<Uint8Array | null>;
  /** This fleet's rows that were read before `readBefore` (and delivered): what the retention purge takes off the bridge, with their files. */
  driverMessagesReadBefore(orgId: string, readBefore: Date, limit: number): Promise<Pick<DriverMessageRow, "id" | "attachments" | "delivered_at" | "read_at">[]>;
  /** Remove files from the bucket (a file already gone is fine). */
  removeDriverFiles(paths: string[]): Promise<void>;
  /** Delete rows of this fleet, only if they were still read before `readBefore` (nothing newer is ever taken). */
  deleteDriverMessages(orgId: string, ids: string[], readBefore: Date): Promise<void>;
  /** HOS mirror (Phase 2 step 4): this fleet's rows on `bridge.driver_status`, to compare before writing. */
  driverStatusRows(orgId: string): Promise<DriverStatusRow[]>;
  /** Write rows, keyed on (org_id, driver_sub): a row already there is replaced. */
  upsertDriverStatus(rows: DriverStatusRow[]): Promise<void>;
  /** Remove this fleet's rows for phones no longer connected to it. */
  deleteDriverStatus(orgId: string, driverSubs: string[]): Promise<void>;
  /** Stop events (sync plan Step 2): this fleet's rows on `bridge.stop_events` written since `afterSeq`, oldest first. */
  stopEventsSince(orgId: string, afterSeq: number, limit: number): Promise<StopEventRow[]>;
  /** Files from the desk (sync plan Step 4): put one in the bucket, under the desk's folder for one driver's phone. One already there is replaced. */
  uploadDeskFile(path: string, data: Uint8Array, mime: string): Promise<void>;
  /** This fleet's rows on `bridge.load_documents`, to compare before writing. */
  loadDocumentRows(orgId: string): Promise<LoadDocumentThere[]>;
  /** Write one row, keyed on (org_id, driver_sub, desk_document_id): a row already there is replaced. */
  upsertLoadDocument(row: LoadDocumentRow): Promise<void>;
  deleteLoadDocuments(orgId: string, ids: string[]): Promise<void>;
  /** Driver pay (sync plan Step 5a): this fleet's statement rows, without their lines, to compare before writing. */
  driverStatementRows(orgId: string): Promise<StatementThere[]>;
  /** Write one statement, keyed on (org_id, driver_sub, desk_statement_id). */
  upsertDriverStatement(row: DriverStatementRow): Promise<void>;
  deleteDriverStatements(orgId: string, ids: string[]): Promise<void>;
  driverBalanceRows(orgId: string): Promise<DriverBalanceRow[]>;
  /** Write balances, keyed on (org_id, driver_sub). */
  upsertDriverBalances(rows: (DriverBalanceRow & { as_of: string })[]): Promise<void>;
  deleteDriverBalances(orgId: string, driverSubs: string[]): Promise<void>;
}

export type StatementThere = { id: string; driver_sub: string; desk_statement_id: string; desk_rev: string; pdf_path: string | null };

/** A row of `bridge.stop_events` (the phone project's supabase/migrations/20261122000100_bridge_stop_events.sql), as the desk reads it. */
export type StopEventRow = {
  id: string;
  org_id: string;
  driver_sub: string;
  dispatch_id: string;
  source_load_id: string | null;
  stop_seq: number | null;
  kind: "arrived" | "arrival_undone" | "loaded" | "emptied" | "check_call" | string;
  at: string;
  wait_minutes: number | null;
  seal: string | null;
  lat: number | null;
  lng: number | null;
  sync_seq: number;
};

const SAFE = { unreachable: "The driver link could not be reached.", rejected: "The driver link refused the request." } as const;

/** The largest file the desk will fetch from the bridge (the bucket's own limit is 15 MB; the desk keeps 10 MB a file, and checks again). */
const FILE_FETCH_MAX = 15 * 1024 * 1024;

/** Values that go into a PostgREST filter are percent-encoded and checked to be plain: an id or a Clerk user id, never a filter of their own. */
const plain = (v: string): string => {
  if (!/^[A-Za-z0-9_.:@-]{1,200}$/.test(v)) throw new BridgeTransportError("rejected", SAFE.rejected);
  return encodeURIComponent(v);
};

export function supabaseTransport(cfg: BridgeConfig, fetchImpl: typeof fetch = fetch): BridgeTransport {
  const base = `${cfg.url}/rest/v1/external_dispatch`;
  const links = `${cfg.url}/rest/v1/driver_links`;
  const msgs = `${cfg.url}/rest/v1/driver_messages`;
  const stopEvents = `${cfg.url}/rest/v1/stop_events`;
  const files = `${cfg.url}/storage/v1/object/bridge-files`;
  const status = `${cfg.url}/rest/v1/driver_status`;
  const docs = `${cfg.url}/rest/v1/load_documents`;
  const statements = `${cfg.url}/rest/v1/driver_statements`;
  const balances = `${cfg.url}/rest/v1/driver_balances`;
  const inList = (ids: string[]) => `(${ids.map(plain).join(",")})`;
  const LINK_COLUMNS = "id,org_id,desk_driver_id,driver_role,claimed_by,claimed_at,revoked_at,ended_by";
  const headers = (write: boolean): Record<string, string> => ({
    apikey: cfg.key,
    Authorization: `Bearer ${cfg.key}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(write ? { "Content-Profile": "bridge", Prefer: "return=representation" } : { "Accept-Profile": "bridge" })
  });
  async function call(url: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, cache: "no-store" });
    } catch {
      throw new BridgeTransportError("unreachable", SAFE.unreachable);
    }
    if (res.status >= 500) throw new BridgeTransportError("unreachable", SAFE.unreachable);
    if (!res.ok) throw new BridgeTransportError("rejected", SAFE.rejected);
    try {
      return await res.json();
    } catch {
      return [];
    }
  }
  const rows = (v: unknown): BridgeRow[] => (Array.isArray(v) ? (v as BridgeRow[]) : []);
  return {
    async findOpenRow(orgId, loadId, phoneUserId) {
      const q = `?org_id=eq.${plain(orgId)}&source_load_id=eq.${plain(loadId)}&assigned_driver_id=eq.${plain(phoneUserId)}&status=in.(draft,dispatched)&order=sync_seq.desc&limit=1`;
      return rows(await call(base + q, { method: "GET", headers: headers(false) }))[0] ?? null;
    },
    async insert(row) {
      const out = rows(await call(base, { method: "POST", headers: headers(true), body: JSON.stringify(row) }))[0];
      if (!out) throw new BridgeTransportError("rejected", SAFE.rejected);
      return out;
    },
    async patch(id, expected, changes) {
      const q = `?id=eq.${plain(id)}&assignment_version=eq.${wholeOf(expected)}`;
      return rows(await call(base + q, { method: "PATCH", headers: headers(true), body: JSON.stringify(changes) }))[0] ?? null;
    },
    async changedSince(orgId, afterSeq, limit) {
      const q = `?org_id=eq.${plain(orgId)}&sync_seq=gt.${wholeOf(afterSeq)}&order=sync_seq.asc&limit=${Math.min(Math.max(wholeOf(limit), 1), 500)}`;
      return rows(await call(base + q, { method: "GET", headers: headers(false) }));
    },
    async stopEventsSince(orgId, afterSeq, limit) {
      const q = `?org_id=eq.${plain(orgId)}&sync_seq=gt.${wholeOf(afterSeq)}&order=sync_seq.asc&limit=${Math.min(Math.max(wholeOf(limit), 1), 500)}`;
      const out = await call(stopEvents + q, { method: "GET", headers: headers(false) });
      return Array.isArray(out) ? (out as StopEventRow[]) : [];
    },
    async rowsForLoad(orgId, loadId) {
      const q = `?org_id=eq.${plain(orgId)}&source_load_id=eq.${plain(loadId)}&order=sync_seq.desc&limit=20`;
      return rows(await call(base + q, { method: "GET", headers: headers(false) }));
    },
    async insertLink(row) {
      const out = (await call(links, { method: "POST", headers: headers(true), body: JSON.stringify(row) })) as { id?: string }[];
      const id = Array.isArray(out) ? out[0]?.id : undefined;
      if (!id) throw new BridgeTransportError("rejected", SAFE.rejected);
      return { id };
    },
    async revokeUnclaimedLinks(orgId, deskDriverId, at) {
      const q = `?org_id=eq.${plain(orgId)}&desk_driver_id=eq.${plain(deskDriverId)}&claimed_by=is.null&revoked_at=is.null`;
      await call(links + q, { method: "PATCH", headers: headers(true), body: JSON.stringify({ revoked_at: at.toISOString(), ended_by: "desk" }) });
    },
    async endLink(orgId, deskDriverId, at) {
      const q = `?org_id=eq.${plain(orgId)}&desk_driver_id=eq.${plain(deskDriverId)}&revoked_at=is.null`;
      await call(links + q, { method: "PATCH", headers: headers(true), body: JSON.stringify({ revoked_at: at.toISOString(), ended_by: "desk" }) });
    },
    async claimedLinks(orgId, limit) {
      const q = `?org_id=eq.${plain(orgId)}&claimed_by=not.is.null&select=${LINK_COLUMNS}&order=updated_at.asc&limit=${Math.min(Math.max(wholeOf(limit), 1), 500)}`;
      const out = await call(links + q, { method: "GET", headers: headers(false) });
      return Array.isArray(out) ? (out as LinkRow[]) : [];
    },
    async insertDriverMessage(row) {
      // ignore-duplicates: a re-delivery of the same desk message adds nothing; read the row that is there instead.
      const h = { ...headers(true), Prefer: "return=representation,resolution=ignore-duplicates" };
      const made = (await call(`${msgs}?on_conflict=direction,sender_id,client_id`, { method: "POST", headers: h, body: JSON.stringify(row) })) as DriverMessageRow[];
      if (Array.isArray(made) && made[0]) return made[0];
      const q = `?direction=eq.to_driver&sender_id=eq.${plain(String(row.sender_id))}&client_id=eq.${plain(String(row.client_id))}&limit=1`;
      const there = (await call(msgs + q, { method: "GET", headers: headers(false) })) as DriverMessageRow[];
      if (!Array.isArray(there) || !there[0]) throw new BridgeTransportError("rejected", SAFE.rejected);
      return there[0];
    },
    async driverMessagesToDesk(orgId, limit) {
      const q = `?org_id=eq.${plain(orgId)}&direction=eq.to_desk&delivered_at=is.null&order=created_at.asc&limit=${Math.min(Math.max(wholeOf(limit), 1), 500)}`;
      const out = await call(msgs + q, { method: "GET", headers: headers(false) });
      return Array.isArray(out) ? (out as DriverMessageRow[]) : [];
    },
    async stampDriverMessages(orgId, ids, field, when) {
      if (ids.length === 0) return;
      const q = `?org_id=eq.${plain(orgId)}&id=in.${inList(ids)}&${field}=is.null`;
      await call(msgs + q, { method: "PATCH", headers: headers(true), body: JSON.stringify({ [field]: when.toISOString() }) });
    },
    async readByDriver(orgId, clientIds) {
      if (clientIds.length === 0) return [];
      const q = `?org_id=eq.${plain(orgId)}&direction=eq.to_driver&client_id=in.${inList(clientIds)}&read_at=not.is.null&select=client_id,read_at`;
      const out = await call(msgs + q, { method: "GET", headers: headers(false) });
      return Array.isArray(out) ? (out as { client_id: string; read_at: string }[]) : [];
    },
    async downloadDriverFile(path) {
      let res: Response;
      try {
        res = await fetchImpl(`${files}/${filePath(path)}`, { method: "GET", headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` }, cache: "no-store" });
      } catch {
        throw new BridgeTransportError("unreachable", SAFE.unreachable);
      }
      // Storage answers a missing object with 400 or 404.
      if (res.status === 404 || res.status === 400) return null;
      if (res.status >= 500) throw new BridgeTransportError("unreachable", SAFE.unreachable);
      if (!res.ok) throw new BridgeTransportError("rejected", SAFE.rejected);
      const len = Number.parseInt(res.headers.get("content-length") ?? "0", 10) || 0;
      if (len > FILE_FETCH_MAX) throw new BridgeTransportError("rejected", SAFE.rejected);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > FILE_FETCH_MAX) throw new BridgeTransportError("rejected", SAFE.rejected);
      return buf;
    },
    async driverMessagesReadBefore(orgId, readBefore, limit) {
      const q = `?org_id=eq.${plain(orgId)}&delivered_at=not.is.null&read_at=lt.${plain(readBefore.toISOString())}&select=id,attachments,delivered_at,read_at&order=read_at.asc&limit=${Math.min(Math.max(wholeOf(limit), 1), 500)}`;
      const out = await call(msgs + q, { method: "GET", headers: headers(false) });
      return Array.isArray(out) ? (out as Pick<DriverMessageRow, "id" | "attachments" | "delivered_at" | "read_at">[]) : [];
    },
    async removeDriverFiles(paths) {
      if (paths.length === 0) return;
      for (const p of paths) filePath(p); // every path is checked before anything is sent
      await call(files, { method: "DELETE", headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: paths }) });
    },
    async deleteDriverMessages(orgId, ids, readBefore) {
      if (ids.length === 0) return;
      const q = `?org_id=eq.${plain(orgId)}&id=in.${inList(ids)}&delivered_at=not.is.null&read_at=lt.${plain(readBefore.toISOString())}`;
      await call(msgs + q, { method: "DELETE", headers: { ...headers(true), Prefer: "return=minimal" } });
    },
    async driverStatusRows(orgId) {
      const q = `?org_id=eq.${plain(orgId)}&select=org_id,driver_sub,desk_driver_id,drive_minutes,shift_minutes,cycle_minutes,unit_name,synced_at&limit=5000`;
      const out = await call(status + q, { method: "GET", headers: headers(false) });
      return Array.isArray(out) ? (out as DriverStatusRow[]) : [];
    },
    async upsertDriverStatus(rows) {
      if (rows.length === 0) return;
      for (const r of rows) {
        plain(r.org_id);
        plain(r.driver_sub);
      }
      const h = { ...headers(true), Prefer: "return=minimal,resolution=merge-duplicates" };
      await call(`${status}?on_conflict=org_id,driver_sub`, { method: "POST", headers: h, body: JSON.stringify(rows.map((r) => ({ ...r, updated_at: new Date().toISOString() }))) });
    },
    async deleteDriverStatus(orgId, subs) {
      if (subs.length === 0) return;
      const q = `?org_id=eq.${plain(orgId)}&driver_sub=in.${inList(subs)}`;
      await call(status + q, { method: "DELETE", headers: { ...headers(true), Prefer: "return=minimal" } });
    },
    async uploadDeskFile(path, data, mime) {
      if (!path.split("/").includes("desk")) throw new BridgeTransportError("rejected", SAFE.rejected);
      await call(`${files}/${filePath(path)}`, { method: "POST", headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, "Content-Type": mime, "x-upsert": "true" }, body: Buffer.from(data) });
    },
    async loadDocumentRows(orgId) {
      const q = `?org_id=eq.${plain(orgId)}&select=id,org_id,driver_sub,source_load_id,desk_document_id,kind,name,mime,bytes,path&order=created_at.asc&limit=5000`;
      const out = await call(docs + q, { method: "GET", headers: headers(false) });
      return Array.isArray(out) ? (out as LoadDocumentThere[]) : [];
    },
    async upsertLoadDocument(row) {
      plain(row.org_id);
      plain(row.driver_sub);
      const h = { ...headers(true), Prefer: "return=minimal,resolution=merge-duplicates" };
      await call(`${docs}?on_conflict=org_id,driver_sub,desk_document_id`, { method: "POST", headers: h, body: JSON.stringify(row) });
    },
    async deleteLoadDocuments(orgId, ids) {
      if (ids.length === 0) return;
      await call(`${docs}?org_id=eq.${plain(orgId)}&id=in.${inList(ids)}`, { method: "DELETE", headers: { ...headers(true), Prefer: "return=minimal" } });
    },
    async driverStatementRows(orgId) {
      const q = `?org_id=eq.${plain(orgId)}&select=id,driver_sub,desk_statement_id,desk_rev,pdf_path&limit=5000`;
      const out = await call(statements + q, { method: "GET", headers: headers(false) });
      return Array.isArray(out) ? (out as StatementThere[]) : [];
    },
    async upsertDriverStatement(row) {
      plain(row.org_id);
      plain(row.driver_sub);
      const h = { ...headers(true), Prefer: "return=minimal,resolution=merge-duplicates" };
      await call(`${statements}?on_conflict=org_id,driver_sub,desk_statement_id`, { method: "POST", headers: h, body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }) });
    },
    async deleteDriverStatements(orgId, ids) {
      if (ids.length === 0) return;
      await call(`${statements}?org_id=eq.${plain(orgId)}&id=in.${inList(ids)}`, { method: "DELETE", headers: { ...headers(true), Prefer: "return=minimal" } });
    },
    async driverBalanceRows(orgId) {
      const q = `?org_id=eq.${plain(orgId)}&select=org_id,driver_sub,desk_driver_id,escrow_cents,advances,next_off,unsettled_cents,unsettled_loads,unsettled_unpriced,ytd&limit=5000`;
      const out = await call(balances + q, { method: "GET", headers: headers(false) });
      return Array.isArray(out) ? (out as DriverBalanceRow[]) : [];
    },
    async upsertDriverBalances(rows) {
      if (rows.length === 0) return;
      for (const r of rows) {
        plain(r.org_id);
        plain(r.driver_sub);
      }
      const h = { ...headers(true), Prefer: "return=minimal,resolution=merge-duplicates" };
      await call(`${balances}?on_conflict=org_id,driver_sub`, { method: "POST", headers: h, body: JSON.stringify(rows) });
    },
    async deleteDriverBalances(orgId, subs) {
      if (subs.length === 0) return;
      await call(`${balances}?org_id=eq.${plain(orgId)}&driver_sub=in.${inList(subs)}`, { method: "DELETE", headers: { ...headers(true), Prefer: "return=minimal" } });
    }
  };
}

/** A bucket path is only ever one a phone wrote under `org/<org>/driver/<sub>/` or the desk wrote under `org/<org>/desk/<sub>/`: plain segments, percent-encoded one by one. */
function filePath(path: string): string {
  if (!/^org\/[A-Za-z0-9_.:@-]{1,200}\/(?:driver|desk)\/[A-Za-z0-9_.:@-]{1,200}\/[A-Za-z0-9_.-]{1,120}$/.test(path) || path.includes("..")) throw new BridgeTransportError("rejected", SAFE.rejected);
  return path.split("/").map(encodeURIComponent).join("/");
}

/** The table, in memory, for tests: a version-checked patch, a rising sequence, and `phone()` to answer the way the phone's RPC does (order enforced, the phone's own counter bumped). */
export function memoryTransport(opts: { down?: () => boolean } = {}) {
  const table: BridgeRow[] = [];
  let seq = 0;
  let n = 0;
  const touch = (r: BridgeRow) => ({ ...r, sync_seq: ++seq });
  const guard = () => {
    if (opts.down?.()) throw new BridgeTransportError("unreachable", SAFE.unreachable);
  };
  const at = (id: string) => table.findIndex((r) => r.id === id);
  type MemLink = LinkRow & { code_hash: string; expires_at: string; carrier_name: string; relationship?: string; forced_dispatch?: boolean; under_authority?: boolean; sponsored?: boolean };
  const linkTable: MemLink[] = [];
  const messages: DriverMessageRow[] = [];
  const files = new Map<string, Uint8Array>();
  const statuses: DriverStatusRow[] = [];
  const documents: LoadDocumentThere[] = [];
  const statementTable: (DriverStatementRow & { id: string })[] = [];
  const balanceTable: (DriverBalanceRow & { as_of: string })[] = [];
  const stopEvents: StopEventRow[] = [];
  let statusWrites = 0;
  const transport: BridgeTransport & {
    /** bridge.driver_status, and how many rows have been written (to see that unchanged clocks are not rewritten). */
    statuses: DriverStatusRow[];
    /** bridge.load_documents; the files themselves are in `files`. */
    documents: LoadDocumentThere[];
    /** bridge.driver_statements and bridge.driver_balances. */
    statements: (DriverStatementRow & { id: string })[];
    balances: (DriverBalanceRow & { as_of: string })[];
    statusWrites: () => number;
    table: BridgeRow[];
    links: MemLink[];
    messages: DriverMessageRow[];
    /** The bridge-files bucket: the phone puts a photo here before it sends the message. */
    files: Map<string, Uint8Array>;
    /** The phone sends a message the way bridge.send_driver_message does (a repeat client id is the same row). */
    phoneSays: (i: { orgId: string; driverSub: string; clientId: string; body: string; attachments?: DriverMessageRow["attachments"]; at?: Date }) => DriverMessageRow;
    /** The phone opens the thread the way bridge.mark_driver_messages_read does. */
    phoneReads: (orgId: string, driverSub: string, at: Date) => void;
    phone: (id: string, response: Record<string, unknown>) => void;
    /** bridge.stop_events, and the phone's send_stop_event (only the assigned driver, only while the dispatch is open; the org comes from the dispatch). */
    stopEvents: StopEventRow[];
    phoneStop: (e: { dispatchId: string; driverSub: string; kind: StopEventRow["kind"]; stopSeq?: number | null; at: Date; waitMinutes?: number | null; seal?: string | null; lat?: number | null; lng?: number | null }) => StopEventRow;
    /** Claim a code the way bridge.claim_driver_link does (unknown, expired or withdrawn -> link_invalid; someone else's -> link_used). */
    claim: (codeHash: string, phoneUserId: string, now: Date) => "ok" | "link_invalid" | "link_used" | "already_employed" | "forced_elsewhere" | "already_linked" | "under_other_authority";
  } = {
    table,
    links: linkTable,
    messages,
    files,
    statuses,
    statements: statementTable,
    balances: balanceTable,
    async driverStatementRows(orgId) {
      guard();
      return statementTable.filter((s) => s.org_id === orgId).map(({ id, driver_sub, desk_statement_id, desk_rev, pdf_path }) => ({ id, driver_sub, desk_statement_id, desk_rev, pdf_path }));
    },
    async upsertDriverStatement(row) {
      guard();
      const i = statementTable.findIndex((s) => s.org_id === row.org_id && s.driver_sub === row.driver_sub && s.desk_statement_id === row.desk_statement_id);
      if (i >= 0) statementTable[i] = { ...statementTable[i]!, ...row };
      else statementTable.push({ id: `st-${++n}`, ...row });
    },
    async deleteDriverStatements(orgId, ids) {
      guard();
      for (let i = statementTable.length - 1; i >= 0; i -= 1) if (statementTable[i]!.org_id === orgId && ids.includes(statementTable[i]!.id)) statementTable.splice(i, 1);
    },
    async driverBalanceRows(orgId) {
      guard();
      return balanceTable.filter((b) => b.org_id === orgId).map(({ as_of: _at, ...b }) => (void _at, { ...b }));
    },
    async upsertDriverBalances(rows) {
      guard();
      for (const r of rows) {
        const i = balanceTable.findIndex((b) => b.org_id === r.org_id && b.driver_sub === r.driver_sub);
        if (i >= 0) balanceTable[i] = r;
        else balanceTable.push(r);
      }
    },
    async deleteDriverBalances(orgId, subs) {
      guard();
      for (let i = balanceTable.length - 1; i >= 0; i -= 1) if (balanceTable[i]!.org_id === orgId && subs.includes(balanceTable[i]!.driver_sub)) balanceTable.splice(i, 1);
    },
    documents,
    async uploadDeskFile(path, data) {
      guard();
      filePath(path);
      files.set(path, data);
    },
    async loadDocumentRows(orgId) {
      guard();
      return documents.filter((d) => d.org_id === orgId).map((d) => ({ ...d }));
    },
    async upsertLoadDocument(row) {
      guard();
      const i = documents.findIndex((d) => d.org_id === row.org_id && d.driver_sub === row.driver_sub && d.desk_document_id === row.desk_document_id);
      if (i >= 0) documents[i] = { ...documents[i]!, ...row };
      else documents.push({ id: `doc-${++n}`, ...row });
    },
    async deleteLoadDocuments(orgId, ids) {
      guard();
      for (let i = documents.length - 1; i >= 0; i -= 1) if (documents[i]!.org_id === orgId && ids.includes(documents[i]!.id)) documents.splice(i, 1);
    },
    stopEvents,
    statusWrites: () => statusWrites,
    async driverStatusRows(orgId) {
      guard();
      return statuses.filter((s) => s.org_id === orgId).map((s) => ({ ...s }));
    },
    async upsertDriverStatus(rows) {
      guard();
      for (const r of rows) {
        const i = statuses.findIndex((s) => s.org_id === r.org_id && s.driver_sub === r.driver_sub);
        if (i >= 0) statuses[i] = { ...r };
        else statuses.push({ ...r });
        statusWrites += 1;
      }
    },
    async deleteDriverStatus(orgId, subs) {
      guard();
      for (let i = statuses.length - 1; i >= 0; i -= 1) if (statuses[i]!.org_id === orgId && subs.includes(statuses[i]!.driver_sub)) statuses.splice(i, 1);
    },
    async downloadDriverFile(path) {
      guard();
      const f = files.get(path);
      return f ? new Uint8Array(f) : null;
    },
    async driverMessagesReadBefore(orgId, readBefore, limit) {
      guard();
      return messages
        .filter((m) => m.org_id === orgId && m.delivered_at && m.read_at && Date.parse(m.read_at) < readBefore.getTime())
        .slice(0, limit)
        .map((m) => ({ id: m.id, attachments: m.attachments, delivered_at: m.delivered_at, read_at: m.read_at }));
    },
    async removeDriverFiles(paths) {
      guard();
      for (const p of paths) files.delete(p);
    },
    async deleteDriverMessages(orgId, ids, readBefore) {
      guard();
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i]!;
        if (m.org_id === orgId && ids.includes(m.id) && m.delivered_at && m.read_at && Date.parse(m.read_at) < readBefore.getTime()) messages.splice(i, 1);
      }
    },
    async findOpenRow(orgId, loadId, phoneUserId) {
      guard();
      return [...table].reverse().find((r) => r.org_id === orgId && r.source_load_id === loadId && r.assigned_driver_id === phoneUserId && ["draft", "dispatched"].includes(r.status)) ?? null;
    },
    async insert(row) {
      guard();
      const made = touch({ id: `row-${++n}`, execution_version: 0, driver_response: null, replaced_by_dispatch_id: null, kind: "dispatch", ...row } as BridgeRow);
      table.push(made);
      return made;
    },
    async patch(id, expected, changes) {
      guard();
      const i = at(id);
      if (i < 0 || table[i]!.assignment_version !== expected) return null;
      table[i] = touch({ ...table[i]!, ...changes } as BridgeRow);
      return table[i]!;
    },
    async changedSince(orgId, afterSeq, limit) {
      guard();
      return table.filter((r) => r.org_id === orgId && r.sync_seq > afterSeq).sort((a, b) => a.sync_seq - b.sync_seq).slice(0, limit);
    },
    async stopEventsSince(orgId, afterSeq, limit) {
      guard();
      return stopEvents.filter((e) => e.org_id === orgId && e.sync_seq > afterSeq).sort((a, b) => a.sync_seq - b.sync_seq).slice(0, limit).map((e) => ({ ...e }));
    },
    phoneStop(e) {
      const row = table.find((r) => r.id === e.dispatchId);
      if (!row || row.assigned_driver_id !== e.driverSub) throw new Error("not_your_dispatch");
      if (row.status !== "dispatched") throw new Error("dispatch_closed");
      const made: StopEventRow = {
        id: `stop-event-${stopEvents.length + 1}`,
        org_id: row.org_id,
        driver_sub: e.driverSub,
        dispatch_id: row.id,
        source_load_id: row.source_load_id,
        stop_seq: e.kind === "check_call" ? null : (e.stopSeq ?? null),
        kind: e.kind,
        at: e.at.toISOString(),
        wait_minutes: e.waitMinutes ?? null,
        seal: e.seal ?? null,
        lat: e.lat ?? null,
        lng: e.lng ?? null,
        sync_seq: ++seq
      };
      stopEvents.push(made);
      return made;
    },
    async rowsForLoad(orgId, loadId) {
      guard();
      return table.filter((r) => r.org_id === orgId && r.source_load_id === loadId).sort((a, b) => b.sync_seq - a.sync_seq).map((r) => ({ ...r }));
    },
    phone(id, response) {
      const i = at(id);
      if (i < 0) throw new Error("no such row");
      table[i] = touch({ ...table[i]!, driver_response: response, execution_version: table[i]!.execution_version + 1 });
    },
    async insertLink(row) {
      guard();
      const made = { id: `link-${++n}`, claimed_by: null, claimed_at: null, revoked_at: null, ended_by: null, ...row } as MemLink;
      linkTable.push(made);
      return { id: made.id };
    },
    async revokeUnclaimedLinks(orgId, deskDriverId, when) {
      guard();
      for (const l of linkTable) if (l.org_id === orgId && l.desk_driver_id === deskDriverId && !l.claimed_by && !l.revoked_at) Object.assign(l, { revoked_at: when.toISOString(), ended_by: "desk" });
    },
    async endLink(orgId, deskDriverId, when) {
      guard();
      for (const l of linkTable) if (l.org_id === orgId && l.desk_driver_id === deskDriverId && !l.revoked_at) Object.assign(l, { revoked_at: when.toISOString(), ended_by: "desk" });
    },
    async claimedLinks(orgId, limit) {
      guard();
      return linkTable.filter((l) => l.org_id === orgId && l.claimed_by).slice(0, limit).map((l) => ({ ...l }));
    },
    async insertDriverMessage(row) {
      guard();
      const there = messages.find((m) => m.direction === row.direction && m.sender_id === row.sender_id && m.client_id === row.client_id);
      if (there) return { ...there };
      const made = { id: `msg-${randomUUID()}`, attachments: [], desk_file_count: 0, load_ref: null, desk_driver_id: null, created_at: new Date().toISOString(), delivered_at: null, read_at: null, ...row } as unknown as DriverMessageRow;
      messages.push(made);
      return { ...made };
    },
    async driverMessagesToDesk(orgId, limit) {
      guard();
      return messages.filter((m) => m.org_id === orgId && m.direction === "to_desk" && !m.delivered_at).slice(0, limit).map((m) => ({ ...m }));
    },
    async stampDriverMessages(orgId, ids, field, when) {
      guard();
      for (const m of messages) if (m.org_id === orgId && ids.includes(m.id) && !m[field]) m[field] = when.toISOString();
    },
    async readByDriver(orgId, clientIds) {
      guard();
      return messages.filter((m) => m.org_id === orgId && m.direction === "to_driver" && clientIds.includes(m.client_id) && m.read_at).map((m) => ({ client_id: m.client_id, read_at: m.read_at! }));
    },
    phoneSays(i) {
      const there = messages.find((m) => m.direction === "to_desk" && m.sender_id === i.driverSub && m.client_id === i.clientId);
      if (there) return there;
      const made: DriverMessageRow = { id: `msg-${randomUUID()}`, org_id: i.orgId, driver_sub: i.driverSub, desk_driver_id: null, direction: "to_desk", sender_id: i.driverSub, client_id: i.clientId, body: i.body, attachments: i.attachments ?? [], desk_file_count: 0, load_ref: null, created_at: (i.at ?? new Date()).toISOString(), delivered_at: null, read_at: null };
      messages.push(made);
      return made;
    },
    phoneReads(orgId, driverSub, when) {
      for (const m of messages) if (m.org_id === orgId && m.driver_sub === driverSub && m.direction === "to_driver" && !m.read_at) m.read_at = when.toISOString();
    },
    claim(codeHash, phoneUserId, now) {
      const l = linkTable.find((x) => x.code_hash === codeHash);
      if (!l || l.revoked_at || (!l.claimed_by && Date.parse(l.expires_at) <= now.getTime())) return "link_invalid";
      if (l.claimed_by && l.claimed_by !== phoneUserId) return "link_used";
      if (!l.claimed_by) {
        // The connection rules of bridge.claim_driver_link (sync plan Step 3).
        const live = linkTable.filter((x) => x.claimed_by === phoneUserId && !x.revoked_at);
        const others = live.filter((x) => x.org_id !== l.org_id);
        const exclusive = (x: MemLink) => x.relationship === "employee" || x.forced_dispatch === true;
        if (others.some((x) => x.relationship === "employee")) return "already_employed";
        if (others.some((x) => x.forced_dispatch === true)) return "forced_elsewhere";
        if (exclusive(l) && others.length > 0) return "already_linked";
        if (l.under_authority === true && others.some((x) => x.under_authority === true)) return "under_other_authority";
        for (const x of live) if (x.org_id === l.org_id && x !== l) Object.assign(x, { revoked_at: now.toISOString(), ended_by: "replaced" });
      }
      Object.assign(l, { claimed_by: phoneUserId, claimed_at: l.claimed_at ?? now.toISOString() });
      return "ok";
    }
  };
  return transport;
}
