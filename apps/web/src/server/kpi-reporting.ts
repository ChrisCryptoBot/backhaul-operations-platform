import type { KpiDashboardResponse } from "@/lib/ui/kpi-mappers";

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

export function buildKpiCsvReport(payload: KpiDashboardResponse): string {
  const header = ["lane", "target", "loads", "revenue", "vsTarget", "emptyPct", "fsc", "revLoad", "status"];
  const rows = payload.lanes.map((lane) =>
    [
      lane.lane,
      String(lane.target ?? ""),
      String(lane.loads),
      String(lane.revenue ?? ""),
      String(lane.vsTarget ?? ""),
      String(lane.emptyPct ?? ""),
      String(lane.fsc ?? ""),
      String(lane.revLoad ?? ""),
      lane.status
    ]
      .map(csvEscape)
      .join(",")
  );
  return [header.join(","), ...rows].join("\n");
}

export function buildKpiPdfLikeReport(payload: KpiDashboardResponse): string {
  const cardLines = payload.cards.map((card) => `- ${card.label}: ${card.value}`).join("\n");
  const notes = payload.managementNotes.map((note) => `- ${note}`).join("\n");
  return [
    "DROP BUCKET KPI MANAGEMENT REPORT",
    `Week: ${payload.weekIso}`,
    `Compared to: ${payload.comparisonWeekIso ?? "N/A"}`,
    "",
    "KPI Summary",
    cardLines,
    "",
    "Notes",
    notes
  ].join("\n");
}

export function buildKpiEmailSummary(payload: KpiDashboardResponse): { subject: string; body: string } {
  const subject = `KPI Summary ${payload.weekIso}`;
  const body = [
    `Week ${payload.weekIso} compared to ${payload.comparisonWeekIso ?? "N/A"}.`,
    `Top KPI cards:`,
    ...payload.cards.slice(0, 4).map((card) => `• ${card.label}: ${card.value}`),
    "",
    "Operational notes:",
    ...payload.managementNotes.map((note) => `• ${note}`)
  ].join("\n");
  return { subject, body };
}
