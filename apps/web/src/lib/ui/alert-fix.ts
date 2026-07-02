/**
 * Map a "needs attention" alert kind to a one-click copilot fix.
 *
 * Phase B of the Attention→Copilot integration. The copilot already exposes
 * every resolving tool (`update_load_fields`, `reschedule_delivery`, `set_tonu`,
 * `upsert_load_leg`, …); this map picks the matching tool and PREFILLS its input
 * so a coordinator can resolve an obligation from the attention feed without
 * opening the drawer. The seeded action runs through the existing confirm-card
 * flow (`/api/copilot` → `dispatchTool(..., {confirmed:true})`), so it is always
 * reviewed before it applies — no server tool changes.
 *
 * Only kinds whose fix is UNAMBIGUOUS and fully determined by the kind alone are
 * mapped — a single whitelisted field flipped to its resolved value. Kinds that
 * need free input (which driver? what new appointment window? bill how much?) or
 * human judgement (a manual flag, a POD flagged NEEDS_ATTENTION) return null and
 * keep their click-through-to-drawer behaviour, where the full editor lives.
 */
import type { LoadAlertKind } from "@/lib/ui/load-alerts";

export interface AlertFix {
  /** Existing copilot tool to dispatch. */
  tool: string;
  /** Prefilled tool input (already confirmed-ready). */
  input: Record<string, unknown>;
  /** Short button label, e.g. "Mark MG done". */
  label: string;
  /** Confirmation-card summary, e.g. "Mark MG task done on REF-1". */
  summary: string;
}

/** update_load_fields fix that flips one whitelisted field to its resolved value. */
function setField(loadId: string, ref: string, field: string, value: string, label: string, what: string): AlertFix {
  return {
    tool: "update_load_fields",
    input: { loadId, fields: { [field]: value } },
    label,
    summary: `${what} on ${ref}`
  };
}

export function alertKindToFix(kind: LoadAlertKind, loadId: string, ref: string): AlertFix | null {
  switch (kind) {
    case "TASK_MG":
      return setField(loadId, ref, "mgStatusTask", "DONE", "Mark MG done", "Mark MG task done");
    case "TASK_TMW":
      return setField(loadId, ref, "tmwStatusTask", "DONE", "Mark TMW done", "Mark TMW task done");
    case "TASK_SCALE_BEFORE":
      return setField(loadId, ref, "scaleBeforeTask", "DONE", "Mark done", "Mark scale-before done");
    case "TASK_SCALE_AFTER":
      return setField(loadId, ref, "scaleAfterTask", "DONE", "Mark done", "Mark scale-after done");
    case "POD_SEND_OBLIGATION":
      return setField(loadId, ref, "podStatus", "SENT_TO_BROKER", "Mark POD sent", "Mark POD sent to broker");
    case "RESCHEDULE_NEEDS_DRIVER":
      return setField(loadId, ref, "rescheduleDriverConfirmed", "DONE", "Confirm driver", "Confirm next-day driver assigned");
    default:
      // No deterministic one-click fix — resolve in the drawer.
      return null;
  }
}
