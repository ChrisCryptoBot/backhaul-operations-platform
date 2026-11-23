import { goesToDriver } from "./documents";

/** The load-document mirror's rules (sync plan Step 4), pure: which files belong on which phone, where they live there, and what to write and remove. */

/** A row of `bridge.load_documents` (phone project supabase/migrations/20261122000400_bridge_load_documents.sql), as the desk writes it. */
export type LoadDocumentRow = { org_id: string; driver_sub: string; source_load_id: string; desk_document_id: string; kind: string; name: string; mime: string; bytes: number; path: string };
export type LoadDocumentThere = LoadDocumentRow & { id: string };

/** After delivery the files stay on the phone this long (the desk keeps them). */
export const AFTER_DELIVERY_MS = 7 * 24 * 60 * 60 * 1000;

const EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/csv": "csv",
  "text/plain": "txt",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp"
};

/** The desk's folder for one driver's phone, in the phone project's private bucket. The phone can read it while connected and can never write to it. */
export const deskFileFolder = (orgId: string, driverSub: string): string => `org/${orgId}/desk/${driverSub}/`;
/** A file's path: the desk's own id and the extension its checked type has, never the name a person gave it. */
export const deskFilePath = (orgId: string, driverSub: string, fileId: string, mime: string): string => `${deskFileFolder(orgId, driverSub)}${fileId}.${EXT[mime] ?? "bin"}`;

/** Whether a load is on its driver's phone, for its files: sent, accepted, on the road, or delivered in the last week. */
export function filesOnPhone(i: { assignment: string; load: string; completedAt: Date | null }, now: Date): boolean {
  if (i.load === "cancelled" || i.load === "tonu" || i.load === "quote") return false;
  if (["dispatched", "accepted", "in_progress"].includes(i.assignment)) return true;
  return i.assignment === "completed" && i.completedAt != null && now.getTime() - i.completedAt.getTime() < AFTER_DELIVERY_MS;
}

export type DocIn = { id: string; kind: string; name: string; mime: string; bytes: number; sha256: string; toDriver: boolean };

/** One load's files for its driver. A file whose bytes are the load's rate confirmation or a money receipt never goes, whatever kind it was filed under. */
export function rowsForLoad(i: { orgId: string; driverSub: string; loadId: string; docs: readonly DocIn[] }): LoadDocumentRow[] {
  const held = new Set(i.docs.filter((d) => d.kind === "rate_con" || d.kind === "receipt").map((d) => d.sha256));
  return i.docs
    .filter((d) => goesToDriver(d) && !held.has(d.sha256))
    .map((d) => ({ org_id: i.orgId, driver_sub: i.driverSub, source_load_id: i.loadId, desk_document_id: d.id, kind: d.kind, name: d.name.slice(0, 120), mime: d.mime, bytes: d.bytes, path: deskFilePath(i.orgId, i.driverSub, d.id, d.mime) }));
}

/** A document is written once (its bytes never change on the desk); a row nothing on the desk asks for any more is removed, with its file. */
export function documentPlan<T extends LoadDocumentThere>(next: readonly LoadDocumentRow[], there: readonly T[]): { write: LoadDocumentRow[]; remove: T[] } {
  const key = (r: { driver_sub: string; desk_document_id: string }) => `${r.driver_sub}|${r.desk_document_id}`;
  const have = new Set(there.map(key));
  const want = new Set(next.map(key));
  return { write: next.filter((r) => !have.has(key(r))), remove: there.filter((r) => !want.has(key(r))) };
}
