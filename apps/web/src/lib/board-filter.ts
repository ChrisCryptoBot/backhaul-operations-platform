/**
 * The Loads screen's filters, in one place so the page and its CSV export always show the same rows:
 * a free-text search (`q`, from the header search), a status, and the "below cost" flag. Pure.
 */
export type BoardFilter = { status?: string; flag?: string; q?: string };

export type BoardFilterable = {
  status: string;
  verdict: string | null;
  loadNumber: string | null;
  brokerName: string | null;
  origin: string | null;
  destination: string | null;
  vehicleName: string | null;
  driverName: string | null;
  /** The assignment's status (none, draft, dispatched, accepted, declined, ...), for the "Needs a driver" and "Sent, waiting" tabs. */
  assignmentStatus?: string | null;
  /** Also searched when present: the customer's PO, the invoice number and the broker's MC. */
  poNumber?: string | null;
  invoiceNumber?: string | null;
  brokerMc?: string | null;
};

export const BOARD_STATUSES = [
  { key: "all", label: "All" },
  { key: "draft", label: "Needs a driver" },
  { key: "sent", label: "Sent, waiting" },
  { key: "accepted", label: "Accepted" },
  { key: "in_progress", label: "On the road" },
  { key: "completed", label: "Delivered" }
] as const;

export const asBoardStatus = (v: string | undefined): string => (BOARD_STATUSES.some((s) => s.key === v) ? (v as string) : "all");

/** A load that is still open and pays below the truck's own cost. */
export const isBelowCost = (r: Pick<BoardFilterable, "status" | "verdict">) => r.verdict === "reject" && r.status !== "completed";

/** The text a row is searched on: load number, PO, invoice number, broker and its MC, either city, truck and driver. */
export const boardSearchText = (r: BoardFilterable) => [r.loadNumber, r.poNumber, r.invoiceNumber, r.brokerName, r.brokerMc, r.origin, r.destination, r.vehicleName, r.driverName].filter(Boolean).join(" ");

/** Lower case with every run of punctuation or space as one space, so "DM-40013", "dm 40013" and "Dallas, TX" read alike. */
const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Rows matching the search: every word typed must be in the row's text, in any order, with punctuation ignored ("tx dallas" finds "Dallas, TX"; "dm40013" and "dm-40013" both find
 * DM-40013). Case-insensitive. Blank keeps everything.
 */
export function searchBoard<T extends BoardFilterable>(rows: T[], q: string | undefined): T[] {
  const words = plain(q ?? "").split(" ").filter(Boolean);
  if (words.length === 0) return rows;
  return rows.filter((r) => {
    const text = plain(boardSearchText(r));
    const squashed = text.replace(/ /g, "");
    return words.every((w) => text.includes(w) || squashed.includes(w));
  });
}

/**
 * Whether a row belongs under a tab. "Needs a driver" is a load with no driver, or one who said no, or one chosen and not yet sent (the same loads the sidebar and the dispatch
 * queue count); a load that has been sent and is waiting for the answer is under "Sent, waiting", not under "Needs a driver".
 */
export function onTab(r: Pick<BoardFilterable, "status" | "assignmentStatus">, key: string): boolean {
  if (key === "all") return true;
  if (key === "draft") return r.status === "draft" && r.assignmentStatus !== "dispatched";
  if (key === "sent") return r.assignmentStatus === "dispatched";
  return r.status === key;
}

export function filterBoard<T extends BoardFilterable>(rows: T[], f: BoardFilter): T[] {
  const status = asBoardStatus(f.status);
  const byText = searchBoard(rows, f.q);
  const byStatus = status === "all" ? byText : byText.filter((r) => onTab(r, status));
  return f.flag === "below" ? byStatus.filter(isBelowCost) : byStatus;
}
