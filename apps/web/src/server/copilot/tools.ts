import type { Role } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { withNonDeletedRegionScope } from "@/lib/scoped-query";
import { policyAdapter } from "@/domain/policy/policy-adapter";
import { getLoadDetail } from "@/server/board-detail";
import {
  deleteBoardLoadLeg,
  rescheduleBoardLoadDelivery,
  getBoardResponse,
  moveBoardLoad,
  setBoardLoadStatus,
  setLoadTonuLifecycle,
  softDeleteBoardLoad,
  updateBoardLoadFields,
  upsertBoardLoadLeg,
  type LoadLifecycleStatus
} from "@/server/board";
import { getKpiDashboard } from "@/server/kpi-dashboard";
import { getEffectiveFscRate, upsertFscIndex } from "@/server/fsc";
import { updateRegionConfig } from "@/server/region-config";
import { getAuditHistory, listAuditLog } from "@/server/audit-read";
import { getLlmSettingsStatus, updateLlmSettings } from "@/server/llm/settings";
import { SUPPORTED_PROVIDERS } from "@/server/llm/registry";
import { acknowledgeKpiAlert } from "@/server/kpi-alerts";
import { getRateConfirmationActivity } from "@/server/rate-confirmation-activity";
import { setLaneNote, setLaneWeeklyTarget } from "@/server/lane-week-write";
import { listOperationalRules, createOperationalRule } from "@/server/operational-rules";
import { createManualLoad, approveRateConfirmationReview, rejectRateConfirmationReview } from "@/server/review";
import { getRoadMiles } from "@/server/distance";
import { collectAttentionItems } from "@/server/copilot/context";
import { boardDayRange, isIsoDay, PHASE1_BOARD_TIMEZONE } from "@/lib/board-date";
import { weekIsoFromPickup } from "@/lib/week";
import {
  addBrokerRep,
  createBroker,
  createDropLot,
  createLane,
  listBrokers,
  listDistributionCenters,
  listDropLots,
  listLanes,
  setLaneTarget,
  softDeleteBroker,
  softDeleteBrokerRep,
  softDeleteDropLot,
  softDeleteLane,
  updateBroker,
  updateBrokerRep,
  updateDropLot
} from "@/server/reference";
import { Prisma } from "@prisma/client";
import type { BrokerOnboardingStatus, FuelSurchargeSource } from "@prisma/client";

/** Identity + scope a copilot turn runs under. Every tool executes as this user. */
export interface CopilotContext {
  userId: string;
  regionId: string;
  role: Role;
  /** The board date the user is currently viewing (YYYY-MM-DD), for relative phrasing. */
  boardDate: string;
}

export interface ToolDispatchResult {
  /** Returned to the model as the tool_result content. */
  content: unknown;
  /** When true, the action was NOT executed and needs explicit user confirmation. */
  needsConfirmation?: boolean;
  /** Human-readable summary for the confirmation card / actions log. */
  summary?: string;
}

// Load fields the copilot may set via update_load_fields. Whitelisted so the
// model can't write columns outside the action layer's contract.
const ALLOWED_LOAD_FIELDS = new Set([
  "shipperName", "receiverName", "pickupCity", "pickupState", "pickupWindow",
  "deliveryCity", "deliveryState", "deliveryWindow", "deliveryDate", "loadNumber",
  "pickupNumber", "pickupNumbers", "threePlRefNumber", "brokerId", "tractorTrailer1", "tractorTrailer2",
  "commodity", "equipmentNeeds", "equipmentType", "equipmentAccessory", "equipmentOtherText",
  "lumperFeeAmount", "pickupDriverAssigned", "driverType", "coordinatorNotes", "attentionNote",
  "attentionSeverity", "podStatus", "mgStatusTask", "tmwStatusTask", "scaleBeforeTask",
  "scaleAfterTask", "puStatusPreset", "puStatusCustom", "delStatusPreset", "delStatusCustom",
  "deliveryExceptionState", "rescheduleDriverConfirmed",
  "lineHaulRate", "loadedMiles", "puDeadheadMiles", "delDeadheadMiles", "fscApplies"
]);
const FINANCIAL_FIELDS = new Set(["lineHaulRate", "loadedMiles", "puDeadheadMiles", "delDeadheadMiles", "fscApplies"]);

/** Positive decimal string, up to 4 dp (money/mileage inputs). */
const DECIMAL_RE = /^\d+(\.\d{1,4})?$/;

/** Tools whose effects are destructive/financial and require user confirmation. */
export const RISKY_TOOLS = new Set([
  "soft_delete_load",
  "set_tonu",
  "delete_load_leg",
  "create_load",
  "create_relayed_load",
  "set_fsc",
  "delete_broker",
  "delete_broker_rep",
  "delete_lane",
  "delete_drop_lot",
  "review_rate_confirmation",
  "set_board_thresholds",
  "set_llm_settings"
]);

