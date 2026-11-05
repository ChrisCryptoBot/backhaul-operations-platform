"use client";

import { useRouter } from "next/navigation";
import React from "react";
import Link from "next/link";
import { connectPartnerAction, disconnectPartnerAction, removePartnerKeysAction, retryPartnerAction, savePartnerKeysAction, sendTestEventAction } from "@/app/(desk)/actions";
import { tried } from "./kit/tried";
import { useToast } from "./kit/toast";

export type KeyField = { name: string; set: boolean; hint: string | null; from: "fleet" | "server" | null };
export type IntegrationItem = {
  capability: string;
  label: string;
  provider: string;
  name: string;
  /** Every key the company needs is set (the fleet's own, or the server's). */
  configured: boolean;
  /** pending | connected | error | revoked, or none. */
  status: string;
  lastError: string | null;
  failures: number;
  lastSyncedAt: string | null;
  /** How this kind of company reaches the desk, in a sentence. */
  rhythm: string;
  /** Read on a clock, and has not answered for longer than that rhythm allows. */
  overdue: boolean;
  /** The keys are test keys: calls go to the built-in simulator and nothing leaves the desk. */
  sandbox: boolean;
  fields: KeyField[];
  /** Where the company posts its events for this fleet, once connected. */
  webhookPath: string | null;
};

const WHY: Record<string, string> = { upstream_error: "The company did not answer." };

function stateOf(r: IntegrationItem): { word: string; tone: "ok" | "warn" | "bad" | undefined } {
  if (r.status === "connected") return { word: "Connected", tone: "ok" };
  if (r.status === "error") return { word: "Needs attention", tone: "bad" };
  if (r.status === "revoked") return { word: "Disconnected", tone: undefined };
  return r.configured ? { word: "Ready to connect", tone: "warn" } : { word: "Keys needed", tone: undefined };
}

/**
 * Settings, Integrations: for each company, where it stands (keys needed, ready, connected, needs attention), the fleet's own keys (sealed on the server; only the last four characters ever come back),
 * the address the company posts its events to, and the buttons that move it. Secrets are typed here and sent once: they are never kept in the browser (no draft, no storage), and the
 * boxes are emptied the moment they are saved. The live link to a company is its own piece of work: a connected company says so honestly until its link is switched on.
 */
