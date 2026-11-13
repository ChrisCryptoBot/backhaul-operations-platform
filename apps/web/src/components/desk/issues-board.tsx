"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { replayPartnerEventAction, resolvePartnerIssueAction, retryPartnerSyncAction, retryWebhookDeliveryAction } from "@/app/(desk)/actions";
import { EVENT_LABEL, MAX_ATTEMPTS, type WebhookEvent } from "@/lib/webhook-events";
import { Card } from "./ui";
import { EmptyState } from "./kit/states";
import { useToast } from "./kit/toast";
import { tried } from "./kit/tried";
import { DraftNote, useDraft } from "./kit/use-draft";

/**
 * Partner issues (Wave 7 step 4): four lists, one screen. An admin runs an item again or settles it (resolved or dismissed, with a word of why); the billing office reads. The note is kept as a
 * draft while it is being written.
 */
export type InboundView = { id: string; provider: string; company: string; kind: string; outcome: string; detail: string | null; receivedAt: string; attemptedAt: string | null; canReplay: boolean };
export type OutboundView = { id: string; eventId: string; type: string; status: string; attempts: number; lastStatus: number | null; lastError: string | null; nextAttemptAt: string; createdAt: string; endpoint: string; endpointOn: boolean };
export type SyncView = { capability: string; provider: string; label: string; company: string; why: string; lastSyncedAt: string | null; canRetry: boolean };
export type SignInView = { provider: string; company: string; expired: boolean; runsOutAt: string | null };

type Settle = { key: string; note: string };
const NONE: Settle = { key: "", note: "" };

const inboundWord = (e: InboundView) => (e.outcome === "failed" ? { word: "Could not apply", tone: "bad" } : e.outcome === "received" ? { word: "Stopped part way", tone: "bad" } : { word: "Not used", tone: "warn" });

