"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { checkJournalAction, saveAccountingAccountsAction, syncAccountingAction, type JournalCheck } from "@/app/(desk)/actions";
import type { AccountingSyncResult } from "@/server/partners/qbo-sync";
import { ACCOUNT_KEYS, GROUP_LABEL, labelOfKey, type AccountGroup, type AccountsForm } from "@/lib/accounting-map";
import { DateInput } from "./date-input";
import { useToast } from "./kit/toast";
import { tried } from "./kit/tried";
import { DraftNote, useDraft } from "./kit/use-draft";

/**
 * The fleet's accounting accounts (docs/MONEY_PLAN.md, rules D and E): for each invoice line kind, expense and balance account, the account it is booked to in the fleet's books. A blank
 * box uses the default shown in it; a kind with no default ("Other charges", "Credits") shows "Choose an account" until it has one, and a QuickBooks sync or a journal that needs it
 * stops until then. An admin saves them; everyone else sees them read-only.
 */
export type AccountRow = { key: string; account: string; number: string; fallback: string | null };

export function AccountingAccountsForm({ rows, canEdit }: { rows: AccountRow[]; canEdit: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const initial: AccountsForm = Object.fromEntries(rows.map((r) => [r.key, { account: r.account, number: r.number }]));
  const [f, setF, kept] = useDraft<AccountsForm>("accounting-accounts", initial);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const fallbackOf = new Map(rows.map((r) => [r.key, r.fallback]));
  const set = (key: string, field: "account" | "number") => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [key]: { account: f[key]?.account ?? "", number: f[key]?.number ?? "", [field]: e.target.value } });

  async function save() {
    setErrors({});
    setMessage(null);
    setBusy(true);
    const got = await tried(() => saveAccountingAccountsAction(f));
    setBusy(false);
    if (!got.ok) return setMessage(got.message);
    if (!got.value.ok) return setErrors(got.value.errors);
    kept.saved();
    toast({ text: got.value.changed ? "Accounting accounts saved." : "Nothing had changed.", tone: "ok" });
    router.refresh();
  }

  const groups: AccountGroup[] = ["income", "expense", "balance"];
  return (
    <form
      className="dlg-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (canEdit && !busy) void save();
      }}>
      <DraftNote draft={kept} what="these accounts" />
      {groups.map((g) => (
        <table key={g} className="t-tbl acct-tbl" aria-label={GROUP_LABEL[g]}>
          <thead>
            <tr>
              <th scope="col">{GROUP_LABEL[g]}</th>
              <th scope="col">Account</th>
              <th scope="col">Number</th>
            </tr>
          </thead>
          <tbody>
            {ACCOUNT_KEYS.filter((k) => k.group === g).map((k) => {
              const v = f[k.key] ?? { account: "", number: "" };
              const unmapped = v.account.trim() === "" && !fallbackOf.get(k.key);
              return (
                <tr key={k.key}>
                  <td>
                    {k.label}
                    {unmapped ? (
                      <span className="t-st" data-tone="warn">
                        Choose an account
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <input aria-label={`${k.label}: account`} value={v.account} placeholder={fallbackOf.get(k.key) ?? "Not chosen"} onChange={set(k.key, "account")} disabled={!canEdit} maxLength={100} autoComplete="off" aria-invalid={!!errors[`${k.key}.account`]} />
                    {errors[`${k.key}.account`] ? (
                      <span className="th-err" role="alert">
                        {errors[`${k.key}.account`]}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <input aria-label={`${k.label}: account number`} value={v.number} placeholder="Optional" onChange={set(k.key, "number")} disabled={!canEdit} maxLength={20} autoComplete="off" aria-invalid={!!errors[`${k.key}.number`]} className="acct-num" />
                    {errors[`${k.key}.number`] ? (
                      <span className="th-err" role="alert">
                        {errors[`${k.key}.number`]}
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ))}
      {message ? (
        <p className="tl-note" role="alert">
          {message}
        </p>
      ) : null}
      {canEdit ? (
        <div className="dlg-actions">
          <button type="submit" className="t-btn sm pri" disabled={busy}>
            Save accounts
          </button>
        </div>
      ) : (
        <p className="tl-note">An admin chooses the accounts.</p>
      )}
    </form>
  );
}

/**
 * The journal for any accounting system that is not QuickBooks: pick the days, check, then download. The check says what will be in it, what was left out and why, or what has to be put right
 * first (a record that cannot be booked, a kind with no account). The download is the same rules on the server.
 */
export function JournalExport({ canExport }: { canExport: boolean }) {
  const [span, setSpan] = useDraft<{ from: string; to: string }>("journal-export", { from: "", to: "" });
  const [result, setResult] = React.useState<JournalCheck | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const href = `/invoices/journal?${new URLSearchParams({ ...(span.from ? { from: span.from } : {}), ...(span.to ? { to: span.to } : {}) }).toString()}`;

  async function check() {
    setBusy(true);
    setMessage(null);
    const got = await tried(() => checkJournalAction(span.from || null, span.to || null));
    setBusy(false);
    if (!got.ok) return setMessage(got.message);
    setResult(got.value);
  }

  if (!canExport) return <p className="tl-note">The billing office downloads the journal.</p>;
  return (
    <div className="dlg-form">
      <div className="dlg-two">
        <label className="tl-field">
          First day
          <DateInput value={span.from} onChange={(e) => (setSpan({ ...span, from: e.target.value }), setResult(null))} aria-label="First day" />
        </label>
        <label className="tl-field">
          Last day
          <DateInput value={span.to} onChange={(e) => (setSpan({ ...span, to: e.target.value }), setResult(null))} aria-label="Last day" />
        </label>
      </div>
      <p className="th-hint">Leave both blank for everything. Days are in the fleet&apos;s own time zone.</p>
      <div className="dlg-actions">
        <button type="button" className="t-btn sm" disabled={busy} onClick={() => void check()}>
          Check the journal
        </button>
        {result?.ok ? (
          <a className="t-btn sm pri" href={href} download>
            Download journal CSV
          </a>
        ) : null}
      </div>
      {message ? (
        <p className="tl-note" role="alert">
          {message}
        </p>
      ) : null}
      {result ? (
        result.ok ? (
          <div role="status">
            <p className="tl-note">
              {result.entries} {result.entries === 1 ? "entry" : "entries"} in {result.rows} rows, every one balanced.
            </p>
            {result.notes.map((n) => (
              <p key={n} className="tl-note">
                {n}
              </p>
            ))}
          </div>
        ) : (
          <div role="alert">
            <p className="tl-note acct-bad">{result.error}</p>
            {result.unmapped.length > 0 ? <p className="tl-note">Missing: {result.unmapped.map(labelOfKey).join(", ")}.</p> : null}
            {result.problems.length > 0 ? (
              <ul className="acct-problems">
                {result.problems.slice(0, 20).map((p) => (
                  <li key={p}>{p}</li>
                ))}
                {result.problems.length > 20 ? <li>and {result.problems.length - 20} more.</li> : null}
              </ul>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}

/**
 * Sync with QuickBooks now (docs/MONEY_PLAN.md, Wave 3): push what changed on the desk, pull payments a bookkeeper entered there. What it did is said in numbers; what it could not send is
 * named, one line each. The first sync is always a person's: the nightly one only keeps going what someone started.
 */
export function AccountingSync({ signedIn, canSync, lastSync }: { signedIn: boolean; canSync: boolean; lastSync: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<AccountingSyncResult | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);

  async function sync() {
    setBusy(true);
    setMessage(null);
    const got = await tried(() => syncAccountingAction());
    setBusy(false);
    if (!got.ok) return setMessage(got.message);
    setResult(got.value);
    router.refresh();
  }

  if (!signedIn) return <p className="tl-note">QuickBooks is not signed in. An admin signs in under Settings, Integrations; the journal below works without it.</p>;
  return (
    <div className="dlg-form">
      <p className="tl-note">{lastSync ? `Last synced ${lastSync}. After the first sync, it also runs once a night.` : "Not synced yet. The first sync sends every invoice, payment, credit, factoring entry and 1099 statement the desk has; check the accounts first."}</p>
      {canSync ? (
        <div className="dlg-actions">
          <button type="button" className="t-btn sm pri" disabled={busy} onClick={() => void sync()}>
            {busy ? "Syncing..." : "Sync with QuickBooks now"}
          </button>
        </div>
      ) : (
        <p className="tl-note">The billing office runs the sync.</p>
      )}
      {message ? (
        <p className="tl-note acct-bad" role="alert">
          {message}
        </p>
      ) : null}
      {result ? (
        result.ok ? (
          <div role="status">
            <p className="tl-note">
              {result.created} created, {result.matched} matched to what QuickBooks already had, {result.updated} updated, {result.voided} voided, {result.pulled} {result.pulled === 1 ? "payment" : "payments"} pulled from QuickBooks.
              {result.created + result.matched + result.updated + result.voided + result.pulled === 0 ? " Nothing had changed." : ""}
            </p>
            {result.problems.length > 0 ? (
              <ul className="acct-problems">
                {result.problems.slice(0, 20).map((p) => (
                  <li key={p}>{p}</li>
                ))}
                {result.problems.length > 20 ? <li>and {result.problems.length - 20} more.</li> : null}
              </ul>
            ) : null}
          </div>
        ) : (
          <div role="alert">
            <p className="tl-note acct-bad">{result.error}</p>
            {result.unmapped.length > 0 ? <p className="tl-note">Missing: {result.unmapped.map(labelOfKey).join(", ")}.</p> : null}
          </div>
        )
      ) : null}
    </div>
  );
}
