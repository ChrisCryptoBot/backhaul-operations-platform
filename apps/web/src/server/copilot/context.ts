import { getBoardResponse } from "@/server/board";
import { getEffectiveFscRate } from "@/server/fsc";
import { weekIsoFromPickup } from "@/lib/week";
import type { BoardResponse, BoardLoadRow } from "@/lib/board-types";
import type { CopilotContext } from "@/server/copilot/tools";

const MAX_FLAGGED = 12;

/** A load is "flagged" if it carries an attention signal or an open POD task. */
export function isFlaggedLoad(load: Pick<BoardLoadRow, "attentionSeverity" | "podStatus">): boolean {
  return (
    load.attentionSeverity !== "INFO" ||
    load.podStatus === "REQUESTED" ||
    load.podStatus === "NEEDS_ATTENTION"
  );
}

export interface AttentionItem {
  id: string;
  ref: string | null;
  status: string;
  attentionSeverity: string;
  podStatus: string | null;
  note: string | null;
  shipper: string | null;
  receiver: string | null;
}

/** Loads on the board that need attention (urgent/warn flag or an open POD). */
export function collectAttentionItems(board: BoardResponse, limit = MAX_FLAGGED): AttentionItem[] {
  return board.sections
    .flatMap((section) => section.loads)
    .filter(isFlaggedLoad)
    .slice(0, limit)
    .map((load) => ({
      id: load.id,
      ref: load.threePlRefNumber ?? load.loadNumber ?? null,
      status: load.status,
      attentionSeverity: load.attentionSeverity,
      podStatus: load.podStatus,
      note: load.lateCancelFailedNote,
      shipper: load.shipperName,
      receiver: load.receiverName
    }));
}

/**
 * A compact, token-bounded snapshot of the live board for the day the user is viewing,
 * injected into the copilot's system prompt each turn so it is grounded without a round-trip.
 * Best-effort: returns an empty string if the board can't be read (never breaks a turn).
 */
export async function buildBoardContextDigest(ctx: CopilotContext): Promise<string> {
  let board: BoardResponse;
  try {
    board = await getBoardResponse({ regionId: ctx.regionId, date: ctx.boardDate });
  } catch {
    return "";
  }

  let fsc: string | null = null;
  try {
    const rate = await getEffectiveFscRate(ctx.regionId, weekIsoFromPickup(new Date(ctx.boardDate)));
    fsc = rate ? rate.toString() : null;
  } catch {
    fsc = null;
  }

  const t = board.dayTotals;
  const lines: string[] = [
    `LIVE BOARD CONTEXT for ${board.date} (read-only snapshot — re-read with tools before acting):`,
    `Totals: ${t.loadCount} loads · line-haul $${t.lineHaulTotal} · all-in $${t.allInTotal} · FSC $${t.fscTotal} · TONU $${t.tonuTotal} · loaded mi ${t.loadedMilesTotal} · empty ${t.emptyMilePct ?? "n/a"} · NBY ${t.nby ?? "n/a"}.`,
    `Current FSC rate (this week): ${fsc ?? "not set"}.`,
    `Board Empty% thresholds: amber ≥ ${board.config.emptyPctAmber}%, red ≥ ${board.config.emptyPctRed}%; dashboard empty-mile alert fires > ${board.config.emptyPctAlert}% (change with set_board_thresholds).`
  ];

  const sectionLines = board.sections
    .filter((section) => section.type !== "deliveries" || section.filledCount > 0)
    .map((section) => {
      const cap = section.dropLot?.dailyCapacity ?? null;
      const over = cap != null && section.filledCount > cap ? " (OVER CAPACITY)" : "";
      const fill = cap != null ? `${section.filledCount}/${cap}${over}` : `${section.filledCount}`;
      return `  - ${section.title}: ${fill}`;
    });
  if (sectionLines.length > 0) {
    lines.push("Sections (filled/capacity):", ...sectionLines);
  }

  const flagged = collectAttentionItems(board).map((item) => {
    const bits = [
      item.ref ?? item.id,
      item.status,
      item.attentionSeverity !== "INFO" ? item.attentionSeverity : null,
      item.podStatus ? `POD ${item.podStatus}` : null,
      item.note ? `note: ${item.note}` : null
    ].filter(Boolean);
    return `  - ${bits.join(" · ")}`;
  });
  if (flagged.length > 0) {
    lines.push("Flagged loads (need attention):", ...flagged);
  } else {
    lines.push("No flagged loads on this day.");
  }

  return lines.join("\n");
}