/** Anthropic tool definitions exposed to the copilot. */
export const COPILOT_TOOLS = [
  {
    name: "find_loads",
    description:
      "Search loads in the current region. Use this to resolve which load the user means before editing. " +
      "Filter by free text (matches load number, 3PL ref, shipper, receiver, or broker), status, and/or a " +
      "specific board day. For an at-a-glance view of a whole day (totals, sections, capacity) prefer get_board_summary.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Free-text match on load number / ref / shipper / receiver / broker." },
        status: { type: "string", description: "Optional load status filter (e.g. BOOKED, DELIVERED, CANCELED)." },
        date: { type: "string", description: "Optional board day (YYYY-MM-DD) to restrict to loads booked that day." },
        limit: { type: "number", description: "Max results (default 10)." }
      }
    }
  },
  {
    name: "get_load_detail",
    description:
      "Fetch the full detail for one load by id (use a load id returned by find_loads). Includes its legs " +
      "(with leg ids) so you can edit or delete a specific leg.",
    input_schema: {
      type: "object" as const,
      properties: { loadId: { type: "string" } },
      required: ["loadId"]
    }
  },
  {
    name: "get_board_summary",
    description:
      "Get the at-a-glance board for a day: day totals (load count, line-haul, FSC, TONU, all-in revenue, loaded miles, " +
      "empty mile %) plus every section (drop lots, ad-hoc/LTL, deliveries due, canceled, region next-day, local CDC " +
      "inbound) with its capacity, fill count, and the loads in it. Defaults to the day the user is viewing. Use this for " +
      "'what's on the board', 'what's delivering today', or 'which lots are over capacity'.",
    input_schema: {
      type: "object" as const,
      properties: {
        date: { type: "string", description: "Optional board day (YYYY-MM-DD). Defaults to the day the user is viewing." }
      }
    }
  },
  {
    name: "get_kpis",
    description:
      "Get the weekly KPI dashboard for the region: headline cards (loads, revenue, loaded miles, empty mile %, MileMax " +
      "RPM, FSC), per-lane performance vs target, and operational alerts, for the week containing the day the user is " +
      "viewing. Use for 'how are we doing this week', 'which lanes are below target', or 'what's our empty-mile %'.",
    input_schema: {
      type: "object" as const,
      properties: {
        weeks: { type: "number", description: "Optional number of trend weeks to include (default 12)." }
      }
    }
  },
  {
    name: "get_attention_items",
    description:
      "List the loads that need attention right now — anything flagged URGENT/WARN or with an open POD task — " +
      "for the day the user is viewing (or a given date). Use for 'what needs attention', 'what's urgent', or " +
      "'which loads are missing a POD'.",
    input_schema: {
      type: "object" as const,
      properties: {
        date: { type: "string", description: "Optional board day (YYYY-MM-DD). Defaults to the day the user is viewing." }
      }
    }
  },
  {
    name: "get_audit_history",
    description:
      "Read the recent change history for one entity (who changed what, and when). Pass a loadId for a load's " +
      "history, or entityType + entityId for anything else (e.g. Broker). Use for 'what changed on this load', " +
      "'who cancelled it', or 'when was the rate last updated'.",
    input_schema: {
      type: "object" as const,
      properties: {
        loadId: { type: "string", description: "Shortcut for a load's history (sets entityType to Load)." },
        entityType: { type: "string", description: "Entity type when not a load (e.g. Broker, WeekSnapshot)." },
        entityId: { type: "string", description: "Entity id when not using loadId." },
        limit: { type: "number", description: "Max entries (default 20, max 100)." }
      }
    }
  },
  {
    name: "list_audit_log",
    description:
      "Browse the global audit trail newest-first across ALL entities (loads, brokers, lanes, drop lots, settings). " +
      "Use this for broad questions like 'what changed today', 'what did <user> do', or 'recent deletions' — when you " +
      "do NOT already have a single entity id (for one entity's history use get_audit_history instead). Filter by " +
      "entityType, action, actorId, a date range, and/or free text (matches entity id, action, or reason). Returns a " +
      "page of entries plus nextCursor for paging.",
    input_schema: {
      type: "object" as const,
      properties: {
        entityType: { type: "string", description: "Optional exact entity type, e.g. Load, Broker, Lane, DropLot, RegionConfig, LlmProviderConfig." },
        action: { type: "string", description: "Optional exact action code, e.g. REFERENCE_LANE_CREATE." },
        actorId: { type: "string", description: "Optional exact actor (user) id." },
        from: { type: "string", description: "Optional inclusive lower bound (YYYY-MM-DD or ISO datetime)." },
        to: { type: "string", description: "Optional inclusive upper bound (YYYY-MM-DD or ISO datetime)." },
        search: { type: "string", description: "Optional free-text match on entity id, action, or reason." },
        cursor: { type: "string", description: "Optional nextCursor from a previous call to fetch the next page." },
        limit: { type: "number", description: "Max entries (default 25, max 100)." }
      }
    }
  },
  {
    name: "get_fsc",
    description:
      "Get the current fuel-surcharge picture: the effective FSC rate for the week the user is viewing, plus which " +
      "brokers have FSC turned off by default. Use for 'what's the FSC this week' or 'which brokers don't get fuel'.",
    input_schema: {
      type: "object" as const,
      properties: {}
    }
  },
  {
    name: "find_destinations",
    description:
      "List the region's distribution centers and drop lots (with city/state) so you can resolve a named " +
      "destination like 'Carlisle' to its city/state before creating a load.",
    input_schema: { type: "object" as const, properties: {} }
  },
  {
    name: "create_load",
    description:
      "Create a new load. Loaded miles are auto-calculated from pickup → delivery via routing when available; if " +
      "routing isn't configured the tool asks you for the loaded miles. ALWAYS ask the user for PU and DEL deadhead " +
      "miles. Resolve a named destination with find_destinations first. Revenue/FSC/week are computed automatically. " +
      "This is financial — it is staged for the user to confirm before it is created.",
    input_schema: {
      type: "object" as const,
      properties: {
        pickupCity: { type: "string" },
        pickupState: { type: "string" },
        deliveryCity: { type: "string" },
        deliveryState: { type: "string" },
        lineHaulRate: { type: "string", description: "Decimal string." },
        fscApplies: { type: "boolean" },
        puDeadheadMiles: { type: "string", description: "Decimal string (ask the user)." },
        delDeadheadMiles: { type: "string", description: "Decimal string (ask the user)." },
        loadedMiles: { type: "string", description: "Optional decimal string; overrides the routing estimate." },
        pickupDate: { type: "string", description: "YYYY-MM-DD; defaults to the board date." },
        deliveryDate: { type: "string", description: "Optional YYYY-MM-DD." },
        brokerName: { type: "string", description: "Optional; resolved to a broker in the region." },
        dropLotName: { type: "string", description: "Optional; resolved to a drop lot in the region." },
        shipperName: { type: "string" },
        receiverName: { type: "string" },
        driverType: { type: "string", enum: ["SHUTTLE", "PTP", "LTL"] }
      },
      required: ["pickupCity", "pickupState", "deliveryCity", "deliveryState", "lineHaulRate", "fscApplies", "puDeadheadMiles", "delDeadheadMiles"]
    }
  },
  {
    name: "get_rate_confirmations",
    description:
      "List rate confirmations for a day: pending (parsing), ready-to-review, and recent activity — with parse state, " +
      "duplicate signal, and whether a load already exists. Use for 'what's waiting to be reviewed' or 'what's still parsing'.",
    input_schema: {
      type: "object" as const,
      properties: { date: { type: "string", description: "Optional YYYY-MM-DD; defaults to the board date." } }
    }
  },
  {
    name: "get_operational_rules",
    description: "List the region's operational rules (code, severity, statement). Use for 'what are our rules/gates'.",
    input_schema: { type: "object" as const, properties: {} }
  },
  {
    name: "set_fsc",
    description:
      "Set the fuel-surcharge rate for the week the user is viewing. source 'tuesday' updates the weekly manual baseline rate; " +
      "'override' adds a manual override (REGIONAL_MANAGER+). Financial — staged for confirmation.",
    input_schema: {
      type: "object" as const,
      properties: {
        value: { type: "string", description: "FSC rate as a decimal string." },
        reason: { type: "string" },
        source: { type: "string", enum: ["tuesday", "override"], description: "Defaults to tuesday." }
      },
      required: ["value", "reason"]
    }
  },
  {
    name: "set_board_thresholds",
    description:
      "Set this region's Empty% thresholds. The Daily Tracker's per-load Empty% turns amber at/above emptyPctAmber " +
      "and red at/above emptyPctRed (whole percents, 0 < amber < red <= 100). emptyPctAlert is the aggregate weekly " +
      "empty-mile % that fires the KPI dashboard alert (e.g. '6.5', 0 < alert <= 100). Pass any subset. Requires " +
      "settings access — staged for confirmation.",
    input_schema: {
      type: "object" as const,
      properties: {
        emptyPctAmber: { type: "string", description: "Amber threshold as a whole-percent decimal string, e.g. '15'." },
        emptyPctRed: { type: "string", description: "Red threshold as a whole-percent decimal string, e.g. '25'." },
        emptyPctAlert: { type: "string", description: "Dashboard alert threshold as a percent decimal string, e.g. '6.5'." },
        reason: { type: "string", description: "Why this change (for audit)." }
      }
    }
  },
  {
    name: "get_llm_settings",
    description:
      "Read the current LLM configuration: AI provider, the PDF-parsing model, the copilot (tool-use) model, whether " +
      "an API key is configured (and its masked last 4), and when it was last updated. The raw API key is NEVER returned. " +
      "Use for 'which model is the copilot using' or 'is an API key set'.",
    input_schema: { type: "object" as const, properties: {} }
  },
  {
    name: "set_llm_settings",
    description:
      "Change the LLM configuration. Pass any subset: provider, model (PDF parsing), copilotModel (tool-use), and/or " +
      "apiKey. Unspecified fields keep their current value. Provider must be supported. The API key is WRITE-ONLY: it is " +
      "encrypted at rest, never echoed back, and must never be repeated in your replies — only the masked last 4 is shown. " +
      "Requires settings (admin) access — staged for confirmation.",
    input_schema: {
      type: "object" as const,
      properties: {
        provider: { type: "string", description: `AI provider. Supported: ${SUPPORTED_PROVIDERS.join(", ")}.` },
        model: { type: "string", description: "PDF-parsing model id, e.g. claude-haiku-4-5." },
        copilotModel: { type: "string", description: "Copilot (tool-use) model id, e.g. claude-sonnet-4-6. Empty string clears to default." },
        apiKey: { type: "string", description: "New provider API key (write-only; rotates the stored key). Omit to keep the current key." }
      }
    }
  },
  {
    name: "acknowledge_alert",
    description: "Acknowledge a KPI alert by its id (from get_kpis). Requires KPI dashboard write access.",
    input_schema: {
      type: "object" as const,
      properties: { alertId: { type: "string" }, reason: { type: "string" } },
      required: ["alertId"]
    }
  },
  {
    name: "set_lane_note",
    description: "Set (or clear) the note for a lane in the week the user is viewing. Empty note clears it.",
    input_schema: {
      type: "object" as const,
      properties: { lane: { type: "string", description: "Lane label as shown in get_kpis (e.g. 'Pittsburgh, PA → Carlisle, PA')." }, note: { type: "string" } },
      required: ["lane", "note"]
    }
  },
  {
    name: "set_lane_weekly_target",
    description: "Set (or clear) the manual weekly target rate-per-mile for a lane in the week the user is viewing. Empty clears it.",
    input_schema: {
      type: "object" as const,
      properties: { lane: { type: "string" }, targetRate: { type: "string", description: "Positive decimal string, or empty to clear." } },
      required: ["lane", "targetRate"]
    }
  },
  {
    name: "add_broker_rep",
    description: "Add a contact (rep) to a broker. Requires REGIONAL_MANAGER+.",
    input_schema: {
      type: "object" as const,
      properties: {
        brokerId: { type: "string" },
        name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" }
      },
      required: ["brokerId", "name"]
    }
  },
  {
    name: "update_broker_rep",
    description: "Update a broker rep's name/email/phone. Requires REGIONAL_MANAGER+.",
    input_schema: {
      type: "object" as const,
      properties: {
        brokerId: { type: "string" },
        repId: { type: "string" },
        name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" }
      },
      required: ["brokerId", "repId"]
    }
  },
  {
    name: "delete_broker_rep",
    description: "Remove a broker rep. Requires REGIONAL_MANAGER+. Staged for confirmation.",
    input_schema: {
      type: "object" as const,
      properties: { brokerId: { type: "string" }, repId: { type: "string" } },
      required: ["brokerId", "repId"]
    }
  },
  {
    name: "delete_broker",
    description: "Soft-delete a broker (from find_brokers). Requires REGIONAL_MANAGER+. Staged for confirmation.",
    input_schema: {
      type: "object" as const,
      properties: { brokerId: { type: "string" }, reason: { type: "string" } },
      required: ["brokerId", "reason"]
    }
  },
  {
    name: "delete_lane",
    description: "Soft-delete a lane (from find_lanes). Requires REGIONAL_MANAGER+. Staged for confirmation.",
    input_schema: {
      type: "object" as const,
      properties: { laneId: { type: "string" }, reason: { type: "string" } },
      required: ["laneId", "reason"]
    }
  },
  {
    name: "delete_drop_lot",
    description:
      "Soft-delete a drop lot (from find_drop_lots). Requires REGIONAL_MANAGER+. Blocked if any loads still reference " +
      "it. Staged for confirmation.",
    input_schema: {
      type: "object" as const,
      properties: { dropLotId: { type: "string" }, reason: { type: "string" } },
      required: ["dropLotId", "reason"]
    }
  },
  {
    name: "create_operational_rule",
    description: "Create an operational rule for the region. code is UPPER_SNAKE. Requires KPI dashboard write access.",
    input_schema: {
      type: "object" as const,
      properties: {
        code: { type: "string", description: "UPPER_SNAKE_CASE." },
        title: { type: "string" },
        severity: { type: "string", enum: ["INFO", "WARN", "ACTION_REQUIRED"] },
        statement: { type: "string" },
        appliesTo: { type: "string" }
      },
      required: ["code", "title", "severity", "statement"]
    }
  },
  {
    name: "review_rate_confirmation",
    description:
      "Approve or reject a rate confirmation that is ready for review (id from get_rate_confirmations). Approving " +
      "CREATES a load from the parsed data. Staged for confirmation. Requires review permission.",
    input_schema: {
      type: "object" as const,
      properties: {
        rateConfirmationId: { type: "string" },
        decision: { type: "string", enum: ["approve", "reject"] },
        reason: { type: "string", description: "Optional; for reject." }
      },
      required: ["rateConfirmationId", "decision"]
    }
  },
  {
    name: "update_load_fields",
    description:
      "Update one or more fields on a load. Pass only the fields to change in `fields`. Dates are YYYY-MM-DD; " +
      "money/mileage values are decimal strings. Changing rate/miles/fscApplies recomputes revenue automatically. " +
      "To assign a broker, resolve its id with find_brokers and pass `brokerId`. PU/DEL operational status can be " +
      "a preset (puStatusPreset/delStatusPreset) or free text (puStatusCustom/delStatusCustom). Revenue, RPM and " +
      "total/negotiable miles are computed — set the inputs (lineHaulRate, loadedMiles, deadhead, fscApplies), not the totals.",
    input_schema: {
      type: "object" as const,
      properties: {
        loadId: { type: "string" },
        fields: {
          type: "object",
          description:
            "Map of field name to new value. Allowed fields include deliveryDate, pickupWindow, deliveryWindow, podStatus, " +
            "pickupDriverAssigned, deliveryDriver, equipmentType, brokerId, puStatusCustom, delStatusCustom, lineHaulRate, loadedMiles, etc."
        }
      },
      required: ["loadId", "fields"]
    }
  },
  {
    name: "set_load_status",
    description:
      "Advance or set a load's lifecycle status. Forward progression is BOOKED → DISPATCHED → PICKED_UP → " +
      "DELIVERED → POD_RECEIVED → COMPLETED; CANCELED and FAILED are exception states (these two require confirmation). " +
      "A load with no driver/coverage assigned cannot reach DISPATCHED (hard gate). If the stage being left still has " +
      "open obligations, the call is rejected unless overrideReason is provided (it's recorded in the audit trail).",
    input_schema: {
      type: "object" as const,
      properties: {
        loadId: { type: "string" },
        status: {
          type: "string",
          enum: ["BOOKED", "DISPATCHED", "PICKED_UP", "DELIVERED", "POD_RECEIVED", "COMPLETED", "CANCELED", "FAILED"]
        },
        overrideReason: { type: "string", description: "Reason for advancing past open obligations; recorded in the audit." }
      },
      required: ["loadId", "status"]
    }
  },
  {
    name: "set_tonu",
    description: "Mark or clear TONU (truck-ordered-not-used) on a load. When marking, provide tonuAmount (decimal string).",
    input_schema: {
      type: "object" as const,
      properties: {
        loadId: { type: "string" },
        isTonu: { type: "boolean" },
        tonuAmount: { type: "string", description: "Required when isTonu is true." }
      },
      required: ["loadId", "isTonu"]
    }
  },
  {
    name: "soft_delete_load",
    description: "Soft-delete (remove from the board) a load. Requires a reason. This is reversible only by an admin.",
    input_schema: {
      type: "object" as const,
      properties: {
        loadId: { type: "string" },
        reason: { type: "string" }
      },
      required: ["loadId", "reason"]
    }
  },
  {
    name: "move_load",
    description:
      "Move a load to a different section of the board. targetSectionId is a drop-lot id (from find_drop_lots) to " +
      'reassign the load to that lot, "adhoc" to move it to the ad-hoc/LTL section, or "canceled" to cancel it. ' +
      "Moving to a lot or ad-hoc sets the load BOOKED and clears TONU. Canceling requires confirmation.",
    input_schema: {
      type: "object" as const,
      properties: {
        loadId: { type: "string" },
        targetSectionId: { type: "string", description: 'A drop-lot id, or "adhoc", or "canceled".' }
      },
      required: ["loadId", "targetSectionId"]
    }
  },
  {
    name: "upsert_load_leg",
    description:
      "Add or update a leg on a load (e.g. assign a driver to a shuttle/PTP/delivery leg). Omit leg.id to add a new " +
      "leg; pass leg.id (from get_load_detail) to edit an existing one. legType is SHUTTLE, PTP, or DELIVERY; legMiles " +
      "is a decimal string. etaAt is the driver's expected arrival at the leg's stop and arrivalAt is the logged on-site " +
      "time — both ISO 8601 timestamps; once etaAt passes with no arrivalAt the board nags to verify the driver on-site.",
    input_schema: {
      type: "object" as const,
      properties: {
        loadId: { type: "string" },
        leg: {
          type: "object",
          description: "The leg to add/update.",
          properties: {
            id: { type: "string", description: "Existing leg id to update; omit to add a new leg." },
            legIndex: { type: "number", description: "0-based order of the leg on the load." },
            legType: { type: "string", enum: ["SHUTTLE", "PTP", "DELIVERY"] },
            driverName: { type: "string" },
            startCity: { type: "string" },
            startState: { type: "string" },
            endCity: { type: "string" },
            endState: { type: "string" },
            legMiles: { type: "string", description: "Decimal string." },
            notes: { type: "string" },
            etaAt: { type: "string", description: "Expected arrival at this leg's stop, ISO 8601 timestamp." },
            arrivalAt: { type: "string", description: "Logged on-site/arrival time, ISO 8601 timestamp." }
          },
          required: ["legIndex", "legType"]
        }
      },
      required: ["loadId", "leg"]
    }
  },
  {
    name: "delete_load_leg",
    description: "Delete a leg from a load. Pass the loadId and the legId (from get_load_detail). Requires confirmation.",
    input_schema: {
      type: "object" as const,
      properties: {
        loadId: { type: "string" },
        legId: { type: "string" }
      },
      required: ["loadId", "legId"]
    }
  },
  {
    name: "reschedule_delivery",
    description:
      "Reschedule a load's delivery appointment to a new window after a missed appt. Pass a new local date " +
      "(YYYY-MM-DD), window start/end as local HH:MM (24h), and apptType (FIRM_APPT, OPEN_WINDOW, FCFS). This " +
      "overwrites the delivery appointment (localised to the destination stop), marks the load RESCHEDULED, and " +
      "re-arms the 'assign next-day driver' nudge. Use update_load_fields with deliveryExceptionState=WORK_IN_REQUESTED " +
      "for a same-day work-in instead.",
    input_schema: {
      type: "object" as const,
      properties: {
        loadId: { type: "string" },
        newDate: { type: "string", description: "New delivery date, YYYY-MM-DD (local to the stop)." },
        windowStart: { type: "string", description: "New window start, local HH:MM (24h)." },
        windowEnd: { type: "string", description: "New window end, local HH:MM (24h)." },
        apptType: { type: "string", enum: ["FIRM_APPT", "OPEN_WINDOW", "FCFS"] }
      },
      required: ["loadId", "newDate", "windowStart", "windowEnd", "apptType"]
    }
  },
  {
    name: "find_brokers",
    description:
      "List brokers in the current region (optionally filtered by name). Use this to resolve which broker " +
      "the user means before updating one. Returns broker ids, names, onboarding status, and rep counts.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Optional case-insensitive substring match on broker name." }
      }
    }
  },
  {
    name: "create_broker",
    description:
      "Create a new broker in the current region. onboardingStatus defaults to PENDING; fscDefaultApplies " +
      "defaults to true. Requires REGIONAL_MANAGER+ — the user must have reference-data management rights.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string" },
        onboardingStatus: { type: "string", enum: ["PENDING", "APPROVED", "BLOCKED"] },
        fscDefaultApplies: { type: "boolean" }
      },
      required: ["name"]
    }
  },
  {
    name: "update_broker",
    description:
      "Update an existing broker's name, onboarding status, and/or whether FSC applies by default. " +
      "Pass the brokerId (from find_brokers) and only the fields to change. Requires REGIONAL_MANAGER+.",
    input_schema: {
      type: "object" as const,
      properties: {
        brokerId: { type: "string" },
        name: { type: "string" },
        onboardingStatus: { type: "string", enum: ["PENDING", "APPROVED", "BLOCKED"] },
        fscDefaultApplies: { type: "boolean" }
      },
      required: ["brokerId"]
    }
  },
  {
    name: "find_lanes",
    description:
      "List lanes in the current region (optionally filtered by an origin/destination city substring). " +
      "Use this to resolve which lane the user means before setting a target rate. Returns lane ids and target rates.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Optional case-insensitive match on any origin/destination city or state." }
      }
    }
  },
  {
    name: "create_lane",
    description:
      "Create a new lane (origin city/state → destination city/state) with a target rate-per-mile (decimal string). " +
      "Requires REGIONAL_MANAGER+. Fails if an identical origin/destination lane already exists in the region.",
    input_schema: {
      type: "object" as const,
      properties: {
        originCity: { type: "string" },
        originState: { type: "string" },
        destinationCity: { type: "string" },
        destinationState: { type: "string" },
        targetRate: { type: "string", description: "Target rate as a decimal string, up to 4 decimals (e.g. 2.15)." }
      },
      required: ["originCity", "originState", "destinationCity", "destinationState", "targetRate"]
    }
  },
  {
    name: "set_lane_target",
    description:
      "Set the target rate-per-mile on an existing lane. Pass the laneId (from find_lanes) and the new target " +
      "as a decimal string. Requires REGIONAL_MANAGER+.",
    input_schema: {
      type: "object" as const,
      properties: {
        laneId: { type: "string" },
        targetRate: { type: "string", description: "New target rate as a decimal string, up to 4 decimals." }
      },
      required: ["laneId", "targetRate"]
    }
  },
  {
    name: "find_drop_lots",
    description:
      "List drop lots in the current region (optionally filtered by name/code substring). Use this to resolve " +
      "which drop lot the user means before updating one. Returns drop-lot ids, names, codes, and locations.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Optional case-insensitive match on drop-lot name or code." }
      }
    }
  },
  {
    name: "create_drop_lot",
    description:
      "Create a new drop lot. name, city, and state are required; code, note, sortOrder, dailyCapacity, slipSeat, " +
      "and dropHookRequired are optional. Requires REGIONAL_MANAGER+.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string" },
        code: { type: "string" },
        note: { type: "string" },
        city: { type: "string" },
        state: { type: "string" },
        sortOrder: { type: "number" },
        dailyCapacity: { type: "number" },
        slipSeat: { type: "boolean" },
        dropHookRequired: { type: "boolean" }
      },
      required: ["name", "city", "state"]
    }
  },
  {
    name: "update_drop_lot",
    description:
      "Update fields on an existing drop lot. Pass the dropLotId (from find_drop_lots) and only the fields to " +
      "change. Requires REGIONAL_MANAGER+.",
    input_schema: {
      type: "object" as const,
      properties: {
        dropLotId: { type: "string" },
        name: { type: "string" },
        code: { type: "string" },
        note: { type: "string" },
        city: { type: "string" },
        state: { type: "string" },
        sortOrder: { type: "number" },
        dailyCapacity: { type: "number" },
        slipSeat: { type: "boolean" },
        dropHookRequired: { type: "boolean" }
      },
      required: ["dropLotId"]
    }
  }
];

