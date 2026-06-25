import { boardDayRange, PHASE1_BOARD_TIMEZONE } from "@/lib/board-date";
import { runInRegionScope } from "@/lib/db";

export async function getRateConfirmationActivity(input: {
  regionId: string;
  date: string;
}) {
  const { dayStart, dayEnd } = boardDayRange(input.date, PHASE1_BOARD_TIMEZONE);
  const recentWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return runInRegionScope(input.regionId, async (tx) => {
    const [rows, recentRows] = await Promise.all([
      tx.$queryRaw<
        Array<{ id: string; parseState: string; reviewDecision: string; updatedAt: Date; hasLoad: boolean; loadId: string | null; duplicateSignal: string | null }>
      >`SELECT rc."id", rc."parseState", rc."reviewDecision", rc."updatedAt",
                COALESCE(rc."duplicateSignal"::text, rc."extractedPayload"->>'duplicateSignal') AS "duplicateSignal",
            EXISTS (
              SELECT 1
              FROM "Load" l
              WHERE l."rateConfirmationId" = rc."id"
                AND l."deletedAt" IS NULL
            ) AS "hasLoad",
            (
              SELECT l2."id"
              FROM "Load" l2
              WHERE l2."rateConfirmationId" = rc."id"
                AND l2."deletedAt" IS NULL
              LIMIT 1
            ) AS "loadId"
        FROM "RateConfirmation" rc
        WHERE rc."regionId" = ${input.regionId}
          AND rc."deletedAt" IS NULL
          AND rc."createdAt" >= ${dayStart}
          AND rc."createdAt" < ${dayEnd}
        ORDER BY rc."updatedAt" DESC`,
      tx.$queryRaw<
        Array<{ id: string; parseState: string; reviewDecision: string; updatedAt: Date; hasLoad: boolean; loadId: string | null; duplicateSignal: string | null }>
      >`SELECT rc."id", rc."parseState", rc."reviewDecision", rc."updatedAt",
                COALESCE(rc."duplicateSignal"::text, rc."extractedPayload"->>'duplicateSignal') AS "duplicateSignal",
            EXISTS (
              SELECT 1
              FROM "Load" l
              WHERE l."rateConfirmationId" = rc."id"
                AND l."deletedAt" IS NULL
            ) AS "hasLoad",
            (
              SELECT l2."id"
              FROM "Load" l2
              WHERE l2."rateConfirmationId" = rc."id"
                AND l2."deletedAt" IS NULL
              LIMIT 1
            ) AS "loadId"
        FROM "RateConfirmation" rc
        WHERE rc."regionId" = ${input.regionId}
          AND rc."deletedAt" IS NULL
          AND rc."updatedAt" >= ${recentWindowStart}
        ORDER BY rc."updatedAt" DESC
        LIMIT 20`
    ]);

    const pendingStates = new Set(["UPLOADED", "QUEUED"]);
    const readyStates = new Set(["EXTRACTED"]);

    return {
      pending: rows
        .filter((row) => pendingStates.has(row.parseState) && row.reviewDecision !== "REJECTED" && !row.hasLoad)
        .map((row) => ({
        id: row.id,
        parseState: row.parseState,
        reviewDecision: row.reviewDecision,
        duplicateSignal: row.duplicateSignal
      })),
      ready: rows
        .filter((row) => readyStates.has(row.parseState) && row.reviewDecision === "PENDING" && !row.hasLoad)
        .map((row) => ({
        id: row.id,
        parseState: row.parseState,
        reviewDecision: row.reviewDecision,
        duplicateSignal: row.duplicateSignal
      })),
      recent: recentRows.map((row) => ({
        id: row.id,
        parseState: row.parseState,
        reviewDecision: row.reviewDecision,
        duplicateSignal: row.duplicateSignal,
        hasLoad: row.hasLoad,
        loadId: row.loadId,
        updatedAt: row.updatedAt.toISOString()
      }))
    };
  });
}
