import type { BoardResponse } from "@/lib/board-types";

export interface BehavioralContractResult {
  ok: boolean;
  violations: string[];
}

export function evaluateBoardBehavioralContract(board: BoardResponse): BehavioralContractResult {
  const violations: string[] = [];
  if (board.dayTotals.loadCount < 0) {
    violations.push("loadCount must be non-negative");
  }
  for (const section of board.sections) {
    if (section.filledCount !== section.loads.length) {
      violations.push(`section ${section.title} filledCount must equal loads length`);
    }
  }
  return { ok: violations.length === 0, violations };
}

