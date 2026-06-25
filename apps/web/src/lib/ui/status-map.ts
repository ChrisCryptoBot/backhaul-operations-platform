export type UiStatusTone =
  | "booked"
  | "dispatched"
  | "picked-up"
  | "delivered"
  | "pod"
  | "completed"
  | "canceled"
  | "failed"
  | "unknown";

export interface StatusPresentation {
  label: string;
  tone: UiStatusTone;
}

const STATUS_MAP: Record<string, StatusPresentation> = {
  BOOKED: { label: "BOOKED", tone: "booked" },
  DISPATCHED: { label: "DISPATCHED", tone: "dispatched" },
  PICKED_UP: { label: "PICKED UP", tone: "picked-up" },
  DELIVERED: { label: "DELIVERED", tone: "delivered" },
  POD_RECEIVED: { label: "POD RECEIVED", tone: "pod" },
  COMPLETED: { label: "COMPLETED", tone: "completed" },
  CANCELED: { label: "CANCELED", tone: "canceled" },
  FAILED: { label: "FAILED", tone: "failed" },
  TONU: { label: "TONU", tone: "canceled" }
};

const LATE_STATUS_KEYWORDS = ["LATE", "DELAYED", "AT_RISK"] as const;

function normalizeStatus(status: string): string {
  return status.trim().toUpperCase();
}

export function mapStatusPresentation(status: string | null | undefined): StatusPresentation {
  if (!status) {
    return { label: "UNKNOWN", tone: "unknown" };
  }
  const normalized = normalizeStatus(status);
  return STATUS_MAP[normalized] ?? { label: normalized.replaceAll("_", " "), tone: "unknown" };
}

export function isLateStatus(status: string | null | undefined): boolean {
  if (!status) {
    return false;
  }
  const normalized = normalizeStatus(status);
  return LATE_STATUS_KEYWORDS.some((keyword) => normalized.includes(keyword));
}
