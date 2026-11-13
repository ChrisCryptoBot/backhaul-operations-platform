"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { createWebhookAction, rotateWebhookSecretAction, sendWebhookTestAction, setWebhookActiveAction } from "@/app/(desk)/actions";
import { EVENT_LABEL, MAX_ATTEMPTS, TEST_EVENT, WEBHOOK_EVENTS, type WebhookEvent } from "@/lib/webhook-events";
import { useToast } from "./kit/toast";
import { tried } from "./kit/tried";
import { DraftNote, useDraft } from "./kit/use-draft";

/**
 * Settings, Integrations: outbound webhooks (docs/MONEY_PLAN.md, Wave 7 step 3). Admins add an address and the events it gets; the signing secret is shown once (after making it or a new
 * one) and held only in this component's memory until "Done". The latest deliveries show what was sent and what is waiting to be tried again. Nobody else sees this card.
 */
export type EndpointView = { id: string; url: string; label: string | null; events: WebhookEvent[]; secretLast4: string; on: boolean; disabledAt: string | null; disabledReason: string | null; deadInARow: number; createdBy: string | null; createdAt: string };
export type DeliveryView = { id: string; endpointId: string; eventId: string; type: string; status: string; attempts: number; lastStatus: number | null; lastError: string | null; createdAt: string; sentAt: string | null; nextAttemptAt: string };
type Draft = { url: string; label: string; events: WebhookEvent[] };
const BLANK: Draft = { url: "", label: "", events: [...WEBHOOK_EVENTS] };

const stateOf = (d: DeliveryView): { word: string; tone: string } =>
  d.status === "sent" ? { word: "Sent", tone: "ok" } : d.status === "dead" ? { word: d.type === TEST_EVENT ? "Test failed" : `Gave up after ${d.attempts}`, tone: "bad" } : d.status === "failed" ? { word: `Trying again ${d.nextAttemptAt} (${d.attempts} of ${MAX_ATTEMPTS})`, tone: "warn" } : { word: "Waiting to send", tone: "" };

