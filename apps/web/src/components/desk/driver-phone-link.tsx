"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { checkDriverLinkAction, endDriverLinkAction, issueDriverInviteAction } from "@/app/(desk)/actions";
import { LINK_RELATIONSHIPS, relationshipOf, type LinkRole } from "@/lib/driver-link-roles";
import { useToast } from "./kit/toast";
import { useDraft } from "./kit/use-draft";

export type PhoneLinkView =
  | { kind: "linked"; since: string | null }
  | { kind: "pending"; expiresAt: string }
  | { kind: "expired" }
  | { kind: "none" };

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * The driver's phone, on their page (Phase 2 step 1). Not linked: pick how they work for you and make a code; the code shows once, to read out or send, and stops working after a week or
 * when a new one is made. Waiting: check now (the desk also checks every minute). Linked: the desk reaches their phone; ending the link clears it on both sides.
 */
export function DriverPhoneLink({ driverId, driverName, view, suggestedRole, canEdit }: { driverId: string; driverName: string; view: PhoneLinkView; suggestedRole: LinkRole; canEdit: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  // The role picked before the code is made survives leaving the page (desk rule: typed fields are kept, forms-keep-fields.test.ts).
  const [form, setForm, draft] = useDraft(`driver-link-role:${driverId}`, { role: suggestedRole as string });
  const role = relationshipOf(form.role as LinkRole);
  const [made, setMade] = React.useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = React.useState("");

  const make = () =>
    start(async () => {
      const out = await issueDriverInviteAction(driverId, role);
      if (!out.ok) return setError(out.error);
      setError("");
      setMade({ code: out.code, expiresAt: out.expiresAt });
      draft.saved();
      router.refresh();
    });
  const check = () =>
    start(async () => {
      const out = await checkDriverLinkAction();
      if (!out.ok) return setError(out.error);
      setError("");
      toast({ text: out.linked > 0 ? "Linked." : "Not claimed yet.", tone: out.linked > 0 ? "ok" : "plain" });
      router.refresh();
    });
  const end = () =>
    start(async () => {
      if (!window.confirm(`End the link with ${driverName}'s phone? Their app stops getting loads from you until they enter a new code.`)) return;
      const out = await endDriverLinkAction(driverId);
      if (!out.ok) return setError(out.error);
      setError("");
      setMade(null);
      toast({ text: "Link ended.", tone: "ok" });
      router.refresh();
    });
  const copy = async () => {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made.code);
      toast({ text: "Code copied.", tone: "ok" });
    } catch {
      toast({ text: "Copy did not work here: select the code instead.", tone: "plain" });
    }
  };

  return (
    <div className="pl-link" data-testid="driver-phone-link">
      {view.kind === "linked" ? (
        <p className="tl-note ok">
          Linked to {driverName}&apos;s TrueLane app{view.since ? ` since ${when(view.since)}` : ""}. Loads you send reach their phone.
        </p>
      ) : made ? (
        <div className="pl-link">
          <p>
            Give {driverName} this code. In the TrueLane app: Profile, then Connect to your carrier. It works once, until {when(made.expiresAt)}.
          </p>
          <div className="pl-link-row">
            <code className="tl-num pl-link-code" data-testid="driver-link-code">
              {made.code}
            </code>
            <button type="button" className="tl-btn ghost sm" onClick={copy}>
              Copy
            </button>
          </div>
          <p className="tl-muted">
            The code is not kept here: if it is lost, make a new one.
          </p>
        </div>
      ) : view.kind === "pending" ? (
        <p>A code was made and has not been used yet. It works until {when(view.expiresAt)}.</p>
      ) : view.kind === "expired" ? (
        <p>The last code ran out before it was used.</p>
      ) : (
        <p>Not linked: you record {driverName}&apos;s answers. A code links their TrueLane app so loads reach their phone.</p>
      )}

      {canEdit ? (
        <div className="pl-link-row">
          {view.kind === "linked" ? (
            <button type="button" className="tl-btn ghost sm" disabled={pending} onClick={end}>
              End the link
            </button>
          ) : (
            <>
              <label className="tl-field">
                <span className="db-sr-only">Who this driver is to you</span>
                <select value={role} onChange={(e) => setForm({ role: e.target.value })} aria-label="Who this driver is to you">
                  {LINK_RELATIONSHIPS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="tl-btn sm" disabled={pending} onClick={make}>
                {view.kind === "pending" || made ? "Make a new code" : "Make a link code"}
              </button>
              {view.kind === "pending" || made ? (
                <button type="button" className="tl-btn ghost sm" disabled={pending} onClick={check}>
                  Check now
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {error ? (
        <span className="tl-note warn" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
