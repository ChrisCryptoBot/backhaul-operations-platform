"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { addMemberAction, removeMemberAction, setMemberGrantsAction, setMemberRoleAction, setMemberScopeAction } from "@/app/(desk)/actions";
import { GRANT_LABEL, ROLES, ROLE_LABEL, ROLE_NOTE, type Grant, type Role } from "@/lib/roles";
import { useToast } from "./kit/toast";
import { DraftNote, useDraft } from "./kit/use-draft";

export type TeamRow = { id: string; email: string; name: string; role: Role; grants: Grant[]; signedIn: boolean; you: boolean; scope: { regionIds: string[]; terminals: string[] } };

/**
 * Who is on this desk. Everyone sees the list; an admin adds a person by email (they sign in with that email and are on the desk), changes a role, lets a dispatcher also do the billing
 * office's work, or takes a person off. A plan holds only so many seats, and a desk keeps one admin; the server enforces both and the message says why.
 */
export function TeamCard({ rows, canEdit, seats, regions = [], terminals = [] }: { rows: TeamRow[]; canEdit: boolean; seats: { used: number; limit: number | null }; regions?: Array<{ id: string; name: string }>; terminals?: string[] }) {
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
            <th scope="col">Can see</th>
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
              <td>
                <ScopeCell row={r} regions={regions} terminals={terminals} canEdit={canEdit && r.role !== "admin"} pending={pending} onSave={(scope) => run(() => setMemberScopeAction(r.id, scope), `${r.name}'s view updated.`)} />
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

/**
 * What a person may see: everything (no limit), or the regions and terminals ticked. An admin always sees everything. The server holds them to it on every list, so a limited dispatcher cannot choose
 * their way past it in the header.
 */
function ScopeCell({ row, regions, terminals, canEdit, pending, onSave }: { row: TeamRow; regions: Array<{ id: string; name: string }>; terminals: string[]; canEdit: boolean; pending: boolean; onSave: (s: { regionIds: string[]; terminals: string[] }) => void }) {
  const [open, setOpen] = React.useState(false);
  const [regionIds, setRegionIds] = React.useState(row.scope.regionIds);
  const [picked, setPicked] = React.useState(row.scope.terminals);
  React.useEffect(() => {
    setRegionIds(row.scope.regionIds);
    setPicked(row.scope.terminals);
  }, [row.scope.regionIds.join("|"), row.scope.terminals.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  const names = [...row.scope.regionIds.map((id) => `${regions.find((r) => r.id === id)?.name ?? "A region"} region`), ...row.scope.terminals];
  const said = row.role === "admin" ? "Everything" : names.length === 0 ? "Everything" : names.join(", ");
  if (!canEdit) return <span className={names.length === 0 ? "dim" : undefined}>{said}</span>;
  const flip = (list: string[], v: string, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));
  return (
    <>
      <span className={names.length === 0 ? "dim" : undefined}>{said}</span>{" "}
      <button type="button" className="tl-btn ghost sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? "Close" : "Change"}
      </button>
      {open ? (
        <fieldset className="tm-scope" style={{ border: 0, margin: "8px 0 0", padding: 0, display: "grid", gap: 4 }}>
          <legend className="sr-only">What {row.name} can see</legend>
          <span className="tl-sub">Tick nothing for no limit.</span>
          {regions.map((r) => (
            <label key={r.id} className="dlg-check">
              <input type="checkbox" checked={regionIds.includes(r.id)} onChange={(e) => setRegionIds((l) => flip(l, r.id, e.target.checked))} /> {r.name} region
            </label>
          ))}
          {terminals.map((t) => (
            <label key={t} className="dlg-check">
              <input type="checkbox" checked={picked.includes(t)} onChange={(e) => setPicked((l) => flip(l, t, e.target.checked))} /> {t}
            </label>
          ))}
          <span>
            <button
              type="button"
              className="tl-btn sm"
              disabled={pending}
              onClick={() => {
                onSave({ regionIds, terminals: picked });
                setOpen(false);
              }}>
              Save
            </button>
          </span>
        </fieldset>
      ) : null}
    </>
  );
}