export function WebhooksCard({ endpoints, deliveries, canEdit, planRefusal, keyMissing }: { endpoints: EndpointView[]; deliveries: DeliveryView[]; canEdit: boolean; planRefusal: string | null; keyMissing: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [f, setF, kept] = useDraft<Draft>("webhook-new", BLANK);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [shown, setShown] = React.useState<{ secret: string; where: string } | null>(null);
  const [confirming, setConfirming] = React.useState<string | null>(null);
  const hostOf = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };
  const where = (id: string) => {
    const e = endpoints.find((x) => x.id === id);
    return e ? e.label || hostOf(e.url) : "a removed address";
  };

  async function run<T extends { ok: boolean }>(fn: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    const got = await tried(fn);
    setBusy(false);
    if (!got.ok) {
      toast({ text: got.message, tone: "bad" });
      return null;
    }
    return got.value;
  }

  async function create() {
    setMessage(null);
    const out = await run(() => createWebhookAction(f.url, f.label, f.events));
    if (!out) return;
    if (!out.ok) return setMessage(out.error);
    kept.saved();
    setShown({ secret: out.secret, where: f.label || hostOf(f.url) });
    setF(BLANK);
    router.refresh();
  }

  async function rotate(id: string) {
    if (confirming !== `rotate:${id}`) return setConfirming(`rotate:${id}`);
    setConfirming(null);
    const out = await run(() => rotateWebhookSecretAction(id));
    if (!out) return;
    if (!out.ok) return toast({ text: out.error, tone: "bad" });
    setShown({ secret: out.secret, where: where(id) });
    router.refresh();
  }

  async function toggle(id: string, on: boolean) {
    const out = await run(() => setWebhookActiveAction(id, on));
    if (!out) return;
    if (!out.ok) return toast({ text: out.error, tone: "bad" });
    toast({ text: on ? "Webhook switched on." : "Webhook switched off: nothing more is sent to it until it is switched on.", tone: "ok" });
    router.refresh();
  }

  async function test(id: string) {
    const out = await run(() => sendWebhookTestAction(id));
    if (!out) return;
    if (!out.ok) return toast({ text: out.error, tone: "bad" });
    toast(out.delivered ? { text: `Test delivered: the receiver answered ${out.status}.`, tone: "ok" } : { text: `Test not delivered: ${out.error ?? "no answer"}`, tone: "bad" });
    router.refresh();
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast({ text: "Secret copied.", tone: "ok" });
    } catch {
      toast({ text: "This browser would not copy it: select the secret and copy it by hand.", tone: "bad" });
    }
  }

  const tick = (e: WebhookEvent) => setF({ ...f, events: f.events.includes(e) ? f.events.filter((x) => x !== e) : [...f.events, e] });

  return (
    <div className="wh-card">
      <p className="tl-note dlg-lead">
        TrueLane tells another system when money moves: an invoice made or taken back, a credit memo, a payment recorded or taken back, a driver statement finalized or voided. Each event is posted
        to the address as JSON, signed with the address&apos;s own secret, and tried again for a day and a half if the receiver does not answer with a 2xx. Drivers are named by id only.
      </p>
      <p className="tl-sub wh-recipe">
        Headers <code>x-truelane-event-id</code>, <code>x-truelane-timestamp</code>, <code>x-truelane-signature: t=…,v1=…</code>; v1 is the hex HMAC-SHA256 of <code>timestamp.body</code>. Keep the event id to do each event once.
      </p>

      {shown ? (
        <div className="ak-made" role="status">
          <p className="ak-made-lead">
            <b>Copy the signing secret for {shown.where} now.</b> It is shown once; TrueLane keeps it sealed and cannot show it again. Put it in the receiver to check each signature.
          </p>
          <div className="ak-made-row">
            <input className="ak-secret" readOnly value={shown.secret} aria-label={`The signing secret for ${shown.where}`} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="tl-btn sm" onClick={() => void copy(shown.secret)}>
              Copy
            </button>
            <button type="button" className="tl-btn primary sm" onClick={() => setShown(null)}>
              Done
            </button>
          </div>
        </div>
      ) : null}

      {endpoints.length > 0 ? (
        <table className="tl-table wh-table" aria-label="Webhook addresses">
          <thead>
            <tr>
              <th>Address</th>
              <th>Events</th>
              <th>Secret</th>
              <th>State</th>
              {canEdit ? <th aria-label="Actions" /> : null}
            </tr>
          </thead>
          <tbody>
            {endpoints.map((e) => (
              <tr key={e.id} aria-disabled={e.on ? undefined : "true"}>
                <td className="wh-addr">
                  {e.label ? <b>{e.label}</b> : null}
                  <span className="tl-sub">{e.url}</span>
                </td>
                <td title={e.events.map((x) => EVENT_LABEL[x]).join(", ")}>{e.events.length === WEBHOOK_EVENTS.length ? "All" : `${e.events.length} of ${WEBHOOK_EVENTS.length}`}</td>
                <td>
                  <code>…{e.secretLast4}</code>
                </td>
                <td>
                  {e.on ? <span className="tl-chip ok">On</span> : e.disabledAt ? <span className="tl-chip bad" title={e.disabledReason ?? undefined}>Switched off by TrueLane</span> : <span className="tl-chip">Off</span>}
                  {e.disabledReason ? <span className="tl-sub wh-why">{e.disabledReason}</span> : null}
                </td>
                {canEdit ? (
                  <td className="ak-act">
                    {e.on ? (
                      <button type="button" className="tl-btn ghost sm" disabled={busy || planRefusal != null} onClick={() => void test(e.id)}>
                        Send a test
                      </button>
                    ) : null}
                    <button type="button" className="tl-btn ghost sm" disabled={busy || (!e.on && planRefusal != null)} onClick={() => void toggle(e.id, !e.on)}>
                      {e.on ? "Switch off" : "Switch on"}
                    </button>
                    <button type="button" className="tl-btn ghost sm" disabled={busy || planRefusal != null || keyMissing} onClick={() => void rotate(e.id)}>
                      {confirming === `rotate:${e.id}` ? "Confirm new secret" : "New secret"}
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="tl-sub">No webhook addresses yet.</p>
      )}

      {planRefusal ? (
        <p className="tl-note warn ak-plan">{planRefusal}</p>
      ) : keyMissing ? (
        <p className="tl-note warn ak-plan">This server cannot keep a signing secret yet: whoever runs it sets the credential key first.</p>
      ) : canEdit ? (
        <form
          className="dlg-form ak-new"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void create();
          }}>
          <DraftNote draft={kept} what="this address" />
          <div className="dlg-two">
            <label className="tl-field">
              Address
              <input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} maxLength={500} autoComplete="off" placeholder="https://hooks.example.com/truelane" disabled={busy} />
              <span className="th-hint">https only. It must reach the public internet: private and local addresses are refused.</span>
            </label>
            <label className="tl-field">
              Name (optional)
              <input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} maxLength={60} autoComplete="off" disabled={busy} />
              <span className="th-hint">Like &ldquo;Books sync&rdquo;.</span>
            </label>
          </div>
          <fieldset className="ak-scopes">
            <legend>Send these events</legend>
            {WEBHOOK_EVENTS.map((e) => (
              <label key={e} className="ak-scope">
                <input type="checkbox" checked={f.events.includes(e)} onChange={() => tick(e)} disabled={busy} /> {EVENT_LABEL[e]}
              </label>
            ))}
          </fieldset>
          <div className="dlg-foot-row">
            {message ? (
              <span className="tl-note warn" role="alert">
                {message}
              </span>
            ) : null}
            <button type="submit" className="tl-btn primary" disabled={busy}>
              {busy ? "Saving…" : "Add the address"}
            </button>
          </div>
        </form>
      ) : null}

      {deliveries.length > 0 ? (
        <>
          <p className="wh-sub-head">
            <b>Latest deliveries</b>
          </p>
          <table className="tl-table wh-table" aria-label="Latest webhook deliveries">
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>To</th>
                <th>State</th>
                <th>Last answer</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => {
                const st = stateOf(d);
                return (
                  <tr key={d.id}>
                    <td>{d.createdAt}</td>
                    <td>
                      {d.type === TEST_EVENT ? "Test" : (EVENT_LABEL[d.type as WebhookEvent] ?? d.type)}
                      <span className="tl-sub wh-evt">{d.eventId}</span>
                    </td>
                    <td>{where(d.endpointId)}</td>
                    <td>
                      <span className={`tl-chip ${st.tone}`}>{st.word}</span>
                    </td>
                    <td className="wh-answer">{d.lastStatus != null ? `${d.lastStatus}` : ""}{d.lastError ? <span className="tl-sub">{d.lastError}</span> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      ) : null}
    </div>
  );
}
