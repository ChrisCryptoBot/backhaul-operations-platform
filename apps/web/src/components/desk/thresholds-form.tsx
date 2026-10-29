"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { saveThresholdsAction } from "@/app/(desk)/actions";
import { emptyZone, resolveThresholds, THRESHOLD_DEFAULTS, THRESHOLD_FIELDS, validateThresholds, type Thresholds } from "@/lib/thresholds";
import { useToast } from "./kit/toast";

const GROUPS: Array<{ title: string; keys: Array<keyof Thresholds> }> = [
  { title: "Empty miles", keys: ["emptyAmberPct", "emptyRedPct"] },
  { title: "Invoices and docks", keys: ["defaultPayTermsDays", "detentionGraceMinutes"] },
  { title: "Alerts", keys: ["pickupAlertHours", "sentNoAnswerHours", "clearanceDays"] }
];

const text = (n: number | null | undefined) => (n == null ? "" : String(n));

/**
 * The desk's thresholds as a form. Each field can be left blank to use the default. The bar under the empty-miles fields redraws as
 * you type, with the fleet's real empty-miles share on it, so you can see which colour today's figure would get before you save.
 */
export function ThresholdsForm({ stored, fleetEmptyShare }: { stored: Record<keyof Thresholds, number | null>; fleetEmptyShare: number | null }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [values, setValues] = React.useState<Record<string, string>>(() => Object.fromEntries(THRESHOLD_FIELDS.map((f) => [f.key, text(stored[f.key])])));
  const [serverErrors, setServerErrors] = React.useState<Partial<Record<keyof Thresholds, string>>>({});

  const check = React.useMemo(() => validateThresholds(values), [values]);
  const errors = check.ok ? {} : check.errors;
  const shown: Partial<Record<keyof Thresholds, string>> = { ...serverErrors, ...errors };

  // The preview uses whatever is typed and valid so far, and the defaults for anything blank or not yet valid.
  const previewRow = Object.fromEntries(
    THRESHOLD_FIELDS.map((f) => {
      const raw = values[f.key]?.trim() ?? "";
      const n = raw === "" ? Number.NaN : Number(raw);
      return [f.key, Number.isFinite(n) ? n : null];
    })
  );
  const t = resolveThresholds(previewRow);
  const amber = Math.min(t.emptyAmberPct, t.emptyRedPct);
  const red = Math.max(t.emptyAmberPct, t.emptyRedPct);
  const top = Math.max(60, red * 1.4, (fleetEmptyShare ?? 0) * 100 * 1.15);
  const zone = emptyZone(fleetEmptyShare, { emptyAmberPct: amber, emptyRedPct: red });
  const unchanged = THRESHOLD_FIELDS.every((f) => (values[f.key]?.trim() ?? "") === text(stored[f.key]));
  const dirtyDefaults = THRESHOLD_FIELDS.some((f) => (values[f.key]?.trim() ?? "") !== "");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!check.ok) return;
        setServerErrors({});
        start(async () => {
          const out = await saveThresholdsAction(values);
          if (out.ok) {
            toast({ text: out.changed ? "Thresholds saved." : "Nothing changed.", tone: "ok" });
            router.refresh();
          } else setServerErrors(out.errors);
        });
      }}>
      {GROUPS.map((g) => (
        <React.Fragment key={g.title}>
          <h3 className="th-group">{g.title}</h3>
          <div className="th-grid">
            {g.keys.map((key) => {
              const f = THRESHOLD_FIELDS.find((x) => x.key === key)!;
              const id = `th-${key}`;
              return (
                <div className="th-field" key={key}>
                  <label htmlFor={id}>{f.label}</label>
                  <div className="th-input">
                    <input
                      id={id}
                      name={key}
                      inputMode="decimal"
                      autoComplete="off"
                      value={values[key] ?? ""}
                      placeholder={String(THRESHOLD_DEFAULTS[key])}
                      aria-invalid={shown[key] ? true : undefined}
                      aria-describedby={`${id}-hint`}
                      onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                    />
                    <span>{f.unit}{(values[key] ?? "").trim() !== "" ? ` · default ${THRESHOLD_DEFAULTS[key]}` : ""}</span>
                  </div>
                  <span className="th-hint" id={`${id}-hint`}>
                    {f.hint}
                  </span>
                  {shown[key] ? (
                    <span className="th-err" role="alert">
                      {shown[key]}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
          {g.title === "Empty miles" ? (
            <div className="th-preview" aria-live="polite">
              <div className="th-bar" role="img" aria-label={`Empty miles: green under ${amber}%, amber from ${amber}%, red from ${red}%`}>
                <i className="ok" style={{ width: `${(amber / top) * 100}%` }} />
                <i className="amber" style={{ width: `${((red - amber) / top) * 100}%` }} />
                <i className="red" style={{ width: `${Math.max(0, 100 - (red / top) * 100)}%` }} />
                {fleetEmptyShare != null ? <span className="th-mark" style={{ left: `${Math.min(99, ((fleetEmptyShare * 100) / top) * 100)}%` }} title={`Your last four weeks: ${(fleetEmptyShare * 100).toFixed(1)}%`} /> : null}
              </div>
              <div className="th-scale">
                <span>0%</span>
                <span>{amber}% amber</span>
                <span>{red}% red</span>
                <span>{top.toFixed(0)}%</span>
              </div>
              <p className="tl-note" style={{ marginTop: 6 }}>
                {fleetEmptyShare == null
                  ? "There are no finished loads in the last four weeks to place on this bar."
                  : `The last four weeks ran ${(fleetEmptyShare * 100).toFixed(1)}% empty (the black mark). With these lines that is ${zone === "red" ? "red" : zone === "amber" ? "amber" : "green"}.`}
              </p>
            </div>
          ) : null}
        </React.Fragment>
      ))}

      <div className="th-actions">
        <button type="submit" className="tl-btn primary" disabled={pending || !check.ok || unchanged} aria-busy={pending || undefined}>
          {pending ? "Saving…" : "Save thresholds"}
        </button>
        <button type="button" className="tl-btn ghost" disabled={pending || !dirtyDefaults} onClick={() => setValues(Object.fromEntries(THRESHOLD_FIELDS.map((f) => [f.key, ""])))}>
          Use all the defaults
        </button>
        {unchanged ? <span className="tl-sub">Saved.</span> : null}
      </div>
    </form>
  );
}
