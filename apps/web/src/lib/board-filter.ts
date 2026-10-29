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
};

export const BOARD_STATUSES = [
  { key: "all", label: "All" },
  { key: "draft", label: "Needs a driver" },
  { key: "accepted", label: "Accepted" },
  { key: "in_progress", label: "On the road" },
  { key: "completed", label: "Delivered" }
] as const;

export const asBoardStatus = (v: string | undefined): string => (BOARD_STATUSES.some((s) => s.key === v) ? (v as string) : "all");

/** A load that is still open and pays below the truck's own cost. */
export const isBelowCost = (r: Pick<BoardFilterable, "status" | "verdict">) => r.verdict === "reject" && r.status !== "completed";

/** Rows matching the search text (load number, broker, either city, truck or driver), case-insensitive. Blank keeps everything. */
export function searchBoard<T extends BoardFilterable>(rows: T[], q: string | undefined): T[] {
  const needle = q?.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => [r.loadNumber, r.brokerName, r.origin, r.destination, r.vehicleName, r.driverName].filter(Boolean).join(" ").toLowerCase().includes(needle));
}

export function filterBoard<T extends BoardFilterable>(rows: T[], f: BoardFilter): T[] {
  const status = asBoardStatus(f.status);
  const byText = searchBoard(rows, f.q);
  const byStatus = status === "all" ? byText : byText.filter((r) => r.status === status);
  return f.flag === "below" ? byStatus.filter(isBelowCost) : byStatus;
}
