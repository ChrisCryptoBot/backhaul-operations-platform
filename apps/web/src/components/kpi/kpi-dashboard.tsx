"use client";

import React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type { ViewKpiDashboard } from "@/lib/ui/kpi-mappers";
import { mapKpiDashboardToView } from "@/lib/ui/kpi-mappers";
import { kpiDashboardSchema } from "@/contracts/kpi";
import { int, money } from "@/lib/ui/formatters";
import type { TrendSeriesPoint } from "@/components/kpi/trend-chart";
import { buildTrendSeries } from "@/components/kpi/trend-chart";
import { TopbarSignOutButton } from "@/components/auth/sign-out-button";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { useTheme, AccentToggle } from "@/components/shell/theme";
import { CopilotPanel } from "@/components/copilot/copilot-panel";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CalendarIcon,
  ChevronDownIcon,
  DashIcon,
  MoonIcon,
  SunIcon
} from "@/components/icons";

type TabId = "Lanes" | "Trend" | "Management Report" | "Reference Rules";

interface KpiDashboardProps {
  initialData: unknown;
  viewerIsAdmin?: boolean;
  viewerCanManageReference?: boolean;
}

function normalizeDashboardPayload(data: unknown) {
  const base = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const activeRegionIdCandidate =
    typeof base.activeRegionId === "string" && base.activeRegionId.length > 0
      ? base.activeRegionId
      : "unknown-region";
  return {
    contractVersion: base.contractVersion ?? "v1",
    weekIso: typeof base.weekIso === "string" ? base.weekIso : "2026-W01",
    comparisonWeekIso: typeof base.comparisonWeekIso === "string" ? base.comparisonWeekIso : null,
    comparisonMode:
      base.comparisonMode === "wow" || base.comparisonMode === "rolling4" || base.comparisonMode === "qtd"
        ? base.comparisonMode
        : "wow",
    cards: Array.isArray(base.cards) ? base.cards : [],
    lanes: Array.isArray(base.lanes) ? base.lanes : [],
    trend: Array.isArray(base.trend) ? base.trend : [],
    chartCatalog:
      typeof base.chartCatalog === "object" && base.chartCatalog !== null
        ? base.chartCatalog
        : {
            weeklyRevenueTrend: [],
            emptyMilePctTrend: [],
            mileMaxRpmTrend: [],
            deadheadMixTrend: [],
            revenueSplitTrend: [],
            tonuEventsTrend: []
          },
    laneDrilldowns: Array.isArray(base.laneDrilldowns) ? base.laneDrilldowns : [],
    availableFilters:
      typeof base.availableFilters === "object" && base.availableFilters !== null
        ? base.availableFilters
        : { lanes: [], brokers: [], lots: [], severities: ["INFO", "WARN", "ACTION_REQUIRED"] },
    activeFilters: typeof base.activeFilters === "object" && base.activeFilters !== null ? base.activeFilters : {},
    alerts: Array.isArray(base.alerts) ? base.alerts : [],
    comparisonInsights: Array.isArray(base.comparisonInsights) ? base.comparisonInsights : [],
    reportMeta:
      typeof base.reportMeta === "object" && base.reportMeta !== null
        ? base.reportMeta
        : { generatedAtIso: new Date().toISOString(), regionId: activeRegionIdCandidate },
    activeRegionId: activeRegionIdCandidate,
    mileMaxMissingInbound: typeof base.mileMaxMissingInbound === "boolean" ? base.mileMaxMissingInbound : true,
    managementNotes: Array.isArray(base.managementNotes) ? base.managementNotes : [],
    rules: Array.isArray(base.rules) ? base.rules : []
  };
}

function toDashboard(data: unknown): ViewKpiDashboard {
  const parsed = kpiDashboardSchema.safeParse(data);
  if (parsed.success) {
    return mapKpiDashboardToView(parsed.data);
  }
  return mapKpiDashboardToView(kpiDashboardSchema.parse(normalizeDashboardPayload(data)));
}

function laneStatusPresentation(status: string): { label: string; cls: string } {
  if (status === "ON_TARGET") {
    return { label: "✓ ON TARGET", cls: "ok" };
  }
  if (status === "BELOW_NEAR") {
    return { label: "⚠ BELOW (<$100)", cls: "near" };
  }
  if (status === "BELOW") {
    return { label: "⚠ BELOW", cls: "below" };
  }
  return { label: "— NO LOADS", cls: "none" };
}

function parseWeekIso(weekIso: string | null | undefined): { week: number; monday: Date; sunday: Date } | null {
  if (!weekIso) {
    return null;
  }
  const match = /^(\d{4})-W(\d{2})$/i.exec(weekIso);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { week, monday, sunday };
}

function formatWeekRangeCompact(weekIso: string | null | undefined): string {
  const parsed = parseWeekIso(weekIso);
  if (!parsed) {
    return weekIso ?? "N/A";
  }
  const { week, monday, sunday } = parsed;
  const mmdd = (d: Date) =>
    d.toLocaleDateString("en-US", {
      month: "2-digit",
      day: "2-digit",
      timeZone: "UTC"
    });
  return `W${week.toString().padStart(2, "0")} · ${mmdd(monday)} — ${mmdd(sunday)}`;
}

function formatWeekRangeLong(weekIso: string | null | undefined): string {
  const parsed = parseWeekIso(weekIso);
  if (!parsed) {
    return weekIso ?? "N/A";
  }
  const { week, monday, sunday } = parsed;
  const monthLong = (d: Date) => d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const day = (d: Date) => d.toLocaleString("en-US", { day: "numeric", timeZone: "UTC" });
  const year = monday.toLocaleString("en-US", { year: "numeric", timeZone: "UTC" });
  return `Week ${week} · ${monthLong(monday)} ${day(monday)} — ${monthLong(sunday)} ${day(sunday)}, ${year}`;
}

function formatWeekOfRange(weekIso: string | null | undefined): string {
  const parsed = parseWeekIso(weekIso);
  if (!parsed) {
    return weekIso ?? "N/A";
  }
  const mmdd = (d: Date) =>
    d.toLocaleDateString("en-US", {
      month: "2-digit",
      day: "2-digit",
      timeZone: "UTC"
    });
  return `Week of ${mmdd(parsed.monday)} — ${mmdd(parsed.sunday)}`;
}

