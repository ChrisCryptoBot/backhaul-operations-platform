"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { saveSignalSettingsAction } from "@/app/(desk)/actions";
import { LEVEL_CHOICES, WEEKDAYS, hourLabel, reportWhen, resolveSignalSettings, validateSignalSettings, type SignalSettings } from "@/lib/signal-settings";
import { useToast } from "./kit/toast";
import { DraftNote, useDraft } from "./kit/use-draft";

type Values = { minLevel: string; reportEnabled: string; reportDay: string; reportHour: string };
const asValues = (s: SignalSettings): Values => ({ minLevel: s.minLevel, reportEnabled: s.reportEnabled ? "on" : "off", reportDay: String(s.reportDay), reportHour: String(s.reportHour) });
const HOURS = Array.from({ length: 24 }, (_, h) => h);

/**
 * What the desk tells people about, and when the weekly report goes. Nothing is sent until a channel is set up on the server (docs/SIGNALS.md): this only says what goes when one is, so it is safe to set first.
 * Every field is a pick, so there is nothing to mistype; the form keeps what was picked until it is saved.
 */
export function SignalSettingsForm({ current, channels }: { current: SignalSettings; channels: string[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [values, setValues, draft] = useDraft<Values>("signal-settings", asValues(current));
  const [serverError, setServerError] = React.useState<string | null>(null);
  const check = React.useMemo(() => validateSignalSettings(values), [values]);
  const was = asValues(current);
  const unchanged = (Object.keys(was) as Array<keyof Values>).every((k) => values[k] === was[k]);
  const shown = check.ok ? resolveSignalSettings(check.stored) : current;
  const set = (key: keyof Values) => (e: React.ChangeEvent<HTMLSelectElement>) => setValues((v) => ({ ...v, [key]: e.target.value }));

  return (
    <>
      <DraftNote draft={draft} what="the signal settings" />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!check.ok) return;
          setServerError(null);
          start(async () => {
            const out = await saveSignalSettingsAction(values);
            if (out.ok) {
              draft.saved();
              toast({ text: out.changed ? "Signal settings saved." : "Nothing changed.", tone: "ok" });
              router.refresh();
            } else setServerError(Object.values(out.errors).join(" "));
          });
        }}>
        <div className="th-grid">
          <div className="th-field">
            <label htmlFor="sg-level">Tell people about</label>
            <div className="th-input">
              <select id="sg-level" name="minLevel" value={values.minLevel} onChange={set("minLevel")}>
                {LEVEL_CHOICES.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <span className="th-hint">{LEVEL_CHOICES.find((c) => c.key === values.minLevel)?.note} Once per level a signal reaches, not every time it is seen.</span>
          </div>
          <div className="th-field">
            <label htmlFor="sg-report">Weekly report</label>
            <div className="th-input">
              <select id="sg-report" name="reportEnabled" value={values.reportEnabled} onChange={set("reportEnabled")}>
                <option value="on">Send it</option>
                <option value="off">Do not send it</option>
              </select>
            </div>
            <span className="th-hint">What was leaked, what the data is missing, and what is still open, once a week.</span>
          </div>
          <div className="th-field">
            <label htmlFor="sg-day">Report day</label>
            <div className="th-input">
              <select id="sg-day" name="reportDay" value={values.reportDay} onChange={set("reportDay")} disabled={values.reportEnabled === "off"}>
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={String(i)}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="th-field">
            <label htmlFor="sg-hour">From</label>
            <div className="th-input">
              <select id="sg-hour" name="reportHour" value={values.reportHour} onChange={set("reportHour")} disabled={values.reportEnabled === "off"}>
                {HOURS.map((h) => (
                  <option key={h} value={String(h)}>
                    {hourLabel(h)}
                  </option>
                ))}
              </select>
              <span>on the carrier&apos;s clock</span>
            </div>
          </div>
        </div>
        <p className="tl-note" style={{ marginTop: 10, maxWidth: "72ch" }}>
          {channels.length === 0 ? "No channel is set up on the server yet, so nothing leaves the desk. The signals list still keeps the history." : `Going out through: ${channels.join(", ")}.`}{" "}
          {shown.reportEnabled ? `The weekly report goes ${reportWhen(shown)}.` : "The weekly report is off."}
        </p>
        {serverError ? (
          <span className="th-err" role="alert">
            {serverError}
          </span>
        ) : null}
        <div className="th-actions">
          <button type="submit" className="tl-btn primary" disabled={pending || !check.ok || unchanged} aria-busy={pending || undefined}>
            {pending ? "Saving…" : "Save signal settings"}
          </button>
          {unchanged ? <span className="tl-sub">Saved.</span> : null}
        </div>
      </form>
    </>
  );
}
