/**
 * Driver messages over the bridge (Wallet + Bridge plan, Phase 2 step 3). Pure: the shape of a `bridge.driver_messages` row, the rules both sides keep, and the desk's reading of a row.
 * The SQL that owns the table is the phone project's `supabase/migrations/20261121000300_bridge_driver_messages.sql`; tests read it to keep the two in step.
 *
 * A thread is one carrier (org_id) with one phone account (driver_sub). The carrier owns the record (D4). Direction is `to_driver` (the desk wrote it) or `to_desk` (the phone wrote it).
 * `client_id` is unique per sender: the desk sends its own Message.id, so a re-delivery of the same desk message is the same row.
 */
export const DRIVER_MESSAGE_BODY_MAX = 2000;
export const DRIVER_MESSAGE_FILES_MAX = 5;

export type DriverMessageRow = {
  id: string;
  org_id: string;
  driver_sub: string;
  desk_driver_id: string | null;
  direction: "to_driver" | "to_desk";
  sender_id: string;
  client_id: string;
  body: string;
  attachments: { path: string; name?: string | null; mime?: string | null; bytes?: number | null }[];
  desk_file_count: number;
  load_ref: string | null;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
  /** To the driver: the dispatcher who wrote it (their name on the desk), or null. Phone project migration 20261122000300. */
  sender_name?: string | null;
};

/** The sender id the desk writes under: one per fleet, never a person's id. Who on the desk wrote it travels as a name only (`sender_name`, shown beside the company). */
export const deskSenderId = (orgId: string): string => `desk:${orgId}`;

/** Where a driver's files for this carrier live in the phone project's storage. The SQL refuses any other path. */
export const driverFileFolder = (orgId: string, driverSub: string): string => `org/${orgId}/driver/${driverSub}/`;

export const attachmentPathAllowed = (orgId: string, driverSub: string, path: string): boolean =>
  path.startsWith(driverFileFolder(orgId, driverSub)) && !path.includes("..") && path.length <= 400;

/**
 * The name the driver sees for who on the desk sent something (Chris 2026-11-22: a company with several dispatchers is one connection; the driver still sees who wrote or sent
 * what). The desk's own fallback name ("Dispatcher", a script or a desk with sign-in off and no demo person) is no one, so it is null. A name that is
 * really a contact (an email or a phone number typed as the name) is not sent either. Trimmed, at most 60 characters.
 */
export const SENDER_NAME_MAX = 60;
export function senderNameOf(actor: string | null | undefined, deskFallback = "Dispatcher"): string | null {
  const name = (actor ?? "").replace(/\s+/g, " ").trim();
  if (!name || name === deskFallback) return null;
  if (name.includes("@") || name.replace(/\D/g, "").length >= 7) return null;
  return name.slice(0, SENDER_NAME_MAX);
}

/** The row the desk writes for a message it sends. Files stay on the desk (the phone is told how many); the desk's Message.id is the client id. */
export function toDriverRow(i: { orgId: string; phoneUserId: string; deskDriverId: string; messageId: string; body: string; fileCount: number; loadNumber: string | null; senderName?: string | null }) {
  return {
    org_id: i.orgId,
    driver_sub: i.phoneUserId,
    desk_driver_id: i.deskDriverId,
    direction: "to_driver" as const,
    sender_id: deskSenderId(i.orgId),
    client_id: i.messageId,
    body: i.body.slice(0, DRIVER_MESSAGE_BODY_MAX),
    attachments: [],
    desk_file_count: Math.max(0, Math.min(i.fileCount, 99)),
    load_ref: i.loadNumber,
    sender_name: senderNameOf(i.senderName)
  };
}

/**
 * Why a file the driver sent is not on the desk message (the desk fetches the phone's photos into its own storage when it takes the message):
 * `full`: this desk's plan has no room; `refused`: the desk's own file checks said no (type, size, unsafe); `gone`: the bridge no longer had it.
 */
export type NotKept = "full" | "refused" | "gone";

const NOT_KEPT_WHY: Record<NotKept, string> = {
  full: "this desk's storage is full",
  refused: "the desk's file checks refused it",
  gone: "it was no longer on the phone link"
};

/** What the desk keeps from a driver's row: the text, and a plain line for each reason a file could not be kept. Never a storage path in the text. */
export function deskBodyOf(row: Pick<DriverMessageRow, "body">, notKept: Partial<Record<NotKept, number>> = {}): string {
  const lines = (Object.keys(NOT_KEPT_WHY) as NotKept[])
    .filter((k) => (notKept[k] ?? 0) > 0)
    .map((k) => {
      const n = notKept[k]!;
      return `(${n} ${n === 1 ? "file" : "files"} from the phone not kept: ${NOT_KEPT_WHY[k]})`;
    });
  return [row.body ?? "", ...lines].filter(Boolean).join("\n");
}

/** A file's name on the desk: the last part of its bridge path (the phone writes `<client id>-<n>.jpg`). */
export const fileNameOf = (path: string): string => path.split("/").pop() || "photo.jpg";

/**
 * How long a message stays on the bridge once both sides are done with it (Chris, 2026-11-21): one day after it was read. The bridge carries messages; the desk keeps the
 * record. A row nobody has read, or that the desk has not taken, stays until it is.
 */
export const BRIDGE_KEEP_MS = 24 * 60 * 60 * 1000;

/** A row the desk may take off the bridge now: delivered, read, and read more than BRIDGE_KEEP_MS ago. */
export function purgeDue(row: Pick<DriverMessageRow, "delivered_at" | "read_at">, now: Date): boolean {
  if (!row.delivered_at || !row.read_at) return false;
  return Date.parse(row.read_at) <= now.getTime() - BRIDGE_KEEP_MS;
}

/**
 * Where a message the dispatcher sent stands, in words: read on the phone, delivered to it, on its way, or kept on the desk only. "On its way" needs both a live link now and a
 * bridge item for this message (`onLink`): a message written before the driver connected never had one, so it stays "Saved on the desk" after the link, not "Sending" forever.
 */
export type DeskDelivery = "read" | "delivered" | "sending" | "saved";
export function deskDelivery(m: { deliveredAt: Date | null; readAt: Date | null; onLink: boolean }, bridged: boolean): DeskDelivery {
  if (m.readAt) return "read";
  if (m.deliveredAt) return "delivered";
  return bridged && m.onLink ? "sending" : "saved";
}
export const DESK_DELIVERY_LABEL: Record<DeskDelivery, string> = { read: "Read", delivered: "Delivered", sending: "Sending", saved: "Saved on the desk" };

/** Rows the desk will take into one fleet: its own org, from a phone, and not yet taken. Anything else is left alone. */
export const isPullable = (row: Pick<DriverMessageRow, "org_id" | "direction" | "delivered_at">, orgId: string): boolean =>
  row.org_id === orgId && row.direction === "to_desk" && row.delivered_at == null;