function assertBoardWrite(ctx: CopilotContext): void {
  policyAdapter.assertPermission(
    { userId: ctx.userId, regionId: ctx.regionId, role: ctx.role },
    { resource: "BOARD", action: "WRITE" }
  );
}

function assertReferenceWrite(ctx: CopilotContext): void {
  policyAdapter.assertPermission(
    { userId: ctx.userId, regionId: ctx.regionId, role: ctx.role },
    { resource: "REFERENCE_DATA", action: "WRITE" }
  );
}

function assertSettingsWrite(ctx: CopilotContext): void {
  policyAdapter.assertPermission(
    { userId: ctx.userId, regionId: ctx.regionId, role: ctx.role },
    { resource: "SYSTEM_SETTINGS", action: "WRITE" }
  );
}

function assertKpiWrite(ctx: CopilotContext): void {
  policyAdapter.assertPermission(
    { userId: ctx.userId, regionId: ctx.regionId, role: ctx.role },
    { resource: "KPI_DASHBOARD", action: "WRITE" }
  );
}

function assertFscWrite(ctx: CopilotContext): void {
  policyAdapter.assertPermission(
    { userId: ctx.userId, regionId: ctx.regionId, role: ctx.role },
    { resource: "FSC_INDEX", action: "WRITE" }
  );
}

