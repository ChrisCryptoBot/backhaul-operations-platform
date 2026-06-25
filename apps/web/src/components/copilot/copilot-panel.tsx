"use client";

import React from "react";
import { MAX_UPLOAD_BYTES, isPdfUpload, readFileAsBase64 } from "@/lib/ui/upload-utils";

interface CopilotPanelProps {
  /** Active region. Optional — the API resolves the Phase 1 region when omitted. */
  regionId?: string;
  /** Board date for context. Optional — the API defaults to today when omitted. */
  date?: string;
  /** Called after the copilot applies/confirms a change. Defaults to a router refresh. */
  onChanged?: () => void;
}

interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

interface PendingAction {
  tool: string;
  input: Record<string, unknown>;
  summary: string;
}

interface IntakeReply {
  label: string;
  value: string;
  mono?: boolean;
  ghost?: boolean;
}

interface SeedField {
  k: string;
  v: string;
}

/** A structured inline error: bold lead + body + an optional actionable link. */
interface CopErrorInfo {
  title?: string;
  body: string;
  link?: { label: string; href: string };
}

const NO_KEY_ERROR: CopErrorInfo = {
  title: "No AI key configured.",
  body: "Set one in Settings to use chat — the relay intake below still works without it.",
  link: { label: "Open Settings", href: "/settings" }
};

/** The current intake question, rendered as a rich stage card (not a chat bubble). */
interface IntakeStage {
  prompt: string;
  stepNo?: number;
  stepTotal?: number;
  replies?: IntakeReply[];
  error?: string;
}

type IntakeResponse = {
  state: unknown;
  prompt?: string;
  error?: string;
  done?: PendingAction;
  stepNo?: number;
  stepTotal?: number;
  replies?: IntakeReply[];
};

type IngestResponse = IntakeResponse & {
  rateConfirmationId?: string;
  parseState?: string | null;
  parseConfidence?: number | null;
  seedFields?: SeedField[];
};

const COLLAPSED_KEY = "db-copilot-collapsed";

// ── Inline icon set (decorative; scoped to the copilot panel) ───────────────
const Icon = {
  spark: (p: React.SVGProps<SVGSVGElement> = {}) => (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" {...p}>
      <path d="M8 2l1.2 3.3L12.5 6.5l-3.3 1.2L8 11 6.8 7.7 3.5 6.5l3.3-1.2L8 2z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M13 10.5l.5 1.4 1.4.6-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.6.5-1.4z" stroke="currentColor" strokeWidth="0.9" strokeLinejoin="round" />
    </svg>
  ),
  chevR: (p: React.SVGProps<SVGSVGElement> = {}) => (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" {...p}><path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
  ),
  chevL: (p: React.SVGProps<SVGSVGElement> = {}) => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" {...p}><path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
  ),
  brief: (p: React.SVGProps<SVGSVGElement> = {}) => (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" {...p}><path d="M3 2.5h7l3 3v8H3v-11z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><path d="M5.5 7h5M5.5 9.5h5M5.5 12h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
  ),
  alert: (p: React.SVGProps<SVGSVGElement> = {}) => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" {...p}><path d="M8 2.5L14.5 13.5h-13L8 2.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M8 6.5v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /><circle cx="8" cy="11.4" r="0.7" fill="currentColor" /></svg>
  ),
  doc: (p: React.SVGProps<SVGSVGElement> = {}) => (
    <svg width="15" height="15" viewBox="0 0 18 18" fill="none" {...p}><path d="M4 2h7l3 3v11H4V2z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M11 2v3h3M6.5 9h5M6.5 12h3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
  ),
  truck: (p: React.SVGProps<SVGSVGElement> = {}) => (
    <svg width="13" height="13" viewBox="0 0 18 18" fill="none" {...p}><path d="M1.5 4.5h9v7h-9zM10.5 7h3l2 2.2v2.3h-5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><circle cx="5" cy="13" r="1.4" stroke="currentColor" strokeWidth="1.2" /><circle cx="13" cy="13" r="1.4" stroke="currentColor" strokeWidth="1.2" /></svg>
  ),
  check: (p: React.SVGProps<SVGSVGElement> = {}) => (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" {...p}><path d="M3 8.5L6.5 12l7-8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
  ),
  up: (p: React.SVGProps<SVGSVGElement> = {}) => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" {...p}><path d="M8 13V4M4 8l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
  )
};

