"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { addMemberAction, removeMemberAction, setMemberRoleAction } from "@/app/(desk)/actions";
import { ROLES, ROLE_LABEL, ROLE_NOTE, type Role } from "@/lib/roles";
import { useToast } from "./kit/toast";

export type TeamRow = { id: string; email: string; name: string; role: Role; signedIn: boolean; you: boolean };

/**
 * Who is on this desk. Everyone sees the list; an owner adds a person by email (they sign in with that email and are on the desk), changes a role, or takes a person off. A plan
 * holds only so many seats, and a desk keeps one owner; the server enforces both and the message says why.
 */
export function TeamCard({ rows, canEdit, seats }: { rows: TeamRow[]; canEdit: boolean; seats: { used: number; limit: number | null } }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState<Role>("dispatcher");
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
        {seats.used} of {seats.limit ?? "no automatic limit on"} seats used. {canEdit ? "Add a person with their email; they sign in with it and are on the desk. A desk keeps one owner." : "Ask an owner to add or change people."}
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
      {canEdit ? (
        <form
          style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end" }}
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const out = await addMemberAction({ email, name, role });
              if (out.ok) {
                setEmail("");
                setName("");
              }
              return out;
            }, `${name || "That person"} added.`);
          }}
        >
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="th-label">Name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" required />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="th-label">Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" required />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="th-label">Role</span>
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((x) => (
                <option key={x} value={x}>
                  {ROLE_LABEL[x]}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="tl-btn primary" disabled={pending || full} title={full ? "Every seat of the plan is used." : undefined}>
            Add person
          </button>
          {full ? <span className="tl-sub">Every seat of the plan is used. Talk to a person to change the plan.</span> : <span className="tl-sub">{ROLE_NOTE[role]}</span>}
        </form>
      ) : null}
    </>
  );
}
