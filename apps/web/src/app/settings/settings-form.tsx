"use client";

import Link from "next/link";
import React from "react";
import type { LlmSettingsStatus } from "@/server/llm/settings";
import type { RegionThresholds } from "@/server/region-config";
import { UndoToast, useToast } from "@/components/ui/toast";
import { SlidersIcon, InfoIcon, KeyIcon } from "@/components/icons";

interface SettingsFormProps {
  initialStatus: LlmSettingsStatus;
  supportedProviders: string[];
  initialThresholds: RegionThresholds;
}

const PROVIDER_OPTIONS = [
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "openai", label: "OpenAI (GPT)" },
  { value: "google", label: "Google (Gemini)" }
];

const MODEL_OPTIONS: Record<string, Array<{ value: string; label: string }>> = {
  anthropic: [
    { value: "claude-haiku-4-5", label: "Claude Haiku 4.5 — cheapest, fast" },
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 — balanced" },
    { value: "claude-opus-4-8", label: "Claude Opus 4.8 — most capable" }
  ]
};

/** Live preview of how the amber/red thresholds segment the board's Empty% coloring. */
function ThresholdPreview({ amber, red }: { amber: number; red: number }) {
  const valid = Number.isFinite(amber) && Number.isFinite(red) && amber > 0 && amber < red && red <= 100;
  const a = valid ? amber : 15;
  const r = valid ? red : 25;
  return (
    <div className="db-thresh">
      <div className="db-thresh-bar">
        <div className="db-thresh-seg ok" style={{ flex: a }}>OK</div>
        <div className="db-thresh-seg amber" style={{ flex: r - a }}>AMBER</div>
        <div className="db-thresh-seg red" style={{ flex: 100 - r }}>RED</div>
      </div>
      <div className="db-thresh-scale"><span>0%</span><span>{a}%</span><span>{r}%</span><span>100%</span></div>
      <div className="db-thresh-cap">Per-load Empty% on the Daily Tracker turns amber at ≥ {a}% and red at ≥ {r}%.</div>
    </div>
  );
}