function weekIsoFromUtcDate(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${weekNo.toString().padStart(2, "0")}`;
}

function getWeeksInMonth(year: number, month: number): string[] {
  const weeks = new Set<string>();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  for (let d = 1; d <= lastDay; d++) {
    weeks.add(weekIsoFromUtcDate(new Date(Date.UTC(year, month, d))));
  }
  return Array.from(weeks).sort();
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function formattedCardValue(key: string, value: string | number): string {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    return String(value);
  }
  if (key === "revenue" || key === "fsc") {
    return money(num, { decimals: 0 });
  }
  if (key === "nby") {
    return `$${num.toFixed(2)}`;
  }
  if (key === "emptyPct") {
    return `${num.toFixed(1)}%`;
  }
  if (key === "tender") {
    return `${num.toFixed(1)}%`;
  }
  return int(num);
}

function Delta({
  value,
  label,
  inverted,
  noPrior
}: {
  value: number | null;
  label: string;
  inverted: boolean;
  noPrior: boolean;
}) {
  if (noPrior || value === null) {
    return (
      <span className="db-delta neutral">
        <DashIcon size={10} />
        {label}
      </span>
    );
  }
  const improved = value === 0 ? null : inverted ? value < 0 : value > 0;
  const cls = improved === null ? "neutral" : improved ? "up" : "down";
  const IconComp = improved === null ? DashIcon : improved ? ArrowUpIcon : ArrowDownIcon;
  return (
    <span className={`db-delta ${cls}`}>
      <IconComp size={10} />
      {label}
    </span>
  );
}

function TrendPopup({ point }: { point: TrendSeriesPoint }) {
  return (
    <div className="db-trend-popup" role="status" aria-live="polite">
      <div className="db-trend-popup-week mono">{point.weekLabel}</div>
      <div className="db-trend-popup-metrics">
        <span>Loads: <strong className="mono">{int(point.loads)}</strong></span>
        <span>Revenue: <strong className="mono">{money(point.rev, { decimals: 0 })}</strong></span>
        <span>Empty %: <strong className="mono">{point.empty.toFixed(1)}%</strong></span>
      </div>
    </div>
  );
}

// Theme-aware via CSS variables so the tooltip reads correctly in dark mode.
const chartTooltipContentStyle: React.CSSProperties = {
  background: "var(--db-bg-rail)",
  border: "1px solid var(--db-border)",
  borderRadius: 6,
  color: "var(--db-fg)"
};

const chartTooltipLabelStyle: React.CSSProperties = {
  color: "var(--db-fg)",
  fontWeight: 700
};

const chartTooltipItemStyle: React.CSSProperties = {
  color: "var(--db-fg-mid)"
};

export function KpiDashboard({ initialData, viewerIsAdmin = false, viewerCanManageReference = false }: KpiDashboardProps) {
  const [tab, setTab] = React.useState<TabId>("Lanes");
  const [expandedLane, setExpandedLane] = React.useState<string | null>(null);
  const [emailStatus, setEmailStatus] = React.useState<string | null>(null);
  const [isSendingEmail, setIsSendingEmail] = React.useState(false);
  const [ackPendingId, setAckPendingId] = React.useState<string | null>(null);
  const [ackStatus, setAckStatus] = React.useState<string | null>(null);
  const [ackError, setAckError] = React.useState<string | null>(null);
  const { theme: themeMode, toggleTheme: toggleThemeMode } = useTheme();
  const tabsBodyRef = React.useRef<HTMLDivElement | null>(null);
  const tabRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const data = toDashboard(initialData);
  const [activeTrendPointId, setActiveTrendPointId] = React.useState<string | null>(null);
  const [isTrendPointPinned, setIsTrendPointPinned] = React.useState(false);

  // Week picker state
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const pickerRef = React.useRef<HTMLDivElement | null>(null);
  const [pickerYear, setPickerYear] = React.useState(() => {
    const parsed = parseWeekIso(data.weekIso);
    return parsed?.monday.getUTCFullYear() ?? new Date().getUTCFullYear();
  });
  const [pickerMonth, setPickerMonth] = React.useState(() => {
    const parsed = parseWeekIso(data.weekIso);
    return parsed?.monday.getUTCMonth() ?? new Date().getUTCMonth();
  });
  const [pickerYearInput, setPickerYearInput] = React.useState(() => String(new Date().getUTCFullYear()));
  const currentYear = new Date().getUTCFullYear();
  const minYear = currentYear - 3;
  const maxYear = currentYear + 1;

  // Inbound (IB) entry panel state. FSC parked (spot-broker-first) — FSC inputs/source removed;
  // panel state kept under the fsc* names to ease a future FSC re-add.
  const [fscPanelOpen, setFscPanelOpen] = React.useState(false);
  const [fscReason, setFscReason] = React.useState("");
  const [ibRevenue, setIbRevenue] = React.useState("");
  const [ibMiles, setIbMiles] = React.useState("");
  const [entrySubmitting, setEntrySubmitting] = React.useState(false);
  const [entryStatus, setEntryStatus] = React.useState<string | null>(null);
  const [entryError, setEntryError] = React.useState<string | null>(null);

  // New rule dialog state
  const [newRuleOpen, setNewRuleOpen] = React.useState(false);
  const [newRuleCode, setNewRuleCode] = React.useState("");
  const [newRuleTitle, setNewRuleTitle] = React.useState("");
  const [newRuleSeverity, setNewRuleSeverity] = React.useState<"INFO" | "WARN" | "ACTION_REQUIRED">("WARN");
  const [newRuleStatement, setNewRuleStatement] = React.useState("");
  const [newRuleAppliesTo, setNewRuleAppliesTo] = React.useState("Region");
  const [newRuleSubmitting, setNewRuleSubmitting] = React.useState(false);
  const [newRuleError, setNewRuleError] = React.useState<string | null>(null);

  // Lane note editing state
  const [editingLaneNote, setEditingLaneNote] = React.useState<string | null>(null);
  const [laneNoteValue, setLaneNoteValue] = React.useState("");
  const [laneNoteSavingLane, setLaneNoteSavingLane] = React.useState<string | null>(null);
  const [laneNoteError, setLaneNoteError] = React.useState<string | null>(null);
  const [editingLaneTarget, setEditingLaneTarget] = React.useState<string | null>(null);
  const [laneTargetValue, setLaneTargetValue] = React.useState("");
  const [laneTargetSavingLane, setLaneTargetSavingLane] = React.useState<string | null>(null);
  const [laneTargetError, setLaneTargetError] = React.useState<string | null>(null);

  const tabIds = React.useMemo<TabId[]>(() => ["Lanes", "Trend", "Management Report", "Reference Rules"], []);
  const tabButtonId = React.useCallback((id: TabId) => `kpi-tab-${id.toLowerCase().replace(/\s+/g, "-")}`, []);
  const tabPanelId = React.useCallback((id: TabId) => `kpi-tabpanel-${id.toLowerCase().replace(/\s+/g, "-")}`, []);

  // MileMax is removed from the UI (server compute kept dormant); NBY is the only $/mi metric.
  const topCards = data.cards.filter((card) => card.key !== "mileMaxRpm").slice(0, 8);
  const trendWindow = Math.max(4, Math.min(52, data.activeFilters.weeks ?? 12));
  const trendSeries = React.useMemo(() => buildTrendSeries(data.trend), [data.trend]);
  const visibleTrendSeries = React.useMemo(() => trendSeries.slice(-trendWindow), [trendSeries, trendWindow]);
  const chartWidth = Math.max(760, visibleTrendSeries.length * 110);
  const trendRows = React.useMemo(() => [...visibleTrendSeries].reverse(), [visibleTrendSeries]);
  const activeTrendPoint = React.useMemo(
    () => visibleTrendSeries.find((point) => point.id === activeTrendPointId) ?? null,
    [activeTrendPointId, visibleTrendSeries]
  );
  const weekRange = formatWeekRangeLong(data.weekIso);
  const weekOfRange = formatWeekOfRange(data.weekIso);
  const weekRangeCompact = formatWeekRangeCompact(data.weekIso);
  const comparisonRange = formatWeekRangeCompact(data.comparisonWeekIso);
  const managementNotes =
    data.managementNotes.length > 0
      ? data.managementNotes
      : [
          "Weekly management summary generated from current lane and snapshot metrics.",
          "Detailed narrative can be replaced by coordinator-authored notes."
        ];
  const alerts = data.alerts ?? [];
  const openAlerts = alerts.filter((alert) => !alert.acknowledgedAt);
  const activeRegion = data.regions.find((region) => region.id === data.activeRegionId);
  const activeRegionCode = activeRegion?.code ?? "NORTHEAST";
  const activeRegionLabel = activeRegion?.name ?? activeRegionCode;

  const pickerWeeks = React.useMemo(() => getWeeksInMonth(pickerYear, pickerMonth), [pickerYear, pickerMonth]);
  const refreshedAt = data.reportMeta?.generatedAtIso
    ? new Date(data.reportMeta.generatedAtIso).toLocaleDateString("en-US", {
        month: "2-digit",
        day: "2-digit"
      })
    : "--";

  const updateQuery = React.useCallback(
    (patch: Record<string, string | undefined>) => {
      const params = new URLSearchParams(searchParams.toString());
      Object.entries(patch).forEach(([key, value]) => {
        if (!value) params.delete(key);
        else params.set(key, value);
      });
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname);
    },
    [pathname, router, searchParams]
  );

  const triggerExport = React.useCallback(
    (kind: "csv" | "pdf") => {
      const params = new URLSearchParams({
        weekIso: data.weekIso
      });
      if (data.activeRegionId) {
        params.set("regionId", data.activeRegionId);
      }
      if (data.comparisonMode) {
        params.set("comparisonMode", data.comparisonMode);
      }
      if (data.activeFilters.weeks) {
        params.set("weeks", String(data.activeFilters.weeks));
      }
      if (data.activeFilters.lane) {
        params.set("lane", data.activeFilters.lane);
      }
      if (data.activeFilters.broker) {
        params.set("broker", data.activeFilters.broker);
      }
      if (data.activeFilters.lot) {
        params.set("lot", data.activeFilters.lot);
      }
      if (data.activeFilters.severity) {
        params.set("severity", data.activeFilters.severity);
      }
      window.open(`/api/kpi/export/${kind}?${params.toString()}`, "_blank");
    },
    [data.activeFilters.broker, data.activeFilters.lane, data.activeFilters.lot, data.activeFilters.severity, data.activeFilters.weeks, data.activeRegionId, data.comparisonMode, data.weekIso]
  );

  const sendEmailSummary = React.useCallback(async () => {
    setIsSendingEmail(true);
    setEmailStatus("Sending...");
    try {
      const response = await fetch("/api/kpi/export/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          weekIso: data.weekIso,
          regionId: data.activeRegionId,
          comparisonMode: data.comparisonMode,
          weeks: data.activeFilters.weeks,
          lane: data.activeFilters.lane,
          broker: data.activeFilters.broker,
          lot: data.activeFilters.lot,
          severity: data.activeFilters.severity,
          recipients: ["manager@dropbucket.local"]
        })
      });
      if (response.ok) {
        setEmailStatus("Queued summary email.");
        return;
      }
      setEmailStatus("Failed to queue email.");
    } catch {
      setEmailStatus("Unable to send summary email. Please try again.");
    } finally {
      setIsSendingEmail(false);
    }
  }, [data.activeFilters.broker, data.activeFilters.lane, data.activeFilters.lot, data.activeFilters.severity, data.activeFilters.weeks, data.activeRegionId, data.comparisonMode, data.weekIso]);

  const acknowledgeAlert = React.useCallback(
    async (alertId: string) => {
      setAckPendingId(alertId);
      setAckStatus(null);
      setAckError(null);
      try {
        const response = await fetch("/api/kpi/alerts/ack", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            alertId,
            regionId: data.activeRegionId,
            reason: "Reviewed in dashboard"
          })
        });
        if (!response.ok) {
          throw new Error("ack-failed");
        }
        setAckStatus("Alert acknowledged.");
        router.refresh();
      } catch {
        setAckError("Unable to acknowledge alert right now.");
      } finally {
        setAckPendingId(null);
      }
    },
    [data.activeRegionId, router]
  );

  const submitFscEntry = React.useCallback(async () => {
    setEntrySubmitting(true);
    setEntryStatus(null);
    setEntryError(null);
    try {
      const hasIb = ibRevenue.trim().length > 0 || ibMiles.trim().length > 0;
      if (!hasIb) {
        setEntryError("Enter IB revenue or loaded miles.");
        return;
      }
      if (fscReason.trim().length < 10) {
        setEntryError("Reason must be at least 10 characters.");
        return;
      }
      const results: string[] = [];
      if (hasIb) {
        const ibRes = await fetch("/api/kpi/inbound", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            regionId: data.activeRegionId,
            weekIso: data.weekIso,
            inboundRevenue: ibRevenue.trim() || "0",
            inboundLoadedMiles: ibMiles.trim() || "0",
            reason: fscReason.trim()
          })
        });
        if (!ibRes.ok) {
          const p = (await ibRes.json().catch(() => null)) as { error?: string } | null;
          throw new Error(p?.error ?? "IB save failed.");
        }
        results.push("IB data saved");
      }
      setEntryStatus(`${results.join(" & ")}. Reloading...`);
      setTimeout(() => router.refresh(), 800);
    } catch (error) {
      setEntryError(error instanceof Error ? error.message : "Save failed.");
    } finally {
      setEntrySubmitting(false);
    }
  }, [data.activeRegionId, data.weekIso, fscReason, ibRevenue, ibMiles, router]);

  const submitNewRule = React.useCallback(async () => {
    setNewRuleSubmitting(true);
    setNewRuleError(null);
    try {
      if (!newRuleCode.trim() || !newRuleTitle.trim() || !newRuleStatement.trim()) {
        setNewRuleError("Code, title, and statement are required.");
        return;
      }
      const res = await fetch("/api/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          regionId: data.activeRegionId,
          code: newRuleCode.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
          title: newRuleTitle.trim(),
          severity: newRuleSeverity,
          statement: newRuleStatement.trim(),
          appliesTo: newRuleAppliesTo.trim() || "Region"
        })
      });
      if (!res.ok) {
        const p = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(p?.error ?? "Rule save failed.");
      }
      setNewRuleOpen(false);
      setNewRuleCode("");
      setNewRuleTitle("");
      setNewRuleStatement("");
      setNewRuleAppliesTo("Region");
      router.refresh();
    } catch (error) {
      setNewRuleError(error instanceof Error ? error.message : "Save failed.");
    } finally {
      setNewRuleSubmitting(false);
    }
  }, [data.activeRegionId, newRuleCode, newRuleTitle, newRuleSeverity, newRuleStatement, newRuleAppliesTo, router]);

  const saveLaneNote = React.useCallback(async (lane: string, note: string) => {
    setLaneNoteSavingLane(lane);
    setLaneNoteError(null);
    try {
      const response = await fetch("/api/kpi/lane-note", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          regionId: data.activeRegionId,
          weekIso: data.weekIso,
          lane,
          note
        })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Lane note save failed.");
      }
      setEditingLaneNote(null);
      router.refresh();
    } catch (error) {
      setLaneNoteError(error instanceof Error ? error.message : "Lane note save failed.");
    } finally {
      setLaneNoteSavingLane(null);
    }
  }, [data.activeRegionId, data.weekIso, router]);

  const saveLaneTarget = React.useCallback(async (lane: string, targetRate: string) => {
    setLaneTargetSavingLane(lane);
    setLaneTargetError(null);
    try {
      const response = await fetch("/api/kpi/lane-target", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          regionId: data.activeRegionId,
          weekIso: data.weekIso,
          lane,
          targetRate
        })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Lane target save failed.");
      }
      setEditingLaneTarget(null);
      router.refresh();
    } catch (error) {
      setLaneTargetError(error instanceof Error ? error.message : "Lane target save failed.");
    } finally {
      setLaneTargetSavingLane(null);
    }
  }, [data.activeRegionId, data.weekIso, router]);

  React.useEffect(() => {
    const tabsBody = tabsBodyRef.current;
    if (!tabsBody) return;
    if (typeof tabsBody.scrollTo === "function") {
      tabsBody.scrollTo({ top: 0, behavior: "auto" });
      return;
    }
    tabsBody.scrollTop = 0;
  }, [tab]);

  const handleTabKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      const maxIndex = tabIds.length - 1;
      let nextIndex: number | null = null;
      if (event.key === "ArrowRight") nextIndex = index === maxIndex ? 0 : index + 1;
      if (event.key === "ArrowLeft") nextIndex = index === 0 ? maxIndex : index - 1;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = maxIndex;
      if (nextIndex === null) return;
      event.preventDefault();
      const nextTab = tabIds[nextIndex];
      setTab(nextTab);
      tabRefs.current[nextIndex]?.focus();
    },
    [tabIds]
  );

  // Close picker on outside click
  React.useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [pickerOpen]);

  // Close picker on Escape
  React.useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [pickerOpen]);

  React.useEffect(() => {
    if (visibleTrendSeries.length === 0) {
      setActiveTrendPointId(null);
      setIsTrendPointPinned(false);
      return;
    }
    setActiveTrendPointId((previous) =>
      previous && visibleTrendSeries.some((point) => point.id === previous) ? previous : visibleTrendSeries[visibleTrendSeries.length - 1].id
    );
  }, [visibleTrendSeries]);

  const renderInteractiveDot = React.useCallback(
    (dot: any) => {
      const payload = dot.payload as TrendSeriesPoint | undefined;
      if (!payload || typeof dot.cx !== "number" || typeof dot.cy !== "number") {
        return null;
      }
      const isActive = activeTrendPointId === payload.id;
      return (
        <circle
          cx={dot.cx}
          cy={dot.cy}
          r={isActive ? 5 : 4}
          fill={dot.fill ?? dot.stroke ?? "currentColor"}
          stroke={isActive ? "var(--db-bg-rail)" : dot.stroke ?? "transparent"}
          strokeWidth={isActive ? 2 : 1.5}
          data-testid={`trend-point-${payload.weekLabel}`}
          tabIndex={0}
          role="button"
          aria-label={`${payload.weekLabel}: ${int(payload.loads)} loads, ${money(payload.rev, { decimals: 0 })} revenue, ${payload.empty.toFixed(1)}% empty`}
          onFocus={() => {
            setActiveTrendPointId(payload.id);
            setIsTrendPointPinned(true);
          }}
          onBlur={() => {
            setIsTrendPointPinned(false);
          }}
          onMouseEnter={() => {
            if (!isTrendPointPinned) {
              setActiveTrendPointId(payload.id);
            }
          }}
          onClick={() => {
            setActiveTrendPointId(payload.id);
            setIsTrendPointPinned(true);
          }}
        />
      );
    },
    [activeTrendPointId, isTrendPointPinned]
  );

  const prevMonth = () => {
    if (pickerMonth === 0) { setPickerMonth(11); setPickerYear((y) => y - 1); }
    else setPickerMonth((m) => m - 1);
  };
  const nextMonth = () => {
    if (pickerMonth === 11) { setPickerMonth(0); setPickerYear((y) => y + 1); }
    else setPickerMonth((m) => m + 1);
  };

  return (
    <div className="db-root db-app" data-theme={themeMode}>
      <AppSidebar
        viewerIsAdmin={viewerIsAdmin}
        viewerCanManageReference={viewerCanManageReference}
        regionCode={activeRegionCode}
        regionLabel={activeRegionLabel}
      />
      <div className="db-shell">
      <header className="db-header">
        <div className="db-h-context">
          <span className="db-h-title">KPI Dashboard</span>
        </div>
        <div className="db-h-spacer" />
        <div className="db-topbar-right">
          {/* Week picker */}
          <div style={{ position: "relative" }} ref={pickerRef}>
            <button
              type="button"
              className="db-datepicker"
              onClick={() => setPickerOpen((o) => !o)}
              aria-label="Select reporting week"
              aria-expanded={pickerOpen}
              aria-haspopup="listbox"
            >
              <CalendarIcon size={14} />
              <span className="mono">{weekRangeCompact}</span>
              <ChevronDownIcon size={12} />
            </button>
            {pickerOpen && (
              <div
                className="db-week-picker"
                role="dialog"
                aria-label="Week picker"
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  right: 0,
                  zIndex: 50,
                  minWidth: 280,
                  background: "var(--db-bg-card)",
                  border: "1px solid var(--db-border-soft)",
                  borderRadius: 6,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
                  padding: "8px 0"
                }}
              >
                {/* Month/Year navigation */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 12px 8px" }}>
                  <button
                    type="button"
                    className="db-btn db-btn-mini db-btn-ghost"
                    onClick={prevMonth}
                    disabled={pickerYear <= minYear && pickerMonth === 0}
                    aria-label="Previous month"
                  >
                    ‹
                  </button>
                  <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>
                    {MONTH_NAMES[pickerMonth]}{" "}
                    <input
                      type="number"
                      value={pickerYearInput}
                      min={minYear}
                      max={maxYear}
                      onChange={(e) => {
                        setPickerYearInput(e.target.value);
                        const y = Number(e.target.value);
                        if (y >= minYear && y <= maxYear) setPickerYear(y);
                      }}
                      style={{
                        width: 52,
                        background: "transparent",
                        border: "none",
                        borderBottom: "1px solid var(--db-border-soft)",
                        color: "inherit",
                        fontFamily: "inherit",
                        fontSize: "inherit",
                        fontWeight: "inherit",
                        textAlign: "center",
                        outline: "none"
                      }}
                      aria-label="Year"
                    />
                  </span>
                  <button
                    type="button"
                    className="db-btn db-btn-mini db-btn-ghost"
                    onClick={nextMonth}
                    disabled={pickerYear >= maxYear && pickerMonth === 11}
                    aria-label="Next month"
                  >
                    ›
                  </button>
                </div>
                {/* Week list */}
                <div role="listbox" aria-label="Weeks">
                  {pickerWeeks.map((iso) => {
                    const compact = formatWeekRangeCompact(iso);
                    const isSelected = iso === data.weekIso;
                    const isCurrentWeek = iso === weekIsoFromUtcDate(new Date());
                    return (
                      <button
                        key={iso}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        className={`db-week-picker-row${isSelected ? " selected" : ""}${isCurrentWeek ? " current-week" : ""}`}
                        style={{
                          display: "block",
                          width: "100%",
                          textAlign: "left",
                          padding: "6px 16px",
                          background: isSelected ? "var(--db-accent)" : "transparent",
                          color: isSelected ? "var(--db-accent-on)" : "inherit",
                          border: "none",
                          cursor: "pointer",
                          fontFamily: "var(--db-font-mono)",
                          fontSize: 12,
                          fontWeight: isCurrentWeek ? 700 : 400
                        }}
                        onClick={() => {
                          updateQuery({ weekIso: iso });
                          setPickerOpen(false);
                        }}
                      >
                        {compact}{isCurrentWeek && !isSelected ? " ←" : ""}
                      </button>
                    );
                  })}
                </div>
                <div style={{ padding: "8px 12px 4px", borderTop: "1px solid var(--db-border-soft)" }}>
                  <button
                    type="button"
                    className="db-btn db-btn-mini"
                    onClick={() => {
                      const iso = weekIsoFromUtcDate(new Date());
                      updateQuery({ weekIso: iso });
                      setPickerOpen(false);
                    }}
                    style={{ width: "100%" }}
                  >
                    Go to current week
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Inbound (IB) entry button */}
          <button
            type="button"
            className="db-btn db-btn-ghost"
            onClick={() => { setFscPanelOpen(true); setEntryStatus(null); setEntryError(null); }}
            title="Enter inbound (IB) revenue / miles for this week"
          >
            IB Entry
          </button>

          <AccentToggle />
          <button
            type="button"
            className="db-iconbtn"
            onClick={toggleThemeMode}
            title={themeMode === "dark" ? "Light theme" : "Dark theme"}
            aria-label={`Switch to ${themeMode === "light" ? "dark" : "light"} mode`}
          >
            {themeMode === "dark" ? <SunIcon size={16} /> : <MoonIcon size={16} />}
          </button>
          <TopbarSignOutButton />
        </div>
      </header>

      {/* Inbound (IB) Entry Panel */}
      {fscPanelOpen && (
        <div
          className="db-overlay"
          onClick={() => setFscPanelOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", zIndex: 100 }}
        />
      )}
      <aside
        style={{
          position: "fixed",
          top: 0,
          right: fscPanelOpen ? 0 : "-420px",
          width: 400,
          height: "100%",
          background: "var(--db-bg-card)",
          borderLeft: "1px solid var(--db-border-soft)",
          boxShadow: "-4px 0 16px rgba(0,0,0,0.12)",
          zIndex: 101,
          transition: "right 0.2s ease",
          overflowY: "auto",
          padding: "24px 20px"
        }}
        aria-label="Inbound (IB) data entry"
        aria-hidden={!fscPanelOpen}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Inbound (IB) Entry · <span className="mono">{weekRangeCompact}</span></h3>
          <button
            type="button"
            className="db-btn db-btn-mini db-btn-ghost"
            onClick={() => setFscPanelOpen(false)}
            aria-label="Close panel"
          >
            ✕
          </button>
        </div>

        <div className="db-mgmt-notes" style={{ marginBottom: 16 }}>
          <div className="db-mgmt-notes-h">Inbound Revenue / Miles</div>
          <p className="dim" style={{ fontSize: 11, margin: "0 0 8px" }}>
            Records this week&apos;s inbound revenue and loaded miles for regional totals.
          </p>
          <label style={{ display: "block", marginBottom: 8, fontSize: 12 }}>
            <span className="dim">IB Revenue ($)</span>
            <input
              type="text"
              className="db-datepicker"
              style={{ display: "block", width: "100%", marginTop: 4 }}
              placeholder="e.g. 12500.00"
              value={ibRevenue}
              onChange={(e) => setIbRevenue(e.target.value)}
            />
          </label>
          <label style={{ display: "block", marginBottom: 8, fontSize: 12 }}>
            <span className="dim">IB Loaded Miles</span>
            <input
              type="text"
              className="db-datepicker"
              style={{ display: "block", width: "100%", marginTop: 4 }}
              placeholder="e.g. 1800"
              value={ibMiles}
              onChange={(e) => setIbMiles(e.target.value)}
            />
          </label>
        </div>

        <label style={{ display: "block", marginBottom: 12, fontSize: 12 }}>
          <span className="dim">Reason (min 10 chars, required)</span>
          <textarea
            className="db-datepicker"
            style={{ display: "block", width: "100%", marginTop: 4, minHeight: 60, resize: "vertical" }}
            placeholder="Reason for inbound (IB) data entry..."
            value={fscReason}
            onChange={(e) => setFscReason(e.target.value)}
          />
        </label>

        {entryError && <div className="db-upload-error" role="alert" style={{ marginBottom: 8 }}>{entryError}</div>}
        {entryStatus && <div className="db-lanes-foot dim" role="status" style={{ marginBottom: 8 }}>{entryStatus}</div>}

        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="db-btn primary"
            onClick={submitFscEntry}
            disabled={entrySubmitting}
            aria-busy={entrySubmitting}
          >
            {entrySubmitting ? "Saving..." : "Save"}
          </button>
          <button type="button" className="db-btn db-btn-ghost" onClick={() => setFscPanelOpen(false)}>
            Cancel
          </button>
        </div>
      </aside>

      {/* New Rule Dialog */}
      {newRuleOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="New operational rule"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 200,
            display: "flex",
            alignItems: "center",
            justifyContent: "center"
          }}
        >
          <div
            style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.4)" }}
            onClick={() => setNewRuleOpen(false)}
          />
          <div
            style={{
              position: "relative",
              background: "var(--db-bg-card)",
              border: "1px solid var(--db-border-soft)",
              borderRadius: 8,
              padding: "24px",
              width: 480,
              maxWidth: "95vw",
              maxHeight: "90vh",
              overflowY: "auto",
              boxShadow: "0 12px 40px rgba(0,0,0,0.2)"
            }}
          >
            <h3 style={{ margin: "0 0 16px", fontSize: 14, fontWeight: 700 }}>New Operational Rule</h3>
            <label style={{ display: "block", marginBottom: 10, fontSize: 12 }}>
              <span className="dim">Code (UPPERCASE_WITH_UNDERSCORES)</span>
              <input
                type="text"
                className="db-datepicker"
                style={{ display: "block", width: "100%", marginTop: 4 }}
                placeholder="e.g. BUFFER_0900"
                value={newRuleCode}
                onChange={(e) => setNewRuleCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
              />
            </label>
            <label style={{ display: "block", marginBottom: 10, fontSize: 12 }}>
              <span className="dim">Title</span>
              <input
                type="text"
                className="db-datepicker"
                style={{ display: "block", width: "100%", marginTop: 4 }}
                placeholder="e.g. No live pickups before 09:00"
                value={newRuleTitle}
                onChange={(e) => setNewRuleTitle(e.target.value)}
              />
            </label>
            <label style={{ display: "block", marginBottom: 10, fontSize: 12 }}>
              <span className="dim">Severity</span>
              <select
                className="db-datepicker"
                style={{ display: "block", width: "100%", marginTop: 4 }}
                value={newRuleSeverity}
                onChange={(e) => setNewRuleSeverity(e.target.value as "INFO" | "WARN" | "ACTION_REQUIRED")}
              >
                <option value="INFO">INFO — context only</option>
                <option value="WARN">WARN — caution flag</option>
                <option value="ACTION_REQUIRED">ACTION REQUIRED — must resolve</option>
              </select>
            </label>
            <label style={{ display: "block", marginBottom: 10, fontSize: 12 }}>
              <span className="dim">Statement</span>
              <textarea
                className="db-datepicker"
                style={{ display: "block", width: "100%", marginTop: 4, minHeight: 80, resize: "vertical" }}
                placeholder="Describe the rule in plain language..."
                value={newRuleStatement}
                onChange={(e) => setNewRuleStatement(e.target.value)}
              />
            </label>
            <label style={{ display: "block", marginBottom: 16, fontSize: 12 }}>
              <span className="dim">Applies to (lot names, &quot;Region&quot;, or leave default)</span>
              <input
                type="text"
                className="db-datepicker"
                style={{ display: "block", width: "100%", marginTop: 4 }}
                value={newRuleAppliesTo}
                onChange={(e) => setNewRuleAppliesTo(e.target.value)}
              />
            </label>
            {newRuleError && <div className="db-upload-error" role="alert" style={{ marginBottom: 10 }}>{newRuleError}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="db-btn db-btn-ghost" onClick={() => setNewRuleOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="db-btn primary"
                onClick={submitNewRule}
                disabled={newRuleSubmitting}
                aria-busy={newRuleSubmitting}
              >
                {newRuleSubmitting ? "Saving..." : "Create rule"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="db-shell-scroll">
      <main className="db-dash-main">
        <div className="db-dash-head">
          <div>
            <div className="db-dash-eyebrow mono">WEEKLY KPI · {activeRegionCode}</div>
            <h1 className="db-dash-h">{weekRange}</h1>
          </div>
          <div className="db-dash-meta">
            {data.regions.length > 1 ? (
              <select
                className="db-datepicker"
                value={data.activeRegionId ?? ""}
                onChange={(event) => updateQuery({ regionId: event.target.value || undefined })}
                aria-label="Select region"
              >
                {data.regions.map((region) => (
                  <option key={region.id} value={region.id}>
                    {region.code}
                  </option>
                ))}
              </select>
            ) : null}
            <span className="dim">Compared to</span>
            <span className="mono">{comparisonRange}</span>
            <span className="db-dash-meta-pill mono">LIVE</span>
            <select
              className="db-datepicker"
              value={data.comparisonMode}
              onChange={(event) => updateQuery({ comparisonMode: event.target.value })}
              aria-label="Select comparison mode"
            >
              <option value="wow">WoW</option>
              <option value="rolling4">Rolling 4</option>
              <option value="qtd">QTD</option>
            </select>
            {openAlerts.length > 0 ? (
              <span className="db-delta down" aria-label={`${openAlerts.length} open alerts`}>
                {openAlerts.length} ALERTS
              </span>
            ) : null}
          </div>
        </div>

        <div className="db-trend-controls db-trend-controls-main">
          <select
            className="db-datepicker"
            value={data.activeFilters.lane ?? ""}
            onChange={(event) => updateQuery({ lane: event.target.value || undefined })}
            aria-label="Filter by lane"
          >
            <option value="">All lanes</option>
            {data.availableFilters.lanes.map((lane) => (
              <option key={lane} value={lane}>
                {lane}
              </option>
            ))}
          </select>
          <select
            className="db-datepicker"
            value={data.activeFilters.broker ?? ""}
            onChange={(event) => updateQuery({ broker: event.target.value || undefined })}
            aria-label="Filter by broker"
          >
            <option value="">All brokers</option>
            {data.availableFilters.brokers.map((broker) => (
              <option key={broker} value={broker}>
                {broker}
              </option>
            ))}
          </select>
          <select
            className="db-datepicker"
            value={data.activeFilters.lot ?? ""}
            onChange={(event) => updateQuery({ lot: event.target.value || undefined })}
            aria-label="Filter by lot"
          >
            <option value="">All lots</option>
            {data.availableFilters.lots.map((lot) => (
              <option key={lot} value={lot}>
                {lot}
              </option>
            ))}
          </select>
          <select
            className="db-datepicker"
            value={data.activeFilters.severity ?? ""}
            onChange={(event) => updateQuery({ severity: event.target.value || undefined })}
            aria-label="Filter by severity"
          >
            <option value="">All severities</option>
            <option value="INFO">Info</option>
            <option value="WARN">Warn</option>
            <option value="ACTION_REQUIRED">Action Required</option>
          </select>
          <button
            className="db-btn"
            type="button"
            onClick={() =>
              updateQuery({
                lane: undefined,
                broker: undefined,
                lot: undefined,
                severity: undefined,
                weeks: undefined
              })
            }
          >
            Reset filters
          </button>
        </div>

        <div className="db-kpi-grid">
          {topCards.map((card) => (
            <div key={card.key} className="db-kpi-card">
              <div className="db-kpi-label">{card.label}</div>
              <div className="db-kpi-value mono">
                {formattedCardValue(card.key, card.value)}
              </div>
              <div className="db-kpi-delta">
                <Delta value={card.delta} label={card.deltaLabel} inverted={card.inverted} noPrior={card.noPrior} />
              </div>
            </div>
          ))}
        </div>

        {/* Comparison Insights */}
        {data.comparisonInsights.length > 0 && (
          <details className="db-mgmt-notes" style={{ marginBottom: 12 }}>
            <summary className="db-mgmt-notes-h" style={{ cursor: "pointer" }}>
              Trend deltas ({data.comparisonMode.toUpperCase()})
            </summary>
            <table className="db-table compact" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th className="right">WoW Δ</th>
                  <th className="right">Rolling 4 Δ</th>
                  <th className="right">QTD Δ</th>
                </tr>
              </thead>
              <tbody>
                {data.comparisonInsights.map((row) => (
                  <tr key={row.key}>
                    <td className="dim">{row.key}</td>
                    <td className={`right mono num ${row.wowDelta !== null && row.wowDelta > 0 ? "pos" : row.wowDelta !== null && row.wowDelta < 0 ? "neg" : "dim"}`}>
                      {row.wowDelta !== null ? (row.wowDelta > 0 ? "+" : "") + row.wowDelta.toFixed(1) : "—"}
                    </td>
                    <td className={`right mono num ${row.rolling4Delta !== null && row.rolling4Delta > 0 ? "pos" : row.rolling4Delta !== null && row.rolling4Delta < 0 ? "neg" : "dim"}`}>
                      {row.rolling4Delta !== null ? (row.rolling4Delta > 0 ? "+" : "") + row.rolling4Delta.toFixed(1) : "—"}
                    </td>
                    <td className={`right mono num ${row.qtdDelta !== null && row.qtdDelta > 0 ? "pos" : row.qtdDelta !== null && row.qtdDelta < 0 ? "neg" : "dim"}`}>
                      {row.qtdDelta !== null ? (row.qtdDelta > 0 ? "+" : "") + row.qtdDelta.toFixed(1) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}

        <div className="db-tabs">
          <div className="db-tabs-bar" role="tablist" aria-label="KPI dashboard sections">
            {tabIds.map((id, index) => (
              <button
                key={id}
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                id={tabButtonId(id)}
                role="tab"
                aria-selected={tab === id}
                aria-controls={tabPanelId(id)}
                tabIndex={tab === id ? 0 : -1}
                className={`db-tab ${tab === id ? "active" : ""}`}
                onClick={() => setTab(id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                {id}
              </button>
            ))}
          </div>
          <div className="db-tabs-body" ref={tabsBodyRef}>
            <div
              id={tabPanelId("Lanes")}
              role="tabpanel"
              aria-labelledby={tabButtonId("Lanes")}
              hidden={tab !== "Lanes"}
              className={`db-tab-panel ${tab === "Lanes" ? "active" : ""}`}
            >
              <div className="db-lanes-tab">
                <div className="db-tab-headrow">
                  <h2 className="db-tab-h">Lane scorecard · {weekOfRange}</h2>
                  <div className="db-tab-meta dim">Default targets from DAT RateView · click Target to enter weekly coordinator overrides · last refreshed {refreshedAt}</div>
                </div>
                <div className="db-table-wrap">
                <table className="db-table compact lanes">
                  <thead>
                    <tr>
                      <th>Lane</th>
                      <th>Driver Type</th>
                      <th className="right">Target</th>
                      <th className="right">Loads</th>
                      <th className="right">Revenue</th>
                      <th className="right">NBY</th>
                      <th className="right">vs Target</th>
                      <th className="right">Empty %</th>
                      <th className="right">TONU</th>
                      <th className="right">Rev / Load</th>
                      <th>Status</th>
                      <th>Lane Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.lanes.map((lane) => {
                      const statusPresentation = laneStatusPresentation(lane.status);
                      const hasLoads = lane.loads > 0;
                      const isEditingNote = editingLaneNote === lane.lane;
                      const isSavingNote = laneNoteSavingLane === lane.lane;
                      const isEditingTarget = editingLaneTarget === lane.lane;
                      const isSavingTarget = laneTargetSavingLane === lane.lane;
                      return (
                        <tr key={lane.lane}>
                          <td className="strong">
                            <button type="button" className="db-row-open-btn" onClick={() => setExpandedLane((prev) => (prev === lane.lane ? null : lane.lane))}>
                              <span className="db-ellipsis" title={lane.lane}>
                                {lane.lane}
                              </span>
                            </button>
                          </td>
                          <td className="mono dim" style={{ fontSize: 11 }}>{lane.driverType ?? "—"}</td>
                          <td className="right mono num">
                            {isEditingTarget ? (
                              <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", alignItems: "flex-start" }}>
                                <input
                                  autoFocus
                                  type="number"
                                  min="0.01"
                                  step="0.01"
                                  className="db-datepicker"
                                  style={{ width: 96, textAlign: "right", fontSize: 11 }}
                                  value={laneTargetValue}
                                  disabled={isSavingTarget}
                                  onChange={(e) => setLaneTargetValue(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      void saveLaneTarget(lane.lane, laneTargetValue.trim());
                                    }
                                    if (e.key === "Escape") {
                                      setEditingLaneTarget(null);
                                    }
                                  }}
                                />
                                <button
                                  className="db-btn db-btn-mini"
                                  disabled={isSavingTarget}
                                  aria-busy={isSavingTarget}
                                  onClick={() => void saveLaneTarget(lane.lane, laneTargetValue.trim())}
                                >
                                  {isSavingTarget ? "..." : "✓"}
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                className="db-row-open-btn"
                                style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}
                                onClick={() => {
                                  setLaneTargetError(null);
                                  setEditingLaneTarget(lane.lane);
                                  setLaneTargetValue(lane.target !== null ? String(lane.target) : "");
                                }}
                              >
                                <span className="mono num">{lane.target === null ? "—" : money(lane.target, { decimals: 0 })}</span>
                                {lane.targetSource === "MANUAL_WEEKLY" ? <span className="db-tag warn">DAT</span> : null}
                              </button>
                            )}
                            {laneTargetError && isEditingTarget ? (
                              <div className="db-upload-error" role="alert" style={{ marginTop: 4 }}>
                                {laneTargetError}
                              </div>
                            ) : null}
                          </td>
                          <td className={`right mono num${hasLoads ? "" : " dim"}`}>{hasLoads ? lane.loads : "—"}</td>
                          <td className="right mono num">{hasLoads && lane.revenue !== null ? money(lane.revenue, { decimals: 0 }) : "—"}</td>
                          <td className="right mono num">{hasLoads && lane.nby !== null ? `$${lane.nby.toFixed(2)}` : "—"}</td>
                          <td
                            className={`right mono num strong ${
                              lane.vsTarget === null ? "dim" : lane.vsTarget >= 0 ? "pos" : "neg"
                            }`}
                          >
                            {lane.vsTarget === null
                              ? "—"
                              : `${lane.vsTarget >= 0 ? "+" : "-"}$${Math.abs(lane.vsTarget).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                          </td>
                          <td className="right mono num">{hasLoads && lane.emptyPct !== null ? `${lane.emptyPct.toFixed(1)}%` : "—"}</td>
                          <td className="right mono num">{hasLoads && lane.tonu !== null && lane.tonu > 0 ? money(lane.tonu, { decimals: 0 }) : "—"}</td>
                          <td className="right mono num">{hasLoads && lane.revLoad !== null ? money(lane.revLoad, { decimals: 0 }) : "—"}</td>
                          <td>
                            <span className={`db-lane-status ${statusPresentation.cls} mono`}>{statusPresentation.label}</span>
                          </td>
                          <td style={{ minWidth: 120 }}>
                            {isEditingNote ? (
                              <>
                                <div style={{ display: "flex", gap: 4, alignItems: "flex-start" }}>
                                  <textarea
                                    autoFocus
                                    className="db-datepicker"
                                    style={{ fontSize: 11, minHeight: 40, width: 160, resize: "vertical" }}
                                    value={laneNoteValue}
                                    disabled={isSavingNote}
                                    onChange={(e) => setLaneNoteValue(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void saveLaneNote(lane.lane, laneNoteValue); }
                                      if (e.key === "Escape") setEditingLaneNote(null);
                                    }}
                                  />
                                  <button
                                    className="db-btn db-btn-mini"
                                    disabled={isSavingNote}
                                    aria-busy={isSavingNote}
                                    onClick={() => void saveLaneNote(lane.lane, laneNoteValue)}
                                  >
                                    {isSavingNote ? "..." : "✓"}
                                  </button>
                                </div>
                                {laneNoteError ? (
                                  <div className="db-upload-error" role="alert" style={{ marginTop: 4 }}>
                                    {laneNoteError}
                                  </div>
                                ) : null}
                              </>
                            ) : (
                              <button
                                type="button"
                                className="db-row-open-btn dim"
                                style={{ fontSize: 11 }}
                                onClick={() => {
                                  setLaneNoteError(null);
                                  setEditingLaneNote(lane.lane);
                                  setLaneNoteValue(lane.laneNote ?? "");
                                }}
                              >
                                {lane.laneNote ? lane.laneNote : "+ note"}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {data.lanes.length === 0 ? (
                      <tr>
                        <td colSpan={12} className="dim">
                          No lane data for selected filters.
                        </td>
                      </tr>
                    ) : null}
                    {expandedLane
                      ? data.laneDrilldowns
                          .filter((group) => group.lane === expandedLane)
                          .map((group) => (
                            <tr key={`${group.lane}:drill`}>
                              <td colSpan={12}>
                                <div className="db-mgmt-notes">
                                  <div className="db-mgmt-notes-h">Lane drilldown · {group.lane}</div>
                                  <table className="db-table compact">
                                    <thead>
                                      <tr>
                                        <th>Week</th>
                                        <th className="right">Loads</th>
                                        <th className="right">Revenue</th>
                                        <th className="right">Empty %</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {group.trend.map((point) => (
                                        <tr key={`${group.lane}-${point.week}`}>
                                          <td className="mono">{point.week}</td>
                                          <td className="right mono num">{point.loads}</td>
                                          <td className="right mono num">{point.rev === null ? "—" : money(point.rev, { decimals: 0 })}</td>
                                          <td className="right mono num">{point.empty === null ? "—" : `${point.empty.toFixed(1)}%`}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </td>
                            </tr>
                          ))
                      : null}
                  </tbody>
                </table>
                </div>
                <div className="db-lanes-foot dim">
                  NBY ($/mi) = line haul ÷ total trip miles (loaded + all deadhead), shown per lane and in totals.
                </div>
              </div>
            </div>

            <div
              id={tabPanelId("Trend")}
              role="tabpanel"
              aria-labelledby={tabButtonId("Trend")}
              hidden={tab !== "Trend"}
              className={`db-tab-panel ${tab === "Trend" ? "active" : ""}`}
            >
              <div className="db-trend">
                <div className="db-trend-head">
                  <h2 className="db-tab-h">Week-over-week trend</h2>
                  <div className="db-trend-controls">
                    <label className="db-datepicker" aria-label="Trend range">
                      <span className="mono">Window</span>
                      <select
                        className="db-trend-window-select"
                        value={String(trendWindow)}
                        onChange={(event) => updateQuery({ weeks: event.target.value })}
                        aria-label="Trend window"
                      >
                        <option value="4">4 weeks</option>
                        <option value="6">6 weeks</option>
                        <option value="8">8 weeks</option>
                        <option value="12">12 weeks</option>
                        <option value="26">26 weeks</option>
                        <option value="52">52 weeks</option>
                      </select>
                    </label>
                    <div className="db-legend">
                      <span className="db-legend-item">
                        <span className="db-legend-sw load" />
                        Loads
                      </span>
                      <span className="db-legend-item">
                        <span className="db-legend-sw rev" />
                        Revenue
                      </span>
                      <span className="db-legend-item">
                        <span className="db-legend-sw empty" />
                        Empty %
                      </span>
                    </div>
                  </div>
                </div>
                <div className="db-trend-chart-shell">
                  <div className="db-trend-chart-scroll" role="region" aria-label="Trend chart horizontal scroll region" tabIndex={0}>
                    <div style={{ width: chartWidth, minWidth: chartWidth }} className="db-trend-chart-canvas">
                      <LineChart
                        width={chartWidth}
                        height={280}
                        data={visibleTrendSeries}
                        margin={{ top: 16, right: 20, left: 10, bottom: 12 }}
                        onMouseLeave={() => {
                          if (!isTrendPointPinned) {
                            setActiveTrendPointId(visibleTrendSeries[visibleTrendSeries.length - 1]?.id ?? null);
                          }
                        }}
                        onMouseMove={(state) => {
                          if (
                            !isTrendPointPinned &&
                            state &&
                            typeof state.activeTooltipIndex === "number" &&
                            visibleTrendSeries[state.activeTooltipIndex]
                          ) {
                            setActiveTrendPointId(visibleTrendSeries[state.activeTooltipIndex].id);
                          }
                        }}
                      >
                        <CartesianGrid stroke="var(--db-border-soft)" vertical={false} />
                        <XAxis
                          dataKey="id"
                          tickLine={false}
                          axisLine={false}
                          tick={{ fill: "var(--db-fg-dim)", fontSize: 11, fontFamily: "var(--db-font-mono)" }}
                          tickFormatter={(value: string) =>
                            visibleTrendSeries.find((point) => point.id === value)?.weekLabel ?? value
                          }
                        />
                        <YAxis
                          yAxisId="loads"
                          tickLine={false}
                          axisLine={false}
                          tick={{ fill: "var(--db-chart-load)", fontSize: 10, fontFamily: "var(--db-font-mono)" }}
                          tickFormatter={(value) => int(Number(value))}
                          width={56}
                        />
                        <YAxis
                          yAxisId="revenue"
                          orientation="right"
                          tickLine={false}
                          axisLine={false}
                          tick={{ fill: "var(--db-chart-rev)", fontSize: 10, fontFamily: "var(--db-font-mono)" }}
                          tickFormatter={(value) => money(Number(value), { decimals: 0 })}
                          width={72}
                        />
                        <YAxis yAxisId="empty" hide domain={[0, "dataMax + 1"]} />
                        <Tooltip
                          cursor={{ stroke: "var(--db-accent)", strokeDasharray: "3 3" }}
                          content={({ active, payload }: any) => {
                            if (!active || !payload || payload.length === 0) {
                              return null;
                            }
                            const point = payload[0]?.payload as TrendSeriesPoint | undefined;
                            if (!point) {
                              return null;
                            }
                            return <TrendPopup point={point} />;
                          }}
                        />
                        <ReferenceLine
                          x={visibleTrendSeries[visibleTrendSeries.length - 1]?.id}
                          stroke="var(--db-accent)"
                          strokeDasharray="3 3"
                          strokeOpacity={0.75}
                        />
                        <Line
                          type="monotone"
                          dataKey="loads"
                          name="Loads"
                          yAxisId="loads"
                          stroke="var(--db-chart-load)"
                          strokeWidth={2}
                          dot={renderInteractiveDot}
                          activeDot={{ r: 5 }}
                        />
                        <Line
                          type="monotone"
                          dataKey="rev"
                          name="Revenue"
                          yAxisId="revenue"
                          stroke="var(--db-chart-rev)"
                          strokeWidth={2}
                          dot={renderInteractiveDot}
                          activeDot={{ r: 5 }}
                        />
                        <Line
                          type="monotone"
                          dataKey="empty"
                          name="Empty %"
                          yAxisId="empty"
                          stroke="var(--db-chart-empty)"
                          strokeWidth={2}
                          strokeDasharray="5 4"
                          dot={renderInteractiveDot}
                          activeDot={{ r: 5 }}
                        />
                      </LineChart>
                    </div>
                  </div>
                  {activeTrendPoint ? (
                    <div className="db-trend-selection">
                      <TrendPopup point={activeTrendPoint} />
                    </div>
                  ) : null}
                </div>
                <div className="db-trend-table">
                  <table className="db-table compact">
                    <thead>
                      <tr>
                        <th>Week</th>
                        <th className="right">Loads</th>
                        <th className="right">Revenue</th>
                        <th className="right">Empty %</th>
                        <th className="right">NBY</th>
                        <th className="right">Tender %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trendRows.map((point, index) => (
                        <tr key={`${point.week}-${index}`} className={index === 0 ? "current" : ""}>
                          <td className="mono">{index === 0 ? `${point.week} (current)` : point.week}</td>
                          <td className="right mono num">{point.loads}</td>
                          <td className="right mono num">{point.rev === null ? "—" : money(point.rev, { decimals: 0 })}</td>
                          <td className="right mono num">{point.empty === null ? "—" : `${point.empty.toFixed(1)}%`}</td>
                          <td className="right mono num">{point.nby === null ? "—" : `$${point.nby.toFixed(2)}`}</td>
                          <td className="right mono num dim">—</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div
              id={tabPanelId("Management Report")}
              role="tabpanel"
              aria-labelledby={tabButtonId("Management Report")}
              hidden={tab !== "Management Report"}
              className={`db-tab-panel ${tab === "Management Report" ? "active" : ""}`}
            >
              <div className="db-mgmt">
                <header className="db-mgmt-head">
                  <div>
                    <div className="db-mgmt-eyebrow mono">MANAGEMENT REPORT</div>
                    <h3 className="db-mgmt-h">{activeRegionCode} · {weekRange}</h3>
                  </div>
                  <div className="db-mgmt-actions">
                    <button className="db-btn" type="button" onClick={() => triggerExport("pdf")}>
                      Export PDF
                    </button>
                    <button
                      className="db-btn primary"
                      type="button"
                      onClick={sendEmailSummary}
                      disabled={isSendingEmail}
                      aria-busy={isSendingEmail ? "true" : "false"}
                    >
                      {isSendingEmail ? (
                        <>
                          <span className="db-spinner" aria-hidden="true" />
                          Sending...
                        </>
                      ) : (
                        "Email manager"
                      )}
                    </button>
                  </div>
                </header>
                <div className="db-mgmt-grid">
                  {topCards.map((card) => (
                    <div key={card.key} className="db-mgmt-cell">
                      <div className="db-mgmt-k">{card.label}</div>
                      <div className="db-mgmt-v mono">{formattedCardValue(card.key, card.value)}</div>
                      <div className="db-mgmt-d">
                        <Delta value={card.delta} label={card.deltaLabel} inverted={card.inverted} noPrior={card.noPrior} />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="db-mgmt-notes">
                  <div className="db-mgmt-notes-h">Operational notes</div>
                  {managementNotes.map((note) => (
                    <p key={note}>{note}</p>
                  ))}
                </div>
                <footer className="db-mgmt-foot">
                  <div className="db-mgmt-sig">
                    <div className="db-mgmt-sig-line" />
                    <div className="dim">Christopher McDaniel · Backhaul Coordinator</div>
                  </div>
                  <div className="dim mono">Generated live · Drop Bucket</div>
                </footer>
                {emailStatus ? (
                  <div className="db-lanes-foot dim" role="status" aria-live="polite">
                    {emailStatus}
                  </div>
                ) : null}
              </div>
            </div>

            <div
              id={tabPanelId("Reference Rules")}
              role="tabpanel"
              aria-labelledby={tabButtonId("Reference Rules")}
              hidden={tab !== "Reference Rules"}
              className={`db-tab-panel ${tab === "Reference Rules" ? "active" : ""}`}
            >
              <div className="db-rules">
                <div className="db-tab-headrow">
                  <h2 className="db-tab-h">Operational rules · {activeRegionCode}</h2>
                  <button
                    className="db-btn"
                    type="button"
                    onClick={() => { setNewRuleOpen(true); setNewRuleError(null); }}
                  >
                    + New rule
                  </button>
                </div>
                <div className="db-rules-list">
                  {ackError ? (
                    <div className="db-lanes-foot dim" role="status" aria-live="polite">
                      {ackError}
                    </div>
                  ) : null}
                  {ackStatus ? (
                    <div className="db-lanes-foot dim" role="status" aria-live="polite">
                      {ackStatus}
                    </div>
                  ) : null}
                  {alerts.length > 0 ? (
                    <div className="db-rule">
                      <div className="db-rule-l">
                        <span className="db-rule-sev warn">ALERTS</span>
                      </div>
                      <div className="db-rule-m">
                        <div className="db-rule-title">Operational alerts</div>
                        <div className="db-rule-body dim">
                          {alerts.map((alert) => (
                            <div key={alert.id} className="db-alert-row">
                              <strong>{alert.title}</strong> — {alert.message}{" "}
                              {alert.acknowledgedAt ? (
                                <span className="dim">Acknowledged</span>
                              ) : (
                                <button
                                  className="db-btn db-btn-mini"
                                  type="button"
                                  onClick={() => acknowledgeAlert(alert.id)}
                                  disabled={ackPendingId === alert.id}
                                >
                                  {ackPendingId === alert.id ? "Acknowledging..." : "Acknowledge"}
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="db-rule-r">
                        <div className="db-rule-lots-l">OPEN</div>
                        <div className="db-rule-lots mono">{openAlerts.length}</div>
                      </div>
                    </div>
                  ) : null}
                  {data.rules.map((rule) => (
                    <div key={rule.code} className="db-rule">
                      <div className="db-rule-l">
                        <span className={`db-rule-sev ${rule.severity.toLowerCase()}`}>{rule.severity}</span>
                        <span className="db-rule-code mono">{rule.code}</span>
                      </div>
                      <div className="db-rule-m">
                        <div className="db-rule-title" title={rule.title}>
                          {rule.title}
                        </div>
                        <div className="db-rule-body dim">{rule.statement}</div>
                      </div>
                      <div className="db-rule-r">
                        <div className="db-rule-lots-l">APPLIES TO</div>
                        <div className="db-rule-lots mono">{rule.appliesTo}</div>
                      </div>
                    </div>
                  ))}
                  {alerts.length === 0 && data.rules.length === 0 ? (
                    <div className="db-rule">
                      <div className="db-rule-m dim">No reference rules are configured for this region yet.</div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
      </div>
      </div>
      <CopilotPanel />
    </div>
  );
}
