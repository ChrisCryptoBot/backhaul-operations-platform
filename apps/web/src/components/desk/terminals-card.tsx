"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { addTerminalAction, archiveTerminalAction, renameTerminalAction, setTerminalRegionAction } from "@/app/(desk)/actions";
import type { TerminalResult } from "@/server/tl/terminal-list";
import { useToast } from "./kit/toast";
import { useDraft } from "./kit/use-draft";

export type TerminalCardRow = { id: string; name: string; city: string | null; note: string | null; regionId: string | null; drivers: number; trucks: number; trailers: number };

/**
 * The terminals a fleet has: the list people pick from when they give a driver, truck or trailer a home base. An admin adds, renames and retires them. Renaming moves everyone based there;
 * a terminal with drivers, trucks or trailers still based at it cannot be retired until they are moved. A home terminal is a base, not a fence: any driver can still be given a load from anywhere.
 */
export function TerminalsCard({ rows, canEdit, regions = [] }: { rows: TerminalCardRow[]; canEdit: boolean; regions?: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [form, setForm, draft] = useDraft("terminals:add", { name: "", city: "", note: "" });
  const [editing, setEditing] = React.useState<{ id: string; name: string } | null>(null);
  const [error, setError] = React.useState("");

  const run = (job: () => Promise<TerminalResult>, done: string, after?: () => void) =>
    start(async () => {
      const out = await job();
      if (out.ok) {
        setError("");
        toast({ text: done, tone: "ok" });
        after?.();
        router.refresh();
      } else setError(out.error);
    });

  return (
    <>
      <p className="tl-note" style={{ marginBottom: 10, maxWidth: "72ch" }}>
        {rows.length === 0 ? "No terminals yet." : `${rows.length} ${rows.length === 1 ? "terminal" : "terminals"}.`} A terminal is a yard, branch or region. A driver&apos;s terminal is their home base, not a limit: anyone can be given a load from anywhere.
        {canEdit ? "" : " Ask an admin to add or change terminals."}
      </p>
      {rows.length > 0 ? (
        <table className="tl-table" aria-label="Terminals">
          <thead>
            <tr>
              <th scope="col">Terminal</th>
              <th scope="col">City</th>
              <th scope="col">Region</th>
              <th scope="col">Drivers</th>
              <th scope="col">Trucks</th>
              <th scope="col">Trailers</th>
              {canEdit ? (
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  {editing?.id === r.id ? (
                    <input aria-label={`New name for ${r.name}`} value={editing.name} maxLength={40} onChange={(e) => setEditing({ id: r.id, name: e.target.value })} />
                  ) : (
                    <b>{r.name}</b>
                  )}
                  {r.note ? <span className="tl-sub" style={{ display: "block" }}>{r.note}</span> : null}
                </td>
                <td>{r.city ?? <span className="dim">{"—"}</span>}</td>
                <td>
                  {canEdit ? (
                    <select value={r.regionId ?? ""} disabled={pending} aria-label={`Region of ${r.name}`} onChange={(e) => run(() => setTerminalRegionAction(r.id, e.target.value || null), e.target.value ? `${r.name} is in ${regions.find((x) => x.id === e.target.value)?.name ?? "the region"}.` : `${r.name} is not in a region.`)}>
                      <option value="">Not in a region</option>
                      {regions.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    (regions.find((g) => g.id === r.regionId)?.name ?? <span className="dim">{"—"}</span>)
                  )}
                </td>
                <td>{r.drivers}</td>
                <td>{r.trucks}</td>
                <td>{r.trailers}</td>
                {canEdit ? (
                  <td style={{ whiteSpace: "nowrap" }}>
                    {editing?.id === r.id ? (
                      <>
                        <button type="button" className="tl-btn sm" disabled={pending} onClick={() => run(() => renameTerminalAction(r.id, editing.name), "Terminal renamed.", () => setEditing(null))}>
                          Save
                        </button>{" "}
                        <button type="button" className="tl-btn ghost sm" onClick={() => setEditing(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="tl-btn ghost sm" disabled={pending} onClick={() => setEditing({ id: r.id, name: r.name })}>
                          Rename
                        </button>{" "}
                        <button type="button" className="tl-btn ghost sm" disabled={pending} onClick={() => run(() => archiveTerminalAction(r.id), `${r.name} retired.`)}>
                          Retire
                        </button>
                      </>
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {canEdit ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end", marginTop: 12 }}>
          <label className="tl-field">
            Terminal name
            <input value={form.name} maxLength={40} placeholder="Dallas yard" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="tl-field">
            City
            <input value={form.city} maxLength={60} placeholder="Dallas, TX" onChange={(e) => setForm({ ...form, city: e.target.value })} />
          </label>
          <label className="tl-field">
            Note
            <input value={form.note} maxLength={120} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </label>
          <button
            type="button"
            className="tl-btn"
            disabled={pending}
            onClick={() =>
              run(() => addTerminalAction({ name: form.name, city: form.city, note: form.note }), "Terminal added.", () => {
                draft.discard();
              })
            }>
            Add terminal
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="tl-note warn" role="alert" style={{ marginTop: 10 }}>
          {error}
        </p>
      ) : null}
    </>
  );
}