export function SettingsForm({ initialStatus, supportedProviders, initialThresholds }: SettingsFormProps) {
  const [provider, setProvider] = React.useState(initialStatus.provider);
  const [model, setModel] = React.useState(initialStatus.model);
  const [copilotModel, setCopilotModel] = React.useState(initialStatus.copilotModel ?? "claude-sonnet-4-6");
  const [apiKey, setApiKey] = React.useState("");
  const [hasKey, setHasKey] = React.useState(initialStatus.hasKey);
  const [last4, setLast4] = React.useState(initialStatus.apiKeyLast4);
  const [updatedAt, setUpdatedAt] = React.useState(initialStatus.updatedAt);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [amber, setAmber] = React.useState(String(initialThresholds.emptyPctAmber));
  const [red, setRed] = React.useState(String(initialThresholds.emptyPctRed));
  const [alert, setAlert] = React.useState(String(initialThresholds.emptyPctAlert));
  const [thBusy, setThBusy] = React.useState(false);
  const [thError, setThError] = React.useState<string | null>(null);

  const { toast, show, clear } = useToast();

  const modelOptions = MODEL_OPTIONS[provider] ?? MODEL_OPTIONS.anthropic;
  const keyPlaceholder = hasKey ? (last4 ? `···· ${last4} — leave blank to keep` : "Key configured — leave blank to keep") : "Paste API key";

  function onProviderChange(next: string) {
    setProvider(next);
    const options = MODEL_OPTIONS[next] ?? [];
    if (options.length > 0 && !options.some((option) => option.value === model)) {
      setModel(options[0].value);
    }
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, model, copilotModel: copilotModel || null, apiKey: apiKey.trim() ? apiKey.trim() : undefined })
      });
      const payload = (await response.json().catch(() => null)) as { error?: string; ok?: boolean; settings?: LlmSettingsStatus } | null;
      if (!response.ok || !payload?.ok || !payload.settings) {
        throw new Error(payload?.error ?? "Failed to save settings.");
      }
      setHasKey(payload.settings.hasKey);
      setLast4(payload.settings.apiKeyLast4);
      setUpdatedAt(payload.settings.updatedAt);
      setApiKey("");
      show({ message: "Settings saved." });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to save settings.");
    } finally {
      setBusy(false);
    }
  }

  async function onSaveThresholds(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setThBusy(true);
    setThError(null);
    try {
      const response = await fetch("/api/region-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emptyPctAmber: amber.trim(), emptyPctRed: red.trim(), emptyPctAlert: alert.trim() })
      });
      const payload = (await response.json().catch(() => null)) as { error?: string; ok?: boolean; config?: RegionThresholds } | null;
      if (!response.ok || !payload?.ok || !payload.config) {
        throw new Error(payload?.error ?? "Failed to save thresholds.");
      }
      setAmber(String(payload.config.emptyPctAmber));
      setRed(String(payload.config.emptyPctRed));
      setAlert(String(payload.config.emptyPctAlert));
      show({ message: "Board thresholds saved." });
    } catch (submitError) {
      setThError(submitError instanceof Error ? submitError.message : "Failed to save thresholds.");
    } finally {
      setThBusy(false);
    }
  }

  return (
    <div className="db-ref">
      <div className="db-ref-body">
        <div className="db-set">

          <section className="db-set-card">
            <div className="db-set-head">
              <div>
                <div className="db-set-eyebrow">Document AI</div>
                <h2 className="db-set-h">LLM provider</h2>
                <p className="db-set-desc">
                  Provider and key used to parse rate-confirmation PDFs and run the copilot. The key is encrypted at rest and
                  never displayed. Until a key is set, the built-in text parser is used.
                </p>
              </div>
              <div className={`db-set-status${hasKey ? "" : " none"}`}>
                <span className="dot" /> {hasKey ? "Key configured" : "No key configured"}
                {hasKey && last4 ? <span className="mono">···· {last4}</span> : null}
              </div>
            </div>
            <div className="db-set-body">
              <form className="db-form-grid" onSubmit={onSubmit}>
                <label className="db-field-label">
                  Provider
                  <select className="db-input" value={provider} onChange={(event) => onProviderChange(event.target.value)}>
                    {PROVIDER_OPTIONS.map((option) => {
                      const active = supportedProviders.includes(option.value);
                      return (
                        <option key={option.value} value={option.value} disabled={!active}>
                          {active ? option.label : `${option.label} (coming soon)`}
                        </option>
                      );
                    })}
                  </select>
                </label>
                <label className="db-field-label">
                  Parsing model
                  <select className="db-input" value={model} onChange={(event) => setModel(event.target.value)}>
                    {modelOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="db-field-label">
                  Copilot model
                  <select className="db-input" value={copilotModel} onChange={(event) => setCopilotModel(event.target.value)}>
                    {modelOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <span className="db-field-hint">tool-use; stronger by default</span>
                </label>
                <label className="db-field-label">
                  API key
                  <div className="db-prefix-input">
                    <span className="pfx"><KeyIcon size={14} /></span>
                    <input
                      type="password"
                      className="db-input"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder={keyPlaceholder}
                      autoComplete="off"
                    />
                  </div>
                  <span className="db-field-hint">write-only · rotates the stored key</span>
                </label>

                {error ? <p className="db-upload-error db-form-full">{error}</p> : null}

                <div className="db-set-meta db-form-full">
                  <InfoIcon size={13} /> {provider} · {model}
                  {updatedAt ? ` · updated ${new Date(updatedAt).toLocaleString()}` : ""}
                </div>
                <div className="db-set-foot db-form-full">
                  <button type="submit" className="db-btn primary" disabled={busy}>
                    {busy ? "Saving…" : "Save provider"}
                  </button>
                  <span className="note">Staged actions are confirmable; the copilot can change these too.</span>
                </div>
              </form>
            </div>
          </section>

          <section className="db-set-card">
            <div className="db-set-head">
              <div>
                <div className="db-set-eyebrow">Daily Tracker</div>
                <h2 className="db-set-h">Board thresholds</h2>
                <p className="db-set-desc">
                  Empty-mile color thresholds for the board, plus the aggregate weekly empty-mile % that fires the KPI
                  dashboard alert.
                </p>
              </div>
              <div className="db-set-status"><SlidersIcon size={13} /> Board colors</div>
            </div>
            <div className="db-set-body">
              <form onSubmit={onSaveThresholds}>
                <div className="db-thresh-layout">
                  <div className="db-form-grid">
                    <label className="db-field-label">
                      Empty % amber (≥)
                      <input className="db-input mono" type="number" min={1} max={99} value={amber} onChange={(event) => setAmber(event.target.value)} />
                    </label>
                    <label className="db-field-label">
                      Empty % red (≥)
                      <input className="db-input mono" type="number" min={1} max={100} value={red} onChange={(event) => setRed(event.target.value)} />
                    </label>
                    <label className="db-field-label db-form-full">
                      Dashboard alert % (&gt;)
                      <input className="db-input mono" type="number" step={0.1} value={alert} onChange={(event) => setAlert(event.target.value)} />
                      <span className="db-field-hint">aggregate weekly empty-mile %</span>
                    </label>
                    <div className="db-form-full" style={{ fontSize: "var(--db-text-2xs)", color: "var(--db-fg-dim)", display: "flex", gap: 6, alignItems: "center" }}>
                      <InfoIcon size={13} /> Must satisfy 0 &lt; amber &lt; red ≤ 100.
                    </div>
                  </div>
                  <div>
                    <div className="db-diff-col-h">Preview</div>
                    <ThresholdPreview amber={Number(amber)} red={Number(red)} />
                  </div>
                </div>

                {thError ? <p className="db-upload-error">{thError}</p> : null}

                <div className="db-set-foot">
                  <button type="submit" className="db-btn primary" disabled={thBusy}>
                    {thBusy ? "Saving…" : "Save thresholds"}
                  </button>
                </div>
              </form>
            </div>
          </section>

          <div className="db-ref-actions" style={{ justifyContent: "flex-end" }}>
            <Link href="/" className="db-btn db-btn-ghost">Back to board</Link>
          </div>

        </div>
      </div>

      <UndoToast toast={toast} onDismiss={clear} />
    </div>
  );
}
