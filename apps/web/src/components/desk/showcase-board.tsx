"use client";

import React from "react";
import { resetShowcaseAction, runShowcaseStepAction } from "@/app/(desk)/actions";
import { SHOWCASE_STEPS, SIMULATOR_LABEL, STEP_INFO, type ShowcaseStep, type StepCard } from "@/lib/showcase";
import { useToast } from "./kit/toast";
import { tried } from "./kit/tried";

/**
 * The partner showcase walkthrough (Wave 7 step 5), laid out for a screen recording: a rail of the ten steps, one card per step that fills with what landed, and "Reset and run the full
 * flow", which runs each step in turn and brings its card into view as it goes. Every card says it is a simulator, not the company.
 */
type Phase = "idle" | "running" | "done" | "error";

export function ShowcaseBoard({ initial }: { initial: StepCard[] }) {
  const toast = useToast();
  const [cards, setCards] = React.useState<StepCard[]>(initial);
  const [phase, setPhase] = React.useState<Partial<Record<ShowcaseStep, Phase>>>({});
  const [errors, setErrors] = React.useState<Partial<Record<ShowcaseStep, string>>>({});
  const [api, setApi] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const refs = React.useRef<Partial<Record<ShowcaseStep, HTMLElement | null>>>({});

  const show = (step: ShowcaseStep) => refs.current[step]?.scrollIntoView({ behavior: "smooth", block: "center" });

  async function runStep(step: ShowcaseStep): Promise<boolean> {
    setPhase((p) => ({ ...p, [step]: "running" }));
    setErrors((e) => ({ ...e, [step]: undefined }));
    show(step);
    const got = await tried(() => runShowcaseStepAction(step));
    if (!got.ok) {
      setPhase((p) => ({ ...p, [step]: "error" }));
      setErrors((e) => ({ ...e, [step]: got.message }));
      return false;
    }
    if (got.value.cards) setCards(got.value.cards);
    if (!got.value.ok) {
      setPhase((p) => ({ ...p, [step]: "error" }));
      setErrors((e) => ({ ...e, [step]: got.value.ok ? "" : got.value.error }));
      return false;
    }
    if (step === "read_api" && got.value.apiSample) setApi(got.value.apiSample);
    setPhase((p) => ({ ...p, [step]: "done" }));
    return true;
  }

  async function reset(): Promise<boolean> {
    const got = await tried(() => resetShowcaseAction());
    if (!got.ok || !got.value.ok) {
      toast({ text: got.ok ? (got.value.ok ? "" : got.value.error) : got.message, tone: "bad" });
      return false;
    }
    setCards(got.value.cards);
    setPhase({});
    setErrors({});
    setApi(null);
    return true;
  }

  async function fullFlow() {
    setBusy(true);
    if (await reset()) {
      for (const step of SHOWCASE_STEPS) {
        if (!(await runStep(step))) break;
        await new Promise((r) => setTimeout(r, 450)); // a beat between cards, so a recording can follow
      }
    }
    setBusy(false);
  }

  const one = async (step: ShowcaseStep) => {
    setBusy(true);
    await runStep(step);
    setBusy(false);
  };
  const resetOnly = async () => {
    setBusy(true);
    if (await reset()) toast({ text: "The showcase fleet was made afresh.", tone: "ok" });
    setBusy(false);
  };

  const stateOf = (c: StepCard): Phase => phase[c.step] ?? (c.done ? "done" : "idle");

  return (
    <div className="sc-board">
      <div className="sc-bar">
        <span className="sc-sim">{SIMULATOR_LABEL}</span>
        <span className="tl-sub">Everything below runs in its own showcase fleet, against the desk&apos;s built-in simulators. No company is called and no real fleet is touched.</span>
        <div className="sc-bar-actions">
          <button type="button" className="tl-btn" disabled={busy} onClick={() => void resetOnly()}>
            Reset
          </button>
          <button type="button" className="tl-btn primary" disabled={busy} onClick={() => void fullFlow()}>
            {busy ? "Running…" : "Reset and run the full flow"}
          </button>
        </div>
      </div>

      <ol className="sc-rail" aria-label="Steps">
        {cards.map((c, i) => (
          <li key={c.step} className={`sc-rail-step is-${stateOf(c)}`}>
            <button type="button" className="sc-rail-btn" onClick={() => show(c.step)}>
              <span className="sc-rail-n">{i + 1}</span>
              <span className="sc-rail-t">{STEP_INFO[c.step].title}</span>
            </button>
          </li>
        ))}
      </ol>

      <div className="sc-grid">
        {cards.map((c, i) => {
          const st = stateOf(c);
          const info = STEP_INFO[c.step];
          const code = c.step === "read_api" ? api : c.code;
          return (
            <section key={c.step} ref={(el) => void (refs.current[c.step] = el)} className={`tl-card sc-card is-${st}`} aria-busy={st === "running" ? "true" : undefined}>
              <header className="sc-head">
                <span className="sc-n">{i + 1}</span>
                <div className="sc-title">
                  <h3>{info.title}</h3>
                  <span className="tl-sub">{info.modeledOn}</span>
                </div>
                <span className={`tl-chip ${st === "done" ? "ok" : st === "error" ? "bad" : st === "running" ? "warn" : ""}`}>{st === "done" ? "Landed" : st === "running" ? "Running" : st === "error" ? "Stopped" : "Not run"}</span>
              </header>
              <p className="tl-note sc-does">{info.does}</p>
              {c.figures.length > 0 ? (
                <dl className="sc-figs">
                  {c.figures.map(([k, v]) => (
                    <div key={k} className="sc-fig">
                      <dt>{k}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {code ? <pre className="sc-code">{code}</pre> : c.step === "read_api" && c.done ? <p className="tl-sub">Run this step to see the API&apos;s answer.</p> : null}
              {errors[c.step] ? (
                <p className="tl-note warn" role="alert">
                  {errors[c.step]}
                </p>
              ) : null}
              <footer className="sc-foot">
                <span className="sc-sim sm">{SIMULATOR_LABEL}</span>
                <button type="button" className="tl-btn ghost sm" disabled={busy} onClick={() => void one(c.step)}>
                  {c.done ? "Run again" : "Run this step"}
                </button>
              </footer>
            </section>
          );
        })}
      </div>
    </div>
  );
}