function assertReviewPermission(ctx: CopilotContext): void {
  policyAdapter.assertPermission(
    { userId: ctx.userId, regionId: ctx.regionId, role: ctx.role },
    { resource: "RATE_CONFIRMATION_REVIEW", action: "REVIEW" }
  );
}

const BROKER_ONBOARDING_STATUSES = new Set(["PENDING", "APPROVED", "BLOCKED"]);

function coerceOnboardingStatus(value: unknown): BrokerOnboardingStatus | undefined {
  return typeof value === "string" && BROKER_ONBOARDING_STATUSES.has(value)
    ? (value as BrokerOnboardingStatus)
    : undefined;
}

type ToolInput = Record<string, unknown>;

/**
 * Executes a single copilot tool under the caller's identity/scope. Risky tools
 * (and any update touching financial fields) are NOT executed unless `confirmed`
 * — instead they return needsConfirmation so the UI can prompt.
 */
export async function dispatchTool(
  name: string,
  input: ToolInput,
  ctx: CopilotContext,
  opts: { confirmed: boolean } = { confirmed: false }
): Promise<ToolDispatchResult> {
  switch (name) {
    case "find_loads": {
      const q = typeof input.query === "string" ? input.query.trim() : "";
      const limit = typeof input.limit === "number" ? Math.min(Math.max(input.limit, 1), 25) : 10;
      const status = typeof input.status === "string" ? input.status.trim().toUpperCase() : undefined;
      const dateStr = typeof input.date === "string" && isIsoDay(input.date) ? input.date : undefined;
      const dateRange = dateStr ? boardDayRange(dateStr, PHASE1_BOARD_TIMEZONE) : null;
      const where = withNonDeletedRegionScope(ctx.regionId, {
        ...(status ? { status: status as never } : {}),
        ...(dateRange ? { bookingDate: { gte: dateRange.dayStart, lt: dateRange.dayEnd } } : {}),
        ...(q
          ? {
              OR: [
                { loadNumber: { contains: q, mode: "insensitive" as const } },
                { threePlRefNumber: { contains: q, mode: "insensitive" as const } },
                { shipperName: { contains: q, mode: "insensitive" as const } },
                { receiverName: { contains: q, mode: "insensitive" as const } },
                { broker: { name: { contains: q, mode: "insensitive" as const } } }
              ]
            }
          : {})
      });
      const loads = await prisma.load.findMany({
        where: where as never,
        orderBy: { bookingDate: "desc" },
        take: limit,
        select: {
          id: true, loadNumber: true, threePlRefNumber: true, status: true,
          shipperName: true, receiverName: true, pickupDate: true, deliveryDate: true,
          broker: { select: { name: true } }
        }
      });
      return {
        content: loads.map((l) => ({
          id: l.id,
          loadNumber: l.loadNumber,
          ref: l.threePlRefNumber,
          status: l.status,
          shipper: l.shipperName,
          receiver: l.receiverName,
          pickupDate: l.pickupDate?.toISOString().slice(0, 10) ?? null,
          deliveryDate: l.deliveryDate?.toISOString().slice(0, 10) ?? null,
          broker: l.broker?.name ?? null
        }))
      };
    }

    case "get_load_detail": {
      const loadId = String(input.loadId ?? "");
      const detail = await getLoadDetail({ regionId: ctx.regionId, loadId });
      return { content: detail ?? { error: "Load not found." } };
    }

    case "get_board_summary": {
      const dateStr = typeof input.date === "string" && isIsoDay(input.date) ? input.date : ctx.boardDate;
      const board = await getBoardResponse({ regionId: ctx.regionId, date: dateStr });
      return {
        content: {
          date: board.date,
          dayTotals: board.dayTotals,
          sections: board.sections.map((section) => ({
            title: section.title,
            type: section.type,
            code: section.code ?? section.dropLot?.code ?? null,
            sectionId: section.dropLot?.id ?? section.type,
            capacity: section.dropLot?.dailyCapacity ?? null,
            filled: section.filledCount,
            overCapacity:
              section.dropLot?.dailyCapacity != null && section.filledCount > section.dropLot.dailyCapacity,
            loads: section.loads.map((load) => ({
              id: load.id,
              ref: load.threePlRefNumber,
              status: load.status,
              shipper: load.shipperName,
              receiver: load.receiverName,
              driver: load.pickupDriverAssigned,
              deliveryDate: load.deliveryDate ? load.deliveryDate.slice(0, 10) : null
            }))
          }))
        }
      };
    }

    case "get_kpis": {
      const weeks = typeof input.weeks === "number" ? input.weeks : undefined;
      const weekIso = weekIsoFromPickup(new Date(ctx.boardDate));
      const dashboard = await getKpiDashboard({ regionId: ctx.regionId, weekIso, weeks });
      return {
        content: {
          weekIso: dashboard.weekIso,
          comparisonWeekIso: dashboard.comparisonWeekIso,
          comparisonMode: dashboard.comparisonMode,
          mileMaxMissingInbound: dashboard.mileMaxMissingInbound,
          cards: dashboard.cards,
          lanes: dashboard.lanes.slice(0, 12),
          alerts: dashboard.alerts,
          trend: dashboard.trend,
          rules: dashboard.rules
        }
      };
    }

    case "get_attention_items": {
      const dateStr = typeof input.date === "string" && isIsoDay(input.date) ? input.date : ctx.boardDate;
      const board = await getBoardResponse({ regionId: ctx.regionId, date: dateStr });
      const items = collectAttentionItems(board);
      return { content: { date: board.date, count: items.length, items } };
    }

    case "get_audit_history": {
      const loadId = typeof input.loadId === "string" && input.loadId ? input.loadId : null;
      const entityId = loadId ?? (typeof input.entityId === "string" ? input.entityId : "");
      if (!entityId) return { content: { error: "Provide a loadId or entityId." } };
      const entityType = loadId ? "Load" : typeof input.entityType === "string" ? input.entityType : undefined;
      const limit = typeof input.limit === "number" ? input.limit : undefined;
      const history = await getAuditHistory({ entityId, entityType, limit });
      return { content: { entityId, entityType: entityType ?? null, count: history.length, history } };
    }

    case "list_audit_log": {
      const parseDate = (value: unknown): Date | undefined => {
        if (typeof value !== "string" || !value.trim()) return undefined;
        const iso = /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? `${value.trim()}T00:00:00` : value.trim();
        const parsed = new Date(iso);
        return Number.isNaN(parsed.getTime()) ? undefined : parsed;
      };
      const limit = typeof input.limit === "number" ? Math.min(Math.max(input.limit, 1), 100) : 25;
      const page = await listAuditLog({
        entityType: typeof input.entityType === "string" && input.entityType.trim() ? input.entityType.trim() : undefined,
        action: typeof input.action === "string" && input.action.trim() ? input.action.trim() : undefined,
        actorId: typeof input.actorId === "string" && input.actorId.trim() ? input.actorId.trim() : undefined,
        from: parseDate(input.from),
        to: parseDate(input.to),
        search: typeof input.search === "string" && input.search.trim() ? input.search.trim() : undefined,
        cursor: typeof input.cursor === "string" && input.cursor.trim() ? input.cursor.trim() : undefined,
        limit
      });
      return { content: { count: page.entries.length, entries: page.entries, nextCursor: page.nextCursor } };
    }

    case "get_fsc": {
      const weekIso = weekIsoFromPickup(new Date(ctx.boardDate));
      const rate = await getEffectiveFscRate(ctx.regionId, weekIso);
      const brokers = await listBrokers({ regionId: ctx.regionId });
      const brokersWithoutDefaultFsc = brokers.filter((b) => !b.fscDefaultApplies).map((b) => b.name);
      return { content: { weekIso, fscRate: rate ? rate.toString() : null, brokersWithoutDefaultFsc } };
    }

    case "find_destinations": {
      const [dcs, lots] = await Promise.all([
        listDistributionCenters({ regionId: ctx.regionId }),
        listDropLots({ regionId: ctx.regionId })
      ]);
      return {
        content: {
          distributionCenters: dcs.map((d) => ({ name: d.name, city: d.city, state: d.state })),
          dropLots: lots.map((l) => ({ name: l.name, code: l.code, city: l.city, state: l.state }))
        }
      };
    }

    case "get_rate_confirmations": {
      const dateStr = typeof input.date === "string" && isIsoDay(input.date) ? input.date : ctx.boardDate;
      const activity = await getRateConfirmationActivity({ regionId: ctx.regionId, date: dateStr });
      return { content: { date: dateStr, ...activity } };
    }

    case "get_operational_rules": {
      const rules = await listOperationalRules({ regionId: ctx.regionId });
      return { content: { count: rules.length, rules } };
    }

    case "create_load": {
      assertBoardWrite(ctx);
      const pickupCity = String(input.pickupCity ?? "").trim();
      const pickupState = String(input.pickupState ?? "").trim();
      const deliveryCity = String(input.deliveryCity ?? "").trim();
      const deliveryState = String(input.deliveryState ?? "").trim();
      const lineHaulRate = typeof input.lineHaulRate === "string" ? input.lineHaulRate.trim() : "";
      const puDeadhead = typeof input.puDeadheadMiles === "string" ? input.puDeadheadMiles.trim() : "";
      const delDeadhead = typeof input.delDeadheadMiles === "string" ? input.delDeadheadMiles.trim() : "";
      const missing: string[] = [];
      if (!pickupCity || !pickupState) missing.push("pickup city/state");
      if (!deliveryCity || !deliveryState) missing.push("delivery city/state");
      if (!DECIMAL_RE.test(lineHaulRate)) missing.push("line-haul rate");
      if (typeof input.fscApplies !== "boolean") missing.push("whether fuel surcharge applies (yes/no)");
      if (!DECIMAL_RE.test(puDeadhead)) missing.push("PU deadhead miles");
      if (!DECIMAL_RE.test(delDeadhead)) missing.push("DEL deadhead miles");
      if (missing.length > 0) return { content: { status: "need_info", message: `I still need: ${missing.join(", ")}.` } };
      const fscApplies = input.fscApplies === true;

      let loadedMiles = typeof input.loadedMiles === "string" && input.loadedMiles.trim() ? input.loadedMiles.trim() : "";
      let milesSource = loadedMiles ? "manual" : "";
      if (!loadedMiles) {
        const road = await getRoadMiles({ originCity: pickupCity, originState: pickupState, destCity: deliveryCity, destState: deliveryState });
        if (road.miles === null) {
          return {
            content: {
              status: "need_miles",
              message: `Routing isn't configured, so I can't auto-calculate miles from ${pickupCity}, ${pickupState} to ${deliveryCity}, ${deliveryState}. What are the loaded miles?`
            }
          };
        }
        loadedMiles = String(road.miles);
        milesSource = road.source;
      } else if (!DECIMAL_RE.test(loadedMiles)) {
        return { content: { status: "need_info", message: "Loaded miles must be a number." } };
      }

      let brokerId: string | undefined;
      const brokerName = typeof input.brokerName === "string" ? input.brokerName.trim() : "";
      if (brokerName) {
        const brokers = await listBrokers({ regionId: ctx.regionId });
        const lower = brokerName.toLowerCase();
        const match = brokers.find((b) => b.name.toLowerCase() === lower) ?? brokers.find((b) => b.name.toLowerCase().includes(lower));
        if (!match) return { content: { status: "need_info", message: `No broker named "${brokerName}" in this region. Create it first or leave the broker off.` } };
        brokerId = match.id;
      }
      let dropLotId: string | undefined;
      const dropLotName = typeof input.dropLotName === "string" ? input.dropLotName.trim() : "";
      if (dropLotName) {
        const lots = await listDropLots({ regionId: ctx.regionId });
        const lower = dropLotName.toLowerCase();
        const match = lots.find((l) => l.name.toLowerCase() === lower || (l.code ?? "").toLowerCase() === lower) ?? lots.find((l) => l.name.toLowerCase().includes(lower));
        if (!match) return { content: { status: "need_info", message: `No drop lot matching "${dropLotName}". Pick an existing lot or leave it off.` } };
        dropLotId = match.id;
      }

      const pickupDate = typeof input.pickupDate === "string" && isIsoDay(input.pickupDate) ? input.pickupDate : ctx.boardDate;
      const deliveryDate = typeof input.deliveryDate === "string" && isIsoDay(input.deliveryDate) ? input.deliveryDate : null;
      const shipperName = typeof input.shipperName === "string" && input.shipperName.trim() ? input.shipperName.trim() : undefined;
      const receiverName = typeof input.receiverName === "string" && input.receiverName.trim() ? input.receiverName.trim() : undefined;
      const driverType =
        input.driverType === "SHUTTLE" || input.driverType === "PTP" || input.driverType === "LTL" ? input.driverType : undefined;

      const summary = `Create load ${pickupCity}, ${pickupState} → ${deliveryCity}, ${deliveryState}: rate $${lineHaulRate}, loaded ${loadedMiles}mi (${milesSource}), PU DH ${puDeadhead}, DEL DH ${delDeadhead}, FSC ${fscApplies ? "yes" : "no"}${brokerName ? `, broker ${brokerName}` : ""}${dropLotName ? `, lot ${dropLotName}` : ""}`;
      if (!opts.confirmed) {
        return { needsConfirmation: true, summary, content: { status: "confirmation_required", summary, loadedMiles, milesSource } };
      }

      const created = await createManualLoad({
        actorId: ctx.userId,
        regionId: ctx.regionId,
        pickupDate: new Date(pickupDate),
        deliveryDate: deliveryDate ? new Date(deliveryDate) : null,
        shipperName,
        receiverName,
        brokerId,
        dropLotId,
        lineHaulRate: new Prisma.Decimal(lineHaulRate),
        loadedMiles: new Prisma.Decimal(loadedMiles),
        puDeadheadMiles: new Prisma.Decimal(puDeadhead),
        delDeadheadMiles: new Prisma.Decimal(delDeadhead),
        fscApplies,
        driverType
      });
      return { content: { status: "created", loadId: created.loadId, loadedMiles, milesSource }, summary };
    }

    case "create_relayed_load": {
      // Birth a relayed load + its legs in one shot. The deterministic intake
      // interview (server/copilot/intake-interview.ts) assembles this input and
      // stages it; confirming runs this branch. Base fields mirror create_load;
      // the legs carry the relay plan set at the load's birth.
      assertBoardWrite(ctx);
      const pickupCity = String(input.pickupCity ?? "").trim();
      const pickupState = String(input.pickupState ?? "").trim();
      const deliveryCity = String(input.deliveryCity ?? "").trim();
      const deliveryState = String(input.deliveryState ?? "").trim();
      const lineHaulRate = typeof input.lineHaulRate === "string" ? input.lineHaulRate.trim() : "";
      const puDeadhead = typeof input.puDeadheadMiles === "string" ? input.puDeadheadMiles.trim() : "";
      const delDeadhead = typeof input.delDeadheadMiles === "string" ? input.delDeadheadMiles.trim() : "";
      const loadedMiles = typeof input.loadedMiles === "string" ? input.loadedMiles.trim() : "";
      const rawLegs = Array.isArray(input.legs) ? (input.legs as Array<Record<string, unknown>>) : [];

      const missing: string[] = [];
      if (!pickupCity || !pickupState) missing.push("pickup city/state");
      if (!deliveryCity || !deliveryState) missing.push("delivery city/state");
      if (!DECIMAL_RE.test(lineHaulRate)) missing.push("line-haul rate");
      if (typeof input.fscApplies !== "boolean") missing.push("whether fuel surcharge applies");
      if (!DECIMAL_RE.test(puDeadhead)) missing.push("PU deadhead miles");
      if (!DECIMAL_RE.test(delDeadhead)) missing.push("DEL deadhead miles");
      if (!DECIMAL_RE.test(loadedMiles)) missing.push("loaded miles");
      if (rawLegs.length === 0) missing.push("at least one leg");
      if (missing.length > 0) return { content: { status: "need_info", message: `I still need: ${missing.join(", ")}.` } };

      const legs = rawLegs.map((leg, i) => ({
        legIndex: typeof leg.legIndex === "number" ? leg.legIndex : i,
        legType: String(leg.legType ?? ""),
        driverName: typeof leg.driverName === "string" && leg.driverName.trim() ? leg.driverName.trim() : null
      }));
      const badLeg = legs.find((l) => !["SHUTTLE", "PTP", "DELIVERY"].includes(l.legType));
      if (badLeg) {
        return { content: { status: "need_info", message: `Leg ${badLeg.legIndex} type must be SHUTTLE, PTP, or DELIVERY.` } };
      }
      const fscApplies = input.fscApplies === true;

      let brokerId: string | undefined;
      const brokerName = typeof input.brokerName === "string" ? input.brokerName.trim() : "";
      if (brokerName) {
        const brokers = await listBrokers({ regionId: ctx.regionId });
        const lower = brokerName.toLowerCase();
        const match = brokers.find((b) => b.name.toLowerCase() === lower) ?? brokers.find((b) => b.name.toLowerCase().includes(lower));
        if (!match) return { content: { status: "need_info", message: `No broker named "${brokerName}" in this region. Create it first or leave the broker off.` } };
        brokerId = match.id;
      }
      const shipperName = typeof input.shipperName === "string" && input.shipperName.trim() ? input.shipperName.trim() : undefined;
      const receiverName = typeof input.receiverName === "string" && input.receiverName.trim() ? input.receiverName.trim() : undefined;
      const pickupDate = typeof input.pickupDate === "string" && isIsoDay(input.pickupDate) ? input.pickupDate : ctx.boardDate;
      const deliveryDate = typeof input.deliveryDate === "string" && isIsoDay(input.deliveryDate) ? input.deliveryDate : null;
      // Set when the interview was seeded by dropping a rate con into the copilot —
      // links the born load back to its rate con (else null, like a manual load).
      const rateConfirmationId =
        typeof input.rateConfirmationId === "string" && input.rateConfirmationId.trim()
          ? input.rateConfirmationId.trim()
          : null;

      const covered = legs.filter((l) => l.driverName).length;
      const chain = legs.map((l) => l.legType).join(" → ");
      const summary =
        `Create relayed load · ${legs.length} leg${legs.length === 1 ? "" : "s"} (${chain}) · ` +
        `${pickupCity}, ${pickupState} → ${deliveryCity}, ${deliveryState} · rate $${lineHaulRate} · ${covered}/${legs.length} legs covered`;
      if (!opts.confirmed) {
        return { needsConfirmation: true, summary, content: { status: "confirmation_required", summary } };
      }

      const created = await createManualLoad({
        actorId: ctx.userId,
        regionId: ctx.regionId,
        pickupDate: new Date(pickupDate),
        deliveryDate: deliveryDate ? new Date(deliveryDate) : null,
        shipperName,
        receiverName,
        brokerId,
        lineHaulRate: new Prisma.Decimal(lineHaulRate),
        loadedMiles: new Prisma.Decimal(loadedMiles),
        puDeadheadMiles: new Prisma.Decimal(puDeadhead),
        delDeadheadMiles: new Prisma.Decimal(delDeadhead),
        fscApplies,
        rateConfirmationId
      });

      // Add the relay legs in chain order; each runs through the same validated
      // path as the drawer leg editor.
      for (const leg of legs) {
        await upsertBoardLoadLeg({
          regionId: ctx.regionId,
          loadId: created.loadId,
          actorId: ctx.userId,
          leg: {
            id: undefined,
            legIndex: leg.legIndex,
            legType: leg.legType as "SHUTTLE" | "PTP" | "DELIVERY",
            driverName: leg.driverName,
            startCity: null,
            startState: null,
            endCity: null,
            endState: null,
            legMiles: null,
            notes: null,
            etaAt: null,
            arrivalAt: null
          }
        });
      }
      return { content: { status: "created", loadId: created.loadId, legs: legs.length }, summary };
    }

    case "set_fsc": {
      assertFscWrite(ctx);
      const value = typeof input.value === "string" ? input.value.trim() : "";
      if (!DECIMAL_RE.test(value)) return { content: { status: "need_info", message: "FSC value must be a positive number." } };
      const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : "Set via copilot";
      const source: FuelSurchargeSource = input.source === "override" ? "manual_override" : "manual_tuesday";
      const weekIso = weekIsoFromPickup(new Date(ctx.boardDate));
      const summary = `Set ${source === "manual_override" ? "FSC override" : "Tuesday FSC"} for ${weekIso} to ${value}`;
      if (!opts.confirmed) return { needsConfirmation: true, summary, content: { status: "confirmation_required", summary } };
      await upsertFscIndex({
        ctx: { userId: ctx.userId, regionId: ctx.regionId, role: ctx.role },
        regionId: ctx.regionId,
        weekIso,
        value: new Prisma.Decimal(value),
        reason,
        source
      });
      return { content: { status: "updated", weekIso, value, source }, summary };
    }

    case "set_board_thresholds": {
      assertSettingsWrite(ctx);
      const amber = typeof input.emptyPctAmber === "string" ? input.emptyPctAmber.trim() : "";
      const red = typeof input.emptyPctRed === "string" ? input.emptyPctRed.trim() : "";
      const alert = typeof input.emptyPctAlert === "string" ? input.emptyPctAlert.trim() : "";
      if (!amber && !red && !alert) {
        return { content: { status: "need_info", message: "Provide emptyPctAmber, emptyPctRed, and/or emptyPctAlert (percents)." } };
      }
      if (amber && !DECIMAL_RE.test(amber)) return { content: { status: "need_info", message: "emptyPctAmber must be a number." } };
      if (red && !DECIMAL_RE.test(red)) return { content: { status: "need_info", message: "emptyPctRed must be a number." } };
      if (alert && !DECIMAL_RE.test(alert)) return { content: { status: "need_info", message: "emptyPctAlert must be a number." } };
      const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : "Set via copilot";
      const summary = `Set Empty% thresholds${amber ? ` · amber ${amber}%` : ""}${red ? ` · red ${red}%` : ""}${alert ? ` · alert ${alert}%` : ""}`;
      if (!opts.confirmed) return { needsConfirmation: true, summary, content: { status: "confirmation_required", summary } };
      const updated = await updateRegionConfig({
        actorId: ctx.userId,
        regionId: ctx.regionId,
        emptyPctAmber: amber || undefined,
        emptyPctRed: red || undefined,
        emptyPctAlert: alert || undefined,
        reason
      });
      return { content: { status: "updated", ...updated }, summary };
    }

    case "get_llm_settings": {
      // Masked, non-sensitive view only — the raw API key is never exposed.
      const status = await getLlmSettingsStatus();
      return { content: status };
    }

    case "set_llm_settings": {
      assertSettingsWrite(ctx);
      const current = await getLlmSettingsStatus();
      const provider = typeof input.provider === "string" && input.provider.trim() ? input.provider.trim() : current.provider;
      const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : current.model;
      const copilotModel = typeof input.copilotModel === "string" ? input.copilotModel.trim() : undefined;
      const apiKey = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : undefined;

      const changingProvider = typeof input.provider === "string" && input.provider.trim().length > 0;
      const changingModel = typeof input.model === "string" && input.model.trim().length > 0;
      if (!changingProvider && !changingModel && copilotModel === undefined && !apiKey) {
        return { content: { status: "need_info", message: "Provide at least one of: provider, model, copilotModel, or apiKey." } };
      }
      if (!SUPPORTED_PROVIDERS.includes(provider)) {
        return { content: { status: "need_info", message: `Unsupported provider "${provider}". Supported: ${SUPPORTED_PROVIDERS.join(", ")}.` } };
      }

      // The key value is never placed in the summary or any tool result.
      const summary = `Update LLM settings · provider ${provider} · parsing ${model}${
        copilotModel !== undefined ? ` · copilot ${copilotModel || "(default)"}` : ""
      }${apiKey ? " · rotate API key" : ""}`;
      if (!opts.confirmed) return { needsConfirmation: true, summary, content: { status: "confirmation_required", summary } };

      const updated = await updateLlmSettings({
        actorId: ctx.userId,
        provider,
        model,
        copilotModel,
        apiKey
      });
      // Return only the masked status (provider/model/last4); the raw key is never echoed.
      return { content: { status: "updated", settings: updated }, summary };
    }

    case "acknowledge_alert": {
      assertKpiWrite(ctx);
      const alertId = typeof input.alertId === "string" ? input.alertId.trim() : "";
      if (!alertId) return { content: { error: "alertId is required." } };
      const reason = typeof input.reason === "string" ? input.reason : undefined;
      await acknowledgeKpiAlert({ alertId, actorId: ctx.userId, reason });
      return { content: { status: "acknowledged", alertId }, summary: `Acknowledged alert ${alertId}` };
    }

    case "set_lane_note": {
      assertKpiWrite(ctx);
      const lane = typeof input.lane === "string" ? input.lane.trim() : "";
      if (!lane) return { content: { error: "lane is required." } };
      const note = typeof input.note === "string" ? input.note : "";
      const weekIso = weekIsoFromPickup(new Date(ctx.boardDate));
      await setLaneNote({ regionId: ctx.regionId, weekIso, lane, note, actorId: ctx.userId });
      return { content: { status: "ok", lane, weekIso }, summary: note.trim() ? `Set note on lane ${lane}` : `Cleared note on lane ${lane}` };
    }

    case "set_lane_weekly_target": {
      assertKpiWrite(ctx);
      const lane = typeof input.lane === "string" ? input.lane.trim() : "";
      if (!lane) return { content: { error: "lane is required." } };
      const targetRate = typeof input.targetRate === "string" ? input.targetRate.trim() : "";
      if (targetRate && !DECIMAL_RE.test(targetRate)) {
        return { content: { status: "need_info", message: "Target rate must be a positive number (or empty to clear)." } };
      }
      const weekIso = weekIsoFromPickup(new Date(ctx.boardDate));
      await setLaneWeeklyTarget({ regionId: ctx.regionId, weekIso, lane, targetRate, actorId: ctx.userId });
      return { content: { status: "ok", lane, weekIso }, summary: targetRate ? `Set weekly target ${targetRate} on lane ${lane}` : `Cleared weekly target on lane ${lane}` };
    }

    case "add_broker_rep": {
      assertReferenceWrite(ctx);
      const brokerId = typeof input.brokerId === "string" ? input.brokerId : "";
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!brokerId || !name) return { content: { error: "brokerId and name are required." } };
      const rep = await addBrokerRep({
        regionId: ctx.regionId,
        actorId: ctx.userId,
        brokerId,
        name,
        email: typeof input.email === "string" ? input.email.trim() || null : null,
        phone: typeof input.phone === "string" ? input.phone.trim() || null : null
      });
      return { content: { status: "created", repId: rep.id }, summary: `Added rep ${name}` };
    }

    case "update_broker_rep": {
      assertReferenceWrite(ctx);
      const brokerId = typeof input.brokerId === "string" ? input.brokerId : "";
      const repId = typeof input.repId === "string" ? input.repId : "";
      if (!brokerId || !repId) return { content: { error: "brokerId and repId are required." } };
      const fields: { name?: string; email?: string | null; phone?: string | null } = {};
      if (typeof input.name === "string" && input.name.trim()) fields.name = input.name.trim();
      if (typeof input.email === "string") fields.email = input.email.trim() || null;
      if (typeof input.phone === "string") fields.phone = input.phone.trim() || null;
      if (Object.keys(fields).length === 0) return { content: { error: "No updatable rep fields were provided." } };
      await updateBrokerRep({ regionId: ctx.regionId, actorId: ctx.userId, brokerId, repId, fields });
      return { content: { status: "updated", repId }, summary: `Updated rep ${repId}` };
    }

    case "delete_broker_rep": {
      assertReferenceWrite(ctx);
      const brokerId = typeof input.brokerId === "string" ? input.brokerId : "";
      const repId = typeof input.repId === "string" ? input.repId : "";
      if (!brokerId || !repId) return { content: { error: "brokerId and repId are required." } };
      const summary = `Delete broker rep ${repId}`;
      if (!opts.confirmed) return { needsConfirmation: true, summary, content: { status: "confirmation_required", summary } };
      await softDeleteBrokerRep({ regionId: ctx.regionId, actorId: ctx.userId, brokerId, repId });
      return { content: { status: "deleted", repId }, summary };
    }

    case "delete_broker": {
      assertReferenceWrite(ctx);
      const brokerId = typeof input.brokerId === "string" ? input.brokerId : "";
      if (!brokerId) return { content: { error: "brokerId is required." } };
      const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : "Removed via copilot";
      const summary = `Delete broker ${brokerId} (${reason})`;
      if (!opts.confirmed) return { needsConfirmation: true, summary, content: { status: "confirmation_required", summary } };
      await softDeleteBroker({ regionId: ctx.regionId, actorId: ctx.userId, brokerId, reason });
      return { content: { status: "deleted", brokerId }, summary };
    }

    case "delete_lane": {
      assertReferenceWrite(ctx);
      const laneId = typeof input.laneId === "string" ? input.laneId : "";
      if (!laneId) return { content: { error: "laneId is required." } };
      const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : "Removed via copilot";
      const summary = `Delete lane ${laneId} (${reason})`;
      if (!opts.confirmed) return { needsConfirmation: true, summary, content: { status: "confirmation_required", summary } };
      await softDeleteLane({ regionId: ctx.regionId, actorId: ctx.userId, laneId, reason });
      return { content: { status: "deleted", laneId }, summary };
    }

    case "delete_drop_lot": {
      assertReferenceWrite(ctx);
      const dropLotId = typeof input.dropLotId === "string" ? input.dropLotId : "";
      if (!dropLotId) return { content: { error: "dropLotId is required." } };
      const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : "Removed via copilot";
      const summary = `Delete drop lot ${dropLotId} (${reason})`;
      if (!opts.confirmed) return { needsConfirmation: true, summary, content: { status: "confirmation_required", summary } };
      await softDeleteDropLot({ regionId: ctx.regionId, actorId: ctx.userId, dropLotId, reason });
      return { content: { status: "deleted", dropLotId }, summary };
    }

    case "create_operational_rule": {
      assertKpiWrite(ctx);
      const code = typeof input.code === "string" ? input.code.trim() : "";
      const title = typeof input.title === "string" ? input.title.trim() : "";
      const statement = typeof input.statement === "string" ? input.statement.trim() : "";
      const severity =
        input.severity === "INFO" || input.severity === "WARN" || input.severity === "ACTION_REQUIRED" ? input.severity : null;
      if (!code || !title || !statement || !severity) return { content: { error: "code, title, severity, and statement are required." } };
      if (!/^[A-Z0-9_]+$/.test(code)) return { content: { status: "need_info", message: "code must be UPPER_SNAKE_CASE (A-Z, 0-9, _)." } };
      const appliesTo = typeof input.appliesTo === "string" && input.appliesTo.trim() ? input.appliesTo.trim() : undefined;
      const rule = await createOperationalRule({ regionId: ctx.regionId, actorId: ctx.userId, code, title, severity, statement, appliesTo });
      return { content: { status: "created", ruleId: rule.id }, summary: `Created rule ${code}` };
    }

    case "review_rate_confirmation": {
      assertReviewPermission(ctx);
      const rateConfirmationId = typeof input.rateConfirmationId === "string" ? input.rateConfirmationId : "";
      if (!rateConfirmationId) return { content: { error: "rateConfirmationId is required." } };
      const decision = input.decision === "approve" || input.decision === "reject" ? input.decision : null;
      if (!decision) return { content: { error: "decision must be 'approve' or 'reject'." } };
      const reason = typeof input.reason === "string" ? input.reason : null;
      const summary =
        decision === "approve" ? `Approve rate con ${rateConfirmationId} (creates a load)` : `Reject rate con ${rateConfirmationId}`;
      if (decision === "approve" && !opts.confirmed) {
        return { needsConfirmation: true, summary, content: { status: "confirmation_required", summary } };
      }
      if (decision === "approve") {
        const result = await approveRateConfirmationReview({ actorId: ctx.userId, regionId: ctx.regionId, rateConfirmationId });
        return { content: { status: "approved", ...result }, summary };
      }
      await rejectRateConfirmationReview({ actorId: ctx.userId, regionId: ctx.regionId, rateConfirmationId, reason });
      return { content: { status: "rejected", rateConfirmationId }, summary };
    }

    case "update_load_fields": {
      assertBoardWrite(ctx);
      const loadId = String(input.loadId ?? "");
      const rawFields = (input.fields ?? {}) as Record<string, unknown>;
      const fields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rawFields)) {
        if (ALLOWED_LOAD_FIELDS.has(key)) fields[key] = value;
      }
      const touchesFinancial = Object.keys(fields).some((k) => FINANCIAL_FIELDS.has(k));
      const summary = `Update load ${loadId}: ${Object.keys(fields).join(", ") || "(no allowed fields)"}`;
      if (touchesFinancial && !opts.confirmed) {
        return { needsConfirmation: true, summary, content: { status: "confirmation_required", summary } };
      }
      await updateBoardLoadFields({ regionId: ctx.regionId, loadId, actorId: ctx.userId, fields: fields as never });
      return { content: { status: "updated", loadId, fields: Object.keys(fields) }, summary };
    }

    case "set_load_status": {
      assertBoardWrite(ctx);
      const loadId = String(input.loadId ?? "");
      const status = String(input.status ?? "") as LoadLifecycleStatus;
      const summary = `Set load ${loadId} status to ${status}`;
      // Forward progression is routine; only the exception transitions confirm.
      if ((status === "CANCELED" || status === "FAILED") && !opts.confirmed) {
        return { needsConfirmation: true, summary, content: { status: "confirmation_required", summary } };
      }
      const overrideReason = typeof input.overrideReason === "string" && input.overrideReason.trim() ? input.overrideReason.trim() : undefined;
      await setBoardLoadStatus({ regionId: ctx.regionId, loadId, status, actorId: ctx.userId, overrideReason });
      return { content: { status: "updated", loadId, newStatus: status }, summary };
    }

    case "set_tonu": {
      assertBoardWrite(ctx);
      const loadId = String(input.loadId ?? "");
      const isTonu = Boolean(input.isTonu);
      const tonuAmount = typeof input.tonuAmount === "string" ? input.tonuAmount : null;
      const summary = isTonu ? `Mark load ${loadId} TONU ($${tonuAmount ?? "?"})` : `Clear TONU on load ${loadId}`;
      if (!opts.confirmed) {
        return { needsConfirmation: true, summary, content: { status: "confirmation_required", summary } };
      }
      await setLoadTonuLifecycle({ regionId: ctx.regionId, loadId, isTonu, tonuAmount, actorId: ctx.userId });
      return { content: { status: "updated", loadId, isTonu }, summary };
    }

    case "soft_delete_load": {
      assertBoardWrite(ctx);
      const loadId = String(input.loadId ?? "");
      const reason = String(input.reason ?? "Removed via copilot");
      const summary = `Delete load ${loadId} (reason: ${reason})`;
      if (!opts.confirmed) {
        return { needsConfirmation: true, summary, content: { status: "confirmation_required", summary } };
      }
      await softDeleteBoardLoad({ regionId: ctx.regionId, loadId, reason, actorId: ctx.userId });
      return { content: { status: "deleted", loadId }, summary };
    }

    case "move_load": {
      assertBoardWrite(ctx);
      const loadId = String(input.loadId ?? "");
      const targetSectionId = String(input.targetSectionId ?? "");
      if (!targetSectionId) return { content: { error: "targetSectionId is required." } };
      const isCancel = targetSectionId === "canceled" || targetSectionId.startsWith("canceled-");
      const summary = `Move load ${loadId} to ${targetSectionId}`;
      if (isCancel && !opts.confirmed) {
        return { needsConfirmation: true, summary, content: { status: "confirmation_required", summary } };
      }
      await moveBoardLoad({ regionId: ctx.regionId, loadId, targetSectionId, actorId: ctx.userId });
      return { content: { status: "moved", loadId, targetSectionId }, summary };
    }

    case "upsert_load_leg": {
      assertBoardWrite(ctx);
      const loadId = String(input.loadId ?? "");
      const legInput = (input.leg ?? {}) as Record<string, unknown>;
      const legType = String(legInput.legType ?? "");
      if (!["SHUTTLE", "PTP", "DELIVERY"].includes(legType)) {
        return { content: { error: "leg.legType must be SHUTTLE, PTP, or DELIVERY." } };
      }
      const leg = {
        id: typeof legInput.id === "string" && legInput.id ? legInput.id : undefined,
        legIndex: typeof legInput.legIndex === "number" ? legInput.legIndex : 0,
        legType: legType as "SHUTTLE" | "PTP" | "DELIVERY",
        driverName: typeof legInput.driverName === "string" ? legInput.driverName : null,
        startCity: typeof legInput.startCity === "string" ? legInput.startCity : null,
        startState: typeof legInput.startState === "string" ? legInput.startState : null,
        endCity: typeof legInput.endCity === "string" ? legInput.endCity : null,
        endState: typeof legInput.endState === "string" ? legInput.endState : null,
        legMiles: typeof legInput.legMiles === "string" ? legInput.legMiles : null,
        notes: typeof legInput.notes === "string" ? legInput.notes : null,
        etaAt: typeof legInput.etaAt === "string" ? legInput.etaAt : null,
        arrivalAt: typeof legInput.arrivalAt === "string" ? legInput.arrivalAt : null
      };
      await upsertBoardLoadLeg({ regionId: ctx.regionId, loadId, actorId: ctx.userId, leg });
      const summary = `${leg.id ? "Update" : "Add"} leg ${leg.legIndex} (${leg.legType}) on load ${loadId}${
        leg.driverName ? ` — driver ${leg.driverName}` : ""
      }`;
      return { content: { status: "ok", loadId }, summary };
    }

    case "delete_load_leg": {
      assertBoardWrite(ctx);
      const loadId = String(input.loadId ?? "");
      const legId = String(input.legId ?? "");
      if (!legId) return { content: { error: "legId is required." } };
      const summary = `Delete leg ${legId} on load ${loadId}`;
      if (!opts.confirmed) {
        return { needsConfirmation: true, summary, content: { status: "confirmation_required", summary } };
      }
      await deleteBoardLoadLeg({ regionId: ctx.regionId, loadId, legId, actorId: ctx.userId });
      return { content: { status: "deleted", loadId, legId }, summary };
    }

    case "reschedule_delivery": {
      assertBoardWrite(ctx);
      const loadId = String(input.loadId ?? "");
      const newDate = String(input.newDate ?? "");
      const windowStart = String(input.windowStart ?? "");
      const windowEnd = String(input.windowEnd ?? "");
      const apptType = String(input.apptType ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
        return { content: { error: "newDate must be YYYY-MM-DD." } };
      }
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(windowStart) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(windowEnd)) {
        return { content: { error: "windowStart/windowEnd must be local HH:MM (24h)." } };
      }
      if (!["FIRM_APPT", "OPEN_WINDOW", "FCFS"].includes(apptType)) {
        return { content: { error: "apptType must be FIRM_APPT, OPEN_WINDOW, or FCFS." } };
      }
      await rescheduleBoardLoadDelivery({
        regionId: ctx.regionId,
        loadId,
        actorId: ctx.userId,
        date: newDate,
        windowStart,
        windowEnd,
        apptType: apptType as "FIRM_APPT" | "OPEN_WINDOW" | "FCFS"
      });
      const summary = `Reschedule load ${loadId} delivery to ${newDate} ${windowStart}–${windowEnd} (${apptType})`;
      return { content: { status: "rescheduled", loadId }, summary };
    }

    case "find_brokers": {
      const q = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
      const brokers = await listBrokers({ regionId: ctx.regionId });
      const filtered = q ? brokers.filter((b) => b.name.toLowerCase().includes(q)) : brokers;
      return {
        content: filtered.map((b) => ({
          id: b.id,
          name: b.name,
          onboardingStatus: b.onboardingStatus,
          fscDefaultApplies: b.fscDefaultApplies,
          reps: b.reps.map((rep) => ({ id: rep.id, name: rep.name, email: rep.email, phone: rep.phone }))
        }))
      };
    }

    case "create_broker": {
      assertReferenceWrite(ctx);
      const brokerName = String(input.name ?? "").trim();
      if (!brokerName) return { content: { error: "A broker name is required." } };
      const onboardingStatus = coerceOnboardingStatus(input.onboardingStatus);
      const fscDefaultApplies = typeof input.fscDefaultApplies === "boolean" ? input.fscDefaultApplies : undefined;
      const broker = await createBroker({
        regionId: ctx.regionId,
        actorId: ctx.userId,
        name: brokerName,
        onboardingStatus,
        fscDefaultApplies
      });
      return { content: { status: "created", brokerId: broker.id, name: broker.name }, summary: `Created broker ${broker.name}` };
    }

    case "update_broker": {
      assertReferenceWrite(ctx);
      const brokerId = String(input.brokerId ?? "");
      const fields: { name?: string; onboardingStatus?: BrokerOnboardingStatus; fscDefaultApplies?: boolean } = {};
      if (typeof input.name === "string" && input.name.trim()) fields.name = input.name.trim();
      const onboardingStatus = coerceOnboardingStatus(input.onboardingStatus);
      if (onboardingStatus) fields.onboardingStatus = onboardingStatus;
      if (typeof input.fscDefaultApplies === "boolean") fields.fscDefaultApplies = input.fscDefaultApplies;
      if (Object.keys(fields).length === 0) return { content: { error: "No updatable broker fields were provided." } };
      await updateBroker({ regionId: ctx.regionId, actorId: ctx.userId, brokerId, fields });
      return { content: { status: "updated", brokerId, fields: Object.keys(fields) }, summary: `Update broker ${brokerId}: ${Object.keys(fields).join(", ")}` };
    }

    case "find_lanes": {
      const q = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
      const lanes = await listLanes({ regionId: ctx.regionId });
      const filtered = q
        ? lanes.filter((l) =>
            [l.originCity, l.originState, l.destinationCity, l.destinationState]
              .some((part) => part.toLowerCase().includes(q))
          )
        : lanes;
      return {
        content: filtered.map((l) => ({
          id: l.id,
          lane: `${l.originCity}, ${l.originState} → ${l.destinationCity}, ${l.destinationState}`,
          targetRate: l.targetRate
        }))
      };
    }

    case "create_lane": {
      assertReferenceWrite(ctx);
      const originCity = String(input.originCity ?? "").trim();
      const originState = String(input.originState ?? "").trim();
      const destinationCity = String(input.destinationCity ?? "").trim();
      const destinationState = String(input.destinationState ?? "").trim();
      const targetRate = typeof input.targetRate === "string" ? input.targetRate.trim() : "";
      if (!originCity || !originState || !destinationCity || !destinationState || !targetRate) {
        return { content: { error: "originCity, originState, destinationCity, destinationState, and targetRate are required." } };
      }
      const lane = await createLane({
        regionId: ctx.regionId,
        actorId: ctx.userId,
        originCity,
        originState,
        destinationCity,
        destinationState,
        targetRate
      });
      return {
        content: { status: "created", laneId: lane.id },
        summary: `Created lane ${originCity}, ${originState} → ${destinationCity}, ${destinationState} @ ${targetRate}`
      };
    }

    case "set_lane_target": {
      assertReferenceWrite(ctx);
      const laneId = String(input.laneId ?? "");
      const targetRate = typeof input.targetRate === "string" ? input.targetRate.trim() : "";
      if (!laneId || !targetRate) return { content: { error: "laneId and targetRate are required." } };
      await setLaneTarget({ regionId: ctx.regionId, actorId: ctx.userId, laneId, targetRate });
      return { content: { status: "updated", laneId, targetRate }, summary: `Set lane ${laneId} target to ${targetRate}` };
    }

    case "find_drop_lots": {
      const q = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
      const lots = await listDropLots({ regionId: ctx.regionId });
      const filtered = q
        ? lots.filter((l) => l.name.toLowerCase().includes(q) || (l.code ?? "").toLowerCase().includes(q))
        : lots;
      return {
        content: filtered.map((l) => ({
          id: l.id,
          name: l.name,
          code: l.code,
          location: `${l.city}, ${l.state}`,
          sortOrder: l.sortOrder
        }))
      };
    }

    case "create_drop_lot": {
      assertReferenceWrite(ctx);
      const lotName = String(input.name ?? "").trim();
      const city = String(input.city ?? "").trim();
      const state = String(input.state ?? "").trim();
      if (!lotName || !city || !state) return { content: { error: "name, city, and state are required." } };
      const lot = await createDropLot({
        regionId: ctx.regionId,
        actorId: ctx.userId,
        fields: {
          name: lotName,
          code: typeof input.code === "string" && input.code.trim() ? input.code.trim() : null,
          note: typeof input.note === "string" && input.note.trim() ? input.note.trim() : null,
          city,
          state,
          sortOrder: typeof input.sortOrder === "number" ? input.sortOrder : 0,
          dailyCapacity: typeof input.dailyCapacity === "number" ? input.dailyCapacity : null,
          slipSeat: typeof input.slipSeat === "boolean" ? input.slipSeat : false,
          dropHookRequired: typeof input.dropHookRequired === "boolean" ? input.dropHookRequired : false
        }
      });
      return { content: { status: "created", dropLotId: lot.id, name: lotName }, summary: `Created drop lot ${lotName}` };
    }

    case "update_drop_lot": {
      assertReferenceWrite(ctx);
      const dropLotId = String(input.dropLotId ?? "");
      const fields: Record<string, unknown> = {};
      if (typeof input.name === "string" && input.name.trim()) fields.name = input.name.trim();
      if (typeof input.code === "string") fields.code = input.code.trim() || null;
      if (typeof input.note === "string") fields.note = input.note.trim() || null;
      if (typeof input.city === "string" && input.city.trim()) fields.city = input.city.trim();
      if (typeof input.state === "string" && input.state.trim()) fields.state = input.state.trim();
      if (typeof input.sortOrder === "number") fields.sortOrder = input.sortOrder;
      if (typeof input.dailyCapacity === "number") fields.dailyCapacity = input.dailyCapacity;
      if (typeof input.slipSeat === "boolean") fields.slipSeat = input.slipSeat;
      if (typeof input.dropHookRequired === "boolean") fields.dropHookRequired = input.dropHookRequired;
      if (Object.keys(fields).length === 0) return { content: { error: "No updatable drop-lot fields were provided." } };
      await updateDropLot({ regionId: ctx.regionId, actorId: ctx.userId, dropLotId, fields: fields as never });
      return { content: { status: "updated", dropLotId, fields: Object.keys(fields) }, summary: `Update drop lot ${dropLotId}: ${Object.keys(fields).join(", ")}` };
    }

    default:
      return { content: { error: `Unknown tool: ${name}` } };
  }
}