export function IssuesBoard({ canAct, inbound, outbound, syncs, signIns }: { canAct: boolean; inbound: InboundView[]; outbound: OutboundView[]; syncs: SyncView[]; signIns: SignInView[] }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [settle, setSettle, kept] = useDraft<Settle>("partner-issue-settle", NONE);
  const total = inbound.length + outbound.length + syncs.length + signIns.length;

  async function run<T extends { ok: boolean }>(fn: () => Promise<T>, done: (v: T) => void) {
    setBusy(true);
    const got = await tried(fn);
    setBusy(false);
    if (!got.ok) return toast({ text: got.message, tone: "bad" });
    if (!got.value.ok) return toast({ text: (got.value as unknown as { error: string }).error, tone: "bad" });
    done(got.value);
    router.refresh();
  }

  const replay = (id: string) =>
    run(
      () => replayPartnerEventAction(id),
      (v) => {
        if (!v.ok) return;
        toast(v.outcome === "applied" ? { text: "Run again: it applied.", tone: "ok" } : v.outcome === "ignored" ? { text: `Run again, still not used: ${v.detail ?? "nothing to do"}`, tone: "bad" } : { text: "Run again and it failed again. It stays here.", tone: "bad" });
      }
    );
  const resend = (id: string) =>
    run(
      () => retryWebhookDeliveryAction(id),
      (v) => {
        if (!v.ok) return;
        toast(v.delivered ? { text: "Sent again: the receiver took it.", tone: "ok" } : { text: `Sent again, not taken: ${(v.error ?? "no answer").replace(/\.$/, "")}. It will be tried again on its schedule.`, tone: "bad" });
      }
    );
  const ask = (capability: string, provider: string) => run(() => retryPartnerSyncAction(capability, provider), () => toast({ text: "Asked again: the schedule calls it now.", tone: "ok" }));
  const close = (kind: "inbound" | "outbound", id: string, resolution: "resolved" | "dismissed") =>
    run(
      () => resolvePartnerIssueAction(kind, id, resolution, settle.note),
      () => {
        kept.saved();
        setSettle(NONE);
        toast({ text: resolution === "resolved" ? "Marked resolved." : "Dismissed.", tone: "ok" });
      }
    );

  const settleRow = (kind: "inbound" | "outbound", id: string, cols: number) =>
    settle.key === `${kind}:${id}` ? (
      <tr className="pi-settle">
        <td colSpan={cols}>
          <DraftNote draft={kept} what="this note" />
          <div className="pi-settle-row">
            <input value={settle.note} onChange={(e) => setSettle({ ...settle, note: e.target.value })} maxLength={300} placeholder="Why it is settled (goes in the audit trail)" aria-label="Why it is settled" disabled={busy} />
            <button type="button" className="tl-btn sm" disabled={busy} onClick={() => void close(kind, id, "resolved")}>
              Resolved
            </button>
            <button type="button" className="tl-btn ghost sm" disabled={busy} onClick={() => void close(kind, id, "dismissed")}>
              Dismiss
            </button>
            <button type="button" className="tl-btn ghost sm" disabled={busy} onClick={() => setSettle(NONE)}>
              Cancel
            </button>
          </div>
        </td>
      </tr>
    ) : null;

  if (total === 0) {
    return (
      <EmptyState icon="check" title="Nothing needs you">
        Every company event was used, every webhook got through, and every connection answers on time.
      </EmptyState>
    );
  }

  return (
    <div className="kstack">
      {inbound.length > 0 ? (
        <Card title={`From companies (${inbound.length})`} className="tl-card">
          <p className="tl-note pi-lead">What a company sent that the desk could not use. One that failed on the desk&apos;s side can be run again here; one that names an invoice the desk does not know is used when the company sends it again. An event already applied is never applied twice.</p>
          <table className="tl-table pi-table" aria-label="Company events not used">
            <thead>
              <tr>
                <th>Received</th>
                <th>Company</th>
                <th>Event</th>
                <th>State</th>
                <th>Why</th>
                {canAct ? <th aria-label="Actions" /> : null}
              </tr>
            </thead>
            <tbody>
              {inbound.map((e) => {
                const st = inboundWord(e);
                return (
                  <React.Fragment key={e.id}>
                    <tr>
                      <td>{e.receivedAt}</td>
                      <td>{e.company}</td>
                      <td>
                        <code>{e.kind}</code>
                      </td>
                      <td>
                        <span className={`tl-chip ${st.tone}`}>{st.word}</span>
                      </td>
                      <td className="pi-why">
                        {e.detail ?? ""}
                        {e.outcome === "ignored" ? <span className="tl-sub pi-sub">Fix it on the desk, then ask {e.company} to send it again: it runs again then.</span> : null}
                      </td>
                      {canAct ? (
                        <td className="ak-act">
                          {e.canReplay ? (
                            <button type="button" className="tl-btn ghost sm" disabled={busy} onClick={() => void replay(e.id)}>
                              Run again
                            </button>
                          ) : null}
                          <button type="button" className="tl-btn ghost sm" disabled={busy} onClick={() => setSettle({ key: `inbound:${e.id}`, note: settle.key === `inbound:${e.id}` ? settle.note : "" })}>
                            Settle
                          </button>
                        </td>
                      ) : null}
                    </tr>
                    {canAct ? settleRow("inbound", e.id, 6) : null}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </Card>
      ) : null}

      {outbound.length > 0 ? (
        <Card title={`Webhooks not delivered (${outbound.length})`} className="tl-card">
          <p className="tl-note pi-lead">Events the desk sent that the receiver did not take. Sending again sends the same event (same id, same body), which a receiver keeps only once.</p>
          <table className="tl-table pi-table" aria-label="Webhook deliveries not taken">
            <thead>
              <tr>
                <th>Made</th>
                <th>Event</th>
                <th>To</th>
                <th>State</th>
                <th>Last answer</th>
                {canAct ? <th aria-label="Actions" /> : null}
              </tr>
            </thead>
            <tbody>
              {outbound.map((d) => (
                <React.Fragment key={d.id}>
                  <tr>
                    <td>{d.createdAt}</td>
                    <td>
                      {EVENT_LABEL[d.type as WebhookEvent] ?? d.type}
                      <span className="tl-sub pi-sub">{d.eventId}</span>
                    </td>
                    <td>
                      {d.endpoint}
                      {d.endpointOn ? null : <span className="tl-sub pi-sub">switched off</span>}
                    </td>
                    <td>{d.status === "dead" ? <span className="tl-chip bad">Gave up after {d.attempts}</span> : <span className="tl-chip warn">Trying again {d.nextAttemptAt} ({d.attempts} of {MAX_ATTEMPTS})</span>}</td>
                    <td className="pi-why">
                      {d.lastStatus != null ? `${d.lastStatus} ` : ""}
                      {d.lastError ?? ""}
                    </td>
                    {canAct ? (
                      <td className="ak-act">
                        <button type="button" className="tl-btn ghost sm" disabled={busy || !d.endpointOn} title={d.endpointOn ? undefined : "Switch the webhook on in Settings first"} onClick={() => void resend(d.id)}>
                          Send again
                        </button>
                        <button type="button" className="tl-btn ghost sm" disabled={busy} onClick={() => setSettle({ key: `outbound:${d.id}`, note: settle.key === `outbound:${d.id}` ? settle.note : "" })}>
                          Settle
                        </button>
                      </td>
                    ) : null}
                  </tr>
                  {canAct ? settleRow("outbound", d.id, 6) : null}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {syncs.length > 0 ? (
        <Card title={`Connections (${syncs.length})`} className="tl-card">
          <table className="tl-table pi-table" aria-label="Connections that stopped">
            <thead>
              <tr>
                <th>Company</th>
                <th>For</th>
                <th>What is wrong</th>
                <th>Last answer</th>
                {canAct ? <th aria-label="Actions" /> : null}
              </tr>
            </thead>
            <tbody>
              {syncs.map((s) => (
                <tr key={`${s.capability}:${s.provider}`}>
                  <td>{s.company}</td>
                  <td>{s.label}</td>
                  <td className="pi-why">{s.why}</td>
                  <td>{s.lastSyncedAt ?? "Never"}</td>
                  {canAct ? (
                    <td className="ak-act">
                      {s.canRetry ? (
                        <button type="button" className="tl-btn ghost sm" disabled={busy} onClick={() => void ask(s.capability, s.provider)}>
                          Try again now
                        </button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {signIns.length > 0 ? (
        <Card title={`Sign-ins (${signIns.length})`} className="tl-card">
          <table className="tl-table pi-table" aria-label="Sign-ins running out">
            <thead>
              <tr>
                <th>Company</th>
                <th>State</th>
                <th>What to do</th>
              </tr>
            </thead>
            <tbody>
              {signIns.map((t) => (
                <tr key={t.provider}>
                  <td>{t.company}</td>
                  <td>{t.expired ? <span className="tl-chip bad">Run out</span> : <span className="tl-chip warn">Runs out {t.runsOutAt}</span>}</td>
                  <td>
                    Sign in to {t.company} again from <a href="/settings?tab=integrations">Settings, Integrations</a>.{t.expired ? " Nothing is read from it until then." : " The nightly sync keeps it alive while it runs; if it has stopped, sign in again before then."}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </div>
  );
}
