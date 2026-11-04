"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { addMemberAction, removeMemberAction, setMemberGrantsAction, setMemberRoleAction } from "@/app/(desk)/actions";
import { GRANT_LABEL, ROLES, ROLE_LABEL, ROLE_NOTE, type Grant, type Role } from "@/lib/roles";
import { useToast } from "./kit/toast";
import { DraftNote, useDraft } from "./kit/use-draft";

export type TeamRow = { id: string; email: string; name: string; role: Role; grants: Grant[]; signedIn: boolean; you: boolean };

/**
 * Who is on this desk. Everyone sees the list; an admin adds a person by email (they sign in with that email and are on the desk), changes a role, lets a dispatcher also do the billing
 * office's work, or takes a person off. A plan holds only so many seats, and a desk keeps one admin; the server enforces both and the message says why.
 */
export function TeamCard({ rows, canEdit, seats }: { rows: TeamRow[]; canEdit: boolean; seats: { used: number; limit: number | null } }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [person, setPerson, draft] = useDraft<{ email: string; name: string; role: Role; bill?: boolean }>("team:add", { email: "", name: "", role: "dispatcher" });
  const { email, name, role } = person;
  const bill = role === "dispatcher" && person.bill === true;
  const setEmail = (v: string) => setPerson((p) => ({ ...p, email: v }));
  const setName = (v: string) => setPerson((p) => ({ ...p, name: v }));
  const setRole = (v: Role) => setPerson((p) => ({ ...p, role: v }));
  const full = seats.limit != null && seats.used >= seats.limit;

  const run = (job: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string) =>
    start(async () => {
      const out = await job();
      if (out.ok) {
        toast({ text: done, tone: "ok" });
        router.refresh();
      } else toast({ text: out.error, tone: "bad" });
    });

  return (
    <>
      <p className="tl-note" style={{ marginBottom: 10, maxWidth: "72ch" }}>
        {seats.used} of {seats.limit ?? "no automatic limit on"} seats used. {canEdit ? "Add a person with their email; they sign in with it and are on the desk. A desk keeps one admin." : "Ask an admin to add or change people."}
      </p>
      <table className="tl-table" aria-label="People on this desk">
        <thead>
          <tr>
            <th scope="col">Person</th>
            <th scope="col">Email</th>
            <th scope="col">Role</th>
            <th scope="col">Signed in</th>
            {canEdit ? <th scope="col"><span className="sr-only">Actions</span></th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <b>{r.name}</b>
                {r.you ? <span className="tl-sub"> (you)</span> : null}
              </td>
              <td>{r.email}</td>
              <td>
                {canEdit ? (
                  <select value={r.role} disabled={pending} aria-label={`Role of ${r.name}`} onChange={(e) => run(() => setMemberRoleAction(r.id, e.target.value), `${r.name} is now ${ROLE_LABEL[e.target.value as Role].toLowerCase()}.`)}>
                    {ROLES.map((x) => (
                      <option key={x} value={x}>
                        {ROLE_LABEL[x]}
                      </option>
                    ))}
                  </select>
                ) : (
                  ROLE_LABEL[r.role]
                )}
                {r.role === "dispatcher" ? (
                  canEdit ? (
                    <label className="dlg-check" style={{ display: "block", marginTop: 4 }}>
                      <input type="checkbox" checked={r.grants.includes("bill")} disabled={pending} onChange={(e) => run(() => setMemberGrantsAction(r.id, e.target.checked ? ["bill"] : []), `${r.name} ${e.target.checked ? "can now also bill" : "no longer bills"}.`)} /> {GRANT_LABEL.bill}
                    </label>
                  ) : r.grants.includes("bill") ? (
                    <span className="tl-sub" style={{ display: "block" }}>{GRANT_LABEL.bill}</span>
                  ) : null
                ) : null}
              </td>
              <td>{r.signedIn ? "Yes" : <span className="dim">Not yet</span>}</td>
              {canEdit ? (
                <td>
                  <button type="button" className="tl-btn" disabled={pending} onClick={() => run(() => removeMemberAction(r.id), `${r.name} removed.`)}>
                    Remove
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {canEdit ? <DraftNote draft={draft} what="the new person" /> : null}
      {canEdit ? (
        <form
          className="tm-form"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const out = await addMemberAction({ email, name, role, grants: bill ? ["bill"] : [] });
              if (out.ok) {
                draft.discard();
              }
              return out;
            }, `${name || "That person"} added.`);
          }}
        >
          <label className="tm-f">
            <span className="th-label">Name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" required />
          </label>
          <label className="tm-f">
            <span className="th-label">Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" required />
          </label>
          <label className="tm-f">
            <span className="th-label">Role</span>
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((x) => (
                <option key={x} value={x}>
                  {ROLE_LABEL[x]}
                </option>
              ))}
            </select>
          </label>
          {role === "dispatcher" ? (
            <label className="dlg-check">
              <input type="checkbox" checked={bill} onChange={(e) => setPerson((p) => ({ ...p, bill: e.target.checked }))} /> {GRANT_LABEL.bill}
            </label>
          ) : null}
          <button type="submit" className="tl-btn primary" disabled={pending || full} title={full ? "Every seat of the plan is used." : undefined}>
            Add person
          </button>
          {full ? <span className="tl-sub">Every seat of the plan is used. Talk to a person to change the plan.</span> : <span className="tl-sub">{ROLE_NOTE[role]}</span>}
        </form>
      ) : null}
    </>
  );
}
