import { wholeOf, type BridgeConfig, type BridgeRow } from "./core";
import type { LinkRow } from "@/lib/driver-link";

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
  /** Driver link (Phase 2 step 1): write a new invite's row on `bridge.driver_links`. */
  insertLink(row: Record<string, unknown>): Promise<{ id: string }>;
  /** Withdraw this driver's codes that nobody claimed yet (a new code replaces them). */
  revokeUnclaimedLinks(orgId: string, deskDriverId: string, at: Date): Promise<void>;
  /** End this driver's live link from the desk side. */
  endLink(orgId: string, deskDriverId: string, at: Date): Promise<void>;
  /** This fleet's claimed links (live or ended), so the pull can link and unlink. */
  claimedLinks(orgId: string, limit: number): Promise<LinkRow[]>;
}

const SAFE = { unreachable: "The driver link could not be reached.", rejected: "The driver link refused the request." } as const;

/** Values that go into a PostgREST filter are percent-encoded and checked to be plain: an id or a Clerk user id, never a filter of their own. */
const plain = (v: string): string => {
  if (!/^[A-Za-z0-9_.:@-]{1,200}$/.test(v)) throw new BridgeTransportError("rejected", SAFE.rejected);
  return encodeURIComponent(v);
};

export function supabaseTransport(cfg: BridgeConfig, fetchImpl: typeof fetch = fetch): BridgeTransport {
  const base = `${cfg.url}/rest/v1/external_dispatch`;
  const links = `${cfg.url}/rest/v1/driver_links`;
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
    }
  };
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
  type MemLink = LinkRow & { code_hash: string; expires_at: string; carrier_name: string };
  const linkTable: MemLink[] = [];
  const transport: BridgeTransport & {
    table: BridgeRow[];
    links: MemLink[];
    phone: (id: string, response: Record<string, unknown>) => void;
    /** Claim a code the way bridge.claim_driver_link does (unknown, expired or withdrawn -> link_invalid; someone else's -> link_used). */
    claim: (codeHash: string, phoneUserId: string, now: Date) => "ok" | "link_invalid" | "link_used";
  } = {
    table,
    links: linkTable,
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
    claim(codeHash, phoneUserId, now) {
      const l = linkTable.find((x) => x.code_hash === codeHash);
      if (!l || l.revoked_at || (!l.claimed_by && Date.parse(l.expires_at) <= now.getTime())) return "link_invalid";
      if (l.claimed_by && l.claimed_by !== phoneUserId) return "link_used";
      Object.assign(l, { claimed_by: phoneUserId, claimed_at: l.claimed_at ?? now.toISOString() });
      return "ok";
    }
  };
  return transport;
}