export function IntegrationsPanel({ items, canKeep, whyNot = "An admin sets the keys.", sandboxOn = false, origin }: { items: IntegrationItem[]; canKeep: boolean; whyNot?: string; /** The built-in simulator may run on this desk (the demo desk). */ sandboxOn?: boolean; origin: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [open, setOpen] = React.useState<string | null>(null);
  const [typed, setTyped] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState("");
  /** What the last test event did, by company: the receipt a person can point at. */
  const [receipts, setReceipts] = React.useState<Record<string, { what: string; result: string; loadId: string | null }>>({});
  const key = (r: IntegrationItem) => `${r.capability}:${r.provider}`;

  const run = (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const got = await tried(fn);
      if (!got.ok) return setError(got.message);
      if (!got.value.ok) return setError(got.value.error ?? "That did not work.");
      setError("");
      toast({ text: label, tone: "ok" });
      router.refresh();
    });

  const testEvent = (r: IntegrationItem) =>
    start(async () => {
      const got = await tried(() => sendTestEventAction(r.capability, r.provider));
      if (!got.ok) return setError(got.message);
      if (!got.value.ok) return setError(got.value.error);
      setError("");
      const { what, result, loadId } = got.value;
      setReceipts((m) => ({ ...m, [key(r)]: { what, result, loadId } }));
      toast({ text: what, tone: "ok" });
      router.refresh();
    });

  const saveKeys = (r: IntegrationItem) => {
    const values = Object.fromEntries(r.fields.map((f) => [f.name, typed[`${r.provider}:${f.name}`] ?? ""]).filter(([, v]) => (v as string).trim() !== ""));
    start(async () => {
      const got = await tried(() => savePartnerKeysAction(r.provider, values as Record<string, string>));
      if (!got.ok) return setError(got.message);
      if (!got.value.ok) return setError(got.value.error);
      // The secrets leave this page the moment they are saved.
      setTyped((t) => Object.fromEntries(Object.entries(t).filter(([k]) => !k.startsWith(`${r.provider}:`))));
      setError("");
      toast({ text: got.value.sandbox && got.value.connected ? `${r.name} keys saved. Connected to the simulator.` : `${r.name} keys saved.`, tone: "ok" });
      router.refresh();
    });
  };

  return (
    <>
      <table className="t-tbl" aria-label="Partner companies">
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">Company</th>
            <th scope="col">State</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {items.map((r) => {
            const st = stateOf(r);
            const isOpen = open === key(r);
            return (
              <React.Fragment key={key(r)}>
                <tr>
                  <td>{r.label}</td>
                  <td>{r.name}</td>
                  <td>
                    <span className="t-st" data-tone={st.tone}>{st.word}</span>
                    {r.status === "error" ? <span className="t-dim"> · {WHY[r.lastError ?? ""] ?? "Calls are failing."} ({r.failures} in a row)</span> : null}
                    {r.status === "connected" ? <span className="t-dim"> · {r.lastSyncedAt ? `answered ${r.lastSyncedAt}` : "not called yet"}</span> : null}
                    {r.sandbox ? <span className="t-st" data-tone="warn" title="These are test keys. Calls go to the built-in simulator and nothing leaves the desk.">Simulator</span> : null}
                    {r.overdue ? <span className="t-st" data-tone="warn" title="This one is read on a clock and has not answered for longer than it should.">Overdue</span> : null}
                  </td>
                  <td className="n">
                    <button type="button" className="t-btn sm" aria-expanded={isOpen} aria-controls={`int-${key(r)}`} onClick={() => setOpen(isOpen ? null : key(r))}>
                      {isOpen ? "Close" : "Set up"}
                    </button>
                  </td>
                </tr>
                {isOpen ? (
                  <tr id={`int-${key(r)}`}>
                    <td colSpan={4}>
                      <div style={{ display: "grid", gap: 10, padding: "8px 0 12px", maxWidth: 640 }}>
                        <div>
                          <div className="t-lbl">This fleet&apos;s keys for {r.name}</div>
                          {canKeep ? (
                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                saveKeys(r);
                              }}
                              autoComplete="off"
                              style={{ display: "grid", gap: 6, marginTop: 4 }}
                            >
                              {r.fields.map((f) => (
                                <label key={f.name} className="t-fld">
                                  <span>{f.name}</span>
                                  <span className="t-in">
                                    <input
                                      type="password"
                                      autoComplete="new-password"
                                      spellCheck={false}
                                      value={typed[`${r.provider}:${f.name}`] ?? ""}
                                      placeholder={f.set ? (f.from === "fleet" ? `Saved ${f.hint ?? ""}. Type to replace.` : "Set on the server. Type to use your own.") : "Not set"}
                                      onChange={(e) => setTyped((t) => ({ ...t, [`${r.provider}:${f.name}`]: e.target.value }))}
                                    />
                                  </span>
                                </label>
                              ))}
                              <div style={{ display: "flex", gap: 6 }}>
                                <button type="submit" className="t-btn sm pri" disabled={pending || r.fields.every((f) => !(typed[`${r.provider}:${f.name}`] ?? "").trim())}>
                                  Save keys
                                </button>
                                {r.fields.some((f) => f.from === "fleet") ? (
                                  <button type="button" className="t-btn sm" disabled={pending} onClick={() => run(`${r.name} keys removed.`, () => removePartnerKeysAction(r.provider))}>
                                    Remove this fleet&apos;s keys
                                  </button>
                                ) : null}
                              </div>
                            </form>
                          ) : (
                            <p className="t-note">{whyNot}</p>
                          )}
                        </div>
                        {r.webhookPath ? (
                          <div>
                            <div className="t-lbl">Where {r.name} sends its events</div>
                            <code className="t-typed" style={{ wordBreak: "break-all" }}>{`${origin}${r.webhookPath}`}</code>
                            <p className="t-note">Paste this into {r.name}&apos;s webhook settings, with the signing secret above. It carries a private token: do not share it.</p>
                          </div>
                        ) : null}
                        {r.rhythm ? <p className="t-note">{r.rhythm}</p> : null}
                        {sandboxOn ? <p className="t-note">To try {r.name} without an account, type a key that starts with sandbox_ (any text after it). It runs the built-in simulator, connects at once, and nothing leaves the desk.</p> : null}
                        <p className="t-note">
                          {r.status === "connected" || r.status === "error"
                            ? `The keys and the webhook address are ready. The live call to ${r.name} is not switched on yet, so nothing is sent to them.`
                            : `Nothing is sent to ${r.name} until it is connected.`}
                        </p>
                        {receipts[key(r)] ? (
                          <p className="t-note" role="status">
                            {receipts[key(r)]!.what}: {receipts[key(r)]!.result}.{" "}
                            {receipts[key(r)]!.loadId ? <Link href={`/loads/${receipts[key(r)]!.loadId}`}>Open the load</Link> : null}
                          </p>
                        ) : null}
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {r.status === "connected" || r.status === "error" ? (
                            <>
                              {r.sandbox && canKeep ? (
                                <button type="button" className="t-btn sm" disabled={pending} title="Runs a signed simulator event through the desk's own receiver. Nothing leaves the desk." onClick={() => testEvent(r)}>
                                  {r.capability === "eld" ? "Read ELD now" : "Send test event"}
                                </button>
                              ) : null}
                              {r.status === "error" ? (
                                <button type="button" className="t-btn sm pri" disabled={pending} onClick={() => run("Trying again.", () => retryPartnerAction(r.capability, r.provider))}>
                                  Try again now
                                </button>
                              ) : null}
                              <button type="button" className="t-btn sm" disabled={pending} onClick={() => run(`${r.name} disconnected.`, () => disconnectPartnerAction(r.capability, r.provider))}>
                                Disconnect
                              </button>
                            </>
                          ) : (
                            <button type="button" className="t-btn sm pri" disabled={pending || !r.configured} title={r.configured ? undefined : "Save this fleet's keys first."} onClick={() => run(`${r.name} connected.`, () => connectPartnerAction(r.capability, r.provider, null))}>
                              Connect
                            </button>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      {error ? (
        <p className="t-note" role="alert" style={{ marginTop: 8, color: "var(--neg)" }}>
          {error}
        </p>
      ) : null}
    </>
  );
}