// ── Presentational sub-components ───────────────────────────────────────────
function CopMsg({ role, text }: { role: "user" | "assistant"; text: string }) {
  return (
    <div className={`db-cop-msg ${role}`}>
      {role === "assistant" ? <span className="db-cop-msg-role mono">copilot</span> : null}
      <span className="db-cop-msg-text">{text}</span>
    </div>
  );
}

function CopBusy() {
  return (
    <div className="db-cop-msg assistant">
      <span className="db-cop-msg-role mono">copilot</span>
      <span className="db-cop-dots" aria-label="Thinking"><i /><i /><i /></span>
    </div>
  );
}

function CopBrief({ lines }: { lines: string[] }) {
  return (
    <div className="db-cop-brief">
      <div className="db-cop-brief-head"><span className="ic">{Icon.brief()}</span> Today&rsquo;s briefing</div>
      <ul className="db-cop-brief-list">
        {lines.map((line, i) => (
          <li key={i}><span className="bullet" />{line}</li>
        ))}
      </ul>
    </div>
  );
}

function CopConfirm({ action, onConfirm, onCancel, busy }: { action: PendingAction; onConfirm: () => void; onCancel: () => void; busy: boolean }) {
  const relay = action.tool === "create_relayed_load";
  const input = action.input || {};
  const legs = (Array.isArray(input.legs) ? input.legs : []) as Array<{ legType?: string; driverName?: string | null }>;
  const covered = legs.filter((l) => l.driverName).length;
  return (
    <div className="db-cop-card">
      <div className="db-cop-card-head">
        <span className="db-cop-card-ic">{Icon.alert()}</span>
        <span className="db-cop-card-kicker">Needs confirmation</span>
        <span className="db-cop-tool">{action.tool}</span>
      </div>
      <div className="db-cop-card-body">
        {relay && legs.length > 0 ? (
          <>
            <div className="db-cop-legs">
              {legs.map((l, i) => (
                <React.Fragment key={i}>
                  {i > 0 ? <span className="db-cop-leg-arrow">→</span> : null}
                  <span className={`db-cop-leg${l.driverName ? "" : " open"}`}>
                    <span className="lt">{l.legType}</span>
                    <span className="dr">{l.driverName || "unassigned"}</span>
                  </span>
                </React.Fragment>
              ))}
            </div>
            <dl className="db-cop-kv">
              <dt>Route</dt>
              <dd>{String(input.pickupCity)}, {String(input.pickupState)} → {String(input.deliveryCity)}, {String(input.deliveryState)}</dd>
              <dt>Line-haul</dt>
              <dd className="mono">${String(input.lineHaulRate)}</dd>
              <dt>Loaded mi</dt>
              <dd className="mono">{String(input.loadedMiles)}</dd>
              <dt>Deadhead</dt>
              <dd className="mono">{String(input.puDeadheadMiles)} pu · {String(input.delDeadheadMiles)} del</dd>
              <dt>FSC</dt>
              <dd>{input.fscApplies ? "Applies" : "Off"}</dd>
              {input.brokerName ? <><dt>Broker</dt><dd>{String(input.brokerName)}</dd></> : null}
              {input.rateConfirmationId ? <><dt>Rate con</dt><dd className="mono">{String(input.rateConfirmationId)}</dd></> : null}
            </dl>
            <div className="db-cop-cov">
              <span>{covered}/{legs.length} covered</span>
              <span className="db-cop-cov-bar"><span className="db-cop-cov-fill" style={{ width: `${(covered / legs.length) * 100}%` }} /></span>
            </div>
          </>
        ) : (
          <p className="db-cop-card-summary">{action.summary}</p>
        )}
      </div>
      <div className="db-cop-actions">
        <button type="button" className="db-btn primary" disabled={busy} onClick={onConfirm}>Confirm</button>
        <button type="button" className="db-btn db-btn-ghost ghost" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function CopApplied({ items }: { items: string[] }) {
  return (
    <div className="db-cop-applied">
      <div className="db-cop-applied-h">Applied this session</div>
      {items.map((t, i) => (
        <div key={i} className="db-cop-chip"><span className="ic">{Icon.check()}</span>{t.replace(/^✓\s*/, "")}</div>
      ))}
    </div>
  );
}

/** Split a prompt like `Question? (hint)` into its question + hint for the stage layout. */
function splitPrompt(prompt: string): { q: string; hint?: string } {
  const m = prompt.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (m && m[1]) return { q: m[1].trim(), hint: m[2].trim() };
  return { q: prompt };
}

function CopIntake({ stage, seedFields, onAnswer }: { stage: IntakeStage; seedFields: SeedField[]; onAnswer: (value: string) => void }) {
  const { q, hint } = splitPrompt(stage.prompt);
  const total = stage.stepTotal;
  return (
    <div className="db-cop-stage">
      <div className="db-cop-stage-head">
        <span className="ic">{Icon.truck()}</span>
        <span className="db-cop-stage-title">New relay load</span>
        {stage.stepNo && total ? <span className="db-cop-stage-count">Step {stage.stepNo} / {total}</span> : null}
      </div>
      <div className="db-cop-stage-body">
        {stage.stepNo && total ? (
          <div className="db-cop-steps">
            {Array.from({ length: total }).map((_, i) => (
              <i key={i} className={i < (stage.stepNo as number) - 1 ? "done" : i === (stage.stepNo as number) - 1 ? "now" : ""} />
            ))}
          </div>
        ) : null}
        {stage.error ? <div className="db-cop-stage-err">{Icon.alert()} {stage.error}</div> : null}
        <div className="db-cop-q">{q}{hint ? <span className="hint">{hint}</span> : null}</div>
        {stage.replies && stage.replies.length ? (
          <div className="db-cop-quick-replies">
            {stage.replies.map((r) => (
              <button key={r.value} type="button" className={`db-cop-qr${r.mono ? " mono" : ""}${r.ghost ? " ghost" : ""}`} onClick={() => onAnswer(r.value)}>{r.label}</button>
            ))}
          </div>
        ) : null}
        {seedFields.length ? (
          <div className="db-cop-seed">
            <div className="db-cop-seed-h">{Icon.doc({ width: 11, height: 11 })} Pre-filled from rate con</div>
            <div className="db-cop-seed-grid">
              {seedFields.map((s) => (
                <span key={s.k} className="db-cop-seed-chip"><span className="ck">{Icon.check()}</span><span className="k">{s.k}</span><span className="v">{s.v}</span></span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CopError({ info }: { info: CopErrorInfo }) {
  return (
    <div className="db-cop-error">
      <span className="ic">{Icon.alert()}</span>
      <span>
        {info.title ? <b>{info.title}</b> : null}
        {info.body}
        {info.link ? <> <a href={info.link.href}>{info.link.label}</a></> : null}
      </span>
    </div>
  );
}

/** Positive confirmation banner — used for the seeded-intake "read the rate con" line. */
function CopParseBanner({ confidence }: { confidence: number | null }) {
  return (
    <div className="db-cop-error pos">
      <span className="ic">{Icon.check()}</span>
      <span>
        <b>Read the rate con{confidence != null ? ` · ${confidence}% confidence` : ""}.</b>
        I&rsquo;ll ask only for the relay plan, deadheads &amp; FSC.
      </span>
    </div>
  );
}

export function CopilotPanel({ regionId, date, onChanged }: CopilotPanelProps) {
  // After a copilot change, refresh so server-rendered data updates. The board passes
  // its own soft reload; elsewhere we fall back to a full reload (only ever called from
  // an action handler, never during render — keeps the component router-context-free).
  const notifyChanged = React.useCallback(() => {
    if (onChanged) onChanged();
    else if (typeof window !== "undefined") window.location.reload();
  }, [onChanged]);
  const [collapsed, setCollapsed] = React.useState(true);
  const [turns, setTurns] = React.useState<ChatTurn[]>([]);
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<CopErrorInfo | null>(null);
  const [actions, setActions] = React.useState<string[]>([]);
  const [pending, setPending] = React.useState<PendingAction[]>([]);
  const [briefLines, setBriefLines] = React.useState<string[]>([]);
  // Deterministic relay-load intake interview (no LLM): while active, the input box
  // feeds answers to /api/copilot {intake}, and the current question renders as a stage card.
  const [intakeOn, setIntakeOn] = React.useState(false);
  const [intakeStage, setIntakeStage] = React.useState<IntakeStage | null>(null);
  const [seedFields, setSeedFields] = React.useState<SeedField[]>([]);
  // Positive "read the rate con · N% confidence" banner shown through a seeded intake.
  const [parseBanner, setParseBanner] = React.useState<{ confidence: number | null } | null>(null);
  const [dragActive, setDragActive] = React.useState(false);
  const [parsingName, setParsingName] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const intakeStateRef = React.useRef<unknown | null>(null);
  // Full prior Anthropic transcript (tool calls + results) round-tripped for cross-turn memory.
  const transcriptRef = React.useRef<unknown[]>([]);
  const briefedRef = React.useRef(false);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);

  // Restore collapse preference once on mount (SSR-safe).
  React.useEffect(() => {
    if (window.localStorage.getItem(COLLAPSED_KEY) === "false") setCollapsed(false);
  }, []);
  React.useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, collapsed ? "true" : "false");
    } catch {
      /* storage unavailable */
    }
  }, [collapsed]);

  // Keep the chat scrolled to the latest message.
  React.useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [turns, pending, actions, error, intakeStage, briefLines]);

  const stageFrom = (data: IntakeResponse): IntakeStage => ({
    prompt: data.prompt ?? "",
    stepNo: data.stepNo,
    stepTotal: data.stepTotal,
    replies: data.replies,
    error: data.error
  });

  async function postIntake(intake: Record<string, unknown>): Promise<IntakeResponse> {
    const response = await fetch("/api/copilot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intake, regionId, date })
    });
    const data = (await response.json().catch(() => null)) as IntakeResponse | { error?: string } | null;
    if (!response.ok || !data) {
      throw new Error((data as { error?: string } | null)?.error ?? "Intake failed.");
    }
    return data as IntakeResponse;
  }

  async function startRelayIntake() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const data = await postIntake({});
      intakeStateRef.current = data.state;
      setIntakeOn(true);
      setSeedFields([]);
      setParseBanner(null);
      setTurns((prev) => [...prev, { role: "assistant", text: "Let's build a relay load." }]);
      setIntakeStage(stageFrom(data));
    } catch (intakeError) {
      setError({ body: intakeError instanceof Error ? intakeError.message : "Intake failed." });
    } finally {
      setBusy(false);
    }
  }

  // Drop a rate con into the copilot: parse it inline, then continue exactly like a
  // manual intake — the returned interview is already seeded + rate-con-linked.
  // Build a board deep-link to an existing load (the board honors ?loadId=).
  function boardLoadHref(loadId: string): string {
    const params = new URLSearchParams();
    if (date) params.set("date", date);
    if (regionId) params.set("regionId", regionId);
    params.set("loadId", loadId);
    return `/?${params.toString()}`;
  }

  async function ingestRateCon(file: File) {
    if (busy) return;
    if (!isPdfUpload(file)) {
      setError({ body: "Drop a PDF rate con to start an intake." });
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError({ body: "That file is too large." });
      return;
    }
    setBusy(true);
    setError(null);
    setParsingName(file.name);
    try {
      const fileBase64 = await readFileAsBase64(file);
      const response = await fetch("/api/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ingest: { fileName: file.name, fileBase64 }, regionId, date })
      });
      const data = (await response.json().catch(() => null)) as IngestResponse | { error?: string; loadId?: string } | null;
      // The rate con already produced a load (idempotent by content hash): link to it.
      if (response.status === 409 && data && "loadId" in data && data.loadId) {
        setError({
          title: "That rate con already has a load.",
          body: "Open it on the board instead of starting a new intake.",
          link: { label: "Open on the board", href: boardLoadHref(data.loadId) }
        });
        return;
      }
      if (!response.ok || !data || !("state" in data)) {
        throw new Error((data as { error?: string } | null)?.error ?? "Couldn't read that rate con.");
      }
      intakeStateRef.current = data.state;
      setIntakeOn(true);
      setSeedFields(data.seedFields ?? []);
      const confidence = typeof data.parseConfidence === "number" ? Math.round(data.parseConfidence * 100) : null;
      if (data.parseState === "EXTRACTED") {
        setParseBanner({ confidence });
      } else {
        setParseBanner(null);
        setTurns((prev) => [...prev, { role: "assistant", text: "Couldn't auto-read every field — I'll ask for the rest." }]);
      }
      setIntakeStage(stageFrom(data));
    } catch (ingestError) {
      setError({ body: ingestError instanceof Error ? ingestError.message : "Couldn't read that rate con." });
    } finally {
      setBusy(false);
      setParsingName(null);
    }
  }

  async function sendIntakeAnswer(answer: string) {
    setBusy(true);
    setError(null);
    setTurns((prev) => [...prev, { role: "user", text: answer }]);
    setInput("");
    try {
      const data = await postIntake({ state: intakeStateRef.current, answer });
      intakeStateRef.current = data.state;
      if (data.done) {
        setIntakeOn(false);
        setIntakeStage(null);
        setSeedFields([]);
        setParseBanner(null);
        setTurns((prev) => [...prev, { role: "assistant", text: "Got everything — confirm below to create the load." }]);
        setPending((prev) => [...prev, data.done as PendingAction]);
      } else {
        setIntakeStage(stageFrom(data));
      }
    } catch (intakeError) {
      setError({ body: intakeError instanceof Error ? intakeError.message : "Intake failed." });
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    if (intakeOn) {
      await sendIntakeAnswer(message);
      return;
    }
    setBusy(true);
    setError(null);
    setTurns((prev) => [...prev, { role: "user", text: message }]);
    setInput("");
    try {
      const response = await fetch("/api/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, transcript: transcriptRef.current, regionId, date })
      });
      const payload = (await response.json().catch(() => null)) as
        | { reply?: string; actions?: string[]; pendingActions?: PendingAction[]; transcript?: unknown[]; error?: string }
        | null;
      if (response.status === 503) {
        setError(NO_KEY_ERROR);
        return;
      }
      if (!response.ok || !payload) {
        throw new Error(payload?.error ?? "Copilot request failed.");
      }
      if (payload.transcript) {
        transcriptRef.current = payload.transcript.slice(-200);
      }
      setTurns((prev) => [...prev, { role: "assistant", text: payload.reply || "(no response)" }]);
      if (payload.actions && payload.actions.length > 0) {
        setActions((prev) => [...prev, ...payload.actions!]);
        notifyChanged();
      }
      setPending(payload.pendingActions ?? []);
    } catch (sendError) {
      setError({ body: sendError instanceof Error ? sendError.message : "Copilot request failed." });
    } finally {
      setBusy(false);
    }
  }

  const brief = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: true, regionId, date })
      });
      const payload = (await response.json().catch(() => null)) as
        | { reply?: string; transcript?: unknown[]; error?: string }
        | null;
      if (response.status === 503) {
        setError(NO_KEY_ERROR);
        return;
      }
      if (!response.ok || !payload) {
        throw new Error(payload?.error ?? "Copilot request failed.");
      }
      if (payload.transcript) {
        transcriptRef.current = payload.transcript.slice(-200);
      }
      const lines = (payload.reply || "")
        .split(/\n+|(?<=\.)\s+(?=[A-Z])/)
        .map((l) => l.trim())
        .filter(Boolean);
      setBriefLines(lines.length ? lines : [payload.reply || "(no briefing)"]);
    } catch (briefError) {
      setError({ body: briefError instanceof Error ? briefError.message : "Copilot request failed." });
    } finally {
      setBusy(false);
    }
  }, [regionId, date]);

  // Auto-brief the first time the panel is expanded.
  React.useEffect(() => {
    if (!collapsed && !briefedRef.current) {
      briefedRef.current = true;
      void brief();
    }
  }, [collapsed, brief]);

  async function confirm(action: PendingAction) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: { tool: action.tool, input: action.input }, regionId, date })
      });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; summary?: string; error?: string } | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error ?? "Action failed.");
      }
      setActions((prev) => [...prev, payload.summary ?? action.summary]);
      setPending((prev) => prev.filter((p) => p !== action));
      notifyChanged();
    } catch (confirmError) {
      setError({ body: confirmError instanceof Error ? confirmError.message : "Action failed." });
    } finally {
      setBusy(false);
    }
  }

  // Collapsed: a thin rail with the brand mark + vertical wordmark, which expands on click.
  if (collapsed) {
    return (
      <aside className="db-copilot" data-collapsed="true" aria-label="Operations copilot">
        <button
          type="button"
          className="db-cop-rail-btn"
          onClick={() => setCollapsed(false)}
          aria-label="Expand copilot"
          aria-expanded={false}
          title="Copilot"
        >
          <span className="db-cop-mark" aria-hidden="true">{Icon.spark()}</span>
          <span className="db-cop-rail-word">Copilot</span>
          <span className="db-cop-rail-chev" aria-hidden="true">{Icon.chevL()}</span>
        </button>
      </aside>
    );
  }

  const showBusy = busy && !intakeStage && turns.length > 0 && turns[turns.length - 1].role === "user";

  return (
    <aside className="db-copilot" data-collapsed="false" aria-label="Operations copilot">
      <header className="db-cop-head">
        <span className="db-cop-mark" aria-hidden="true">{Icon.spark()}</span>
        <div className="db-cop-headtext">
          <span className="db-cop-title">Copilot</span>
          <span className="db-cop-sub">Scoped to {date ?? "today"}</span>
        </div>
        <button
          type="button"
          className="db-iconbtn db-cop-collapse"
          onClick={() => setCollapsed(true)}
          aria-label="Collapse copilot"
          aria-expanded
          title="Collapse"
        >
          {Icon.chevR()}
        </button>
      </header>

      <div className="db-cop-body" ref={bodyRef}>
        {briefLines.length ? <CopBrief lines={briefLines} /> : null}
        {turns.length === 0 && !briefLines.length && !intakeStage ? (
          <p className="db-cop-empty">
            Ask me to change a load — e.g. <b>&ldquo;set delivery date for load 12345 to 2026-06-22 and mark POD received&rdquo;</b> — or drop a rate con below to start a relay intake.
          </p>
        ) : null}
        {turns.map((turn, index) => (
          <CopMsg key={index} role={turn.role} text={turn.text} />
        ))}

        {showBusy ? <CopBusy /> : null}

        {parseBanner ? <CopParseBanner confidence={parseBanner.confidence} /> : null}

        {intakeStage ? <CopIntake stage={intakeStage} seedFields={seedFields} onAnswer={(value) => void sendIntakeAnswer(value)} /> : null}

        {pending.map((action, index) => (
          <CopConfirm
            key={`pending-${index}`}
            action={action}
            busy={busy}
            onConfirm={() => void confirm(action)}
            onCancel={() => setPending((prev) => prev.filter((p) => p !== action))}
          />
        ))}

        {actions.length > 0 ? <CopApplied items={actions} /> : null}

        {error ? <CopError info={error} /> : null}
      </div>

      <div className="db-cop-quick">
        <button
          type="button"
          className="db-btn db-btn-ghost ghost"
          disabled={busy || intakeOn}
          onClick={() => void startRelayIntake()}
          title="Start a guided relay-load intake (works without AI credits)"
        >
          + New relay load
        </button>
        {intakeOn ? <span className="db-cop-intake-tag"><span className="pulse" />intake in progress</span> : null}
      </div>

      <div
        className={`db-cop-drop${parsingName ? " parsing" : dragActive ? " drag-active" : ""}`}
        role={parsingName ? undefined : "button"}
        tabIndex={parsingName ? undefined : 0}
        aria-label={parsingName ? undefined : "Drop a rate con to start an intake"}
        onDragOver={parsingName ? undefined : (event) => { event.preventDefault(); if (!dragActive) setDragActive(true); }}
        onDragLeave={parsingName ? undefined : () => setDragActive(false)}
        onDrop={parsingName ? undefined : (event) => {
          event.preventDefault();
          setDragActive(false);
          const file = event.dataTransfer.files?.[0];
          if (file) void ingestRateCon(file);
        }}
        onClick={parsingName ? undefined : () => fileInputRef.current?.click()}
        onKeyDown={parsingName ? undefined : (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            fileInputRef.current?.click();
          }
        }}
      >
        <span className="ic">{Icon.doc()}</span>
        {parsingName ? (
          <span className="txt" style={{ flex: 1 }}>
            <b>Parsing {parsingName}…</b>
            <span>Reading rate, route &amp; broker</span>
            <span className="db-cop-parsebar"><i /></span>
          </span>
        ) : (
          <span className="txt">
            <b>{dragActive ? "Release to parse" : "Drop a rate con"}</b>
            <span>{dragActive ? "PDF → seeded intake" : "PDF — parses, then starts an intake"}</span>
          </span>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,application/pdf"
          className="db-sr-only"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void ingestRateCon(file);
            event.target.value = "";
          }}
        />
      </div>

      <form
        className={`db-cop-input${intakeOn ? " intake" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <input
          className="db-cop-field"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={intakeOn ? "Type your answer…" : "Tell the copilot what to change…"}
          disabled={busy}
          aria-label={intakeOn ? "Intake answer" : "Copilot message"}
        />
        <button type="submit" className="db-cop-send" disabled={busy || !input.trim()} aria-label="Send" title="Send">
          {busy ? <span className="db-cop-send-busy" aria-hidden="true">…</span> : Icon.up()}
        </button>
      </form>
      <div className="db-cop-hint">Reads live board data · actions require confirmation</div>
    </aside>
  );
}
